import TelegramBot from 'node-telegram-bot-api';
import { BOT_TOKEN } from './config';
import { Configuration } from './database/models/Configuration';
import { REGIONS } from './constants/regions';
import { IUserConfig } from './types/config.types';
// --- ИЗМЕНЕНИЕ: Импортируем новую функцию ---
import { triggerImmediateParse } from './scheduler';

if (!BOT_TOKEN) {
	throw new Error('BOT_TOKEN не задан в .env');
}

const userAction = new Map<number, 'add_region' | 'remove_region'>();

export const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const MAIN_KEYBOARD = {
	reply_markup: {
		keyboard: [
			[{ text: '➕ Добавить регион' }, { text: '➖ Удалить регион' }],
			[{ text: 'Мои регионы' }],
		],
		resize_keyboard: true,
	},
};

// --- Хелперы для чистоты кода ---

async function getUserConfig(chatId: number): Promise<IUserConfig> {
	const config = await Configuration.findOne({ where: { userId: chatId } });
	if (config?.configData) {
		try {
			const parsed = JSON.parse(config.configData);
			if (Array.isArray(parsed.regions)) {
				return parsed;
			}
		} catch (e) {
			// Игнорируем ошибки
		}
	}
	return { regions: [] };
}

async function saveUserConfig(chatId: number, userConfig: IUserConfig) {
	await Configuration.upsert({
		userId: chatId,
		configData: JSON.stringify(userConfig),
	});
}

// --- Основные обработчики ---

bot.onText(/\/start/, async (msg) => {
	const chatId = msg.chat.id;
	await bot.sendMessage(
		chatId,
		'Добро пожаловать! Используйте кнопки для управления регионами.',
		MAIN_KEYBOARD,
	);
});

bot.on('message', async (msg) => {
	const chatId = msg.chat.id;
	const text = (msg.text || '').trim();
	
	if (userAction.has(chatId)) {
		const action = userAction.get(chatId);
		userAction.delete(chatId);
		
		if (action === 'add_region') {
			await handleAddRegion(chatId, text);
		}
		return;
	}
	
	switch (text) {
		case '➕ Добавить регион':
			userAction.set(chatId, 'add_region');
			await bot.sendMessage(chatId, 'Введите код региона для добавления (например, 78 - Санкт-Петербург).');
			break;
		
		case '➖ Удалить регион':
			await showRegionsForDeletion(chatId);
			break;
		
		case 'Мои регионы':
			const currentConfig = await getUserConfig(chatId);
			if (currentConfig.regions.length === 0) {
				await bot.sendMessage(chatId, 'У вас пока нет добавленных регионов.');
			} else {
				await bot.sendMessage(chatId, `Ваши регионы:\n- ${currentConfig.regions.join('\n- ')}`);
			}
			break;
	}
});

// --- Логика добавления региона ---

async function handleAddRegion(chatId: number, regionCode: string) {
	const regionName = REGIONS[regionCode];
	if (!regionName) {
		await bot.sendMessage(chatId, 'Код региона не найден. Попробуйте снова');
		return;
	}
	
	const regionValue = `${regionName} - ${regionCode}`;
	const config = await getUserConfig(chatId);
	
	if (config.regions.includes(regionValue)) {
		await bot.sendMessage(chatId, `Регион "${regionName}" уже есть в вашем списке.`);
		return;
	}
	
	config.regions.push(regionValue);
	await saveUserConfig(chatId, config);
	
	await bot.sendMessage(chatId, `✅ Регион "${regionName}" успешно добавлен!`, MAIN_KEYBOARD);
	
	// --- НОВЫЙ БЛОК: Запуск немедленной проверки для нового региона ---
	await bot.sendMessage(chatId, '🚀 Запускаю первоначальный поиск по новому региону. Это может занять минуту...');
	// Вызываем функцию, которая выполнит поиск и отправит результат пользователю
	await triggerImmediateParse(regionValue, chatId);
}

// --- Логика удаления региона ---

async function showRegionsForDeletion(chatId: number) {
	const config = await getUserConfig(chatId);
	if (config.regions.length === 0) {
		await bot.sendMessage(chatId, 'Нечего удалять. У вас нет добавленных регионов.', MAIN_KEYBOARD);
		return;
	}
	
	const inlineKeyboard = config.regions.map(region => ([{
		text: `❌ ${region}`,
		callback_data: `delete_region:${region}`,
	}]));
	
	await bot.sendMessage(chatId, 'Нажмите на регион, чтобы его удалить:', {
		reply_markup: {
			inline_keyboard: inlineKeyboard,
		},
	});
}

bot.on('callback_query', async (callbackQuery) => {
	const message = callbackQuery.message;
	if (!message) return;
	const chatId = message.chat.id;
	const data = callbackQuery.data;
	
	if (data?.startsWith('delete_region:')) {
		const regionToDelete = data.substring('delete_region:'.length);
		const config = await getUserConfig(chatId);
		
		config.regions = config.regions.filter(r => r !== regionToDelete);
		await saveUserConfig(chatId, config);
		
		await bot.answerCallbackQuery(callbackQuery.id, { text: `Регион "${regionToDelete}" удален.` });
		
		await bot.editMessageText('Регион удален. Вы можете удалить еще, нажав кнопку "Удалить регион" снова.', {
			chat_id: chatId,
			message_id: message.message_id,
		});
	}
});