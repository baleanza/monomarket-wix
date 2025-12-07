import { createWixOrder, getProductsBySkus } from '../lib/wixClient.js';
import { ensureAuth } from '../lib/sheetsClient.js'; 
import { google } from 'googleapis';

// Проверка Basic Auth
function checkAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return false;

  const b64auth = authHeader.split(' ')[1];
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

  const expectedUser = process.env.MURKIT_USER;
  const expectedPass = process.env.MURKIT_PASS;

  return login === expectedUser && password === expectedPass;
}

// Новая функция для чтения данных Sheets
async function readSheetData(sheets, spreadsheetId) {
  const importRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Import!A1:ZZ' });
  const controlRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Feed Control List!A1:F' });

  return { 
    importValues: importRes.data.values || [], 
    controlValues: controlRes.data.values || [] 
  };
}

// Функция для создания карты: Murkit Code -> Wix SKU
function getProductSkuMap(importValues, controlValues) {
    const headers = importValues[0] || [];
    const rows = importValues.slice(1);
    const controlHeaders = controlValues[0] || [];
    const controlRows = controlValues.slice(1);

    const idxImportField = controlHeaders.indexOf('Import field');
    const idxFeedName = controlHeaders.indexOf('Feed name');

    let murkitCodeSheetField = '';
    let wixSkuSheetField = '';

    controlRows.forEach(row => {
        const importField = row[idxImportField];
        const feedName = row[idxFeedName];
        if (feedName === 'code') murkitCodeSheetField = String(importField).trim();
        if (feedName === 'id') wixSkuSheetField = String(importField).trim();
    });
    
    const murkitCodeColIndex = headers.indexOf(murkitCodeSheetField);
    const wixSkuColIndex = headers.indexOf(wixSkuSheetField);
    
    if (murkitCodeColIndex === -1 || wixSkuColIndex === -1) {
        console.warn(`Cannot find required mapping columns (Code: ${murkitCodeSheetField}, SKU: ${wixSkuSheetField}) in Import sheet.`);
        return {};
    }

    const map = {};
    rows.forEach(row => {
        const murkitCode = row[murkitCodeColIndex] ? String(row[murkitCodeColIndex]).trim() : '';
        const wixSku = row[wixSkuColIndex] ? String(row[wixSkuColIndex]).trim() : '';
        if (murkitCode && wixSku) {
            map[murkitCode] = wixSku;
        }
    });
    
    return map;
}

// Вспомогательная функция для получения имени получателя
function getFullName(nameObj) {
    if (!nameObj) return { firstName: "Client", lastName: "" };
    return {
        firstName: nameObj.first || nameObj.firstName || "Client",
        lastName: nameObj.last || nameObj.lastName || ""
    };
}


