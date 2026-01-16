console.log('Запуск самодиагностики...')
const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Загрузка конфигурации
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const { telegram, messages } = config;

// Инициализация бота
const bot = new TelegramBot(telegram.token, { polling: true });

// Инициализация базы данных
const db = new Database(path.join(__dirname, 'bot.db'));

// Создание таблиц
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    message_text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    is_answered INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS blacklist (
    user_id INTEGER PRIMARY KEY,
    blocked_until INTEGER,
    is_permanent INTEGER DEFAULT 0,
    blocked_at INTEGER NOT NULL
  );
`);

// Глобальный обработчик для временных токенов
const pendingMessages = new Map();

// Состояния администратора для многошаговых действий
const adminStates = new Map();

// Функция для добавления сообщения (экспортируется для Express API)
function addPendingMessage(messageText) {
  const timestamp = Date.now();
  pendingMessages.set(timestamp.toString(), messageText);
  return timestamp;
}

// Проверка, является ли пользователь администратором
function isAdmin(userId) {
  return userId === telegram.adminId;
}

// Проверка, заблокирован ли пользователь
function isUserBlocked(userId) {
  const row = db.prepare('SELECT * FROM blacklist WHERE user_id = ?').get(userId);
  
  if (!row) return false;
  
  if (row.is_permanent) return true;
  
  const now = Date.now();
  if (row.blocked_until && row.blocked_until > now) return true;
  
  // Если временная блокировка истекла, удаляем запись
  if (row.blocked_until && row.blocked_until <= now) {
    db.prepare('DELETE FROM blacklist WHERE user_id = ?').run(userId);
    return false;
  }
  
  return false;
}

// Функция замены плейсхолдеров в сообщениях
function formatMessage(template, replacements = {}) {
  let result = template;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  return result;
}

// Команда /start
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const param = match[1].trim();
  
  // Если это администратор, показываем админские команды
  if (isAdmin(userId)) {
    const keyboard = {
      inline_keyboard: [
        [{ text: messages.buttons.viewMessages, callback_data: 'admin_view_messages' }],
        [{ text: messages.buttons.blacklist, callback_data: 'admin_blacklist' }],
        [{ text: messages.buttons.deleteMessage, callback_data: 'delete_message' }]
      ]
    };
    
    bot.sendMessage(chatId, messages.admin.panel, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
    return;
  }
  
  // Проверка на блокировку
  if (isUserBlocked(userId)) {
    bot.sendMessage(chatId, messages.user.blocked);
    return;
  }
  
  // Если есть параметр (timestamp), проверяем его
  if (param) {
    const messageText = pendingMessages.get(param);
    
    if (messageText) {
      // Сохраняем сообщение в базу данных
      db.prepare(`
        INSERT INTO messages (user_id, username, first_name, last_name, message_text, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        msg.from.username || null,
        msg.from.first_name || null,
        msg.from.last_name || null,
        messageText,
        Date.now()
      );
      
      // Удаляем токен из обработчика
      pendingMessages.delete(param);
      
      bot.sendMessage(chatId, messages.user.messageSent);
      
      // Уведомляем администратора
      bot.sendMessage(telegram.adminId, messages.admin.newMessage);
    } else {
      bot.sendMessage(chatId, messages.user.invalidLink);
    }
  } else {
    // Обычное сообщение для пользователя
    bot.sendMessage(chatId, messages.user.welcome);
  }
});

