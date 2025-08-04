import axios from 'axios';
import * as crypto from 'crypto';
import { parse } from 'csv-parse/sync';
import https from 'https';
import cron from 'node-cron';
import { bot } from './bot';
import { Configuration } from './database/models/Configuration';
import { ParsedData } from './database/models/ParsedData';
import { IEgrzRecord } from './types/egrz.types';
import { IUserConfig } from './types/config.types';
import { processLeadWithAI } from './services/aiService';
import { ProcessedLead } from './database/models/ProcessedLead';
import { logger } from './logger';
import { Op } from 'sequelize';

// =================================================================================
// ВАЖНО: Настройка для совместимости со старым API egrz.ru
// =================================================================================
const httpsAgent = new https.Agent({
	secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
});

// =================================================================================
// КОНФИГУРАЦИЯ И КОНСТАНТЫ
// =================================================================================
const SCHEDULER_CONFIG = {
	// Максимальное время выполнения одной задачи (30 минут)
	MAX_EXECUTION_TIME: 30 * 60 * 1000,
	// Таймаут для HTTP запросов (30 секунд)
	HTTP_TIMEOUT: 30 * 1000,
	// Максимальное количество записей с API за раз
	MAX_RECORDS_PER_REQUEST: 100,
	// Максимальное количество повторных попыток
	MAX_RETRIES: 3,
	// Задержка между повторными попытками (мс)
	RETRY_DELAY: 5000,
};

// =================================================================================
// ИНТЕРФЕЙСЫ ДЛЯ ТИПИЗАЦИИ
// =================================================================================
interface RegionUserMap {
	region: string;
	userIds: number[];
}

interface ProcessingResult {
	region: string;
	totalRecords: number;
	processedRecords: number;
	skippedRecords: number;
	errorRecords: number;
}

// =================================================================================
// ОСНОВНОЙ ПЛАНИРОВЩИК С ЗАЩИТОЙ ОТ БЛОКИРОВОК
// =================================================================================
let isTaskRunning = false;
let taskStartTime: number = 0;

cron.schedule('*/15 * * * *', async () => {
	// Проверка блокировки
	if (isTaskRunning) {
		const currentTime = Date.now();
		const executionTime = currentTime - taskStartTime;
		
		if (executionTime > SCHEDULER_CONFIG.MAX_EXECUTION_TIME) {
			logger.error(`[SCHEDULER] КРИТИЧЕСКАЯ ОШИБКА: Задача выполняется более ${SCHEDULER_CONFIG.MAX_EXECUTION_TIME / 60000} минут. Принудительная разблокировка.`);
			isTaskRunning = false;
		} else {
			logger.warn(`[SCHEDULER] Пропуск запуска: предыдущая задача выполняется уже ${Math.round(executionTime / 1000)} секунд.`);
			return;
		}
	}
	
	logger.info('[SCHEDULER] ==================== ЗАПУСК ЗАДАЧИ ПАРСИНГА ====================');
	isTaskRunning = true;
	taskStartTime = Date.now();
	
	try {
		await executeMainTask();
	} catch (error) {
		logger.error('[SCHEDULER] КРИТИЧЕСКАЯ ОШИБКА в глобальной задаче парсинга:', error);
	} finally {
		const executionTime = Date.now() - taskStartTime;
		logger.info(`[SCHEDULER] ==================== ЗАДАЧА ЗАВЕРШЕНА (${Math.round(executionTime / 1000)}с) ====================`);
		isTaskRunning = false;
	}
});

// =================================================================================
// ОСНОВНАЯ ЛОГИКА ВЫПОЛНЕНИЯ ЗАДАЧИ
// =================================================================================
async function executeMainTask(): Promise<void> {
	// Шаг 1: Сбор конфигураций и подготовка данных
	const regionUserMaps = await collectRegionUserMaps();
	if (regionUserMaps.length === 0) {
		logger.info('[SCHEDULER] Нет активных подписок на регионы. Задача завершена.');
		return;
	}
	
	logger.info(`[SCHEDULER] Найдено уникальных регионов для обработки: ${regionUserMaps.length}`);
	
	// Шаг 2: Получение текущей даты для фильтрации
	const todayMsk = getTodayMoscowDate();
	logger.info(`[SCHEDULER] Дата для поиска: ${todayMsk}`);
	
	// Шаг 3: Обработка каждого региона
	const results: ProcessingResult[] = [];
	
	for (const regionMap of regionUserMaps) {
		try {
			const result = await processRegion(regionMap, todayMsk);
			results.push(result);
			
			// Небольшая пауза между регионами для снижения нагрузки
			await sleep(1000);
		} catch (error) {
			logger.error(`[SCHEDULER] Ошибка обработки региона "${regionMap.region}":`, error);
			results.push({
				region: regionMap.region,
				totalRecords: 0,
				processedRecords: 0,
				skippedRecords: 0,
				errorRecords: 1,
			});
		}
	}
	
	// Шаг 4: Итоговая статистика
	logFinalStatistics(results);
}

