import OpenAI from 'openai';
import { IEgrzRecord } from '../types/egrz.types';
import moment from 'moment';
import { logger } from '../logger';

// Получаем ключ из переменных окружения
const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
	logger.warn('ВНИМАНИЕ: API-ключ для OpenAI не найден в .env файле. AI-обработка будет отключена.');
}

// Создаем клиент OpenAI
const client = new OpenAI({
	apiKey: apiKey,
});

// Конфигурация для retry логики
const AI_CONFIG = {
	MAX_RETRIES: 3,
	RETRY_DELAY: 2000, // 2 секунды
	REQUEST_TIMEOUT: 60000, // 60 секунд
};

/**
 * Обрабатывает данные о лиде с помощью AI для создания привлекательного сообщения.
 * @param leadData - Объект с данными из ЕГРЗ.
 * @param region - Название региона.
 * @returns - Строка с отформатированным сообщением.
 */
export async function processLeadWithAI(leadData: IEgrzRecord, region: string): Promise<string> {
	logger.info(`[AI] Запуск обработки AI для записи "${leadData['Номер заключения экспертизы']}"`);
	
	const formattedDate = moment(leadData['Дата заключения экспертизы'], 'DD.MM.YYYY').format('DD.MM.YYYY');
	
	// Резервный текст на случай сбоя AI
	const fallbackText = `Новый лид за ${formattedDate} (регион: ${region})
Номер заключения: ${leadData['Номер заключения экспертизы']}
Застройщик: ${leadData['Сведения о застройщике, обеспечившем подготовку проектной документации']}`;
	
	if (!apiKey) {
		logger.debug('[AI] API ключ отсутствует, возвращаем fallback текст');
		return fallbackText;
	}
	
	// Валидация входных данных
	if (!leadData['Номер заключения экспертизы']?.trim()) {
		logger.warn('[AI] Отсутствует номер заключения экспертизы');
		return fallbackText;
	}
	
	// Попытка обработки с retry логикой
	for (let attempt = 1; attempt <= AI_CONFIG.MAX_RETRIES; attempt++) {
		try {
			logger.debug(`[AI] Попытка ${attempt}/${AI_CONFIG.MAX_RETRIES} обращения к OpenAI API`);
			
			const result = await callOpenAIWithTimeout(leadData, region, formattedDate);
			
			if (result && validateAIResponse(result)) {
				logger.info(`[AI] Успешно получен и валидирован ответ от AI (попытка ${attempt})`);
				return result;
			} else {
				logger.warn(`[AI] Получен невалидный ответ от AI (попытка ${attempt})`);
				if (attempt === AI_CONFIG.MAX_RETRIES) {
					logger.error('[AI] Все попытки исчерпаны, возвращаем fallback');
					return fallbackText;
				}
			}
			
		} catch (error: any) {
			const isLastAttempt = attempt === AI_CONFIG.MAX_RETRIES;
			
			// Анализируем тип ошибки
			if (error.code === 'insufficient_quota') {
				logger.error('[AI] КРИТИЧЕСКАЯ ОШИБКА: Превышена квота OpenAI API');
				return fallbackText;
			}
			
			if (error.code === 'rate_limit_exceeded') {
				logger.warn(`[AI] Rate limit превышен (попытка ${attempt})`);
				if (!isLastAttempt) {
					await sleep(AI_CONFIG.RETRY_DELAY * attempt); // Увеличиваем задержку
					continue;
				}
			}
			
			if (error.name === 'AbortError' || error.code === 'ECONNABORTED') {
				logger.warn(`[AI] Таймаут запроса к OpenAI (попытка ${attempt})`);
				if (!isLastAttempt) {
					await sleep(AI_CONFIG.RETRY_DELAY);
					continue;
				}
			}
			
			// Логируем ошибку и решаем, стоит ли повторять попытку
			logger.error(`[AI] Ошибка при обращении к OpenAI (попытка ${attempt}):`, {
				message: error.message,
				code: error.code,
				type: error.type,
				status: error.status,
			});
			
			if (isLastAttempt) {
				logger.error('[AI] Все попытки обращения к OpenAI исчерпаны, возвращаем fallback');
				return fallbackText;
			}
			
			// Пауза перед повторной попыткой
			await sleep(AI_CONFIG.RETRY_DELAY);
		}
	}
	
	return fallbackText;
}

