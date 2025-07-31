import { sequelize } from './database';
import { PORT } from './config';
import { app } from './app';
import './bot';
import './scheduler';

(async () => {
	try {
		// Подключаемся к БД
		await sequelize.authenticate();
		console.log('Подключено к БД');

		// Если используем Express
		app.listen(PORT || 5000, () => {
			console.log(`Сервер запущен на порту ${PORT}`);
		});
	} catch (error) {
		console.error('Ошибка при подключении к БД:', error);
	}
})();