// =================================================================================
// СБОР КОНФИГУРАЦИЙ И ГРУППИРОВКА ПО РЕГИОНАМ
// =================================================================================
async function collectRegionUserMaps(): Promise<RegionUserMap[]> {
	logger.info('[SCHEDULER] Шаг 1/5: Сбор конфигураций пользователей...');
	
	try {
		const allConfigs = await Configuration.findAll({
			attributes: ['userId', 'configData'],
		});
		
		const regionToUsersMap = new Map<string, Set<number>>();
		let validConfigs = 0;
		
		for (const config of allConfigs) {
			try {
				const userConfig: IUserConfig = JSON.parse(config.dataValues.configData);
				
				if (userConfig.regions && Array.isArray(userConfig.regions) && userConfig.regions.length > 0) {
					validConfigs++;
					for (const region of userConfig.regions) {
						if (!regionToUsersMap.has(region)) {
							regionToUsersMap.set(region, new Set());
						}
						regionToUsersMap.get(region)!.add(config.dataValues.userId);
					}
				}
			} catch (parseError) {
				logger.error(`[SCHEDULER] Ошибка парсинга конфигурации пользователя ${config.dataValues.userId}:`, parseError);
			}
		}
		
		const regionUserMaps: RegionUserMap[] = Array.from(regionToUsersMap.entries()).map(([region, userSet]) => ({
			region,
			userIds: Array.from(userSet),
		}));
		
		logger.info(`[SCHEDULER] Обработано конфигураций: ${validConfigs}/${allConfigs.length}, уникальных регионов: ${regionUserMaps.length}`);
		
		return regionUserMaps;
	} catch (error) {
		logger.error('[SCHEDULER] Критическая ошибка при сборе конфигураций:', error);
		throw error;
	}
}

// =================================================================================
// ОБРАБОТКА ОДНОГО РЕГИОНА
// =================================================================================
async function processRegion(regionMap: RegionUserMap, todayMsk: string): Promise<ProcessingResult> {
	const { region, userIds } = regionMap;
	
	logger.info(`[SCHEDULER] Шаг 2/5: Обработка региона "${region}" (подписчиков: ${userIds.length})`);
	
	const result: ProcessingResult = {
		region,
		totalRecords: 0,
		processedRecords: 0,
		skippedRecords: 0,
		errorRecords: 0,
	};
	
	try {
		// Получение данных с API ЕГРЗ с повторными попытками
		const records = await fetchEgrzDataWithRetry(region, todayMsk);
		result.totalRecords = records.length;
		
		if (records.length === 0) {
			logger.info(`[SCHEDULER] Регион "${region}": новых данных не найдено`);
			return result;
		}
		
		logger.info(`[SCHEDULER] Регион "${region}": найдено ${records.length} записей для обработки`);
		
		// Оптимизированная обработка записей
		await processRecordsOptimized(records, region, userIds, result);
		
		logger.info(`[SCHEDULER] Регион "${region}": обработано=${result.processedRecords}, пропущено=${result.skippedRecords}, ошибок=${result.errorRecords}`);
		
	} catch (error) {
		logger.error(`[SCHEDULER] Критическая ошибка обработки региона "${region}":`, error);
		result.errorRecords++;
		throw error;
	}
	
	return result;
}

