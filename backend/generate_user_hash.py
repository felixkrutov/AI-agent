# backend/generate_user_hash.py
import json
from getpass import getpass
from auth import get_password_hash, USERS_FILE, load_users

def add_user():
    """Интерактивно добавляет нового пользователя в users.json"""
    print("--- Добавление нового пользователя ---")
    
    # Загружаем существующих пользователей
    try:
        users = load_users()
    except FileNotFoundError:
        users = {}
    
    # Запрашиваем данные
    username = input("Введите имя пользователя (логин): ").strip()
    if not username:
        print("Ошибка: Имя пользователя не может быть пустым.")
        return
    if username in users:
        print(f"Ошибка: Пользователь '{username}' уже существует.")
        return
        
    password = getpass("Введите пароль: ")
    password_confirm = getpass("Подтвердите пароль: ")
    
    if password != password_confirm:
        print("Ошибка: Пароли не совпадают.")
        return

    # Создаем хэш и добавляем пользователя
    hashed_password = get_password_hash(password)
    users[username] = {
        "hashed_password": hashed_password,
        "disabled": False
    }
    
    # Сохраняем обновленный список
    with open(USERS_FILE, 'w') as f:
        json.dump(users, f, indent=4)
        
    print(f"\nПользователь '{username}' успешно добавлен в {USERS_FILE}!")
    print("Не забудьте перезапустить бэкенд, чтобы изменения вступили в силу.")


if __name__ == "__main__":
    add_user()