export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  // 1. Проверяем авторизацию
  if (!checkAuth(req)) {
    console.warn('Unauthorized access attempt to Murkit Webhook');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const murkitData = req.body;
    console.log('New Order from Murkit:', JSON.stringify(murkitData, null, 2));

    const murkitItems = murkitData.items || [];
    if (murkitItems.length === 0) {
      res.status(400).json({ error: 'No items in order' });
      return;
    }

    // 2. ЗАГРУЗКА И СОЗДАНИЕ КАРТЫ СОПОСТАВЛЕНИЯ
    const { sheets, spreadsheetId } = await ensureAuth();
    const { importValues, controlValues } = await readSheetData(sheets, spreadsheetId);
    
    const codeToSkuMap = getProductSkuMap(importValues, controlValues);
    
    // 3. Собираем все Wix SKU для запроса к Wix
    const murkitCodes = murkitItems.map(item => String(item.code).trim()).filter(Boolean);
    const wixSkus = murkitCodes
      .map(code => codeToSkuMap[code] || code) // Fallback to code if mapping not found
      .filter(Boolean);

    if (wixSkus.length === 0) {
        res.status(400).json({ error: 'None of the Murkit product codes could be mapped to a Wix SKU.' });
        return;
    }

    // 4. Ищем эти товары в Wix, чтобы получить их ID
    const wixProducts = await getProductsBySkus(wixSkus);
    
    // Создаем карту: Wix SKU -> Wix Product ID
    const skuToIdMap = {};
    wixProducts.forEach(p => {
      skuToIdMap[p.sku] = p.id;
    });

    // 5. РАСЧЕТ ИТОГОВ и ФОРМИРОВАНИЕ ПЕРЕМЕННЫХ
    const currency = "UAH"; // Укр. гривна
    
    const totalAmount = parseFloat(murkitData.sum || 0).toFixed(2);
    // Для Murkit у нас нет разделения, поэтому subtotal = total = sum
    const subtotalAmount = totalAmount; 
    
    const clientName = getFullName(murkitData.client?.name);
    const recipientName = getFullName(murkitData.recipient?.name);
    const defaultEmail = "monomarket@mywoodmood.com"; // Дефолтный email
    const clientPhone = murkitData.client?.phone || murkitData.recipient?.phone || "";

    // 6. ФОРМИРОВАНИЕ LINE ITEMS
    const lineItems = murkitItems.map(item => {
        const murkitCode = String(item.code).trim();
        const wixSku = codeToSkuMap[murkitCode] || murkitCode; 
        const wixId = wixSku ? skuToIdMap[wixSku] : null;
        
        const price = parseFloat(item.price || 0).toFixed(2);

        const baseItem = {
            name: item.name || `Item ${murkitCode}`, 
            quantity: parseInt(item.quantity || 1, 10),
            price: {
                amount: price,
                currency: currency
            },
            // Добавляем SKU и Murkit Code как customFields
            customFields: [
                { title: "SKU", value: wixSku },
                { title: "Murkit Code", value: murkitCode }
            ],
            // Добавляем минимальные данные для Wix PriceSummary, чтобы он не ругался
            totalPriceBeforeTax: { amount: price, currency: currency },
            totalPriceAfterTax: { amount: price, currency: currency },
            lineItemPrice: { amount: price, currency: currency }
        };

        if (!wixId) {
            console.warn(`Murkit Code ${murkitCode} (Wix SKU: ${wixSku}) not found in Wix, adding as custom item.`);
            return baseItem; 
        }

        // Возвращаем каталожный item
        return {
            ...baseItem,
            catalogReference: {
                catalogItemId: wixId,
                appId: "1380b703-ce81-ff05-f115-39571d94dfcd", // Wix Stores App ID
            }
        };
    });

    // 7. ФОРМИРОВАНИЕ ОБЪЕКТА ЗАКАЗА WIX
    
    // Адрес для Billing (используем город и телефон)
    const billingAddress = {
        country: "UA",
        city: murkitData.delivery?.settlementName || "Не вказано",
        addressLine: "Телефон: " + clientPhone, // Запасной способ хранения телефона
        email: murkitData.client?.email || defaultEmail,
    };
    
    // Адрес для Shipping (доставка на отделение Новой Почты)
    const shippingAddress = {
        country: "UA",
        city: murkitData.delivery?.settlementName || "Не вказано",
        addressLine: `НП №${murkitData.delivery?.warehouseNumber || "N/A"} (${murkitData.deliveryType || "N/A"})`,
    };

    const wixOrderPayload = {
      order: {
        channelInfo: {
          type: "API",
          externalId: String(murkitData.id || murkitData.number) 
        },
        lineItems: lineItems,
        
        // 8. TOTALS / PRICE SUMMARY
        priceSummary: {
          subtotal: { amount: subtotalAmount, currency: currency },
          shipping: { amount: "0.00", currency: currency },
          tax: { amount: "0.00", currency: currency },
          discount: { amount: "0.00", currency: currency },
          total: { amount: totalAmount, currency: currency },
        },
        
        // 9. BILLING INFO (Клиент)
        billingInfo: {
          address: billingAddress,
          contactDetails: {
            firstName: clientName.firstName,
            lastName: clientName.lastName,
            phone: clientPhone,
            company: ""
          }
        },

        // 10. SHIPPING INFO (Получатель и детали доставки)
        shippingInfo: {
            title: `Доставка: ${murkitData.deliveryType || 'Не вказано'}`,
            logistics: {
                shippingDestination: {
                    address: shippingAddress,
                    contactDetails: {
                        firstName: recipientName.firstName,
                        lastName: recipientName.lastName,
                        phone: murkitData.recipient?.phone || clientPhone,
                        company: ""
                    }
                }
            },
            cost: {
                price: { amount: "0.00", currency: currency },
            }
        },
        
        paymentStatus: murkitData.payment_status === 'paid' ? 'PAID' : 'NOT_PAID',
        currency: currency,
        // Добавление кастомных полей заказа (например, комментарии, тип доставки)
        customFields: [
            { title: "Murkit Order ID", value: String(murkitData.id || murkitData.number) },
            { title: "Тип доставки", value: murkitData.deliveryType || "Не вказано" },
            { title: "Місто (НП)", value: murkitData.delivery?.settlementName || "Не вказано" },
            { title: "Відділення НП", value: murkitData.delivery?.warehouseNumber || "Не вказано" },
        ]
      }
    };

    // 11. Отправляем в Wix
    const createdOrder = await createWixOrder(wixOrderPayload);
    console.log('Order created in Wix:', createdOrder.order?.id);

    // 12. Отвечаем Murkit успешным статусом
    res.status(200).json({ 
        success: true, 
        wix_order_id: createdOrder.order?.id 
    });

  } catch (e) {
    console.error('Error processing Murkit webhook:', e);
    res.status(500).json({ error: e.message });
  }
}
