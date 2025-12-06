import { google } from 'googleapis';
import { getSheetsClient } from '../lib/sheetsClient.js';
import { getInventoryBySkus } from '../lib/wixClient.js';

// --- Вспомогательные функции (как в фидах) ---
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

async function ensureAuth() {
  const keyJson = requireEnv('GOOGLE_SERVICE_ACCOUNT_KEY');
  const spreadsheetId = requireEnv('SPREADSHEET_ID');
  const keyObj = JSON.parse(keyJson);

  const jwtClient = new google.auth.JWT(
    keyObj.client_email,
    null,
    keyObj.private_key,
    ['https://www.googleapis.com/auth/spreadsheets.readonly']
  );
  await jwtClient.authorize();

  const sheets = getSheetsClient(jwtClient);
  return { sheets, spreadsheetId };
}

// Чистим цену для отображения
function cleanPrice(val) {
  if (!val) return 0;
  let str = String(val).trim().replace(/\s/g, '').replace(',', '.');
  return parseFloat(str.replace(/[^0-9.]/g, '')) || 0;
}

export default async function handler(req, res) {
  try {
    const { sheets, spreadsheetId } = await ensureAuth();

    // 1. Читаем данные из Таблицы
    const [importRes, controlRes] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId, range: 'Import!A1:ZZ' }),
      sheets.spreadsheets.values.get({ spreadsheetId, range: 'Feed Control List!A1:F' })
    ]);

    const importRows = importRes.data.values || [];
    const controlRows = controlRes.data.values || [];

    if (importRows.length < 2) {
      return res.send('<h1>Таблица пуста</h1>');
    }

    // 2. Разбираем настройки колонок (где Имя, где SKU, где Цена)
    const headers = importRows[0];
    const dataRows = importRows.slice(1);
    
    // Ищем индексы колонок в Feed Control List
    // Нам нужны поля, у которых "Feed name" равно: sku, name, price
    const controlHeaders = controlRows[0] || [];
    const idxImportField = controlHeaders.indexOf('Import field');
    const idxFeedName = controlHeaders.indexOf('Feed name');

    let colSku = -1;
    let colName = -1;
    let colPrice = -1;

    // Карта: "Имя в фиде" -> "Имя колонки в Import"
    const fieldMap = {}; 
    controlRows.slice(1).forEach(row => {
      const imp = row[idxImportField];
      const feedName = row[idxFeedName];
      if (imp && feedName) {
        fieldMap[String(feedName).trim()] = String(imp).trim();
      }
    });

    // Теперь ищем индексы в заголовках Import
    colSku = headers.indexOf(fieldMap['sku'] || 'SKU'); // Фоллбек на 'SKU'
    colName = headers.indexOf(fieldMap['name'] || 'Name');
    colPrice = headers.indexOf(fieldMap['price'] || 'Price');

    if (colSku === -1) return res.send('<h1>Ошибка: Не найдена колонка SKU</h1>');

    // 3. Собираем список SKU для запроса в Wix
    const skus = [];
    const tableData = [];

    dataRows.forEach(row => {
      const sku = row[colSku] ? String(row[colSku]).trim() : '';
      if (!sku) return;

      skus.push(sku);
      
      const priceVal = colPrice > -1 ? row[colPrice] : '0';
      
      tableData.push({
        sku: sku,
        name: colName > -1 ? row[colName] : '(No Name)',
        priceRaw: priceVal,
        price: cleanPrice(priceVal)
      });
    });

    // 4. Запрашиваем реальный сток из Wix (используем нашу новую мощную функцию)
    // Это может занять пару секунд
    const inventory = await getInventoryBySkus(skus);
    
    // Превращаем массив стока в удобную карту: SKU -> Info
    const stockMap = {};
    inventory.forEach(item => {
      stockMap[String(item.sku).trim()] = item;
    });

    // 5. Генерируем HTML
    let html = `
    <html>
      <head>
        <title>Stock Check</title>
        <style>
          body { font-family: sans-serif; padding: 20px; }
          table { border-collapse: collapse; width: 100%; max-width: 1000px; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #f2f2f2; }
          .instock { background-color: #d4edda; color: #155724; font-weight: bold; }
          .outstock { background-color: #f8d7da; color: #721c24; }
          .warn { background-color: #fff3cd; color: #856404; }
          h2 { margin-bottom: 5px; }
          .summary { margin-bottom: 20px; font-size: 14px; color: #666; }
        </style>
      </head>
      <body>
        <h2>Проверка товаров и стока</h2>
        <div class="summary">
          Всего товаров в таблице: ${tableData.length} <br>
          Найдено в Wix: ${inventory.length}
        </div>
        <table>
          <thead>
            <tr>
              <th>Артикул (SKU)</th>
              <th>Название</th>
              <th>Цена (Sheet)</th>
              <th>Наличие (Wix)</th>
              <th>Кол-во (Wix)</th>
            </tr>
          </thead>
          <tbody>
    `;

    tableData.forEach(item => {
      const wixItem = stockMap[item.sku];
      
      let stockClass = '';
      let stockText = '';
      let qtyText = '-';

      if (!wixItem) {
        stockClass = 'warn'; // Желтый
        stockText = 'Не найден в Wix';
      } else if (wixItem.inStock) {
        stockClass = 'instock'; // Зеленый
        stockText = 'В НАЛИЧИИ';
        qtyText = wixItem.quantity;
      } else {
        stockClass = 'outstock'; // Красный
        stockText = 'Нет в наличии';
        qtyText = wixItem.quantity;
      }

      html += `
        <tr>
          <td>${item.sku}</td>
          <td>${item.name}</td>
          <td>${item.price}</td>
          <td class="${stockClass}">${stockText}</td>
          <td>${qtyText}</td>
        </tr>
      `;
    });

    html += `
          </tbody>
        </table>
      </body>
    </html>
    `;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);

  } catch (e) {
    res.status(500).send(`<h1>Error</h1><pre>${e.message}\n${e.stack}</pre>`);
  }
}
