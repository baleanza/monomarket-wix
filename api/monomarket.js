// api/monomarket.js
import { ensureAuth, cleanPrice } from '../lib/sheetsClient.js'; 
import { getInventoryBySkus } from '../lib/wixClient.js';

// --- NEW HELPER FUNCTION FOR CLOUDINARY TRANSFORMATION ---
function modifyImageUrl(originalUrl) {
    if (typeof originalUrl !== 'string') originalUrl = '';
    originalUrl = originalUrl.trim();
    
    // Якщо сирий URL пустий, невірний або є результатом функції IMAGE()
    if (!originalUrl || originalUrl === 'CellImage' || originalUrl.toLowerCase().includes('no photo')) {
        return '';
    }
    
    // Transformation to inject (на основі формули користувача)
    const transformation = 't_JPG_w240h160_cropped30/';
    const uploadBase = 'upload/';
    
    // Виконуємо трансформацію тільки для URL-адрес Cloudinary
    if (originalUrl.includes('res.cloudinary.com/') && originalUrl.includes(uploadBase)) {
        // Знаходимо індекс одразу після сегменту 'upload/'
        const index = originalUrl.indexOf(uploadBase) + uploadBase.length;
        
        // Вставляємо рядок трансформації
        return originalUrl.slice(0, index) + transformation + originalUrl.slice(index);
    }
    
    // Якщо це інша URL-адреса, повертаємо її без змін
    return originalUrl; 
}
// --- END HELPER FUNCTION ---


