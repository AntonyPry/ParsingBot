import cron from 'node-cron';
import https from 'https';
import * as crypto from 'crypto';
import axios from 'axios';
import { parse } from 'csv-parse/sync';
import { ParsedData } from './database/models/ParsedData';
import { bot } from './bot';
import { Configuration } from './database/models/Configuration';

// Разрешаем небезопасную renegotiation (требуется для open-api.egrz.ru)
const httpsAgent = new https.Agent({
  secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
});

// Пример: каждую минуту (для теста), потом поменяете на 0 */3 * * *
cron.schedule('* * * * *', async () => {
  console.log('Cron job: запрос к open-api.egrz.ru');

  try {
    // 1. Получаем всех пользователей (конфигурации)
    const configs = await Configuration.findAll();

    for (const cfg of configs) {
      const userId = cfg.dataValues.userId;

      // 2. Достаём из cfg.configData нужный параметр, например region
      //    Предположим, configData хранится как JSON {"region":"Санкт-Петербург - 78"}
      let region = 'Санкт-Петербург - 78';
      // Если у вас JSON — распарсим:
      try {
        const parsed = JSON.parse(cfg.configData || '{}');
        if (parsed.region) {
          region = parsed.region;
        }
      } catch (e) {
        console.error('configData не в JSON-формате, используем по умолчанию');
      }

      // 3. Строим фильтр. Пример: date(...) + contains(tolower(SubjectRf), tolower('region'))
      const nowInMoscowString = new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' });
      const nowInMoscow = new Date(nowInMoscowString);

      const yyyy = nowInMoscow.getFullYear();
      const mm = String(nowInMoscow.getMonth() + 1).padStart(2, '0');
      const dd = String(nowInMoscow.getDate()).padStart(2, '0');
      const todayMsk = `${yyyy}-${mm}-${dd}`;

      // пятница: 2025-03-14

      // Дата "вчера"
      const dateObj = new Date();
      dateObj.setDate(dateObj.getDate() - 1);
      const yesterday = dateObj.toISOString().slice(0, 10);

      // ВАЖНО: обратите внимание на кавычки!
      const filter = `(date(ExpertiseConclusionDate) ge ${todayMsk}Z and date(ExpertiseConclusionDate) le ${todayMsk}T23:59:59.999Z and contains(tolower(SubjectRf),tolower('${region}')))`;

      // 4. Запрашиваем API
      const response = await axios.get('https://open-api.egrz.ru/api/PublicRegistrationBook/openDataFile', {
        params: {
          $filter: filter,
          $orderby: 'ExpertiseDate desc',
          $count: 'true',
          $top: 20,
          $skip: 0,
        },
        httpsAgent,
      });

      const originalCsv = response.data as string;

      // 5. Убираем паразитные строки
      const cleanedCsv = originalCsv
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim();
          if (!trimmed) return false;
          if (trimmed.includes('Дата и время генерации файла:')) return false;
          if (!trimmed.includes(';')) return false;
          return true;
        })
        .join('\n');

      // 6. Парсим CSV
      const records = parse(cleanedCsv, {
        columns: true,
        delimiter: ';',
        skipEmptyLines: true,
      });

      console.log(`UserID ${userId}, конфиг "${region}", найдено строк: ${records.length}`);

      // 7. Обрабатываем записи
      for (const row of records) {
        const uniqueNumber = row['Номер заключения экспертизы'] || '';
        if (!uniqueNumber) continue;

        // Проверяем, нет ли уже у ЭТОГО userId такой записи
        const existing = await ParsedData.findOne({
          where: { userId, dataContent: uniqueNumber },
        });

        // Если нет — отправляем
        if (!existing) {
          await ParsedData.create({ userId, dataContent: uniqueNumber });

          // Составляем сообщение:
          const now = new Date().toISOString();
          const result =
            row['Результат проведенной экспертизы (положительное или отрицательное заключение экспертизы)'] || '-';
          const preparedBy =
            row[
              'Сведения об индивидуальных предпринимателях и (или) юридических лицах, подготовивших проектную документацию'
            ] || '-';
          const developer = row['Сведения о застройщике, обеспечившем подготовку проектной документации'] || '-';

          const project =
            row[
              'Наименование и адрес (местоположение) объекта капитального строительства, применительно к которому подготовлена проектная документация'
            ] || '-';

          const messageText = `Новый лид за ${now}

Номер заключения экспертизы: ${uniqueNumber}
Результат экспертизы: ${result}

Кто подготовил документацию:
${preparedBy}

Сведения о застройщике:
${developer}

Наименование и адрес объекта:
${project}
`;

          await bot.sendMessage(userId, messageText);
        }
      }
    }

    console.log('Запрос завершён, новые данные отправлены.');
  } catch (error) {
    console.error('Ошибка в cron-задаче:', error);
  }
});