// =================================================================================
// ПОЛУЧЕНИЕ ДАННЫХ С API ЕГРЗ С ПОВТОРНЫМИ ПОПЫТКАМИ
// =================================================================================
async function fetchEgrzDataWithRetry(region: string, todayMsk: string): Promise<IEgrzRecord[]> {
	const filter = `(date(ExpertiseConclusionDate) ge ${todayMsk}Z and date(ExpertiseConclusionDate) le ${todayMsk}T23:59:59.999Z and contains(tolower(SubjectRf),tolower('${region}')))`;
	
	for (let attempt = 1; attempt <= SCHEDULER_CONFIG.MAX_RETRIES; attempt++) {
		try {
			logger.debug(`[SCHEDULER] Попытка ${attempt}/${SCHEDULER_CONFIG.MAX_RETRIES} получения данных для региона "${region}"`);
			
			const response = await axios.get('https://open-api.egrz.ru/api/PublicRegistrationBook/openDataFile', {
				params: {
					$filter: filter,
					$top: SCHEDULER_CONFIG.MAX_RECORDS_PER_REQUEST,
				},
				httpsAgent,
				timeout: SCHEDULER_CONFIG.HTTP_TIMEOUT,
			});
			
			// Очистка и парсинг CSV
			const cleanedCsv = cleanCsvData(response.data);
			if (!cleanedCsv) {
				return [];
			}
			
			const records: IEgrzRecord[] = parse(cleanedCsv, {
				columns: true,
				delimiter: ';',
				skip_empty_lines: true,
				trim: true,
			});
			
			logger.debug(`[SCHEDULER] Успешно получено ${records.length} записей для региона "${region}"`);
			return records;
			
		} catch (error: any) {
			const isLastAttempt = attempt === SCHEDULER_CONFIG.MAX_RETRIES;
			
			if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
				logger.warn(`[SCHEDULER] Сетевая ошибка для региона "${region}" (попытка ${attempt}): ${error.message}`);
				
				if (!isLastAttempt) {
					logger.info(`[SCHEDULER] Повторная попытка через ${SCHEDULER_CONFIG.RETRY_DELAY / 1000} секунд...`);
					await sleep(SCHEDULER_CONFIG.RETRY_DELAY);
					continue;
				}
			}
			
			if (isLastAttempt) {
				logger.error(`[SCHEDULER] Все попытки исчерпаны для региона "${region}". Ошибка:`, error.message);
				throw error;
			}
		}
	}
	
	return [];
}

// =================================================================================
// ОПТИМИЗИРОВАННАЯ ОБРАБОТКА ЗАПИСЕЙ
// =================================================================================
async function processRecordsOptimized(
	records: IEgrzRecord[],
	region: string,
	userIds: number[],
	result: ProcessingResult,
): Promise<void> {
	logger.info(`[SCHEDULER] Шаг 3/5: Оптимизированная обработка ${records.length} записей...`);
	
	// Извлекаем все номера заключений
	const allConclusionNumbers = records
		.map(record => record['Номер заключения экспертизы'])
		.filter(num => num && num.trim());
	
	if (allConclusionNumbers.length === 0) {
		logger.warn('[SCHEDULER] Не найдено ни одного валидного номера заключения');
		return;
	}
	
	// КРИТИЧЕСКОЕ УЛУЧШЕНИЕ: Один запрос вместо N запросов
	const alreadySentRecords = await ParsedData.findAll({
		where: {
			userId: { [Op.in]: userIds },
			dataContent: { [Op.in]: allConclusionNumbers },
		},
		attributes: ['userId', 'dataContent'],
		raw: true,
	});
	
	// Создаем Set для быстрого поиска отправленных комбинаций
	const sentCombinations = new Set(
		alreadySentRecords.map(record => `${record.userId}:${record.dataContent}`),
	);
	
	logger.info(`[SCHEDULER] Найдено уже отправленных записей: ${alreadySentRecords.length}`);
	
	// Обрабатываем каждую запись
	for (const record of records) {
		try {
			await processIndividualRecord(record, region, userIds, sentCombinations, result);
		} catch (error) {
			logger.error(`[SCHEDULER] Ошибка обработки записи "${record['Номер заключения экспертизы']}":`, error);
			result.errorRecords++;
		}
	}
}

