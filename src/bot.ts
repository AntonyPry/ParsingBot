import TelegramBot from 'node-telegram-bot-api';
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
// Добавляем новые состояния для админки
const userAction = new Map<
	number,
	'add_region' | 'remove_region' | 'awaiting_username'
>();

// =============================================================================
// УЛУЧШЕННАЯ ИНИЦИАЛИЗАЦИЯ БОТА С ОБРАБОТКОЙ ОШИБОК
// =============================================================================

const botOptions: TelegramBot.ConstructorOptions = {
	polling: {
		interval: 1000,
		autoStart: true,
		params: {
			timeout: 10,
			allowed_updates: ['message', 'callback_query']
		}
	},
	// Увеличиваем таймауты для стабильности
	request: {
		agentOptions: {
			keepAlive: true,
			family: 4
		},
		timeout: 30000,
		url: '' // Добавляем обязательное поле url (будет переопределено библиотекой)
	} as TelegramBot.ConstructorOptions['request']
};

export const bot = new TelegramBot(config.BOT_TOKEN, botOptions);

// =============================================================================
// ОБРАБОТЧИКИ ОШИБОК И ВОССТАНОВЛЕНИЯ
// =============================================================================

// Счетчик последовательных ошибок
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;
const RESTART_DELAY = 30000; // 30 секунд

// Обработчик polling ошибок
bot.on('polling_error', async (error: any) => {
	consecutiveErrors++;
	
	logger.error(`[BOT] Polling error #${consecutiveErrors}:`, {
		code: error.code,
		message: error.message,
		syscall: error.syscall,
		errno: error.errno
	});
	
	// Определяем тип ошибки
	if (error.code === 'EFATAL' || error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET') {
		logger.warn(`[BOT] Сетевая ошибка polling: ${error.code} - ${error.message}`);
		
		// Если слишком много последовательных ошибок - пытаемся перезапустить polling
		if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
			logger.error(`[BOT] КРИТИЧНО: ${consecutiveErrors} последовательных ошибок. Попытка перезапуска polling...`);
			await restartBotPolling();
		}
	} else if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
		logger.error(`[BOT] DNS/сетевая проблема: ${error.message}`);
		// Ждем больше времени при DNS проблемах
		setTimeout(() => {
			logger.info('[BOT] Попытка восстановления после DNS ошибки...');
		}, RESTART_DELAY * 2);
	} else {
		logger.error(`[BOT] Неизвестная polling ошибка:`, error);
	}
});

// Обработчик webhook ошибок (если когда-то переключитесь на webhook)
bot.on('webhook_error', (error: any) => {
	logger.error('[BOT] Webhook error:', error);
});

// Сброс счетчика ошибок при успешных операциях
bot.on('message', () => {
	if (consecutiveErrors > 0) {
		logger.info(`[BOT] Успешное сообщение получено, сброс счетчика ошибок (было: ${consecutiveErrors})`);
		consecutiveErrors = 0;
	}
});

bot.on('callback_query', () => {
	if (consecutiveErrors > 0) {
		logger.info(`[BOT] Успешный callback получен, сброс счетчика ошибок (было: ${consecutiveErrors})`);
		consecutiveErrors = 0;
	}
});

