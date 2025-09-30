import logging
import os
import json
import uuid
import re
import asyncio
from datetime import datetime

from fastapi import Depends
from auth import router as auth_router, get_current_active_user, User

import google.generativeai as genai
import google.generativeai.protos as gap
from google.ai.generativelanguage_v1beta.services.generative_service import GenerativeServiceAsyncClient
from google.api_core.client_options import ClientOptions
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
from typing import Dict, List, Optional, Any
from apscheduler.schedulers.background import BackgroundScheduler
from google.api_core.exceptions import ResourceExhausted, InternalServerError
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
from openai import AsyncOpenAI
import redis
import httpx

from kb_service.connector import MockConnector
from kb_service.yandex_connector import YandexDiskConnector
from kb_service.indexer import KnowledgeBaseIndexer
from kb_service.parser import parse_document

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

load_dotenv()

PROXY_URL = "http://51.158.76.113:9999"

redis_client = redis.Redis(host=os.getenv("REDIS_HOST", "redis"), port=6379, db=0, decode_responses=True)

YANDEX_TOKEN = os.getenv("YANDEX_DISK_API_TOKEN")

if YANDEX_TOKEN:
    logging.info("YANDEX_DISK_API_TOKEN found. Initializing YandexDiskConnector.")
    kb_connector = YandexDiskConnector(token=YANDEX_TOKEN)
else:
    logging.info("YANDEX_DISK_API_TOKEN not found. Initializing MockConnector as a fallback.")
    kb_connector = MockConnector()

kb_indexer = KnowledgeBaseIndexer(connector=kb_connector)
scheduler = BackgroundScheduler()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    raise ValueError("GEMINI_API_KEY environment variable not set!")

generative_client = GenerativeServiceAsyncClient(transport="rest", client_options=ClientOptions(api_key=GEMINI_API_KEY))
embedding_client = generative_client
genai.configure(api_key=os.getenv("GEMINI_API_KEY"))

CONTROLLER_PROVIDER = os.getenv("CONTROLLER_PROVIDER", "openai").lower()
CONTROLLER_API_KEY = None
CONTROLLER_BASE_URL = None

if CONTROLLER_PROVIDER == "openrouter":
    CONTROLLER_API_KEY = os.getenv("OPENROUTER_API_KEY")
    CONTROLLER_BASE_URL = "https://openrouter.ai/api/v1"
    logger.info("Configuring Controller to use OpenRouter.")
else:
    CONTROLLER_API_KEY = os.getenv("OPENAI_API_KEY")
    CONTROLLER_BASE_URL = "https://api.openai.com/v1"
    logger.info("Configuring Controller to use OpenAI.")

if not CONTROLLER_API_KEY:
    logger.warning("Controller API key is not set. The Quality Control stage will be skipped.")
    controller_client = None
else:
    controller_client = AsyncOpenAI(
        base_url=CONTROLLER_BASE_URL,
        api_key=CONTROLLER_API_KEY,
        http_client=httpx.AsyncClient(proxies={"all://": PROXY_URL})
    )

def analyze_document(file_id: str, query: str) -> str:
    logger.info(f"TOOL CALL: analyze_document for file_id: {file_id} with query: '{query}'")
    try:
        results = kb_indexer.search(query=query, file_id=file_id)
        if not results:
            file_info = kb_indexer.get_file_by_id(file_id)
            file_name = file_info['name'] if file_info else file_id
            return f"Внутри файла '{file_name}' по вашему запросу '{query}' ничего не найдено."
        formatted_results = [f"--- Результат поиска №{i+1} (из файла: {chunk['file_name']}) ---\n{chunk['text']}\n" for i, chunk in enumerate(results)]
        return "\n".join(formatted_results)
    except Exception as e:
        logger.error(f"Error in analyze_document tool for file_id {file_id}: {e}", exc_info=True)
        return f"ОШИБКА: Произошла внутренняя ошибка при поиске по файлу: {e}"

def search_knowledge_base(query: str) -> str:
    logger.info(f"TOOL CALL: search_knowledge_base with query: '{query}'")
    results = kb_indexer.search(query)
    if not results:
        return "По вашему запросу в базе знаний ничего не найдено."
    formatted_results = [f"--- Результат поиска №{i+1} (из файла: {chunk['file_name']}) ---\n{chunk['text']}\n" for i, chunk in enumerate(results)]
    return "\n".join(formatted_results)

