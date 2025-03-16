// src/bot.ts
import TelegramBot from 'node-telegram-bot-api';
import { BOT_TOKEN } from './config';
import { Configuration } from './database/models/Configuration';
import { REGIONS } from './constants/regions';

// Храним список chatId, которые сейчас ввели «Сменить регион» и ждём, пока они отправят код
const awaitingRegionCode = new Set<number>();

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN не задан в .env');
}

export const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// При старте бота /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  // Проверяем, есть ли у нас конфиг для этого пользователя
  let config = await Configuration.findOne({ where: { userId: chatId } });

  // Если нет — создаём запись, сразу спрашиваем регион
  if (!config) {
    awaitingRegionCode.add(chatId);
    await bot.sendMessage(chatId, 'Добро пожаловать! Введите код региона (например, 35).', {
      reply_markup: {
        // Клавиатура с одной кнопкой «Сменить регион»
        keyboard: [[{ text: 'Сменить регион' }]],
        resize_keyboard: true,
        one_time_keyboard: false,
      },
    });
  } else {
    // Если конфиг уже есть — просто приветствуем
    await bot.sendMessage(chatId, 'С возвращением! Используйте кнопку «Сменить регион», если нужно.', {
      reply_markup: {
        keyboard: [[{ text: 'Сменить регион' }]],
        resize_keyboard: true,
        one_time_keyboard: false,
      },
    });
  }
});

// Обработка нажатия кнопки "Сменить регион"
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  // Если пользователь жмёт «Сменить регион» — предлагаем ввести код
  if (text === 'Сменить регион') {
    awaitingRegionCode.add(chatId);
    await bot.sendMessage(chatId, 'Введите код региона (например, 35).');
    return;
  }

  // Если пользователь в режиме «ждём код»
  if (awaitingRegionCode.has(chatId)) {
    // Снимаем режим ожидания
    awaitingRegionCode.delete(chatId);

    // Проверяем, есть ли такой код
    const regionName = `${REGIONS[text]} - ${text}`;
    if (!regionName) {
      await bot.sendMessage(chatId, 'Код региона не найден. Попробуйте снова «Сменить регион».');
      return;
    }

    // Сохраняем в БД (Configuration)
    let config = await Configuration.findOne({ where: { userId: chatId } });
    if (!config) {
      // Создаём, если нет
      config = await Configuration.create({
        userId: chatId,
        configData: JSON.stringify({ region: regionName }),
      });
    } else {
      // Обновляем
      config.configData = JSON.stringify({ region: regionName });
      await config.save();
    }

    await bot.sendMessage(chatId, `Регион установлен: ${regionName}`);
    return;
  }
});