// =============================================================================
// ФУНКЦИЯ ПЕРЕЗАПУСКА POLLING
// =============================================================================
async function restartBotPolling(): Promise<void> {
	try {
		logger.info('[BOT] Остановка polling...');
		await bot.stopPolling();
		
		// Ждем перед перезапуском
		await new Promise(resolve => setTimeout(resolve, RESTART_DELAY));
		
		logger.info('[BOT] Перезапуск polling...');
		await bot.startPolling();
		
		consecutiveErrors = 0;
		logger.info('[BOT] ✅ Polling успешно перезапущен');
		
	} catch (restartError) {
		logger.error('[BOT] ❌ Ошибка при перезапуске polling:', restartError);
		
		// Если перезапуск не удался, попробуем еще раз через больший интервал
		setTimeout(async () => {
			logger.info('[BOT] Повторная попытка перезапуска...');
			await restartBotPolling();
		}, RESTART_DELAY * 2);
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
// УЛУЧШЕННАЯ ОБРАБОТКА ОТПРАВКИ СООБЩЕНИЙ
// =============================================================================

// Обертка для безопасной отправки сообщений с retry
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
			logger.warn(`[BOT] Попытка ${attempt}/${maxRetries} отправки сообщения пользователю ${chatId} не удалась:`, error.message);
			
			// Если это последняя попытка или критическая ошибка
			if (attempt === maxRetries || error.response?.statusCode === 403) {
				if (error.response?.statusCode === 403) {
					logger.info(`[BOT] Пользователь ${chatId} заблокировал бота`);
				} else {
					logger.error(`[BOT] Не удалось отправить сообщение пользователю ${chatId} после ${maxRetries} попыток`);
				}
				return false;
			}
			
			// Пауза перед повторной попыткой
			await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
		}
	}
	return false;
}

// =============================================================================
// КЛАВИАТУРЫ И ПРОВЕРКА ДОСТУПА
// =============================================================================