def list_all_files_summary() -> str:
    logger.info("TOOL CALL: list_all_files_summary")
    try:
        all_files = kb_indexer.get_all_files()
        if not all_files:
            return "В базе знаний нет доступных файлов."
        
        summary = "Доступные файлы в базе знаний:\n"
        for f in all_files:
            summary += f"- Имя файла: '{f.get('name', 'N/A')}', ID: '{f.get('id', 'N/A')}'\n"
        return summary.strip()
    except Exception as e:
        logger.error(f"Error in list_all_files_summary tool: {e}", exc_info=True)
        return f"ОШИБКА: Не удалось получить список файлов: {e}"

@retry(
    wait=wait_exponential(multiplier=1, min=2, max=60),
    stop=stop_after_attempt(3),
    retry=retry_if_exception_type((ResourceExhausted, InternalServerError))
)
async def run_with_retry(func, *args, **kwargs):
    return await func(*args, **kwargs)


async def determine_file_context(user_message: str, all_files: List[Dict]) -> Optional[str]:
    if not all_files:
        return None

    files_summary = "\n".join([f"- Имя файла: '{f.get('name', 'N/A')}', ID: '{f.get('id', 'N/A')}'" for f in all_files])
    
    prompt = f"""You are a classification assistant. Your task is to determine if the user's query refers to a specific file from the provided list.

Here is the list of available files:
<file_list>
{files_summary}
</file_list>

Here is the user's query:
<user_query>
{user_message}
</user_query>

Analyze the user's query. If it explicitly or implicitly refers to one of the files from the list, respond with ONLY the file's ID (e.g., "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d").
If the query does not refer to any specific file, respond with the exact word "None". Do not provide any other text or explanation.
"""
    try:
        context_model = genai.GenerativeModel('gemini-2.5-flash')
        response = await run_with_retry(context_model.generate_content_async, prompt)
        
        file_id_match = response.text.strip()
        
        available_ids = {f.get('id') for f in all_files}
        if file_id_match in available_ids:
            logger.info(f"Context analysis determined the query refers to file_id: {file_id_match}")
            return file_id_match
        else:
            logger.info("Context analysis did not find a specific file reference.")
            return None
    except Exception as e:
        logger.error(f"Error during context determination: {e}")
        return None


app = FastAPI(title="Engineering Hub API", docs_url="/api/docs", openapi_url="/api/openapi.json")

app.include_router(auth_router, prefix="/api", tags=["Authentication"])


def update_kb_index() -> None:
    kb_indexer.build_index()

@app.on_event("startup")
def startup_event():
    logging.info("Application startup: Initializing services...")
    update_kb_index()
    scheduler.add_job(update_kb_index, "interval", hours=1, id="update_kb_index_job", replace_existing=True)
    scheduler.start()
    logging.info("Application startup: Services initialized and scheduler started.")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

HISTORY_DIR = "chat_histories"
CONFIG_FILE = "/app_config/config.json"
CONTROLLER_SYSTEM_PROMPT = "You are a helpful assistant."

class AgentSettings(BaseModel):
    model_name: str
    system_prompt: str

class AppConfig(BaseModel):
    executor: AgentSettings
    controller: AgentSettings

class ChatRequest(BaseModel):
    message: str
    conversation_id: str
    file_id: Optional[str] = None
    use_agent_mode: bool = False

class CreateChatRequest(BaseModel):
    title: str

class ChatInfo(BaseModel):
    id: str
    title: str
    
class RenameRequest(BaseModel):
    new_title: str

class ThinkingStep(BaseModel):
    type: str
    content: str

class Message(BaseModel):
    role: str
    parts: List[str]
    thinking_steps: Optional[List[ThinkingStep]] = None

class JobCreationResponse(BaseModel):
    job_id: str


def load_config() -> AppConfig:
    default_config = AppConfig(
        executor=AgentSettings(model_name='gemini-2.5-pro', system_prompt='You are a helpful assistant.'),
        controller=AgentSettings(model_name='o4-mini', system_prompt='You are a helpful assistant.')
    )
    if not os.path.exists(CONFIG_FILE):
        return default_config
    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return AppConfig.model_validate(data)
    except Exception as e:
        logger.warning(f"Could not load or validate config file due to: {e}. Deleting corrupt file and using defaults.")
        try:
            os.remove(CONFIG_FILE)
        except OSError as del_e:
            logger.error(f"Failed to delete corrupt config file: {del_e}")
        return default_config

def save_config(config: AppConfig):
    os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(config.model_dump(), f, indent=2, ensure_ascii=False)

@app.get("/api/v1/config", response_model=AppConfig)
async def get_config(current_user: User = Depends(get_current_active_user)):
    return load_config()

@app.post("/api/v1/config", status_code=status.HTTP_200_OK)
async def set_config(config: AppConfig, current_user: User = Depends(get_current_active_user)):
    save_config(config)
    return {"status": "success", "message": "Configuration saved."}

