// frontend/src/App.tsx

import React, { useState, useEffect, useRef } from 'react';
import { ClipLoader } from 'react-spinners';
import { FaPaperPlane, FaBars, FaTimes, FaPencilAlt, FaTrashAlt, FaSun, FaMoon, FaCog, FaSignOutAlt } from 'react-icons/fa';
import { v4 as uuidv4 } from 'uuid';
import AgentThoughts, { Thought } from './components/AgentThoughts';
import './App.css';

// --- ADDED: Новые импорты для авторизации ---
import { useAuth } from './context/AuthContext';
import LoginPage from './pages/LoginPage';
import apiClient from './api/client';
// ------------------------------------------

// Интерфейсы остаются без изменений
interface Chat { id: string; title: string; }
interface Message { id:string; jobId?: string; role: 'user' | 'model' | 'error'; content: string; displayedContent: string; thinking_steps?: Thought[]; sources?: string[]; }
interface ModalState { visible: boolean; title: string; message: string; showInput: boolean; inputValue: string; confirmText: string; onConfirm: (value: string | boolean | null) => void; }
interface KnowledgeBaseFile { id: string; name: string; }
interface AgentSettings { model_name: string; system_prompt: string; }
interface AppConfig { executor: AgentSettings; controller: AgentSettings; }

const user = { username: 'Engineer' }; // Оставим пока для отображения имени