// Read data from Google Sheets
// ... (readSheetData без змін)

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
  const AUTH_USER = process.env.MONOMARKET_USER;
  const AUTH_PASS = process.env.MONOMARKET_PASSWORD;
  
  // Якщо облікові дані для захисту встановлені, активуємо перевірку (Basic Auth)
  if (AUTH_USER && AUTH_PASS) {
      const authHeader = req.headers.authorization;
      
      if (!authHeader || !authHeader.startsWith('Basic ')) {
          res.setHeader('WWW-Authenticate', 'Basic realm="Monomarket Private Area"');
          return res.status(401).send('Unauthorized');
      }

      const b64Credentials = authHeader.split(' ')[1];
      const credentials = Buffer.from(b64Credentials, 'base64').toString('utf-8');
      const [user, pass] = credentials.split(':');

      if (user !== AUTH_USER || pass !== AUTH_PASS) {
          res.setHeader('WWW-Authenticate', 'Basic realm="Monomarket Private Area"');
          return res.status(401).send('Invalid Credentials');
      }
  }

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
    
    // Parse feed settings
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

    // --- COLUMN INDEX DEFINITION ---
    
    // 1. Find Name/Title column
    let colName = -1;
    const nameKeys = [fieldMap['name'], fieldMap['title'], 'Name', 'Title'].filter(Boolean);
    for (const key of nameKeys) {
      colName = headers.indexOf(key);
      if (colName > -1) break;
    }

    // 2. Find SKU column
    const colSku = headers.indexOf(fieldMap['sku'] || 'SKU'); 
    
    // 3. Find Price column
    const colPrice = headers.indexOf(fieldMap['price'] || 'Price');

    // 4. Find Code column (Product ID)
    let colCode = -1;
    if (fieldMap['code']) {
        colCode = headers.indexOf(fieldMap['code']);
    }
    if (colCode === -1) {
        colCode = headers.indexOf('code');
    }
    
    // 5. Find Image columns (image_1 to image_7)
    const imageCols = [];
    const maxImages = 7;
    for (let i = 1; i <= maxImages; i++) {
        const feedName = `image_${i}`;
        const sheetHeader = fieldMap[feedName]; // Get sheet header from control list
        let colIndex = -1;
        
        if (sheetHeader) {
            colIndex = headers.indexOf(sheetHeader);
        }
        // Save the index, even if -1, to maintain order
        imageCols.push({ index: colIndex, feedName: feedName });
    }
    
    // --- END COLUMN INDEX DEFINITION ---


    if (colSku === -1) return res.status(500).send('<h1>Помилка: Не знайдено колонку SKU для синхронізації</h1>');

    const skus = [];
    const tableData = [];

    dataRows.forEach(row => {
      const sku = row[colSku] ? String(row[colSku]).trim() : '';
      if (!sku) return;

      skus.push(sku);
      
      const priceVal = colPrice > -1 ? row[colPrice] : '0';
      const codeVal = colCode > -1 ? (row[colCode] || '') : ''; 
      
      const images = [];
      const rawImages = []; // Зберігаємо сирі значення для дебагу
      imageCols.forEach(imgCol => {
          if (imgCol.index > -1) {
              const rawUrl = row[imgCol.index] ? String(row[imgCol.index]).trim() : '';
              rawImages.push(rawUrl);
              
              // APPLY MODIFICATION HERE
              const modifiedUrl = modifyImageUrl(rawUrl);
              images.push(modifiedUrl);
          } else {
              images.push(''); // Placeholder for missing mapping
              rawImages.push('');
          }
      });
      
      tableData.push({
        sku: sku,
        code: codeVal,
        name: colName > -1 ? row[colName] : '(Без назви)',
        priceRaw: priceVal,
        price: cleanPrice(priceVal),
        images: images,
        rawImages: rawImages // Передаємо сирі значення
      });
    });

    // Request inventory from Wix
    const inventory = await getInventoryBySkus(skus);
    
    const stockMap = {};
    inventory.forEach(item => {
      stockMap[String(item.sku).trim()] = item;
    });

    // PAGE HTML
    let html = `
    <html>
      <head>
        <title>Monomarket Control</title>
        <meta charset="UTF-8">
        <style>
          /* ... (стилі без змін, крім img-placeholder) ... */
          body { font-family: sans-serif; padding: 20px; max-width: 1200px; margin: 0 auto; }
          
          /* Styles for order lookup block */
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

          /* Table styles */
          table { border-collapse: collapse; width: 100%; margin-top: 15px; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #f2f2f2; }
          
          /* NEW IMAGE STYLES */
          .img-cell {
              padding: 0 !important; 
              width: 40px; 
              height: 40px; 
              min-width: 40px;
              min-height: 40px;
              text-align: center; 
              vertical-align: middle;
              line-height: 0; 
              border-left: 1px dashed #eee; 
              position: relative; /* For image hover effect */
          }
          .img-cell img {
              max-width: 40px;
              max-height: 40px;
              object-fit: contain; 
              display: block;
              margin: 0 auto;
              transition: transform 0.2s;
              cursor: pointer;
          }
          .img-cell img:hover {
              transform: scale(3.5); /* Zoom effect on hover */
              z-index: 10;
              position: absolute;
              border: 1px solid #ccc;
              background: white;
              box-shadow: 0 0 10px rgba(0,0,0,0.5);
          }
          .img-placeholder {
              display: block;
              width: 100%;
              height: 100%;
              background-color: #f9f9f9; 
              font-size: 8px;
              line-height: 10px; /* Зменшуємо лінійний простір, щоб вмістити текст */
              padding: 5px 2px;
              overflow: hidden; /* Обрізати довгий URL */
              color: #888;
          }
          /* END NEW IMAGE STYLES */

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
                // ... (JS функція без змін)
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
                    // Використовуємо шлях /debug-order, згідно з vercel.json
                    const res = await fetch('/debug-order?id=' + encodeURIComponent(id));
                    
                    // 1. Check response status to avoid HTML parsing errors
                    if (!res.ok) {
                        const errorText = await res.text();
                        // Output status and part of the response body
                        resultSpan.textContent = \`Помилка сервера (\${res.status}): \${errorText.substring(0, 50)}...\`;
                        resultSpan.className = "lookup-result res-error";
                        return;
                    }
                    
                    const data = await res.json();
                    
                    // 2. Correctly find the number in the structure {"order": {"number": "..."}}
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
                    // Handle network errors or JSON parsing errors
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
              <th title="Фото 1" class="img-cell">Ф1</th>
              <th title="Фото 2" class="img-cell">Ф2</th>
              <th title="Фото 3" class="img-cell">Ф3</th>
              <th title="Фото 4" class="img-cell">Ф4</th>
              <th title="Фото 5" class="img-cell">Ф5</th>
              <th title="Фото 6" class="img-cell">Ф6</th>
              <th title="Фото 7" class="img-cell">Ф7</th>
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
          
          ${item.images.map((url, index) => {
              const rawContent = item.rawImages[index] || '-'; // Сирий вміст для дебагу
              
              return `
                <td class="img-cell" title="Фото ${index + 1}">
                  ${url 
                    ? `<img src="${url}" alt="Фото ${index + 1}" loading="lazy">` 
                    : `<span class="img-placeholder">${rawContent.length > 10 ? 'CONTENT...' : rawContent}</span>`
                  }
                </td>
              `;
          }).join('')}
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