// =================================================================================
// ОБРАБОТКА ОТДЕЛЬНОЙ ЗАПИСИ
// =================================================================================
async function processIndividualRecord(
	record: IEgrzRecord,
	region: string,
	userIds: number[],
	sentCombinations: Set<string>,
	result: ProcessingResult,
): Promise<void> {
	const uniqueNumber = record['Номер заключения экспертизы'];
	if (!uniqueNumber?.trim()) {
		result.skippedRecords++;
		return;
	}
	
	// Проверка релевантности записи
	const developerInfo = record['Сведения о застройщике, обеспечившем подготовку проектной документации'] || '';
	if (developerInfo.trim().toLowerCase() === 'не требуется') {
		logger.debug(`[SCHEDULER] Запись "${uniqueNumber}" пропущена (застройщик "Не требуется")`);
		result.skippedRecords++;
		return;
	}
	
	// Определяем пользователей, которым еще не отправляли эту запись
	const usersToSend = userIds.filter(userId =>
		!sentCombinations.has(`${userId}:${uniqueNumber}`),
	);
	
	if (usersToSend.length === 0) {
		// Всем уже отправляли
		return;
	}
	
	logger.debug(`[SCHEDULER] Запись "${uniqueNumber}": найдено ${usersToSend.length} новых получателей`);
	
	// Получение или создание сообщения с кешированием
	const messageText = await getOrCreateProcessedMessage(record, region, uniqueNumber);
	if (!messageText) {
		result.skippedRecords++;
		return;
	}
	
	// Рассылка сообщения новым получателям
	await sendMessageToUsers(usersToSend, messageText, uniqueNumber, result);
	
	result.processedRecords++;
}

// =================================================================================
// ПОЛУЧЕНИЕ ИЛИ СОЗДАНИЕ ОБРАБОТАННОГО СООБЩЕНИЯ
// =================================================================================
async function getOrCreateProcessedMessage(record: IEgrzRecord, region: string, uniqueNumber: string): Promise<string> {
	// Проверяем кеш
	const cachedLead = await ProcessedLead.findOne({
		where: { conclusionNumber: uniqueNumber },
		attributes: ['processedMessage'],
	});
	
	if (cachedLead) {
		logger.debug(`[SCHEDULER] Сообщение для "${uniqueNumber}" найдено в кеше`);
		return cachedLead.processedMessage;
	}
	
	// Создаем новое сообщение через AI
	logger.debug(`[SCHEDULER] Создание нового сообщения для "${uniqueNumber}" через AI...`);
	const messageText = await processLeadWithAI(record, region);
	
	// Сохраняем в кеш только валидные сообщения
	if (messageText && (messageText.includes('🏙️') || messageText.includes('🏠'))) {
		try {
			await ProcessedLead.create({
				conclusionNumber: uniqueNumber,
				processedMessage: messageText,
			});
			logger.debug(`[SCHEDULER] Сообщение для "${uniqueNumber}" сохранено в кеш`);
		} catch (cacheError) {
			// Игнорируем ошибки кеширования, но логируем их
			logger.warn(`[SCHEDULER] Не удалось сохранить в кеш "${uniqueNumber}":`, cacheError);
		}
	}
	
	return messageText;
}

// =================================================================================
// РАССЫЛКА СООБЩЕНИЯ ПОЛЬЗОВАТЕЛЯМ
// =================================================================================
async function sendMessageToUsers(userIds: number[], messageText: string, uniqueNumber: string, result: ProcessingResult): Promise<void> {
	logger.info(`[SCHEDULER] Шаг 4/5: Рассылка сообщения "${uniqueNumber}" для ${userIds.length} пользователей...`);
	
	const sendPromises = userIds.map(async (userId) => {
		try {
			await bot.sendMessage(userId, messageText);
			
			// Записываем факт отправки
			await ParsedData.create({
				userId,
				dataContent: uniqueNumber,
			});
			
			logger.debug(`[SCHEDULER] Сообщение "${uniqueNumber}" успешно отправлено пользователю ${userId}`);
		} catch (error: any) {
			if (error.response?.statusCode === 403) {
				logger.warn(`[SCHEDULER] Пользователь ${userId} заблокировал бота`);
			} else if (error.response?.statusCode === 400 && error.response?.body?.description?.includes('chat not found')) {
				logger.warn(`[SCHEDULER] Чат с пользователем ${userId} не найден`);
			} else {
				logger.error(`[SCHEDULER] Ошибка отправки сообщения пользователю ${userId}:`, error.message);
				result.errorRecords++;
			}
		}
	});
	
	// Ждем завершения всех отправок
	await Promise.allSettled(sendPromises);
}

// =================================================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// =================================================================================
function getTodayMoscowDate(): string {
	// В продакшене замените на эту строку:
	return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' })).toISOString().split('T')[0];
	
}

