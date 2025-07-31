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
import * as cheerio from 'cheerio';
import { ProcessedLead } from './database/models/ProcessedLead';
import { SCRAPER_ENABLED } from './config';

// =================================================================================
// ВАЖНО: Настройка для совместимости со старым API egrz.ru
// =================================================================================
const httpsAgent = new https.Agent({
	secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
});


// =================================================================================
// БЛОК: Функции для поиска информации в интернете (скрапинг)
// Логика этих функций остается без изменений.
// =================================================================================

function extractSearchQuery(developerInfo: string): string | null {
	if (!developerInfo) return null;
	const innMatch = developerInfo.match(/ИНН:?\s*(\d{10,12})/);
	if (innMatch && innMatch[1]) return `ИНН ${innMatch[1]}`;
	const ogrnMatch = developerInfo.match(/ОГРНИП?:?\s*(\d{13,15})/);
	if (ogrnMatch && ogrnMatch[1]) return `ОГРН ${ogrnMatch[1]}`;
	const companyNameMatch = developerInfo.match(/^([^()]+)/);
	if (companyNameMatch && companyNameMatch[1]) return companyNameMatch[1].trim();
	return developerInfo;
}

async function findBeneficiaryInfo(developerInfo: string): Promise<string> {
	if (!developerInfo || developerInfo.trim().toLowerCase() === 'не требуется') {
		return 'В исходных данных не указан застройщик.';
	}
	const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
	const searchEngineId = process.env.SEARCH_ENGINE_ID;
	if (!apiKey || !searchEngineId) return 'Поиск в интернете не настроен.';
	const innOrOgrn = extractSearchQuery(developerInfo);
	const companyName = (developerInfo.match(/^([^()]+)/)?.[1] || '').trim();
	if (!companyName) return 'Не удалось извлечь название компании.';
	const queries = [
		`"${companyName}" ${innOrOgrn} руководитель официальный сайт`,
		`"${companyName}" ${innOrOgrn} реквизиты`,
		`"${companyName}" генеральный директор контакты`,
	];
	const searchUrl = `https://www.googleapis.com/customsearch/v1`;
	for (const query of queries) {
		try {
			const searchResponse = await axios.get(searchUrl, { params: { key: apiKey, cx: searchEngineId, q: query } });
			const firstResult = searchResponse.data.items?.[0];
			if (firstResult && firstResult.link) {
				try {
					const pageResponse = await axios.get(firstResult.link, {
						timeout: 5000,
						headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' },
					});
					const html = pageResponse.data;
					const $ = cheerio.load(html);
					const pageText = $('body').text().replace(/\s\s+/g, ' ').trim();
					if (pageText.length > 100) {
						return pageText.substring(0, 4000);
					}
				} catch (scrapeError: any) {
					console.error(`[SCRAPER] Ошибка при скрапинге ${firstResult.link}:`, scrapeError.message);
				}
			}
		} catch (searchError: any) {
			console.error(`[SCRAPER] Ошибка при поиске в Google:`, searchError.message);
		}
	}
	return 'Не удалось найти и обработать релевантные страницы.';
}


// =================================================================================
// НОВЫЙ, ОПТИМИЗИРОВАННЫЙ ПЛАНИРОВЩИК
// =================================================================================

// Флаг-блокировщик, чтобы избежать параллельного запуска нескольких задач парсинга
let isTaskRunning = false;

