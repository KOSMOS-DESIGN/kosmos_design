const express = require('express');
const path = require('path');
const { addPendingMessage } = require('./bot'); // Импортируем функцию из бота

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware для парсинга JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Раздача статических файлов из папки public
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'media')));

// API endpoint для получения сообщений с формы
app.post('/api/submit-message', (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message || message.trim() === '') {
      return res.status(400).json({ 
        success: false, 
        error: 'Сообщение не может быть пустым' 
      });
    }
    
    // Добавляем сообщение в обработчик и получаем timestamp
    const timestamp = addPendingMessage(message);
    
    // Генерируем ссылку для телеграм бота
    const botUsername = `kosmos_manager_bot`;
    const telegramLink = `https://t.me/${botUsername}?start=${timestamp}`;
    
    res.json({
      success: true,
      timestamp: timestamp,
      telegram_link: telegramLink,
      message: 'Сообщение успешно обработано. Используйте ссылку для отправки в Telegram.'
    });
    
  } catch (error) {
    console.error('Ошибка при обработке сообщения:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Внутренняя ошибка сервера' 
    });
  }
});

// Маршруты для всех HTML страниц
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/portfolio', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'portfolio.html'));
});

app.get('/about', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'about.html'));
});

app.get('/mission-control', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mission-control.html'));
});

// Fallback route - перенаправление на главную для несуществующих маршрутов
app.get(/(.*)/, (req, res) => {
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT} (перейдите по этой ссылке в браузере для тестирования)`);
});

module.exports = app;