const ADMIN_KEYBOARD = {
	reply_markup: {
		keyboard: [
			[{ text: '➕ Добавить регион' }, { text: '➖ Удалить регион' }],
			[{ text: 'Мои регионы' }],
			[
				{ text: '➕ Добавить пользователя' },
				{ text: '👥 Список пользователей' },
			],
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
	reply_markup: { keyboard: [[{ text: '/start' }]], resize_keyboard: true }
};

// Set для быстрой проверки
const COMMAND_BUTTONS = new Set([
	'➕ Добавить регион', '➖ Удалить регион', 'Мои регионы',
	'➕ Добавить пользователя', '👥 Список пользователей',
]);

function isAdmin(userId: number): boolean {
	return config.ADMIN_TELEGRAM_IDS.includes(userId);
}

async function isRegistered(username?: string): Promise<boolean> {
	if (!username) return false;
	const user = await User.findOne({ where: { username } });
	return !!user;
}

async function isActivated(userId: number): Promise<boolean> {
	const user = await User.findOne({ where: { userId } });
	return !!user;
}

async function hasAccess(userId: number, username?: string): Promise<'admin' | 'activated' | 'registered' | 'none'> {
	if (isAdmin(userId)) return 'admin';
	if (await isActivated(userId)) return 'activated';
	if (await isRegistered(username)) return 'registered';
	return 'none';
}

bot.on('message', async (msg) => {
	const chatId = msg.chat.id;
	const username = msg.from?.username;
	const text = (msg.text || '').trim();
	
	// === 1) Всегда обрабатываем /start первым, до гейткипера ===
	if (text === '/start') {
		// Ищем пользователя по username
		const userInDb = username
			? await User.findOne({ where: { username } })
			: null;
		
		// Если он был в списке ожидания, активируем
		if (userInDb && !userInDb.userId) {
			userInDb.userId = chatId;
			await userInDb.save();
			
			const welcomeMsg = isAdmin(chatId)
				? 'Добро пожаловать, администратор! Расширенные функции доступны.'
				: 'Ваш доступ к боту активирован! Используйте кнопки ниже.';
			const kb = isAdmin(chatId) ? ADMIN_KEYBOARD : USER_KEYBOARD;
			
			await safeSendMessage(chatId, welcomeMsg, kb);
		} else {
			// Новый пользователь или уже активирован
			const access = isAdmin(chatId) || await isActivated(chatId)
				? 'ok' : 'wait';
			if (access === 'ok') {
				const kb = isAdmin(chatId) ? ADMIN_KEYBOARD : USER_KEYBOARD;
				await safeSendMessage(
					chatId,
					isAdmin(chatId)
						? 'Вы уже администратор, выбирайте команду.'
						: 'Вы уже активированы, выбирайте команду.',
					kb
				);
			} else {
				// Нет в списке и не админ — просим запросить доступ
				await safeSendMessage(
					chatId,
					'У вас нет доступа. При получении доступа повторно нажмите /start',
					GUEST_KEYBOARD
				);
			}
		}
		return; // дальше в этом апдейте текста не пускаем
	}
	
	// === 2) Гейткипер для всего остального ===
	const access = await hasAccess(chatId, username);
	if (access !== 'admin' && access !== 'activated') {
		// Показываем только кнопку /start
		await safeSendMessage(
			chatId,
			access === 'registered'
				? 'Пожалуйста, нажмите /start для активации доступа.'
				: 'У вас нет доступа. При получении доступа повторно нажмите /start',
			GUEST_KEYBOARD
		);
		return;
	}
	
	try {
		// const chatId = msg.chat.id;
		// const text = (msg.text || '').trim();
		//
		// // --- Главный гейткипер ---
		// if (!(await hasAccess(chatId, msg.from?.username))) {
		// 	await bot.sendMessage(chatId, 'У вас нет доступа к этому боту.');
		// 	logger.warn(
		// 		`[AUTH] Пользователь ${chatId} (${msg.from?.username}) попытался получить несанкционированный доступ.`,
		// 	);
		// 	return;
		// }
		
		// const access = await hasAccess(chatId, msg.from?.username);
		//
		// if (access === 'none' || access === 'registered') {
		// 	// гость или ещё не нажал /start
		// 	await bot.sendMessage(chatId,
		// 		access === 'registered'
		// 			? 'Пожалуйста, нажмите /start для активации.'
		// 			: 'У вас нет доступа. При получении доступа повторно нажмите /start',
		// 		GUEST_KEYBOARD
		// 	);
		// 	return;
		// }
		
		// --- Обработка ожидаемых действий (добавление региона, ожидание пересылки) ---
		if (userAction.has(chatId)) {
			// Если бот ждет ввода данных, но пользователь нажал кнопку - отменяем ожидание
			if (COMMAND_BUTTONS.has(text) || text === '/start') {
				userAction.delete(chatId);
				logger.debug(`Действие для пользователя ${chatId} отменено из-за нажатия кнопки.`);
			} else {
				// Если это не команда, а ввод данных - обрабатываем
				const action = userAction.get(chatId);
				userAction.delete(chatId);
				
				if (action === 'add_region' && text) {
					await handleAddRegion(chatId, text);
				} else if (action === 'awaiting_username' && text) {
					await handleAddUsername(msg);
				}
				return; // Завершаем, чтобы не попасть в switch-case ниже
			}
		}
		
		if (!text) return; // Если текста нет и действий не ожидается - выходим
		
		// --- Обработка команд с кнопок ---
		switch (text) {
			case '/start':
				// --- ИЗМЕНЕНИЕ ЗДЕСЬ: Логика "активации" пользователя ---
				const userInDb = await User.findOne({
					where: { username: msg.from?.username },
				});
				if (userInDb && !userInDb.userId && msg.from?.id) {
					userInDb.userId = msg.from.id;
					await userInDb.save();
				}
				
				const welcomeMessage = isAdmin(chatId)
					? 'Добро пожаловать, администратор! Вам доступны расширенные функции.'
					: 'Добро пожаловать! Используйте кнопки для управления регионами.';
				const keyboard = isAdmin(chatId) ? ADMIN_KEYBOARD : USER_KEYBOARD;
				await safeSendMessage(chatId, welcomeMessage, keyboard);
				break;
			// Общие команды
			case '➕ Добавить регион':
				userAction.set(chatId, 'add_region');
				await safeSendMessage(
					chatId,
					'Введите код региона для добавления (например, 78 - Санкт-Петербург).',
				);
				break;
			case '➖ Удалить регион':
				await showRegionsForDeletion(chatId);
				break;
			case 'Мои регионы':
				await showMyRegions(chatId);
				break;
			
			// Команды только для администратора
			case '➕ Добавить пользователя':
				if (isAdmin(chatId)) {
					// Меняем состояние и текст сообщения
					userAction.set(chatId, 'awaiting_username');
					await safeSendMessage(
						chatId,
						'Введите username пользователя (например, @username), которого вы хотите добавить.',
					);
				}
				break;
			case '👥 Список пользователей':
				if (isAdmin(chatId)) {
					await showUsersForDeletion(chatId);
				}
				break;
		}
	} catch (error) {
		logger.error(`[BOT_MESSAGE_HANDLER] Произошла критическая ошибка:`, error);
		if (msg && msg.chat) {
			await safeSendMessage(
				msg.chat.id,
				'Произошла внутренняя ошибка. Пожалуйста, попробуйте позже.',
			);
		}
	}
});

// =============================================================================
// НОВЫЙ БЛОК: ЛОГИКА АДМИНИСТРИРОВАНИЯ
// =============================================================================

async function handleAddUsername(msg: TelegramBot.Message) {
	const adminId = msg.chat.id;
	let username = (msg.text || '').trim();
	
	// Убираем символ '@', если он есть
	if (username.startsWith('@')) {
		username = username.substring(1);
	}
	
	if (!username) {
		await safeSendMessage(adminId, 'Вы ввели пустое имя. Попробуйте снова.');
		userAction.set(adminId, 'awaiting_username');
		return;
	}
	
	try {
		const [user, created] = await User.findOrCreate({
			where: { username: username },
			// ID пока не знаем, так и должно быть
			defaults: { username: username, userId: null },
		});
		
		if (created) {
			logger.info(
				`[ADMIN] Администратор ${adminId} добавил нового пользователя @${username} в список ожидания.`,
			);
			await safeSendMessage(
				adminId,
				`✅ Пользователь @${username} добавлен в белый список.\n\n` +
				`❗️Теперь этот пользователь должен сам найти бот и нажать /start, чтобы активировать доступ.`,
			);
		} else {
			await safeSendMessage(
				adminId,
				`Пользователь @${username} уже был в списке.`,
			);
		}
	} catch (error) {
		logger.error(
			`[ADMIN] Ошибка при добавлении пользователя @${username}:`,
			error,
		);
		await safeSendMessage(
			adminId,
			'Произошла ошибка при добавлении пользователя в базу данных.',
		);
	}
}

async function showUsersForDeletion(adminId: number) {
	if (!isAdmin(adminId)) return;
	
	const users = await User.findAll();
	if (users.length === 0) {
		await safeSendMessage(adminId, 'В списке нет ни одного пользователя.');
		return;
	}
	
	const inlineKeyboard = users.map((user) => {
		const userIdText = user.userId ? `(${user.userId})` : '(ожидает активации)';
		return [{
			text: `❌ @${user.username} ${userIdText}`,
			callback_data: `delete_user:${user.id}`,
		}]
	});
	
	await safeSendMessage(
		adminId,
		'Нажмите на пользователя, чтобы удалить его из списка доступа:',
		{
			reply_markup: { inline_keyboard: inlineKeyboard },
		}
	);
}

// =============================================================================
// ОБРАБОТЧИК CALLBACK-ЗАПРОСОВ (КНОПОК)
// =============================================================================

bot.on('callback_query', async (callbackQuery) => {
	try {
		const message = callbackQuery.message;
		if (!message) return;
		const chatId = message.chat.id;
		const data = callbackQuery.data;
		
		// --- И снова гейткипер ---
		if (!(await hasAccess(chatId))) {
			await bot.answerCallbackQuery(callbackQuery.id, {
				text: 'У вас нет доступа.',
			});
			return;
		}
		
		// Удаление региона (старая логика)
		if (data?.startsWith('delete_region:')) {
			await handleDeleteRegion(
				chatId,
				callbackQuery.id,
				message.message_id,
				data,
			);
		}
		
		// НОВЫЙ ОБРАБОТЧИК: Удаление пользователя
		else if (data?.startsWith('delete_user:')) {
			if (!isAdmin(chatId)) {
				await bot.answerCallbackQuery(callbackQuery.id, {
					text: 'Это действие доступно только администратору.',
				});
				return;
			}
			await handleDeleteUser(
				chatId,
				callbackQuery.id,
				message.message_id,
				data,
			);
		}
	} catch (error) {
		logger.error(`[BOT_CALLBACK_HANDLER] Произошла критическая ошибка:`, error);
		if (callbackQuery.message) {
			await safeSendMessage(
				callbackQuery.message.chat.id,
				'Не удалось обработать ваше действие. Попробуйте еще раз.',
			);
		}
	}
});

// --- Хелперы ---

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

// --- Логика добавления региона ---
async function handleAddRegion(chatId: number, regionCode: string) {
	const regionName = REGIONS[regionCode];
	if (!regionName) {
		await safeSendMessage(chatId, 'Код региона не найден. Попробуйте снова');
		return;
	}
	
	const regionValue = `${regionName} - ${regionCode}`;
	const config = await getUserConfig(chatId);
	
	if (config.regions.includes(regionValue)) {
		await safeSendMessage(
			chatId,
			`Регион "${regionName}" уже есть в вашем списке.`,
		);
		return;
	}
	
	config.regions.push(regionValue);
	await saveUserConfig(chatId, config);
	
	// --- ИЗМЕНЕНИЕ ЗДЕСЬ ---
	// Определяем, какую клавиатуру показать пользователю
	const keyboard = isAdmin(chatId) ? ADMIN_KEYBOARD : USER_KEYBOARD;
	await safeSendMessage(
		chatId,
		`✅ Регион "${regionName}" успешно добавлен!`,
		keyboard,
	);
	// --- КОНЕЦ ИЗМЕНЕНИЯ ---
	
	// --- Блок немедленного парсинга остается без изменений ---
	await safeSendMessage(
		chatId,
		'🚀 Запускаю первоначальный поиск по новому региону. Это может занять минуту...',
	);
	await triggerImmediateParse(regionValue, chatId);
}

// --- Логика удаления региона ---
async function showRegionsForDeletion(chatId: number) {
	const config = await getUserConfig(chatId);
	if (config.regions.length === 0) {
		// --- ИЗМЕНЕНИЕ ЗДЕСЬ ---
		// Точно так же определяем правильную клавиатуру
		const keyboard = isAdmin(chatId) ? ADMIN_KEYBOARD : USER_KEYBOARD;
		await safeSendMessage(
			chatId,
			'Нечего удалять. У вас нет добавленных регионов.',
			keyboard,
		);
		// --- КОНЕЦ ИЗМЕНЕНИЯ ---
		return;
	}
	
	const inlineKeyboard = config.regions.map((region) => [
		{
			text: `❌ ${region}`,
			callback_data: `delete_region:${region}`,
		},
	]);
	
	await safeSendMessage(chatId, 'Нажмите на регион, чтобы его удалить:', {
		reply_markup: {
			inline_keyboard: inlineKeyboard,
		},
	});
}

async function showMyRegions(chatId: number) {
	const currentConfig = await getUserConfig(chatId);
	if (currentConfig.regions.length === 0) {
		await safeSendMessage(chatId, 'У вас пока нет добавленных регионов.');
	} else {
		await safeSendMessage(
			chatId,
			`Ваши регионы:\n- ${currentConfig.regions.join('\n- ')}`,
		);
	}
}

async function handleDeleteRegion(
	chatId: number,
	callbackQueryId: string,
	messageId: number,
	data: string,
) {
	const regionToDelete = data.substring('delete_region:'.length);
	const config = await getUserConfig(chatId);
	
	config.regions = config.regions.filter((r) => r !== regionToDelete);
	await saveUserConfig(chatId, config);
	
	await bot.answerCallbackQuery(callbackQueryId, {
		text: `Регион "${regionToDelete}" удален.`,
	});
	
	// Обновляем клавиатуру, чтобы она не "зависала"
	const currentConfig = await getUserConfig(chatId);
	const inlineKeyboard = currentConfig.regions.map((region) => [
		{
			text: `❌ ${region}`,
			callback_data: `delete_region:${region}`,
		},
	]);
	
	if (inlineKeyboard.length > 0) {
		await bot.editMessageText('Выберите регион для удаления:', {
			chat_id: chatId,
			message_id: messageId,
			reply_markup: {
				inline_keyboard: inlineKeyboard,
			},
		});
	} else {
		await bot.editMessageText('Все регионы удалены.', {
			chat_id: chatId,
			message_id: messageId,
		});
	}
}

async function handleDeleteUser(
	adminId: number,
	callbackQueryId: string,
	messageId: number,
	data: string
) {
	// --- ИСПРАВЛЕНИЕ 1: Получаем ID из базы, а не Telegram ID ---
	// Этот ID - это первичный ключ из таблицы `users` (например, 1, 2, 3...), а не огромный Telegram ID.
	const userDbIdToDelete = parseInt(data.substring('delete_user:'.length), 10);
	
	// --- ИСПРАВЛЕНИЕ 2: Проверка на NaN ---
	// Если по какой-то причине ID не распарсился, выходим, чтобы не было ошибки в SQL.
	if (isNaN(userDbIdToDelete)) {
		logger.error(`Получен невалидный ID для удаления из callback_data: ${data}`);
		await bot.answerCallbackQuery(callbackQueryId, { text: 'Ошибка: неверный ID пользователя.' });
		return;
	}
	
	// Находим пользователя в базе по его уникальному ID, чтобы получить его данные перед удалением
	const userToDelete = await User.findByPk(userDbIdToDelete);
	
	if (!userToDelete) {
		await bot.answerCallbackQuery(callbackQueryId, { text: 'Этот пользователь уже был удален.' });
		// Обновляем сообщение, чтобы убрать кнопки
		await bot.editMessageText('Пользователь уже был удален.', {
			chat_id: adminId,
			message_id: messageId,
		});
		return;
	}
	
	// --- ИСПРАВЛЕНИЕ 3: Удаляем по правильному полю `id` ---
	const deletedCount = await User.destroy({
		where: { id: userDbIdToDelete },
	});
	
	if (deletedCount > 0) {
		logger.info(
			`Администратор ${adminId} удалил пользователя @${userToDelete.username} (DB ID: ${userDbIdToDelete}).`
		);
		await bot.answerCallbackQuery(callbackQueryId, {
			text: `Пользователь @${userToDelete.username} удален.`,
		});
		
		// Уведомляем пользователя об удалении, только если у него есть активный Telegram ID
		if (userToDelete.userId) {
			const success = await safeSendMessage(
				userToDelete.userId,
				'Ваш доступ к боту был отозван администратором.'
			);
			if (!success) {
				logger.warn(
					`Не удалось уведомить пользователя ${userToDelete.userId} об удалении (возможно, бот заблокирован).`
				);
			}
		}
	}
	
	// --- ИСПРАВЛЕНИЕ 4: Корректно обновляем список пользователей ---
	const remainingUsers = await User.findAll();
	if (remainingUsers.length > 0) {
		const newKeyboard = remainingUsers.map((user) => {
			const userIdText = user.userId ? `(${user.userId})` : '(ожидает активации)';
			return [{
				text: `❌ @${user.username} ${userIdText}`,
				callback_data: `delete_user:${user.id}`, // Снова используем ID из базы
			}];
		});
		await bot.editMessageText(
			'Пользователь удален. Выберите следующего для удаления:',
			{
				chat_id: adminId,
				message_id: messageId,
				reply_markup: { inline_keyboard: newKeyboard },
			}
		);
	} else {
		// Если это был последний пользователь
		await bot.editMessageText('Все пользователи были удалены. Список пуст.', {
			chat_id: adminId,
			message_id: messageId,
		});
	}
}
