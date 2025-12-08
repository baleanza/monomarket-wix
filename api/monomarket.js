// api/monomarket.js
import { ensureAuth, cleanPrice } from '../lib/sheetsClient.js'; 
import { getInventoryBySkus } from '../lib/wixClient.js';

// Читання даних з Google Sheets
async function readSheetData(sheets, spreadsheetId) {
    const importRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Import!A1:ZZ'
    });
    const controlRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Feed Control List!A1:F'
    });
    return { 
        importValues: importRes.data.values || [], 
        controlValues: controlRes.data.values || [] 
    };
}

export default async function handler(req, res) {
  try {
    const { sheets, spreadsheetId } = await ensureAuth();

    const { importValues, controlValues } = await readSheetData(
      sheets,
      spreadsheetId
    );

    if (importValues.length < 2) {
      return res.send('<h1>Таблиця пуста</h1>');
    }

    const headers = importValues[0];
    const dataRows = importValues.slice(1);
    
    // Парсимо налаштування фіду
    const controlHeaders = controlValues[0] || [];
    const idxImportField = controlHeaders.indexOf('Import field');
    const idxFeedName = controlHeaders.indexOf('Feed name');

    const fieldMap = {}; 
    controlValues.slice(1).forEach(row => {
      const imp = row[idxImportField];
      const feedName = row[idxFeedName];
      if (imp && feedName) {
        fieldMap[String(feedName).trim()] = String(imp).trim();
      }
    });

    // --- ВИЗНАЧЕННЯ ІНДЕКСІВ КОЛОНОК ---
    
    // 1. Шукаємо колонку Name/Title
    let colName = -1;
    const nameKeys = [fieldMap['name'], fieldMap['title'], 'Name', 'Title'].filter(Boolean);
    for (const key of nameKeys) {
      colName = headers.indexOf(key);
      if (colName > -1) break;
    }

    // 2. Шукаємо колонку SKU
    const colSku = headers.indexOf(fieldMap['sku'] || 'SKU'); 
    
    // 3. Шукаємо колонку Price
    const colPrice = headers.indexOf(fieldMap['price'] || 'Price');

    // 4. Шукаємо колонку Code (Product ID)
    let colCode = -1;
    if (fieldMap['code']) {
        colCode = headers.indexOf(fieldMap['code']);
    }
    // Якщо в мапінгу немає, шукаємо просто за назвою "code"
    if (colCode === -1) {
        colCode = headers.indexOf('code');
    }

    if (colSku === -1) return res.status(500).send('<h1>Помилка: Не знайдено колонку SKU для синхронізації</h1>');

    const skus = [];
    const tableData = [];

    dataRows.forEach(row => {
      const sku = row[colSku] ? String(row[colSku]).trim() : '';
      if (!sku) return;

      skus.push(sku);
      
      const priceVal = colPrice > -1 ? row[colPrice] : '0';
      const codeVal = colCode > -1 ? (row[colCode] || '') : ''; 
      
      tableData.push({
        sku: sku,
        code: codeVal,
        name: colName > -1 ? row[colName] : '(Без назви)',
        priceRaw: priceVal,
        price: cleanPrice(priceVal)
      });
    });

    // Запитуємо залишки з Wix
    const inventory = await getInventoryBySkus(skus);
    
    const stockMap = {};
    inventory.forEach(item => {
      stockMap[String(item.sku).trim()] = item;
    });

    // HTML СТОРІНКИ
    let html = `
    <html>
      <head>
        <title>Monomarket Control</title>
        <meta charset="UTF-8">
        <style>
          body { font-family: sans-serif; padding: 20px; max-width: 1200px; margin: 0 auto; }
          
          /* Стилі для блоку пошуку замовлення */
          .order-lookup-box {
            background-color: #f0f7ff;
            border: 1px solid #cce5ff;
            border-radius: 6px;
            padding: 15px;
            margin-bottom: 25px;
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .order-lookup-box input {
            padding: 8px;
            border: 1px solid #ccc;
            border-radius: 4px;
            width: 350px;
            font-size: 14px;
          }
          .order-lookup-box button {
            padding: 8px 15px;
            background-color: #0070f3;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
          }
          .order-lookup-box button:hover { background-color: #005bb5; }
          .lookup-result { font-weight: bold; font-size: 16px; margin-left: 10px; }
          .res-success { color: #0070f3; }
          .res-error { color: #d93025; }

          /* Стилі таблиці */
          table { border-collapse: collapse; width: 100%; margin-top: 15px; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #f2f2f2; }
          .instock { background-color: #d4edda; color: #155724; font-weight: bold; }
          .outstock { background-color: #f8d7da; color: #721c24; }
          .warn { background-color: #fff3cd; color: #856404; }
          h2 { margin-bottom: 10px; margin-top: 30px;}
          .summary { margin-bottom: 20px; font-size: 14px; color: #666; }
        </style>
      </head>
      <body>
        
        <h2>Перевірка номера замовлення</h2>
        <div class="order-lookup-box">
            <strong>Wix Order ID:</strong>
            <input type="text" id="wixOrderId" placeholder="Вставте ID (наприклад: 89700e12-...)">
            <button onclick="lookupOrder()">Отримати номер</button>
            <span id="lookupResult" class="lookup-result"></span>
        </div>

        <script>
            async function lookupOrder() {
                const input = document.getElementById('wixOrderId');
                const resultSpan = document.getElementById('lookupResult');
                const id = input.value.trim();

                if (!id) {
                    resultSpan.textContent = "Введіть ID!";
                    resultSpan.className = "lookup-result res-error";
                    return;
                }

                resultSpan.textContent = "Пошук...";
                resultSpan.className = "lookup-result";

                try {
                    const res = await fetch('/api/debug-order?id=' + encodeURIComponent(id));
                    
                    // 1. Перевіряємо статус відповіді, щоб уникнути помилок парсингу HTML
                    if (!res.ok) {
                        const errorText = await res.text();
                        // Виводимо статус та частину тіла відповіді
                        resultSpan.textContent = `Помилка сервера (${res.status}): ${errorText.substring(0, 50)}...`;
                        resultSpan.className = "lookup-result res-error";
                        return;
                    }
                    
                    const data = await res.json();
                    
                    // 2. Коректний пошук номера в структурі {"order": {"number": "..."}}
                    if (data.order && data.order.number) {
                        resultSpan.textContent = "Номер замовлення: " + data.order.number;
                        resultSpan.className = "lookup-result res-success";
                    } else if (data.error) {
                        resultSpan.textContent = "Помилка: " + data.error;
                        resultSpan.className = "lookup-result res-error";
                    } else {
                        resultSpan.textContent = "Не знайдено або недійсний ID";
                        resultSpan.className = "lookup-result res-error";
                    }
                } catch (e) {
                    // Обробка мережевих помилок або помилок парсингу JSON
                    resultSpan.textContent = "Помилка запиту (JS): " + e.message;
                    resultSpan.className = "lookup-result res-error";
                }
            }
        </script>

        <h2>Monomarket Feed Table</h2>
        
        <div class="summary">
          Усього товарів у таблиці: ${tableData.length} <br>
          Зібрано залишків з Wix: ${inventory.length}
        </div>

        <table>
          <thead>
            <tr>
              <th>Product ID</th>
              <th>Артикул (SKU)</th>
              <th>Назва (Sheet)</th>
              <th>Ціна (Sheet)</th>
              <th>Наявність (Wix)</th>
              <th>К-сть (Wix)</th>
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
        stockClass = 'warn'; 
        stockText = 'Не знайдено в Wix';
      } else if (wixItem.inStock) {
        stockClass = 'instock'; 
        stockText = 'В НАЯВНОСТІ';
        qtyText = wixItem.quantity;
      } else {
        stockClass = 'outstock'; 
        stockText = 'Немає в наявності';
        qtyText = wixItem.quantity;
      }

      html += `
        <tr>
          <td>${item.code}</td>
          <td>${item.sku}</td>
          <td>${item.name}</td>
          <td>${item.price.toFixed(2)} ₴</td>
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
    res.status(500).send(`<h1>Помилка</h1><pre>${e.message}\n${e.stack}</pre>`);
  }
}
