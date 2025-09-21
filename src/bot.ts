import TelegramBot from 'node-telegram-bot-api';
import { Op } from 'sequelize'; // НОВОЕ: Нужно для запросов с `IN`
import { config } from './config';
import { REGIONS } from './constants/regions';
import { Configuration } from './database/models/Configuration';
import { User } from './database/models/User';
import { logger } from './logger';
import { triggerImmediateParse } from './scheduler';
import { IUserConfig } from './types/config.types';

if (!config.BOT_TOKEN) {
	throw new Error('BOT_TOKEN не задан в .env');
}

// ИЗМЕНЕНО: Обновляем состояния для нового текстового флоу удаления
const userAction = new Map<
	number,
	| 'add_region'
	| 'awaiting_username'
	| 'awaiting_region_deletion' // НОВОЕ
	| 'awaiting_user_deletion' // НОВОЕ
>();

// =============================================================================
// ИНИЦИАЛИЗАЦИЯ БОТА И ОБРАБОТКА ОШИБОК (без изменений)
// =============================================================================
const botOptions: TelegramBot.ConstructorOptions = {
	polling: {
		interval: 1000,
		autoStart: true,
		params: {
			timeout: 10,
			allowed_updates: ['message', 'callback_query'],
		},
	},
	request: {
		agentOptions: {
			keepAlive: true,
			family: 4,
		},
		timeout: 30000,
		url: '',
	} as TelegramBot.ConstructorOptions['request'],
};

export const bot = new TelegramBot(config.BOT_TOKEN, botOptions);

let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;
const RESTART_DELAY = 30000;

bot.on('polling_error', async (error: any) => {
	consecutiveErrors++;
	logger.error(`[BOT] Polling error #${consecutiveErrors}:`, {
		code: error.code,
		message: error.message,
	});
	if (error.code === 'EFATAL' || error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET') {
		if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
			logger.error(`[BOT] КРИТИЧНО: ${consecutiveErrors} последовательных ошибок. Попытка перезапуска polling...`);
			await restartBotPolling();
		}
	} else {
		logger.error(`[BOT] Неизвестная polling ошибка:`, error);
	}
});

bot.on('message', () => {
	if (consecutiveErrors > 0) {
		logger.info(`[BOT] Успешное сообщение получено, сброс счетчика ошибок (было: ${consecutiveErrors})`);
		consecutiveErrors = 0;
	}
});

let isRestarting = false;
async function restartBotPolling(): Promise<void> {
    if (isRestarting) {
        logger.warn('[BOT] Перезапуск уже в процессе, пропускаем...');
        return;
    }
    
    isRestarting = true;
    
    try {
        logger.info('[BOT] Остановка polling...');
        await bot.stopPolling();
        
        // Ждем полной остановки
        await new Promise(resolve => setTimeout(resolve, RESTART_DELAY));
        
        // Проверяем, что polling действительно остановлен
        logger.info('[BOT] Перезапуск polling...');
        await bot.startPolling();
        
        consecutiveErrors = 0;
        logger.info('[BOT] ✅ Polling успешно перезапущен');
        
    } catch (restartError) {
        logger.error('[BOT] ❌ Ошибка при перезапуске polling:', restartError);
        // НЕ делаем рекурсивный вызов - это критично!
        logger.error('[BOT] Принудительное завершение процесса для перезапуска PM2...');
        process.exit(1); // Пусть PM2 перезапустит весь процесс
        
    } finally {
        isRestarting = false;
    }
}
// =============================================================================
// HEALTH CHECK ФУНКЦИЯ
// =============================================================================
export async function checkBotHealth(): Promise<boolean> {
	try {
		const me = await bot.getMe();
		logger.debug(`[BOT] Health check OK: ${me.username}`);
		return true;
	} catch (error) {
		logger.error('[BOT] Health check failed:', error);
		return false;
	}
}

// Периодическая проверка здоровья бота (каждые 5 минут)
setInterval(async () => {
	const isHealthy = await checkBotHealth();
	if (!isHealthy) {
		logger.warn('[BOT] Health check failed, возможны проблемы с ботом');
		consecutiveErrors++;
	}
}, 5 * 60 * 1000);

// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================
process.on('SIGTERM', async () => {
	logger.info('[BOT] Получен SIGTERM, остановка бота...');
	await gracefulShutdown();
});

process.on('SIGINT', async () => {
	logger.info('[BOT] Получен SIGINT, остановка бота...');
	await gracefulShutdown();
});

async function gracefulShutdown(): Promise<void> {
	try {
		logger.info('[BOT] Graceful shutdown начат...');
		
		// Останавливаем polling
		await bot.stopPolling();
		logger.info('[BOT] Polling остановлен');
		
		// Даем время завершить текущие операции
		await new Promise(resolve => setTimeout(resolve, 2000));
		
		logger.info('[BOT] ✅ Graceful shutdown завершен');
		process.exit(0);
	} catch (error) {
		logger.error('[BOT] Ошибка при graceful shutdown:', error);
		process.exit(1);
	}
}
// =============================================================================
// БЕЗОПАСНАЯ ОТПРАВКА СООБЩЕНИЙ С УЛУЧШЕННЫМ ЛОГИРОВАНИЕМ
// =============================================================================

export async function safeSendMessage(
	chatId: number,
	text: string,
	options?: TelegramBot.SendMessageOptions,
	maxRetries: number = 3
): Promise<boolean> {
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			await bot.sendMessage(chatId, text, options);
			return true;
		} catch (error: any) {
			const shortText = text.substring(0, 80).replace(/\n/g, ' ') + (text.length > 80 ? '...' : '');
			logger.warn(`[BOT] Попытка ${attempt}/${maxRetries} отправки сообщения пользователю ${chatId} не удалась. Сообщение: "${shortText}". Ошибка: ${error.message}`);
			
			if (attempt === maxRetries || error.response?.statusCode === 403) {
				if (error.response?.statusCode === 403) {
					logger.info(`[BOT] Пользователь ${chatId} заблокировал бота`);
				} else {
					logger.error(`[BOT] Не удалось отправить сообщение пользователю ${chatId} после ${maxRetries} попыток`);
				}
				return false;
			}
			await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
		}
	}
	return false;
}

// =============================================================================
// КЛАВИАТУРЫ И ПРОВЕРКА ДОСТУПА
// =============================================================================

// ИЗМЕНЕНО: Кнопка "Список пользователей" заменена на "Удалить пользователя"
const ADMIN_KEYBOARD = {
	reply_markup: {
		keyboard: [
			[{ text: '➕ Добавить регион' }, { text: '➖ Удалить регион' }],
			[{ text: 'Мои регионы' }],
			[{ text: '➕ Добавить пользователя' }, { text: '➖ Удалить пользователя' }],
		],
		resize_keyboard: true,
	},
};

const USER_KEYBOARD = {
	reply_markup: {
		keyboard: [
			[{ text: '➕ Добавить регион' }, { text: '➖ Удалить регион' }],
			[{ text: 'Мои регионы' }],
		],
		resize_keyboard: true,
	},
};

const GUEST_KEYBOARD = {
	reply_markup: { keyboard: [[{ text: '/start' }]], resize_keyboard: true },
};

// ИЗМЕНЕНО: Обновляем Set кнопок
const COMMAND_BUTTONS = new Set([
	'➕ Добавить регион', '➖ Удалить регион', 'Мои регионы',
	'➕ Добавить пользователя', '➖ Удалить пользователя',
]);

// Функции проверки доступа (без изменений)
function isAdmin(userId: number): boolean {
	return config.ADMIN_TELEGRAM_IDS.includes(userId);
}
async function isActivated(userId: number): Promise<boolean> {
	const user = await User.findOne({ where: { userId } });
	return !!user;
}
async function hasAccess(userId: number, username?: string): Promise<'admin' | 'activated' | 'registered' | 'none'> {
	if (isAdmin(userId)) return 'admin';
	if (await isActivated(userId)) return 'activated';
	const userInDb = username ? await User.findOne({ where: { username } }) : null;
	if (userInDb) return 'registered';
	return 'none';
}