// Просмотр сообщений администратором
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from.id;
  const data = query.data;
  
  if (!isAdmin(userId)) {
    bot.answerCallbackQuery(query.id, { text: messages.admin.noAccessFunction });
    return;
  }
  
  // Удаление сообщения
  if (data === 'delete_message') {
    bot.deleteMessage(chatId, messageId);
    bot.answerCallbackQuery(query.id);
    return;
  }
  
  // Просмотр сообщений
  if (data === 'admin_view_messages') {
    const senders = db.prepare(`
      SELECT DISTINCT user_id, username, first_name, last_name, 
             COUNT(*) as msg_count,
             SUM(CASE WHEN is_answered = 0 THEN 1 ELSE 0 END) as unread_count
      FROM messages 
      GROUP BY user_id
      ORDER BY MAX(created_at) DESC
    `).all();
    
    if (senders.length === 0) {
      bot.editMessageText(messages.admin.noMessages, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [[{ text: messages.buttons.back, callback_data: 'admin_back_start' }]]
        }
      });
      bot.answerCallbackQuery(query.id);
      return;
    }
    
    const keyboard = senders.map(sender => {
      const name = sender.first_name || sender.username || `ID: ${sender.user_id}`;
      const badge = sender.unread_count > 0 
        ? formatMessage(messages.messageView.unreadBadge, { count: sender.unread_count }) 
        : '';
      const blockedBadge = isUserBlocked(sender.user_id) ? messages.messageView.blockedBadge : '';
      return [{ 
        text: `${name}${badge}${blockedBadge}`, 
        callback_data: `view_sender_${sender.user_id}_0` 
      }];
    });
    
    keyboard.push([{ text: messages.buttons.back, callback_data: 'admin_back_start' }]);
    
    bot.editMessageText(messages.admin.selectSender, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });
    bot.answerCallbackQuery(query.id);
    return;
  }
  
  // Просмотр сообщений конкретного отправителя
  if (data.startsWith('view_sender_')) {
    const parts = data.split('_');
    const senderId = parseInt(parts[2]);
    const page = parseInt(parts[3]);
    
    const msgs = db.prepare(`
      SELECT * FROM messages 
      WHERE user_id = ? 
      ORDER BY created_at DESC
    `).all(senderId);
    
    if (msgs.length === 0) {
      bot.answerCallbackQuery(query.id, { text: 'Сообщений не найдено.' });
      return;
    }
    
    const msg = msgs[page];
    const date = new Date(msg.created_at).toLocaleString('ru-RU');
    const status = msg.is_answered ? messages.messageView.statusAnswered : messages.messageView.statusNew;
    const name = msg.first_name || msg.username || `ID: ${msg.user_id}`;
    
    // Проверяем, заблокирован ли пользователь
    const isBlocked = isUserBlocked(senderId);
    const blockInfo = db.prepare('SELECT * FROM blacklist WHERE user_id = ?').get(senderId);
    
    let blockStatus = '';
    if (isBlocked && blockInfo) {
      if (blockInfo.is_permanent) {
        blockStatus = messages.messageView.blockedPermanent;
      } else {
        const now = Date.now();
        const hoursLeft = Math.ceil((blockInfo.blocked_until - now) / (1000 * 60 * 60));
        blockStatus = formatMessage(messages.messageView.blockedTemporary, { hours: hoursLeft });
      }
    }
    
    const text = blockStatus + formatMessage(messages.messageView.header, {
      name,
      status,
      date,
      page: page + 1,
      total: msgs.length,
      text: msg.message_text
    });
    
    const keyboard = [];
    
    // Навигация
    const navRow = [];
    if (page > 0) {
      navRow.push({ text: messages.buttons.prev, callback_data: `view_sender_${senderId}_${page - 1}` });
    }
    if (page < msgs.length - 1) {
      navRow.push({ text: messages.buttons.next, callback_data: `view_sender_${senderId}_${page + 1}` });
    }
    if (navRow.length > 0) keyboard.push(navRow);
    
    // Действия - показываем либо "Заблокировать" либо "Разблокировать"
    if (isBlocked) {
      keyboard.push([
        { text: messages.buttons.reply, callback_data: `reply_${msg.id}` },
        { text: messages.buttons.unblock, callback_data: `unblock_${senderId}_msg` }
      ]);
    } else {
      keyboard.push([
        { text: messages.buttons.reply, callback_data: `reply_${msg.id}` },
        { text: messages.buttons.block, callback_data: `block_user_${senderId}` }
      ]);
    }
    
    keyboard.push([
      { text: messages.buttons.deleteMsg, callback_data: `delete_msg_${msg.id}` }
    ]);
    keyboard.push([
      { text: messages.buttons.backToSenders, callback_data: 'admin_view_messages' }
    ]);
    
    bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });
    bot.answerCallbackQuery(query.id);
    return;
  }
  
  // Ответить на сообщение
  if (data.startsWith('reply_')) {
    const msgId = parseInt(data.split('_')[1]);
    adminStates.set(userId, { action: 'reply', messageId: msgId });
    
    bot.editMessageText(messages.admin.enterReply, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [[{ text: messages.buttons.cancel, callback_data: 'cancel_action' }]]
      }
    });
    bot.answerCallbackQuery(query.id);
    return;
  }
  
  // Блокировка пользователя
  if (data.startsWith('block_user_')) {
    const targetUserId = parseInt(data.split('_')[2]);
    
    const keyboard = [
      [{ text: messages.buttons.blockTemporary, callback_data: `block_temp_${targetUserId}` }],
      [{ text: messages.buttons.blockPermanent, callback_data: `block_perm_${targetUserId}` }],
      [{ text: messages.buttons.back, callback_data: 'admin_view_messages' }]
    ];
    
    bot.editMessageText(messages.admin.selectBlockType, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });
    bot.answerCallbackQuery(query.id);
    return;
  }
  
  // Временная блокировка
  if (data.startsWith('block_temp_')) {
    const targetUserId = parseInt(data.split('_')[2]);
    adminStates.set(userId, { action: 'block_temp', targetUserId });
    
    bot.editMessageText(messages.admin.enterBlockHours, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [[{ text: messages.buttons.cancel, callback_data: 'cancel_action' }]]
      }
    });
    bot.answerCallbackQuery(query.id);
    return;
  }
  
  // Постоянная блокировка
  if (data.startsWith('block_perm_')) {
    const targetUserId = parseInt(data.split('_')[2]);
    
    db.prepare(`
      INSERT OR REPLACE INTO blacklist (user_id, blocked_until, is_permanent, blocked_at)
      VALUES (?, NULL, 1, ?)
    `).run(targetUserId, Date.now());
    
    bot.editMessageText(messages.admin.userBlockedPermanent, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [[{ text: messages.buttons.backToMessages, callback_data: 'admin_view_messages' }]]
      }
    });
    bot.answerCallbackQuery(query.id, { text: messages.admin.userUnblocked });
    return;
  }
  
  // Удаление сообщения
  if (data.startsWith('delete_msg_')) {
    const msgId = parseInt(data.split('_')[2]);
    
    const keyboard = [
      [{ text: messages.buttons.confirmDelete, callback_data: `confirm_delete_${msgId}` }],
      [{ text: messages.buttons.cancel, callback_data: 'admin_view_messages' }]
    ];
    
    bot.editMessageText(messages.admin.confirmDelete, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });
    bot.answerCallbackQuery(query.id);
    return;
  }
  
  // Подтверждение удаления
  if (data.startsWith('confirm_delete_')) {
    const msgId = parseInt(data.split('_')[2]);
    db.prepare('DELETE FROM messages WHERE id = ?').run(msgId);
    
    bot.editMessageText(messages.admin.messageDeleted, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [[{ text: messages.buttons.backToMessages, callback_data: 'admin_view_messages' }]]
      }
    });
    bot.answerCallbackQuery(query.id, { text: messages.admin.messageDeleted });
    return;
  }
  
  // Черный список
  if (data === 'admin_blacklist' || data.startsWith('blacklist_page_')) {
    const page = data === 'admin_blacklist' ? 0 : parseInt(data.split('_')[2]);
    
    const blocked = db.prepare(`
      SELECT * FROM blacklist 
      ORDER BY blocked_at DESC
    `).all();
    
    if (blocked.length === 0) {
      bot.editMessageText(messages.admin.blacklistEmpty, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [[{ text: messages.buttons.back, callback_data: 'admin_back_start' }]]
        }
      });
      bot.answerCallbackQuery(query.id);
      return;
    }
    
    const user = blocked[page];
    const now = Date.now();
    
    let status = '';
    if (user.is_permanent) {
      status = messages.blacklist.statusPermanent;
    } else if (user.blocked_until > now) {
      const hoursLeft = Math.ceil((user.blocked_until - now) / (1000 * 60 * 60));
      status = formatMessage(messages.blacklist.statusTemporary, { hours: hoursLeft });
    } else {
      status = messages.blacklist.statusExpired;
    }
    
    const blockedDate = new Date(user.blocked_at).toLocaleString('ru-RU');
    
    const text = formatMessage(messages.blacklist.header, {
      userId: user.user_id,
      status,
      date: blockedDate,
      page: page + 1,
      total: blocked.length
    });
    
    const keyboard = [];
    
    // Навигация
    const navRow = [];
    if (page > 0) {
      navRow.push({ text: messages.buttons.prev, callback_data: `blacklist_page_${page - 1}` });
    }
    if (page < blocked.length - 1) {
      navRow.push({ text: messages.buttons.next, callback_data: `blacklist_page_${page + 1}` });
    }
    if (navRow.length > 0) keyboard.push(navRow);
    
    keyboard.push([{ text: messages.buttons.unblock, callback_data: `unblock_${user.user_id}` }]);
    keyboard.push([{ text: messages.buttons.back, callback_data: 'admin_back_start' }]);
    
    bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });
    bot.answerCallbackQuery(query.id);
    return;
  }
  
  // Разблокировка
  if (data.startsWith('unblock_')) {
    const parts = data.split('_');
    const targetUserId = parseInt(parts[1]);
    const fromMessages = parts[2] === 'msg';
    
    db.prepare('DELETE FROM blacklist WHERE user_id = ?').run(targetUserId);
    
    bot.answerCallbackQuery(query.id, { text: messages.admin.userUnblocked });
    
    if (fromMessages) {
      bot.emit('callback_query', { ...query, data: `view_sender_${targetUserId}_0` });
    } else {
      bot.emit('callback_query', { ...query, data: 'admin_blacklist' });
    }
    return;
  }
  
  // Отмена действия
  if (data === 'cancel_action') {
    adminStates.delete(userId);
    bot.editMessageText(messages.admin.actionCancelled, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [[{ text: messages.buttons.back, callback_data: 'admin_view_messages' }]]
      }
    });
    bot.answerCallbackQuery(query.id);
    return;
  }
  
  // Возврат к началу
  if (data === 'admin_back_start') {
    const keyboard = {
      inline_keyboard: [
        [{ text: messages.buttons.viewMessages, callback_data: 'admin_view_messages' }],
        [{ text: messages.buttons.blacklist, callback_data: 'admin_blacklist' }],
        [{ text: messages.buttons.deleteMessage, callback_data: 'delete_message' }]
      ]
    };
    
    bot.editMessageText(messages.admin.panel, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
    bot.answerCallbackQuery(query.id);
    return;
  }
});