/**
 * Выполняет запрос к OpenAI с таймаутом
 */
async function callOpenAIWithTimeout(leadData: IEgrzRecord, region: string, formattedDate: string): Promise<string> {
	const prompt = generatePrompt(leadData, region, formattedDate);
	
	// Создаем промис с таймаутом
	const timeoutPromise = new Promise<never>((_, reject) => {
		setTimeout(() => reject(new Error('OpenAI request timeout')), AI_CONFIG.REQUEST_TIMEOUT);
	});
	
	const apiPromise = client.chat.completions.create({
		model: 'gpt-4o-mini',
		messages: [{ role: 'system', content: prompt }],
		temperature: 0.1,
		max_tokens: 1500, // Ограничиваем длину ответа
	});
	
	const response = await Promise.race([apiPromise, timeoutPromise]);
	
	return response.choices[0]?.message?.content?.trim() || '';
}

/**
 * Генерирует промпт для OpenAI
 */
function generatePrompt(leadData: IEgrzRecord, region: string, formattedDate: string): string {
	return `
Твоя роль — AI-ассистент, который извлекает, сокращает и форматирует информацию для создания структурированного отчета.
Твоя главная задача — вернуть ПОЛНОСТЬЮ готовый отчет в указанном формате, строго следуя правилам.

**ПРАВИЛА ФОРМАТИРОВАНИЯ ДАННЫХ:**
1.  **"Кто подготовил документацию" и "Сведения о застройщике":**
    * Извлеки и оставь только: сокращенную форму (ООО, АО и т.д.), название в кавычках и ИНН. **Всегда оставляй ИНН.**
    * **Убирай ОГРН**, если есть ИНН.
    * **Для ИП:** Оставляй ФИО и ОГРНИП.
    * Сокращай адрес (убирай "Россия", "МЕСТО НАХОЖДЕНИЯ", лишние детали).
    * **Пример:** 'ООО "Название" (ИНН: 1234567890, Москва, ул. Ленина, д. 1)'
    * **Пример для ИП:** 'ИП Иванов И.И. (ОГРНИП: 321098765432101, Вологда, ул. Мира, д. 1)'

2.  **"Наименование и адрес объекта":**
    * Убери всю информацию после слов "Почтовый адрес:". Оставь только описание объекта.

---
**Верни ТОЛЬКО итоговый отчет и ничего больше.**

**ФОРМАТ ИТОГОВОГО ОТЧЕТА:**
Новый лид за ${formattedDate} (регион: ${region.split(' - ')[0]})

Номер заключения экспертизы: ${leadData['Номер заключения экспертизы']}
Результат: ${leadData['Результат проведенной экспертизы (положительное или отрицательное заключение экспертизы)']}

🏙️ Кто подготовил документацию:
отформатированные данные из ${leadData['Сведения об индивидуальных предпринимателях и (или) юридических лицах, подготовивших проектную документацию']}

🏠 Сведения о застройщике:
отформатированные данные из ${leadData['Сведения о застройщике, обеспечившем подготовку проектной документации']}

🏭 Наименование и адрес объекта:
отформатированные данные из ${leadData['Наименование и адрес (местоположение) объекта капитального строительства, применительно к которому подготовлена проектная документация']}
`;
}

/**
 * Валидирует ответ от AI
 */
function validateAIResponse(response: string): boolean {
	if (!response || response.length < 50) {
		logger.warn('[AI] Ответ слишком короткий');
		return false;
	}
	
	// Проверяем наличие ключевых элементов
	const requiredElements = [
		'Номер заключения экспертизы:',
		'🏙️',
		'🏠',
		'🏭',
	];
	
	for (const element of requiredElements) {
		if (!response.includes(element)) {
			logger.warn(`[AI] Ответ не содержит обязательный элемент: ${element}`);
			return false;
		}
	}
	
	// Проверяем, что ответ не содержит технические фразы от AI
	const invalidPhrases = [
		'я не могу',
		'извините',
		'не удалось',
		'ошибка',
		'как AI',
		'как искусственный интеллект',
	];
	
	const lowerResponse = response.toLowerCase();
	for (const phrase of invalidPhrases) {
		if (lowerResponse.includes(phrase)) {
			logger.warn(`[AI] Ответ содержит нежелательную фразу: ${phrase}`);
			return false;
		}
	}
	
	return true;
}

/**
 * Вспомогательная функция для паузы
 */
function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}