// =============================================================================
// ГЛАВНЫЙ ОБРАБОТЧИК СООБЩЕНИЙ
// =============================================================================
bot.on('message', async (msg) => {
	const chatId = msg.chat.id;
	const username = msg.from?.username;
	const text = (msg.text || '').trim();
	
	// --- 1) Обработка /start (логика активации) ---
	if (text === '/start') {
		const userInDb = username ? await User.findOne({ where: { username } }) : null;
		if (userInDb && !userInDb.userId) {
			userInDb.userId = chatId;
			await userInDb.save();
			const welcomeMsg = isAdmin(chatId) ? 'Добро пожаловать, администратор!' : 'Ваш доступ к боту активирован!';
			await safeSendMessage(chatId, welcomeMsg, isAdmin(chatId) ? ADMIN_KEYBOARD : USER_KEYBOARD);
		} else {
			const access = await hasAccess(chatId, username);
			if (access === 'admin' || access === 'activated') {
				await safeSendMessage(chatId, 'Вы уже активированы, выбирайте команду.', isAdmin(chatId) ? ADMIN_KEYBOARD : USER_KEYBOARD);
			} else {
				await safeSendMessage(chatId, 'У вас нет доступа. При получении доступа повторно нажмите /start', GUEST_KEYBOARD);
			}
		}
		return;
	}
	
	// --- 2) Гейткипер для всех остальных команд ---
	const access = await hasAccess(chatId, username);
	if (access !== 'admin' && access !== 'activated') {
		await safeSendMessage(chatId, 'Пожалуйста, нажмите /start для активации или получения доступа.', GUEST_KEYBOARD);
		return;
	}
	
	try {
		// --- 3) Обработка ожидаемых действий (ввод данных) ---
		if (userAction.has(chatId)) {
			if (COMMAND_BUTTONS.has(text) || text.startsWith('/')) {
				userAction.delete(chatId);
				logger.debug(`Действие для пользователя ${chatId} отменено из-за нажатия кнопки.`);
			} else {
				const action = userAction.get(chatId);
				userAction.delete(chatId); // Сразу удаляем действие
				
				switch (action) {
					case 'add_region':
						await handleAddRegion(chatId, text);
						break;
					case 'awaiting_username':
						await handleAddUsername(msg);
						break;
					// НОВОЕ: Обработка ввода для удаления
					case 'awaiting_region_deletion':
						await handleDeleteRegionsByInput(chatId, text);
						break;
					case 'awaiting_user_deletion':
						await handleDeleteUsersByInput(chatId, text);
						break;
				}
				return;
			}
		}
		
		if (!text) return;
		
		// --- 4) Обработка команд с кнопок ---
		switch (text) {
			// Общие команды
			case '➕ Добавить регион':
				userAction.set(chatId, 'add_region');
				await safeSendMessage(chatId, 'Введите код или несколько кодов регионов через запятую (например, 77, 78).');
				break;
			case '➖ Удалить регион':
				// ИЗМЕНЕНО: Запускаем текстовый флоу удаления
				await promptForRegionDeletion(chatId);
				break;
			case 'Мои регионы':
				await showMyRegions(chatId);
				break;
			
			// Команды только для администратора
			case '➕ Добавить пользователя':
				if (isAdmin(chatId)) {
					userAction.set(chatId, 'awaiting_username');
					await safeSendMessage(chatId, 'Введите username пользователя (например, @username), которого вы хотите добавить.');
				}
				break;
			case '➖ Удалить пользователя': // ИЗМЕНЕНО: Новое название команды
				if (isAdmin(chatId)) {
					// ИЗМЕНЕНО: Запускаем текстовый флоу удаления
					await promptForUserDeletion(chatId);
				}
				break;
		}
	} catch (error) {
		logger.error(`[BOT_MESSAGE_HANDLER] Произошла критическая ошибка:`, error);
		await safeSendMessage(msg.chat.id, 'Произошла внутренняя ошибка. Пожалуйста, попробуйте позже.');
	}
});

