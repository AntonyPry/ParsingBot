import winston from 'winston';

// Определяем уровни логирования и цвета для них
const levels = {
	error: 0,
	warn: 1,
	info: 2,
	http: 3,
	debug: 4,
};

const colors = {
	error: 'red',
	warn: 'yellow',
	info: 'green',
	http: 'magenta',
	debug: 'white',
};

winston.addColors(colors);

// Определяем уровень логирования в зависимости от окружения
const logLevel = process.env.NODE_ENV === 'production' ? 'info' : 'debug';

// Формат для вывода в консоль
const consoleFormat = winston.format.combine(
	winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
	winston.format.colorize({ all: true }),
	winston.format.printf(
		(info) => `[${info.timestamp}] ${info.level}: ${info.message}`
	)
);

// Формат для записи в файл (более подробный для продакшена)
const fileFormat = winston.format.combine(
	winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
	winston.format.errors({ stack: true }), // Включаем stack trace для ошибок
	winston.format.json()
);

// Определяем "транспорты" - куда будут выводиться логи
const transports: winston.transport[] = [
	// Всегда выводим в консоль
	new winston.transports.Console({
		format: consoleFormat,
		level: logLevel
	}),
	// Записываем все логи уровня 'info' и ниже в combined.log
	new winston.transports.File({
		filename: 'logs/combined.log',
		format: fileFormat,
		level: 'info',
		maxsize: 10 * 1024 * 1024, // 10MB
		maxFiles: 5, // Храним 5 файлов
	}),
	// Записываем все логи уровня 'error' и ниже в errors.log
	new winston.transports.File({
		filename: 'logs/errors.log',
		level: 'error',
		format: fileFormat,
		maxsize: 10 * 1024 * 1024, // 10MB
		maxFiles: 5, // Храним 5 файлов
	}),
];

// В продакшене добавляем отдельный файл для системных операций
if (process.env.NODE_ENV === 'production') {
	transports.push(
		new winston.transports.File({
			filename: 'logs/scheduler.log',
			format: fileFormat,
			level: 'info',
			maxsize: 50 * 1024 * 1024, // 50MB для планировщика
			maxFiles: 10,
		})
	);
}

// Создаем и экспортируем экземпляр логгера
export const logger = winston.createLogger({
	level: logLevel,
	levels,
	transports,
	// Отключаем обработку uncaught exceptions в продакшене для лучшего контроля
	exitOnError: process.env.NODE_ENV !== 'production',
});

// Добавляем обработчики для необработанных исключений и промисов
if (process.env.NODE_ENV === 'production') {
	// Логируем необработанные исключения
	process.on('uncaughtException', (error) => {
		logger.error('Uncaught Exception:', error);
		// Даем время записать лог, затем завершаем процесс
		setTimeout(() => process.exit(1), 1000);
	});
	
	// Логируем необработанные отклоненные промисы
	process.on('unhandledRejection', (reason, promise) => {
		logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
	});
}

// Утилитарные функции для специализированного логирования
export const schedulerLogger = {
	info: (message: string, meta?: any) => logger.info(`[SCHEDULER] ${message}`, meta),
	warn: (message: string, meta?: any) => logger.warn(`[SCHEDULER] ${message}`, meta),
	error: (message: string, error?: any) => logger.error(`[SCHEDULER] ${message}`, error),
	debug: (message: string, meta?: any) => logger.debug(`[SCHEDULER] ${message}`, meta),
};

export const botLogger = {
	info: (message: string, meta?: any) => logger.info(`[BOT] ${message}`, meta),
	warn: (message: string, meta?: any) => logger.warn(`[BOT] ${message}`, meta),
	error: (message: string, error?: any) => logger.error(`[BOT] ${message}`, error),
	debug: (message: string, meta?: any) => logger.debug(`[BOT] ${message}`, meta),
};

export const aiLogger = {
	info: (message: string, meta?: any) => logger.info(`[AI] ${message}`, meta),
	warn: (message: string, meta?: any) => logger.warn(`[AI] ${message}`, meta),
	error: (message: string, error?: any) => logger.error(`[AI] ${message}`, error),
	debug: (message: string, meta?: any) => logger.debug(`[AI] ${message}`, meta),
};