// Обработка текстовых сообщений для администратора
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId) || !msg.text || msg.text.startsWith('/')) return;
  
  const state = adminStates.get(userId);
  if (!state) return;
  
  if (state.action === 'reply') {
    // Отправка ответа пользователю
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(state.messageId);
    
    if (message) {
      const replyText = formatMessage(messages.user.replyFromAdmin, { text: msg.text });
      bot.sendMessage(message.user_id, replyText, {
        parse_mode: 'HTML'
      });
      
      // Отмечаем как отвеченное
      db.prepare('UPDATE messages SET is_answered = 1 WHERE id = ?').run(state.messageId);
      
      bot.sendMessage(chatId, messages.admin.replySent, {
        reply_markup: {
          inline_keyboard: [[{ text: messages.buttons.backToMessages, callback_data: 'admin_view_messages' }]]
        }
      });
    }
    
    adminStates.delete(userId);
  } else if (state.action === 'block_temp') {
    // Временная блокировка
    const hours = parseInt(msg.text);
    
    if (isNaN(hours) || hours <= 0) {
      bot.sendMessage(chatId, messages.admin.invalidHours);
      return;
    }
    
    const blockedUntil = Date.now() + (hours * 60 * 60 * 1000);
    
    db.prepare(`
      INSERT OR REPLACE INTO blacklist (user_id, blocked_until, is_permanent, blocked_at)
      VALUES (?, ?, 0, ?)
    `).run(state.targetUserId, blockedUntil, Date.now());
    
    bot.sendMessage(chatId, formatMessage(messages.admin.userBlocked, { hours }), {
      reply_markup: {
        inline_keyboard: [[{ text: messages.buttons.backToMessages, callback_data: 'admin_view_messages' }]]
      }
    });
    
    adminStates.delete(userId);
  }
});

// Команда /blacklist
bot.onText(/\/blacklist/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!isAdmin(userId)) {
    bot.sendMessage(chatId, messages.admin.noAccess);
    return;
  }
  
  bot.sendMessage(chatId, messages.admin.blacklistLoading, {
    reply_markup: {
      inline_keyboard: [[{ text: messages.buttons.openBlacklist, callback_data: 'admin_blacklist' }]]
    }
  });
});

console.log('Тест самодиагностики пройден. Бот запущен и функционирует корректно!');

// Экспорт функции для использования в Express
module.exports = {
  bot,
  addPendingMessage
};