// =============================================================================
// УДАЛЕНО: ОБРАБОТЧИК CALLBACK-ЗАПРОСОВ БОЛЬШЕ НЕ НУЖЕН ДЛЯ УДАЛЕНИЯ
// =============================================================================
bot.on('callback_query', async (callbackQuery) => {
	// Здесь может быть другая логика, не связанная с удалением, поэтому обработчик оставляем пустым.
	// Если других inline-кнопок нет, его можно полностью удалить.
	await bot.answerCallbackQuery(callbackQuery.id);
});

// =============================================================================
// ХЕЛПЕРЫ ДЛЯ РАБОТЫ С КОНФИГУРАЦИЕЙ (без изменений)
// =============================================================================
async function getUserConfig(chatId: number): Promise<IUserConfig> {
	const config = await Configuration.findOne({ where: { userId: chatId } });
	if (config?.configData) {
		try {
			const parsed = JSON.parse(config.configData);
			if (Array.isArray(parsed.regions)) return parsed;
		} catch (e) { /* ignore */ }
	}
	return { regions: [] };
}

async function saveUserConfig(chatId: number, userConfig: IUserConfig) {
	await Configuration.upsert({
		userId: chatId,
		configData: JSON.stringify(userConfig),
	});
}

// =============================================================================
// ЛОГИКА ДОБАВЛЕНИЯ
// =============================================================================
async function handleAddRegion(chatId: number, text: string) {
	const regionCodes = text.split(',').map(code => code.trim()).filter(Boolean);
	if (regionCodes.length === 0) {
		await safeSendMessage(chatId, 'Вы не ввели коды регионов. Попробуйте снова.');
		return;
	}
	
	const config = await getUserConfig(chatId);
	let addedRegions: string[] = [];
	let failedRegions: string[] = [];
	
	for (const code of regionCodes) {
		const regionName = REGIONS[code];
		if (!regionName) {
			failedRegions.push(code);
			continue;
		}
		const regionValue = `${regionName} - ${code}`;
		if (!config.regions.includes(regionValue)) {
			config.regions.push(regionValue);
			addedRegions.push(regionName);
		}
	}
	
	if (addedRegions.length > 0) {
		await saveUserConfig(chatId, config);
		let response = `✅ Регионы успешно добавлены:\n- ${addedRegions.join('\n- ')}`;
		if (failedRegions.length > 0) {
			response += `\n\n❌ Не удалось найти регионы с кодами: ${failedRegions.join(', ')}`;
		}
		await safeSendMessage(chatId, response, isAdmin(chatId) ? ADMIN_KEYBOARD : USER_KEYBOARD);
		
		await safeSendMessage(chatId, '🚀 Запускаю первоначальный поиск по новым регионам. Это может занять минуту...');
		for (const regionName of addedRegions) {
			const code = Object.keys(REGIONS).find(key => REGIONS[key] === regionName);
			if (code) {
				await triggerImmediateParse(`${regionName} - ${code}`, chatId);
			}
		}
	} else {
		await safeSendMessage(chatId, `Не удалось добавить регионы. Либо они уже были в списке, либо коды неверны: ${failedRegions.join(', ')}`);
	}
}

async function handleAddUsername(msg: TelegramBot.Message) {
	const adminId = msg.chat.id;
	let username = (msg.text || '').trim().replace('@', '');
	
	if (!username) {
		await safeSendMessage(adminId, 'Вы ввели пустое имя. Попробуйте снова.');
		userAction.set(adminId, 'awaiting_username');
		return;
	}
	
	const [user, created] = await User.findOrCreate({
		where: { username: username },
		defaults: { username: username, userId: null },
	});
	
	if (created) {
		logger.info(`[ADMIN] Администратор ${adminId} добавил нового пользователя @${username}`);
		await safeSendMessage(adminId, `✅ Пользователь @${username} добавлен в белый список. Он должен нажать /start для активации.`);
	} else {
		await safeSendMessage(adminId, `Пользователь @${username} уже был в списке.`);
	}
}

// =============================================================================
// НОВОЕ: ЛОГИКА УДАЛЕНИЯ ЧЕРЕЗ ТЕКСТОВЫЙ ВВОД
// =============================================================================