function cleanCsvData(rawData: string): string {
	return rawData
		.split('\n')
		.filter(line =>
			line.trim() &&
			!line.includes('Дата и время генерации файла:') &&
			line.includes(';'),
		)
		.join('\n');
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function logFinalStatistics(results: ProcessingResult[]): void {
	const totals = results.reduce((acc, result) => ({
		totalRecords: acc.totalRecords + result.totalRecords,
		processedRecords: acc.processedRecords + result.processedRecords,
		skippedRecords: acc.skippedRecords + result.skippedRecords,
		errorRecords: acc.errorRecords + result.errorRecords,
	}), { totalRecords: 0, processedRecords: 0, skippedRecords: 0, errorRecords: 0 });
	
	logger.info('[SCHEDULER] ==================== ИТОГОВАЯ СТАТИСТИКА ====================');
	logger.info(`[SCHEDULER] Обработано регионов: ${results.length}`);
	logger.info(`[SCHEDULER] Всего записей получено: ${totals.totalRecords}`);
	logger.info(`[SCHEDULER] Успешно обработано: ${totals.processedRecords}`);
	logger.info(`[SCHEDULER] Пропущено: ${totals.skippedRecords}`);
	logger.info(`[SCHEDULER] Ошибок: ${totals.errorRecords}`);
	logger.info('[SCHEDULER] ================================================================');
}

// =================================================================================
// ФУНКЦИЯ НЕМЕДЛЕННОГО ПАРСИНГА (ОБНОВЛЕННАЯ ВЕРСИЯ)
// =================================================================================
export async function triggerImmediateParse(region: string, userId: number): Promise<void> {
	logger.info(`[IMMEDIATE_PARSE] Запуск немедленного парсинга для пользователя ${userId} по региону "${region}"`);
	
	try {
		const todayMsk = getTodayMoscowDate();
		
		// Получаем данные с повторными попытками
		const records = await fetchEgrzDataWithRetry(region, todayMsk);
		
		if (records.length === 0) {
			await bot.sendMessage(userId, `По региону "${region.split(' - ')[0]}" за сегодня пока нет новых данных.`);
			return;
		}
		
		let sentMessagesCount = 0;
		let skippedRecordsCount = 0;
		
		// Получаем уже отправленные записи для этого пользователя
		const sentRecords = await ParsedData.findAll({
			where: {
				userId,
				dataContent: { [Op.in]: records.map(r => r['Номер заключения экспертизы']).filter(Boolean) },
			},
			attributes: ['dataContent'],
			raw: true,
		});
		
		const sentNumbers = new Set(sentRecords.map(r => r.dataContent));
		
		for (const record of records) {
			const uniqueNumber = record['Номер заключения экспертизы'];
			if (!uniqueNumber) {
				skippedRecordsCount++;
				continue;
			}
			
			const developerInfo = record['Сведения о застройщике, обеспечившем подготовку проектной документации'] || '';
			if (developerInfo.trim().toLowerCase() === 'не требуется') {
				skippedRecordsCount++;
				continue;
			}
			
			if (sentNumbers.has(uniqueNumber)) {
				continue; // Уже отправляли этому пользователю
			}
			
			const messageText = await getOrCreateProcessedMessage(record, region, uniqueNumber);
			
			if (messageText) {
				try {
					await bot.sendMessage(userId, messageText);
					await ParsedData.create({ userId, dataContent: uniqueNumber });
					sentMessagesCount++;
				} catch (error: any) {
					if (error.response?.statusCode === 403) {
						logger.warn(`[IMMEDIATE_PARSE] Пользователь ${userId} заблокировал бота`);
					} else {
						logger.error(`[IMMEDIATE_PARSE] Ошибка отправки сообщения пользователю ${userId}:`, error.message);
					}
				}
			}
		}
		
		// Отправляем итоговое сообщение
		let finalMessage = '';
		if (sentMessagesCount > 0) {
			finalMessage = `✅ Первоначальный поиск завершен. Отправлено новых записей: ${sentMessagesCount}.`;
			if (skippedRecordsCount > 0) {
				finalMessage += `\nПропущено нерелевантных: ${skippedRecordsCount}.`;
			}
		} else {
			if (skippedRecordsCount > 0) {
				finalMessage = `✅ Первоначальный поиск завершен. Новых записей для отправки нет, т.к. найденные ${skippedRecordsCount} шт. были нерелевантны.`;
			} else {
				finalMessage = '✅ Первоначальный поиск завершен. Все найденные записи уже были отправлены вам ранее.';
			}
		}
		
		await bot.sendMessage(userId, finalMessage);
		
	} catch (error) {
		logger.error(`[IMMEDIATE_PARSE] Критическая ошибка при немедленном парсинге для ${userId}:`, error);
		await bot.sendMessage(userId, '❌ При поиске произошла ошибка. Попробуйте добавить регион еще раз или обратитесь к администратору.');
	}
}