@app.get("/api/kb/files", response_model=List[Dict])
async def get_all_kb_files(current_user: User = Depends(get_current_active_user)):
    return kb_indexer.get_all_files()

@app.get("/api/v1/chats", response_model=List[ChatInfo])
async def list_chats(current_user: User = Depends(get_current_active_user)):
    chats = []
    os.makedirs(HISTORY_DIR, exist_ok=True)
    for filename in os.listdir(HISTORY_DIR):
        if filename.endswith(".json"):
            conversation_id = filename[:-5]
            title_path = os.path.join(HISTORY_DIR, f"{conversation_id}.title.txt")
            title = "Новый чат"
            if os.path.exists(title_path):
                with open(title_path, 'r', encoding='utf-8') as f:
                    title = f.read().strip() or title
            else:
                try:
                    with open(os.path.join(HISTORY_DIR, filename), 'r', encoding='utf-8') as f:
                        history = json.load(f)
                        if history:
                            first_user_message = next((item for item in history if item.get('role') == 'user'), None)
                            if first_user_message and first_user_message.get('parts'):
                               title = first_user_message['parts'][0][:50]
                except (json.JSONDecodeError, IndexError) as e:
                    logger.warning(f"Could not generate title for {filename} due to error: {e}")
                    pass
            chats.append(ChatInfo(id=conversation_id, title=title))
    return sorted(chats, key=lambda item: os.path.getmtime(os.path.join(HISTORY_DIR, f"{item.id}.json")), reverse=True)

@app.post("/api/v1/chats", response_model=ChatInfo, status_code=status.HTTP_201_CREATED)
async def create_new_chat(request: CreateChatRequest, current_user: User = Depends(get_current_active_user)):
    conversation_id = str(uuid.uuid4())
    history_file_path = os.path.join(HISTORY_DIR, f"{conversation_id}.json")
    title_file_path = os.path.join(HISTORY_DIR, f"{conversation_id}.title.txt")
    try:
        os.makedirs(HISTORY_DIR, exist_ok=True)
        with open(history_file_path, 'w', encoding='utf-8') as f: json.dump([], f)
        with open(title_file_path, 'w', encoding='utf-8') as f: f.write(request.title)
        return ChatInfo(id=conversation_id, title=request.title)
    except OSError as e:
        raise HTTPException(status_code=500, detail="Failed to create chat files.")

@app.post("/api/v1/jobs", response_model=JobCreationResponse, status_code=status.HTTP_202_ACCEPTED)
async def create_chat_job(request: ChatRequest, current_user: User = Depends(get_current_active_user)):
    job_id = f"job:{uuid.uuid4()}"
    job_data = request.model_dump_json()

    try:
        history_file_path = os.path.join(HISTORY_DIR, f"{request.conversation_id}.json")
        if not os.path.exists(history_file_path):
            with open(history_file_path, 'w', encoding='utf-8') as f:
                json.dump([], f)

        with open(history_file_path, 'r+', encoding='utf-8') as f:
            try:
                history = json.load(f)
                if not isinstance(history, list): history = []
            except json.JSONDecodeError:
                history = []
            
            history.append({"role": "user", "parts": [request.message]})
            
            f.seek(0)
            json.dump(history, f, indent=2, ensure_ascii=False)
            f.truncate()
    except Exception as e:
        logger.error(f"Failed to write user message to history file {history_file_path}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to save user message.")

    redis_client.set(f"active_job_for_convo:{request.conversation_id}", job_id, ex=3600)
    logger.info(f"Linked conversation {request.conversation_id} to active job {job_id}")

    initial_status = {
        "status": "queued",
        "thoughts": json.dumps([{"type": "info", "content": "Задача поставлена в очередь..."}]),
        "final_answer": ""
    }
    
    redis_client.hset(job_id, mapping=initial_status)
    
    redis_client.lpush("job_queue", json.dumps({"job_id": job_id, "payload": job_data}))
    
    logger.info(f"Job {job_id} created and queued for conversation {request.conversation_id}.")
    return JobCreationResponse(job_id=job_id)

@app.get("/api/v1/jobs/{job_id}/status")
async def get_job_status(job_id: str, current_user: User = Depends(get_current_active_user)):
    job_data = redis_client.hgetall(job_id)
    if not job_data:
        raise HTTPException(status_code=404, detail="Job not found")
    
    job_data['thoughts'] = json.loads(job_data.get('thoughts', '[]'))
    return JSONResponse(content=job_data)

@app.post("/api/v1/jobs/{job_id}/cancel", status_code=status.HTTP_200_OK)
async def cancel_job(job_id: str, current_user: User = Depends(get_current_active_user)):
    if not redis_client.exists