async function promptForRegionDeletion(chatId: number) {
	const config = await getUserConfig(chatId);
	if (config.regions.length === 0) {
		await safeSendMessage(chatId, 'Нечего удалять. У вас нет добавленных регионов.');
		return;
	}
	
	const regionList = config.regions.map(r => {
		const [name, code] = r.split(' - ');
		return `- ${name} (код: ${code})`;
	}).join('\n');
	
	userAction.set(chatId, 'awaiting_region_deletion');
	await safeSendMessage(chatId, `Ваши текущие регионы:\n${regionList}\n\nВведите коды регионов для удаления через запятую (например, 77, 98).`);
}

async function handleDeleteRegionsByInput(chatId: number, text: string) {
	const codesToDelete = new Set(text.split(',').map(code => code.trim()).filter(Boolean));
	if (codesToDelete.size === 0) {
		await safeSendMessage(chatId, 'Вы не ввели коды для удаления.');
		return;
	}
	
	const config = await getUserConfig(chatId);
	const initialCount = config.regions.length;
	const deletedRegions: string[] = [];
	
	config.regions = config.regions.filter(region => {
		const code = region.split(' - ')[1];
		if (codesToDelete.has(code)) {
			deletedRegions.push(region.split(' - ')[0]);
			return false;
		}
		return true;
	});
	
	if (deletedRegions.length > 0) {
		await saveUserConfig(chatId, config);
		await safeSendMessage(chatId, `✅ Регионы удалены:\n- ${deletedRegions.join('\n- ')}`);
	} else {
		await safeSendMessage(chatId, 'Ни один из указанных регионов не был найден в вашем списке.');
	}
}

async function promptForUserDeletion(adminId: number) {
	if (!isAdmin(adminId)) return;
	
	const users = await User.findAll();
	if (users.length === 0) {
		await safeSendMessage(adminId, 'В базе данных нет пользователей для удаления.');
		return;
	}
	
	const userList = users.map(user => {
		const status = user.userId ? `(ID: ${user.userId})` : '(ожидает активации)';
		return `- @${user.username} ${status}`;
	}).join('\n');
	
	userAction.set(adminId, 'awaiting_user_deletion');
	await safeSendMessage(adminId, `Текущие пользователи:\n${userList}\n\nВведите username для удаления через запятую (например, user1, @user2).`);
}

async function handleDeleteUsersByInput(adminId: number, text: string) {
	const usernamesToDelete = text.split(',').map(u => u.trim().replace('@', '')).filter(Boolean);
	if (usernamesToDelete.length === 0) {
		await safeSendMessage(adminId, 'Вы не ввели username для удаления.');
		return;
	}
	
	// Находим пользователей, чтобы уведомить их об удалении
	const usersToNotify = await User.findAll({
		where: { username: { [Op.in]: usernamesToDelete }, userId: { [Op.not]: null } },
	});
	
	const deletedCount = await User.destroy({
		where: { username: { [Op.in]: usernamesToDelete } },
	});
	
	if (deletedCount > 0) {
		logger.info(`[ADMIN] Администратор ${adminId} удалил ${deletedCount} пользователей.`);
		await safeSendMessage(adminId, `✅ Удалено ${deletedCount} пользователей.`);
		
		// Уведомляем тех, кого смогли
		for (const user of usersToNotify) {
			await safeSendMessage(user.userId!, 'Ваш доступ к боту был отозван администратором.');
		}
	} else {
		await safeSendMessage(adminId, 'Ни один из указанных пользователей не найден в базе данных.');
	}
}

// =============================================================================
// ПРОЧИЕ КОМАНДЫ
// =============================================================================

async function showMyRegions(chatId: number) {
	const currentConfig = await getUserConfig(chatId);
	if (currentConfig.regions.length === 0) {
		await safeSendMessage(chatId, 'У вас пока нет добавленных регионов.');
	} else {
		await safeSendMessage(chatId, `Ваши регионы:\n- ${currentConfig.regions.join('\n- ')}`);
	}
}