// Рекомендуется установить более разумное расписание, например, раз в 15 минут.
// '* * * * *' - каждую минуту (для тестов). '*/15 * * * *' - каждые 15 минут.
cron.schedule('*/15 * * * *', async () => {
	// -----------------------------------------------------------------------------
	// ШАГ 0: ПРОВЕРКА БЛОКИРОВКИ
	// -----------------------------------------------------------------------------
	if (isTaskRunning) {
		console.log('[SCHEDULER] Пропуск запуска: предыдущая задача еще не завершена.');
		return;
	}
	console.log('[SCHEDULER] Запуск задачи парсинга...');
	isTaskRunning = true; // Устанавливаем блокировку
	
	try {
		// -----------------------------------------------------------------------------
		// ШАГ 1: СБОР УНИКАЛЬНЫХ РЕГИОНОВ И ПОДПИСЧИКОВ
		// Вместо того чтобы итерироваться по пользователям, мы создаем карту,
		// где ключ - это регион, а значение - массив ID пользователей,
		// которые на него подписаны. Это главная оптимизация.
		// -----------------------------------------------------------------------------
		console.log('[SCHEDULER] Шаг 1/5: Сбор конфигураций и формирование списка уникальных регионов...');
		const allConfigs = await Configuration.findAll();
		const regionToUsersMap = new Map<string, number[]>();
		
		for (const config of allConfigs) {
			try {
				const userConfig: IUserConfig = JSON.parse(config.dataValues.configData);
				if (userConfig.regions && userConfig.regions.length > 0) {
					for (const region of userConfig.regions) {
						if (!regionToUsersMap.has(region)) {
							regionToUsersMap.set(region, []);
						}
						regionToUsersMap.get(region)!.push(config.dataValues.userId);
					}
				}
			} catch (e) {
				console.error(`[SCHEDULER] Ошибка парсинга конфигурации для пользователя ${config.dataValues.userId}:`, e);
			}
		}
		
		const uniqueRegions = Array.from(regionToUsersMap.keys());
		if (uniqueRegions.length === 0) {
			console.log('[SCHEDULER] Нет активных подписок на регионы. Задача завершена.');
			return; // Выходим, если никто ни на что не подписан
		}
		console.log(`[SCHEDULER] Обнаружено уникальных регионов для парсинга: ${uniqueRegions.length}.`);
		
		
		// -----------------------------------------------------------------------------
		// ШАГ 2: ПОЛУЧЕНИЕ ДАННЫХ ДЛЯ КАЖДОГО УНИКАЛЬНОГО РЕГИОНА
		// Теперь мы делаем только один запрос на регион, вне зависимости от
		// количества подписчиков.
		// -----------------------------------------------------------------------------
		console.log('[SCHEDULER] Шаг 2/5: Получение данных из API ЕГРЗ...');
		const todayMsk = '2024-05-20'; // Для тестов используется фиксированная дата
		// const todayMsk = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' })).toISOString().split('T')[0];
		
		for (const region of uniqueRegions) {
			let records: IEgrzRecord[] = [];
			try {
				const filter = `(date(ExpertiseConclusionDate) ge ${todayMsk}Z and date(ExpertiseConclusionDate) le ${todayMsk}T23:59:59.999Z and contains(tolower(SubjectRf),tolower('${region}')))`;
				const response = await axios.get('https://open-api.egrz.ru/api/PublicRegistrationBook/openDataFile', {
					params: { $filter: filter, $top: 100 }, // Увеличим лимит на всякий случай
					httpsAgent,
				});
				
				const cleanedCsv = (response.data as string).split('\n').filter(line => line.trim() && !line.includes('Дата и время генерации файла:') && line.includes(';')).join('\n');
				if (!cleanedCsv) {
					console.log(`[SCHEDULER] Для региона "${region}" нет новых данных.`);
					continue;
				}
				
				records = parse(cleanedCsv, { columns: true, delimiter: ';', skip_empty_lines: true });
				console.log(`[SCHEDULER] Регион "${region}", найдено новых строк: ${records.length}`);
			} catch (error) {
				console.error(`[SCHEDULER] Критическая ошибка при получении данных для региона "${region}":`, error);
				continue; // Пропускаем регион в случае ошибки, но продолжаем работу
			}
			
			if (records.length === 0) continue;
			
			// -----------------------------------------------------------------------------
			// ШАГ 3: ОБРАБОТКА КАЖДОЙ ЗАПИСИ (ЛИДА)
			// -----------------------------------------------------------------------------
			console.log(`[SCHEDULER] Шаг 3/5: Обработка ${records.length} записей для региона "${region}"...`);
			for (const record of records) {
				const uniqueNumber = record['Номер заключения экспертизы'];
				if (!uniqueNumber) continue;
				
				// Пропускаем записи, где застройщик не требуется
				const developerInfo = record['Сведения о застройщике, обеспечившем подготовку проектной документации'] || '';
				if (developerInfo.trim().toLowerCase() === 'не требуется') {
					console.log(`[AI_PROCESS] Запись "${uniqueNumber}" пропущена (застройщик "Не требуется").`);
					continue;
				}
				
				let messageText = '';
				
				// Сначала ищем готовое сообщение в нашем кеше
				const cachedLead = await ProcessedLead.findOne({ where: { conclusionNumber: uniqueNumber } });
				
				if (cachedLead) {
					console.log(`[AI_PROCESS] Запись "${uniqueNumber}" найдена в кеше.`);
					messageText = cachedLead.processedMessage;
				} else {
					// Если в кеше нет - запускаем полный цикл с AI
					console.log(`[AI_PROCESS] Запись "${uniqueNumber}" не найдена в кеше. Запуск полной обработки...`);
					let beneficiaryInfo = 'Скрапинг отключен';
					if (SCRAPER_ENABLED) {
						beneficiaryInfo = await findBeneficiaryInfo(developerInfo);
					} else {
						console.log(`[AI_PROCESS] Скрапинг отключен в конфигурации. Пропускаем поиск бенефициаров.`);
					}
					
					messageText = await processLeadWithAI(record, region, beneficiaryInfo);
					
					// Кешируем только качественный результат от AI
					if (messageText && (messageText.includes('🏙️') || messageText.includes('🏠'))) {
						await ProcessedLead.create({ conclusionNumber: uniqueNumber, processedMessage: messageText });
						console.log(`[AI_PROCESS] Результат для "${uniqueNumber}" сохранен в кеш.`);
					}
				}
				
				// -----------------------------------------------------------------------------
				// ШАГ 4: РАССЫЛКА СООБЩЕНИЯ ПОДПИСЧИКАМ
				// -----------------------------------------------------------------------------
				console.log(`[SCHEDULER] Шаг 4/5: Рассылка сообщения по записи "${uniqueNumber}"...`);
				const subscribers = regionToUsersMap.get(region) || [];
				for (const userId of subscribers) {
					// Проверяем, не отправляли ли мы этому пользователю эту запись ранее
					const alreadySent = await ParsedData.findOne({ where: { userId, dataContent: uniqueNumber } });
					if (!alreadySent) {
						try {
							await bot.sendMessage(userId, messageText);
							await ParsedData.create({ userId, dataContent: uniqueNumber });
							console.log(`[SCHEDULER] Сообщение по "${uniqueNumber}" успешно отправлено пользователю ${userId}.`);
						} catch (error: any) {
							// Если бота заблокировали, ловим ошибку, чтобы не остановить всю рассылку
							if (error.response && error.response.statusCode === 403) {
								console.warn(`[SCHEDULER] Не удалось отправить сообщение пользователю ${userId} (вероятно, бот заблокирован).`);
							} else {
								console.error(`[SCHEDULER] Ошибка отправки сообщения пользователю ${userId}:`, error.message);
							}
						}
					}
				}
			}
		}
		
	} catch (error) {
		console.error('[SCHEDULER] Критическая ошибка в глобальной задаче парсинга:', error);
	} finally {
		// -----------------------------------------------------------------------------
		// ШАГ 5: СНЯТИЕ БЛОКИРОВКИ
		// -----------------------------------------------------------------------------
		isTaskRunning = false;
		console.log('[SCHEDULER] Шаг 5/5: Задача парсинга завершена. Блокировка снята.');
	}
});

