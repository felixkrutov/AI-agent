// frontend/src/index.tsx

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AuthProvider } from './context/AuthContext'; // ADDED: Импортируем наш провайдер

// Стили лучше импортировать здесь, чтобы они были доступны всему приложению
import './index.css'; 

const rootElement = document.getElementById('root') as HTMLElement;
const root = ReactDOM.createRoot(rootElement);

root.render(
  <React.StrictMode>
    {/* ADDED: Оборачиваем App в AuthProvider */}
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>
);
