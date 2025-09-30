import json
from getpass import getpass
from auth import get_password_hash, USERS_FILE, load_users

def add_user():
    print("--- Добавление нового пользователя ---")
    
    try:
        users = load_users()
    except FileNotFoundError:
        users = {}
    
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

    hashed_password = get_password_hash(password)
    users[username] = {
        "hashed_password": hashed_password,
        "disabled": False
    }
    
    with open(USERS_FILE, 'w') as f:
        json.dump(users, f, indent=4)
        
    print(f"\nПользователь '{username}' успешно добавлен в {USERS_FILE}!")
    print("Не забудьте перезапустить бэкенд, чтобы изменения вступили в силу.")


if __name__ == "__main__":
    add_user()
