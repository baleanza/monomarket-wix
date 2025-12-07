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
    // Учитываем вложенные объекты имени {first: "...", last: "..."}
    return {
        firstName: String(nameObj.first || nameObj.firstName || "Client"),
        lastName: String(nameObj.last || nameObj.lastName || "")
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
    const murkitOrderId = String(murkitData.number || murkitData.id); 
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
      .map(code => codeToSkuMap[code] || code) 
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
    const currency = "UAH";
    
    const totalAmount = String(parseFloat(murkitData.sum || 0).toFixed(2));
    const subtotalAmount = totalAmount; 
    
    const clientName = getFullName(murkitData.client?.name);
    const recipientName = getFullName(murkitData.recipient?.name);
    const defaultEmail = String(murkitData.client?.email || murkitData.recipient?.email || "monomarket@mywoodmood.com"); 
    const clientPhone = String(murkitData.client?.phone || murkitData.recipient?.phone || "");

    // 6. ФОРМИРОВАНИЕ LINE ITEMS
    const lineItems = murkitItems.map(item => {
        const murkitCode = String(item.code).trim();
        const wixSku = String(codeToSkuMap[murkitCode] || murkitCode); 
        const wixId = wixSku ? skuToIdMap[wixSku] : null;
        
        const price = String(parseFloat(item.price || 0).toFixed(2));

        const baseItem = {
            name: String(item.name || `Item ${murkitCode}`), 
            quantity: parseInt(item.quantity || 1, 10),
            price: {
                amount: price,
                currency: currency
            },
            
            physicalProperties: {
                sku: wixSku || "N/A", 
                shippable: true 
            },
            
            customFields: [
                { title: "SKU", value: wixSku },
                { title: "Murkit Code", value: murkitCode }
            ],
            totalPriceBeforeTax: { amount: price, currency: currency },
            totalPriceAfterTax: { amount: price, currency: currency },
            lineItemPrice: { amount: price, currency: currency }
        };

        if (!wixId) {
            console.warn(`Murkit Code ${murkitCode} (Wix SKU: ${wixSku}) not found in Wix, adding as custom item.`);
            return baseItem; 
        }

        return {
            ...baseItem,
            catalogReference: {
                catalogItemId: wixId,
                appId: "1380b703-ce81-ff05-f115-39571d94dfcd", // Wix Stores App ID
            }
        };
    });

    // 7. ФОРМИРОВАНИЕ TOTALS / PRICE SUMMARY
    const priceSummaryPayload = {
        subtotal: { amount: subtotalAmount, currency: currency },
        shipping: { amount: "0.00", currency: currency },
        tax: { amount: "0.00", currency: currency },
        discount: { amount: "0.00", currency: currency },
        total: { amount: totalAmount, currency: currency },
    };

    // 8. ФОРМИРОВАНИЕ ОБЪЕКТА ЗАКАЗА WIX
    
    // Адрес для Billing (Клиент)
    const billingAddress = {
        country: "UA",
        city: String(murkitData.delivery?.settlementName || "Не вказано"),
        addressLine: String("Телефон: " + clientPhone), 
        email: defaultEmail,
    };
    
    // Адрес для Shipping (Получатель)
    const shippingAddress = {
        country: "UA",
        city: String(murkitData.delivery?.settlementName || "Не вказано"),
        addressLine: String(`НП №${murkitData.delivery?.warehouseNumber || "N/A"} (${murkitData.deliveryType || "N/A"})`),
    };

    const wixOrderPayload = {
        channelInfo: {
          type: "API",
          externalId: murkitOrderId 
        },
        lineItems: lineItems,
        
        priceSummary: priceSummaryPayload,
        
        billingInfo: {
          address: billingAddress,
          contactDetails: {
            firstName: clientName.firstName,
            lastName: clientName.lastName,
            phone: clientPhone,
            // company: "" (удалено, чтобы избежать пустой строки)
          }
        },

        shippingInfo: {
            title: String(`Доставка: ${murkitData.deliveryType || 'Не вказано'}`),
            logistics: {
                shippingDestination: {
                    address: shippingAddress,
                    contactDetails: {
                        firstName: recipientName.firstName,
                        lastName: recipientName.lastName,
                        phone: murkitData.recipient?.phone || clientPhone,
                        // company: "" (удалено, чтобы избежать пустой строки)
                    }
                }
            },
            cost: {
                price: { amount: "0.00", currency: currency },
            }
        },
        
        paymentStatus: String(murkitData.paymentType && murkitData.paymentType.includes('mono') ? 'PAID' : 'NOT_PAID'),
        currency: currency,
        
        customFields: [
            { title: "Murkit Order ID", value: murkitOrderId },
            { title: "Тип доставки", value: String(murkitData.deliveryType || "Не вказано") },
            { title: "Місто (НП)", value: String(murkitData.delivery?.settlementName || "Не вказано") },
            { title: "Відділення НП", value: String(murkitData.delivery?.warehouseNumber || "Не вказано") },
        ]
    };

    // **** ДОБАВЛЕНО ДЛЯ ОТЛАДКИ (печатает JSON перед отправкой) ****
    console.log('Wix Payload (PRE-SEND):', JSON.stringify(wixOrderPayload, null, 2));
    // ********************************************************************


    // 9. Отправляем в Wix
    const createdOrder = await createWixOrder(wixOrderPayload);
    console.log('Order created in Wix:', createdOrder.order?.id);

    // 10. Отвечаем Murkit успешным статусом
    res.status(200).json({ 
        success: true, 
        wix_order_id: createdOrder.order?.id 
    });

  } catch (e) {
    console.error('Error processing Murkit webhook:', e);
    res.status(500).json({ error: e.message });
  }
}