function App() {
  const { isAuthenticated, isLoading: isAuthLoading, logout } = useAuth();

  const [theme, setTheme] = useState('dark');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chats, setChats] = useState<Chat[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [userInput, setUserInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [isAgentMode, setIsAgentMode] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] = useState('ai');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [dirtyConfig, setDirtyConfig] = useState<AppConfig | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [kbFiles, setKbFiles] = useState<KnowledgeBaseFile[]>([]);
  const [isKbFilesLoading, setIsKbFilesLoading] = useState(false);
  const [kbFilesError, setKbFilesError] = useState<string | null>(null);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [modalState, setModalState] = useState<ModalState>({ visible: false, title: '', message: '', showInput: false, inputValue: '', confirmText: 'OK', onConfirm: () => {}, });

  const chatContainerRef = useRef<HTMLDivElement>(null);
  const userInputRef = useRef<HTMLTextAreaElement>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);


  useEffect(() => {
    if (isSettingsModalOpen && config) {
        setDirtyConfig(JSON.parse(JSON.stringify(config)));
    }
  }, [isSettingsModalOpen, config]);

  useEffect(() => {
    const fetchFiles = async () => {
      setIsKbFilesLoading(true);
      setKbFilesError(null);
      try {
        const response = await apiClient.get('/kb/files');
        setKbFiles(response.data.map((file: any) => ({ id: file.id, name: file.name })));
      } catch (error) {
        console.error("Failed to fetch KB files:", error);
        setKbFilesError("Не удалось загрузить список файлов.");
      } finally {
        setIsKbFilesLoading(false);
      }
    };

    if (isAuthenticated && isSettingsModalOpen && activeSettingsTab === 'db') {
      fetchFiles();
    }
  }, [isAuthenticated, isSettingsModalOpen, activeSettingsTab]);

  const loadConfig = async () => {
    try {
      const response = await apiClient.get('/v1/config');
      const data: AppConfig = response.data;
      setConfig(data);
      setDirtyConfig(JSON.parse(JSON.stringify(data)));
    } catch (error) {
      console.error("Could not load config:", error);
    }
  };

  const handleSaveSettings = async () => {
    if (!dirtyConfig) return;
    setIsSaving(true);
    try {
      await apiClient.post('/v1/config', dirtyConfig);
      setConfig(JSON.parse(JSON.stringify(dirtyConfig)));
    } catch(error) {
      console.error("Save settings failed:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleUseFile = (fileId: string, fileName: string) => {
    setActiveFileId(fileId);
    setUserInput(`Проанализируй файл "${fileName}" по запросу: `);
    setIsSettingsModalOpen(false);
    userInputRef.current?.focus();
  };
  
  const loadChats = async () => {
    try {
      const response = await apiClient.get('/v1/chats');
      setChats(response.data);
    } catch (error) {
      console.error("Ошибка загрузки чатов:", error);
    }
  };

  const startPolling = (jobId: string, isNewChat: boolean) => {
      if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
      }

      const poll = async () => {
          try {
              const response = await apiClient.get(`/v1/jobs/${jobId}/status`);
              const jobStatus = response.data;

              setMessages(currentMessages => currentMessages.map(msg => {
                  if (msg.jobId === jobId) {
                      const updatedMsg: Message = { 
                          ...msg, 
                          thinking_steps: jobStatus.thoughts,
                          content: (jobStatus.status === 'complete') ? (jobStatus.final_answer || '') : msg.content,
                          role: (jobStatus.status === 'failed') ? 'error' : msg.role,
                          jobId: msg.jobId
                      };
                      if (['complete', 'failed', 'cancelled'].includes(jobStatus.status)) {
                          delete updatedMsg.jobId; 
                          if (jobStatus.status === 'failed') {
                              updatedMsg.content = 'Обработка задачи завершилась с ошибкой.';
                          }
                      }
                      return updatedMsg;
                  }
                  return msg;
              }));

              if (['complete', 'failed', 'cancelled'].includes(jobStatus.status)) {
                  if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
                  setIsLoading(false);
                  setCurrentJobId(null);
              }
          } catch (error) {
              console.error('Polling error:', error);
              if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
              setIsLoading(false);
              setCurrentJobId(null);
              setMessages(currentMessages => currentMessages.map(msg =>
                  msg.jobId === jobId ? { ...msg, role: 'error', content: 'Ошибка при получении статуса задачи.', displayedContent: 'Ошибка при получении статуса задачи.' } : msg
              ));
          }
      };

      pollIntervalRef.current = setInterval(poll, 2000);
  };

  const selectChat = async (chatId: string) => {
    if (isLoading && chatId !== currentChatId) return;
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);

    setIsLoading(true);
    setCurrentChatId(chatId);
    setMessages([]);

    try {
        const historyRes = await apiClient.get(`/v1/chats/${chatId}`);
        const historyData = historyRes.data;
        const historyMessages: Message[] = historyData.map((m: any, index: number) => ({
            id: `${chatId}-${index}`,
            role: m.role,
            content: m.content || '',
            displayedContent: m.content || '',
            thinking_steps: m.thinking_steps || [],
            sources: m.sources || []
        }));
        
        const activeJobRes = await apiClient.get(`/v1/chats/${chatId}/active_job`);
        const { job_id } = activeJobRes.data;

        if (job_id) {
            const jobStatusRes = await apiClient.get(`/v1/jobs/${job_id}/status`);
            const jobStatus = jobStatusRes.data;
            
            const modelMessage: Message = {
                id: uuidv4(), role: 'model', content: '', displayedContent: '',
                thinking_steps: jobStatus.thoughts,
                jobId: job_id
            };

            setMessages([...historyMessages, modelMessage]);
            setCurrentJobId(job_id);

            if (!['complete', 'failed', 'cancelled'].includes(jobStatus.status)) {
                setIsLoading(true);
                startPolling(job_id, false);
            } else {
                setIsLoading(false);
            }
        } else {
            setMessages(historyMessages);
            setIsLoading(false);
            setCurrentJobId(null);
        }
    } catch (error) {
        console.error("Failed to select chat:", error);
        setMessages([{ id: uuidv4(), role: 'error', content: 'Не удалось загрузить этот чат.', displayedContent: 'Не удалось загрузить этот чат.' }]);
        setIsLoading(false);
    }
  };


  const startNewChat = () => {
    setCurrentChatId(null);
    setCurrentJobId(null);
    setMessages([]);
    setActiveFileId(null);
  };
  
  const handleRenameChat = async (chatId: string, currentTitle: string) => {
    const newTitle = await showModal({ title: 'Переименовать чат', message: 'Введите новое название для этого чата.', showInput: true, inputValue: currentTitle, confirmText: 'Сохранить' });
    if (typeof newTitle === 'string' && newTitle.trim() && newTitle.trim() !== currentTitle) {
        try {
            await apiClient.put(`/v1/chats/${chatId}`, { new_title: newTitle.trim() });
            await loadChats();
        } catch (error) { console.error("Error renaming chat:", error); }
    }
  };

  const handleDeleteChat = async (chatId: string) => {
    const confirmed = await showModal({ title: 'Удалить чат?', message: 'Вы уверены, что хотите удалить этот чат? Это действие необратимо.', confirmText: 'Удалить' });
    if (confirmed) {
        try {
            await apiClient.delete(`/v1/chats/${chatId}`);
            if (currentChatId === chatId) startNewChat();
            await loadChats();
        } catch (error) { console.error("Error deleting chat:", error); }
    }
  };

  useEffect(() => {
    if (isAuthenticated) {
        loadChats();
        loadConfig();
    }
  }, [isAuthenticated]);

  const scrollToBottom = () => {
    chatContainerRef.current?.scrollTo({ top: chatContainerRef.current.scrollHeight, behavior: 'smooth' });
  };

  const handleSendMessage = async () => {
    const messageText = userInput.trim();
    if (!messageText || isLoading) return;

    const userMessage: Message = {
      id: `local-${uuidv4()}`,
      role: 'user',
      content: messageText,
      displayedContent: messageText,
    };
    setMessages(prevMessages => [...prevMessages, userMessage]);
    setUserInput('');
    setIsLoading(true);

    if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
    }

    let conversationId = currentChatId;
    const isNewChat = !conversationId;

    try {
        if (isNewChat) {
            const response = await apiClient.post('/v1/chats', { title: messageText.substring(0, 50) || "Новый чат" });
            const newChatInfo: Chat = response.data;
            conversationId = newChatInfo.id;
            setCurrentChatId(conversationId);
            await loadChats();
        }

        if (!conversationId) throw new Error("Missing conversation ID to create a job.");

        const jobResponse = await apiClient.post('/v1/jobs', {
            message: messageText, conversation_id: conversationId,
            file_id: activeFileId, use_agent_mode: isAgentMode,
        });
        setActiveFileId(null);

        const { job_id } = jobResponse.data;
        setCurrentJobId(job_id);

        const modelPlaceholder: Message = {
            id: `model-${job_id}`,
            role: 'model',
            content: '',
            displayedContent: '',
            thinking_steps: [{ type: 'log', content: 'Задача поставлена в очередь...' }],
            jobId: job_id,
        };
        setMessages(prevMessages => [...prevMessages, modelPlaceholder]);
        startPolling(job_id, isNewChat);

    } catch (error) {
        console.error('Error during message sending process:', error);
        setMessages(prev => prev.filter(m => m.id !== userMessage.id)); 
        setUserInput(messageText);
        setIsLoading(false);
    }
};

  const handleCancelJob = async () => {
    if (!currentJobId) return;

    try {
      await apiClient.post(`/v1/jobs/${currentJobId}/cancel`);

      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      setIsLoading(false);
      setCurrentJobId(null);

      if (currentChatId) {
        selectChat(currentChatId);
      }

    } catch (error) {
      console.error("Failed to cancel job:", error);
    }
  };

  useEffect(() => {
    const messageToType = messages.find(m => m.role === 'model' && m.content.length > m.displayedContent.length);
    if (messageToType) {
      const interval = setInterval(() => {
        setMessages(currentMessages => currentMessages.map(m => {
            if (m.id === messageToType.id) {
              const nextCharIndex = m.displayedContent.length;
              if (nextCharIndex >= m.content.length) {
                clearInterval(interval);
                return m;
              }
              return { ...m, displayedContent: m.content.substring(0, nextCharIndex + 1) };
            }
            return m;
          }));
      }, 20);
      return () => clearInterval(interval);
    }
  }, [messages]);

  const adjustTextareaHeight = () => {
    if (userInputRef.current) {
        userInputRef.current.style.height = 'auto';
        userInputRef.current.style.height = `${userInputRef.current.scrollHeight}px`;
    }
  };

  const showModal = (props: Partial<Omit<ModalState, 'visible' | 'onConfirm'>>) => {
    return new Promise<string | boolean | null>((resolve) => {
      setModalState({
        visible: true, title: props.title || '', message: props.message || '',
        showInput: props.showInput || false, inputValue: props.inputValue || '',
        confirmText: props.confirmText || 'OK',
        onConfirm: (value) => { setModalState(prev => ({...prev, visible: false})); resolve(value); },
      });
    });
  };

  useEffect(scrollToBottom, [messages]);
  useEffect(adjustTextareaHeight, [userInput]);

  const handleThemeToggle = () => setTheme(theme === 'dark' ? 'light' : 'dark');
  const hasChanges = config && dirtyConfig ? JSON.stringify(config) !== JSON.stringify(dirtyConfig) : false;

  if (isAuthLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', backgroundColor: '#202123' }}>
        <ClipLoader color="#fff" size={50} />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <div className={`app-wrapper ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`} data-theme={theme}>
        {sidebarCollapsed && (<button className="sidebar-reopen-btn" onClick={() => setSidebarCollapsed(false)}><FaBars /></button>)}
        <aside className="sidebar">
          <div className="sidebar-header">
            <button className="new-chat-btn" onClick={startNewChat}><i className="bi bi-plus-lg"></i> Новый чат</button>
            <button className="hide-sidebar-btn" onClick={() => setSidebarCollapsed(true)}><FaTimes /></button>
          </div>
          <ul className="chat-list">
              {chats.map(chat => (
                  <li key={chat.id} className={`chat-list-item ${chat.id === currentChatId ? 'active' : ''}`} onClick={() => selectChat(chat.id)}>
                      <span className="chat-title">{chat.title}</span>
                      <div className="chat-actions">
                          <button title="Переименовать" onClick={(e) => { e.stopPropagation(); handleRenameChat(chat.id, chat.title); }}><FaPencilAlt /></button>
                          <button title="Удалить" onClick={(e) => { e.stopPropagation(); handleDeleteChat(chat.id); }}><FaTrashAlt /></button>
                      </div>
                  </li>
              ))}
          </ul>
          <div className="sidebar-footer">
            <div className="user-info">
              <div className="user-icon">{user.username[0].toUpperCase()}</div>
              <span>{user.username}</span>
            </div>
            <div>
              <button className="theme-toggle-btn" title="Сменить тему" onClick={handleThemeToggle}>{theme === 'dark' ? <FaSun /> : <FaMoon />}</button>
              <button className="settings-btn" title="Настройки" onClick={() => setIsSettingsModalOpen(true)}><FaCog /></button>
              <button className="logout-btn" title="Выйти" onClick={logout}><FaSignOutAlt /></button>
            </div>
          </div>
        </aside>
        <main className="main-content">
          <div className="chat-area">
            <div className="chat-container" ref={chatContainerRef}>
              {messages.length === 0 && !isLoading ? (
                  <div className="welcome-screen"><h1>Mossa AI</h1><p>Начните новый диалог или выберите существующий</p></div>
              ) : (
                  messages.map((msg, index) => (
                      <div key={msg.id} className={`message-block ${msg.role} ${msg.content.length > 0 && msg.content === msg.displayedContent ? 'done' : ''}`}>
                          <div className="message-content">
                              {msg.role === 'model' && msg.thinking_steps && msg.thinking_steps.length > 0 && (
                                <AgentThoughts
                                  steps={msg.thinking_steps}
                                  defaultCollapsed={!msg.jobId}
                                />
                              )}
                              <p className="content">{msg.displayedContent}</p>
                              {msg.sources && msg.sources.length > 0 && (
                                <div className="message-sources">
                                  <strong>Источники: </strong>
                                  <span>{msg.sources.join(', ')}</span>
                                </div>
                              )}
                          </div>
                      </div>
                  ))
              )}
               {isLoading && messages.length > 0 && messages[messages.length-1].role !== 'model' && <div className="spinner-container"><ClipLoader color="#888" size={30} /></div>}
            </div>
            <div className="input-area-wrapper">
              <div className="input-area">
                  <div className="input-top-row">
                      <textarea
                        ref={userInputRef}
                        className="user-input"
                        placeholder="Спросите что-нибудь..."
                        rows={1}
                        value={userInput}
                        onChange={(e) => setUserInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); }}}
                        disabled={isLoading}
                      />
                      {isLoading ? (
                          <button className="cancel-btn" onClick={handleCancelJob} title="Отменить">
                              <FaTimes />
                          </button>
                      ) : (
                          <button className="send-btn" onClick={handleSendMessage} disabled={userInput.trim() === ''}>
                              <FaPaperPlane />
                          </button>
                      )}
                  </div>
                  <div className="input-bottom-toolbar">
                      <button
                          className={`mode-toggle-btn ${isAgentMode ? 'active' : ''}`}
                          onClick={() => setIsAgentMode(!isAgentMode)}
                      >
                          Режим агента
                      </button>
                  </div>
              </div>
            </div>
          </div>
        </main>
        {modalState.visible && (
          <div className={`modal-overlay visible`} onClick={() => modalState.onConfirm(null)}>
              <div className="modal-box" onClick={(e) => e.stopPropagation()}>
                  <h3>{modalState.title}</h3><p>{modalState.message}</p>
                  {modalState.showInput && (<input type="text" className="modal-input" value={modalState.inputValue} onChange={(e) => setModalState(prev => ({...prev, inputValue: e.target.value }))} autoFocus />)}
                  <div className="modal-actions">
                      <button className="modal-btn-cancel" onClick={() => modalState.onConfirm(null)}>Отмена</button>
                      <button className="modal-btn-confirm" onClick={() => modalState.onConfirm(modalState.showInput ? modalState.inputValue : true)}>{modalState.confirmText}</button>
                  </div>
              </div>
          </div>
        )}
        {isSettingsModalOpen && (
          <div className="modal-overlay visible">
            <div className="modal-box settings-modal">
              <div className="modal-header"><h2>Настройки</h2><button className="modal-close-btn" onClick={() => setIsSettingsModalOpen(false)}>×</button></div>
              <div className="modal-content">
                <div className="tabs">
                  <button className={`tab-btn ${activeSettingsTab === 'ai' ? 'active' : ''}`} onClick={() => setActiveSettingsTab('ai')}>Настройки ИИ</button>
                  <button className={`tab-btn ${activeSettingsTab === 'db' ? 'active' : ''}`} onClick={() => setActiveSettingsTab('db')}>База Знаний</button>
                </div>
                <div className="tab-content">
                  {activeSettingsTab === 'ai' && dirtyConfig && (
                    <div className="ai-settings">
                      <div className="settings-group">
                        <h4>Агент-Исполнитель (Gemini)</h4>
                        <label htmlFor="executor-model-name">Модель</label>
                        <input id="executor-model-name" type="text" value={dirtyConfig.executor.model_name} onChange={(e) => setDirtyConfig({...dirtyConfig, executor: {...dirtyConfig.executor, model_name: e.target.value}})} />
                        <label htmlFor="executor-system-prompt">Системный промпт</label>
                        <textarea id="executor-system-prompt" rows={6} value={dirtyConfig.executor.system_prompt} onChange={(e) => setDirtyConfig({...dirtyConfig, executor: {...dirtyConfig.executor, system_prompt: e.target.value}})} />
                      </div>
                      <div className="settings-group">
                        <h4>Агент-Контролёр (OpenAI / OpenRouter)</h4>
                        <label htmlFor="controller-model-name">Модель</label>
                        <input id="controller-model-name" type="text" value={dirtyConfig.controller.model_name} onChange={(e) => setDirtyConfig({...dirtyConfig, controller: {...dirtyConfig.controller, model_name: e.target.value}})} />
                        <label htmlFor="controller-system-prompt">Системный промпт</label>
                        <textarea id="controller-system-prompt" rows={6} value={dirtyConfig.controller.system_prompt} onChange={(e) => setDirtyConfig({...dirtyConfig, controller: {...dirtyConfig.controller, system_prompt: e.target.value}})} />
                      </div>
                    </div>
                  )}
                  {activeSettingsTab === 'db' && (
                    <div className="db-settings file-manager">
                      {kbFilesError && <p className="error-message">{kbFilesError}</p>}
                      {isKbFilesLoading ? (<div className="spinner-container"><ClipLoader color="#888" size={30} /></div>) : (
                        kbFiles.length > 0 ? (
                          <div className="kb-file-list-container">
                            <ul className="kb-file-list">
                              {kbFiles.map((file) => (
                                <li key={file.id} className="kb-file-item">
                                  <span className="kb-file-name">{file.name}</span>
                                  <button className="modal-btn-confirm kb-use-btn" onClick={() => handleUseFile(file.id, file.name)}>Использовать</button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : (<p>Файлы в базе знаний не найдены.</p>)
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="modal-footer"><button className={`modal-btn-confirm ${!hasChanges || isSaving ? 'disabled' : ''}`} onClick={handleSaveSettings} disabled={!hasChanges || isSaving}>{isSaving ? <ClipLoader color="#ffffff" size={16} /> : 'Сохранить'}</button></div>
            </div>
          </div>
        )}
    </div>
  );
}

export default App;
