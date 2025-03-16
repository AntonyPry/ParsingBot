import dotenv from 'dotenv';
dotenv.config();

export const DB_HOST = process.env.DB_HOST || 'localhost';
export const DB_NAME = process.env.DB_NAME || 'parsing_bot';
export const DB_USER = process.env.DB_USER || 'root';
export const DB_PASSWORD = process.env.DB_PASSWORD || '';
export const BOT_TOKEN = process.env.BOT_TOKEN || '';
export const PORT = process.env.PORT || 3000;