// frontend/src/api/client.ts

import axios from 'axios';

const apiClient = axios.create({
  // Указываем базовый URL для всех запросов. 
  // Убедись, что твой vite.config.ts или nginx настроен на проксирование /api на бэкенд.
  baseURL: '/api', 
});

// Это самая важная часть! Перехватчик запросов.
apiClient.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('authToken');
    if (token) {
      // Если токен есть, добавляем его в заголовок Authorization
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

export default apiClient;
