import dotenv from 'dotenv';
import { z } from 'zod';
import { logger } from './logger';
dotenv.config();

// Создаем схему для валидации переменных окружения
const configSchema = z.object({
	// База данных
	DB_HOST: z.string().default('localhost'),
	DB_NAME: z.string().default('parsing_bot'),
	DB_USER: z.string().default('root'),
	DB_PASSWORD: z.string().default(''),
	// Токен бота
	BOT_TOKEN: z.string().min(1, { message: 'BOT_TOKEN не может быть пустым' }),
	
	ADMIN_TELEGRAM_IDS: z
		.string()
		.min(1, { message: 'ADMIN_TELEGRAM_IDS не может быть пустым' })
		.transform((val) => val.split(',').map(s => s.trim())) // Превращаем строку в массив
		.pipe(z.coerce.number().array().min(1)), // Убеждаемся, что это массив чисел
	
	// Порт сервера
	PORT: z.coerce.number().default(3000),
	// Ключи для внешних API (опционально, но лучше указать)
	OPENAI_API_KEY: z.string().optional(),
});

const parseResult = configSchema.safeParse(process.env);

// Если валидация провалилась, логируем ошибку и завершаем процесс
if (!parseResult.success) {
	logger.error('❌ Ошибки валидации в .env файле:', parseResult.error.flatten().fieldErrors);
	process.exit(1); // Завершаем работу с кодом ошибки
}

// Экспортируем провалидированную и типизированную конфигурацию
export const config = parseResult.data;
