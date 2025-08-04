import { Sequelize } from 'sequelize';
import { config } from '../config';
import { logger } from '../logger';

// Конфигурация пула соединений для продакшена
const sequelizeConfig = {
	host: config.DB_HOST,
	dialect: 'mysql' as const,
	// Отключаем логирование SQL запросов в продакшене
	logging: process.env.NODE_ENV === 'production' ? false : (msg: string) => logger.debug(msg),
	
	// Настройки пула соединений для оптимальной производительности
	pool: {
		max: 20, // Максимальное количество соединений в пуле
		min: 5,  // Минимальное количество соединений
		acquire: 30000, // Максимальное время ожидания соединения (30 сек)
		idle: 10000,    // Время бездействия перед закрытием соединения (10 сек)
	},
	
	// Настройки для продакшена
	define: {
		timestamps: true,
		underscored: false,
		freezeTableName: true, // Не изменять названия таблиц
	},
	
	// Настройки retry для надежности
	retry: {
		max: 3,
		match: [
			/ECONNRESET/,
			/ETIMEDOUT/,
			/ENOTFOUND/,
			/ER_LOCK_WAIT_TIMEOUT/,
			/ER_LOCK_DEADLOCK/,
		],
	},
	
	// Таймауты
	dialectOptions: {
		connectTimeout: 60000, // 60 секунд на подключение
		acquireTimeout: 60000, // 60 секунд на получение соединения
		timeout: 60000,        // 60 секунд на выполнение запроса
	},
};

export const sequelize = new Sequelize(
	config.DB_NAME,
	config.DB_USER,
	config.DB_PASSWORD,
	sequelizeConfig
);

// Обработчики событий для мониторинга состояния БД
if (process.env.NODE_ENV === 'production') {
	sequelize.addHook('beforeConnect', () => {
		logger.debug('Попытка подключения к базе данных');
	});
	
	sequelize.addHook('afterConnect', () => {
		logger.debug('Успешное подключение к базе данных');
	});
	
	sequelize.addHook('beforeDisconnect', () => {
		logger.info('Отключение от базы данных');
	});
}

// Функция для проверки подключения к БД с retry логикой
export async function testDatabaseConnection(maxRetries: number = 5): Promise<boolean> {
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			await sequelize.authenticate();
			logger.info(`Успешное подключение к базе данных (попытка ${attempt})`);
			return true;
		} catch (error) {
			logger.error(`Ошибка подключения к БД (попытка ${attempt}/${maxRetries}):`, error);
			
			if (attempt === maxRetries) {
				logger.error('Все попытки подключения к БД исчерпаны');
				return false;
			}
			
			// Ждем перед повторной попыткой (экспоненциальная задержка)
			const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
			logger.info(`Повторная попытка через ${delay}мс...`);
			await new Promise(resolve => setTimeout(resolve, delay));
		}
	}
	
	return false;
}

// Функция для graceful shutdown
export async function closeDatabaseConnection(): Promise<void> {
	try {
		await sequelize.close();
		logger.info('Соединение с базой данных закрыто');
	} catch (error) {
		logger.error('Ошибка при закрытии соединения с БД:', error);
	}
}