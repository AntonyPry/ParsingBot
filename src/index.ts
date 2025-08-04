import { sequelize } from './database';
import { config } from './config';
import { app } from './app';
import './bot';
import './scheduler';
import { logger } from './logger';

(async () => {
	try {
		// Подключаемся к БД
		await sequelize.authenticate();
		logger.info('Подключено к БД');

		app.listen(config.PORT || 5000, () => {
			logger.info(`Сервер запущен на порту ${config.PORT}`);
		});
	} catch (error) {
		logger.error('Ошибка при подключении к БД:', error);
	}
})();