// =================================================================================
// НОВЫЙ БЛОК: Функция для немедленного парсинга по запросу от бота
// Эту функцию можно будет вызывать из других частей приложения (в нашем случае, из bot.ts)
// =================================================================================

/**
 * Выполняет поиск и отправку новых лидов для конкретного пользователя по одному региону.
 * @param region - Название региона (в формате "Название - Код").
 * @param userId - ID пользователя в Telegram.
 */
export async function triggerImmediateParse(region: string, userId: number) {
	console.log(`[IMMEDIATE_PARSE] Запуск немедленного парсинга для пользователя ${userId} по региону "${region}"`);
	
	try {
		const todayMsk = '2024-05-20'; // Для тестов
		// const todayMsk = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' })).toISOString().split('T')[0];
		
		const filter = `(date(ExpertiseConclusionDate) ge ${todayMsk}Z and date(ExpertiseConclusionDate) le ${todayMsk}T23:59:59.999Z and contains(tolower(SubjectRf),tolower('${region}')))`;
		
		const response = await axios.get('https://open-api.egrz.ru/api/PublicRegistrationBook/openDataFile', {
			params: { $filter: filter, $top: 100 },
			httpsAgent,
		});
		
		const cleanedCsv = (response.data as string).split('\n').filter(line => line.trim() && !line.includes('Дата и время генерации файла:') && line.includes(';')).join('\n');
		
		if (!cleanedCsv) {
			await bot.sendMessage(userId, `По региону "${region.split(' - ')[0]}" за сегодня пока нет новых данных.`);
			return;
		}
		
		const records: IEgrzRecord[] = parse(cleanedCsv, { columns: true, delimiter: ';', skip_empty_lines: true });
		if (records.length === 0) {
			await bot.sendMessage(userId, `По региону "${region.split(' - ')[0]}" за сегодня пока нет новых данных.`);
			return;
		}
		
		// --- ИЗМЕНЕНИЕ: Добавляем счетчики для отправленных и пропущенных записей ---
		let sentMessagesCount = 0;
		let skippedRecordsCount = 0; // Новый счетчик
		
		for (const record of records) {
			const uniqueNumber = record['Номер заключения экспертизы'];
			if (!uniqueNumber) {
				skippedRecordsCount++;
				continue;
			}
			
			const developerInfo = record['Сведения о застройщике, обеспечившем подготовку проектной документации'] || '';
			if (developerInfo.trim().toLowerCase() === 'не требуется') {
				skippedRecordsCount++; // Увеличиваем счетчик пропущенных
				console.log(`[IMMEDIATE_PARSE] Запись "${uniqueNumber}" пропущена (застройщик "Не требуется").`);
				continue;
			}
			
			const alreadySent = await ParsedData.findOne({ where: { userId, dataContent: uniqueNumber } });
			if (alreadySent) {
				continue;
			}
			
			let messageText = '';
			const cachedLead = await ProcessedLead.findOne({ where: { conclusionNumber: uniqueNumber } });
			
			if (cachedLead) {
				messageText = cachedLead.processedMessage;
			} else {
				let beneficiaryInfo = 'Скрапинг отключен';
				if (SCRAPER_ENABLED) {
					beneficiaryInfo = await findBeneficiaryInfo(developerInfo);
				}
				messageText = await processLeadWithAI(record, region, beneficiaryInfo);
				if (messageText && (messageText.includes('🏙️') || messageText.includes('🏠'))) {
					await ProcessedLead.create({ conclusionNumber: uniqueNumber, processedMessage: messageText });
				}
			}
			
			if (messageText) {
				try {
					await bot.sendMessage(userId, messageText);
					await ParsedData.create({ userId, dataContent: uniqueNumber });
					sentMessagesCount++;
				} catch (error: any) {
					if (error.response && error.response.statusCode === 403) {
						console.warn(`[IMMEDIATE_PARSE] Не удалось отправить сообщение пользователю ${userId} (вероятно, бот заблокирован).`);
					} else {
						console.error(`[IMMEDIATE_PARSE] Ошибка отправки сообщения пользователю ${userId}:`, error.message);
					}
				}
			}
		}
		
		// --- ИЗМЕНЕНИЕ: Новая логика финального сообщения ---
		let finalMessage = '';
		if (sentMessagesCount > 0) {
			finalMessage = `✅ Первоначальный поиск завершен. Отправлено новых записей: ${sentMessagesCount}.`;
			if (skippedRecordsCount > 0) {
				finalMessage += `\nПропущено нерелевантных: ${skippedRecordsCount}.`;
			}
		} else {
			if (skippedRecordsCount > 0) {
				finalMessage = `✅ Первоначальный поиск завершен. Новых записей для отправки нет, т.к. найденные ${skippedRecordsCount} шт. были нерелевантны (например, без указания застройщика).`;
			} else {
				finalMessage = '✅ Первоначальный поиск завершен. Все найденные записи уже были отправлены вам ранее. Новых лидов нет.';
			}
		}
		
		await bot.sendMessage(userId, finalMessage);
		
	} catch (error) {
		console.error(`[IMMEDIATE_PARSE] Критическая ошибка при немедленном парсинге для ${userId}:`, error);
		await bot.sendMessage(userId, '❌ При поиске произошла ошибка. Попробуйте добавить регион еще раз или обратитесь к администратору.');
	}
}