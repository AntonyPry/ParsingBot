import express from 'express';
import { sequelize } from './database';
import { checkBotHealth } from './bot';
import { logger } from './logger';

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
	res.send('Сервер работает');
});

// Health check endpoint
app.get('/health', async (req, res) => {
	try {
		const checks = {
			timestamp: new Date().toISOString(),
			database: 'unknown',
			bot: 'unknown',
			uptime: process.uptime()
		};

		// Проверка базы данных
		try {
			await sequelize.authenticate();
			checks.database = 'connected';
		} catch (dbError) {
			checks.database = 'disconnected';
			logger.error('[HEALTH] Database check failed:', dbError);
		}

		// Проверка бота
		try {
			const botHealthy = await checkBotHealth();
			checks.bot = botHealthy ? 'healthy' : 'unhealthy';
		} catch (botError) {
			checks.bot = 'error';
			logger.error('[HEALTH] Bot check failed:', botError);
		}

		// Определяем общий статус
		const isHealthy = checks.database === 'connected' && checks.bot === 'healthy';
		const statusCode = isHealthy ? 200 : 503;

		res.status(statusCode).json({
			status: isHealthy ? 'ok' : 'degraded',
			...checks
		});

	} catch (error) {
		logger.error('[HEALTH] Health check error:', error);
		res.status(500).json({
			status: 'error',
			timestamp: new Date().toISOString(),
			error: 'Internal server error'
		});
	}
});

export { app };