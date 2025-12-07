import { createWixOrder, getProductsBySkus } from '../lib/wixClient.js';
import { ensureAuth } from '../lib/sheetsClient.js'; 

const WIX_STORES_APP_ID = "215238eb-22a5-4c36-9e7b-e7c08025e04e"; 

// Проверка Auth
function checkAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return false;
  const b64auth = authHeader.split(' ')[1];
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
  return login === process.env.MURKIT_USER && password === process.env.MURKIT_PASS;
}

// Чтение таблицы
async function readSheetData(sheets, spreadsheetId) {
  const importRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Import!A1:ZZ' });
  const controlRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Feed Control List!A1:F' });
  return { 
    importValues: importRes.data.values || [], 
    controlValues: controlRes.data.values || [] 
  };
}

// Маппинг
function getProductSkuMap(importValues, controlValues) {
    const headers = importValues[0] || [];
    const rows = importValues.slice(1);
    const controlHeaders = controlValues[0] || [];
    const controlRows = controlValues.slice(1);

    const idxImportField = controlHeaders.indexOf('Import field');
    const idxFeedName = controlHeaders.indexOf('Feed name');

    let murkitCodeColRaw = '';
    let wixSkuColRaw = '';

    controlRows.forEach(row => {
        const importField = row[idxImportField];
        const feedName = row[idxFeedName];
        if (feedName === 'code') murkitCodeColRaw = String(importField).trim();
        if (feedName === 'id') wixSkuColRaw = String(importField).trim();
    });
    
    const murkitCodeColIndex = headers.indexOf(murkitCodeColRaw);
    const wixSkuColIndex = headers.indexOf(wixSkuColRaw);
    
    if (murkitCodeColIndex === -1 || wixSkuColIndex === -1) return {};

    const map = {};
    rows.forEach(row => {
        const mCode = row[murkitCodeColIndex] ? String(row[murkitCodeColIndex]).trim() : '';
        const wSku = row[wixSkuColIndex] ? String(row[wixSkuColIndex]).trim() : '';
        if (mCode && wSku) map[mCode] = wSku;
    });
    return map;
}

const fmtPrice = (num) => parseFloat(num || 0).toFixed(2);

function getFullName(nameObj) {
    if (!nameObj) return { firstName: "Client", lastName: "" };
    return {
        firstName: String(nameObj.first || nameObj.firstName || "Client"),
        lastName: String(nameObj.last || nameObj.lastName || "")
    };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  // Переменная для сохранения тела запроса (для отладки)
  let debugPayload = null;

  try {
    const murkitData = req.body;
    console.log(`Processing Murkit Order #${murkitData.number}`);

    const murkitItems = murkitData.items || [];
    if (murkitItems.length === 0) return res.status(400).json({ error: 'No items in order' });

    // 1. Данные из таблицы
    const { sheets, spreadsheetId } = await ensureAuth();
    const { importValues, controlValues } = await readSheetData(sheets, spreadsheetId);
    const codeToSkuMap = getProductSkuMap(importValues, controlValues);
    
    // 2. Получаем Wix SKU
    const wixSkusToFetch = [];
    const itemsWithSku = murkitItems.map(item => {
        const mCode = String(item.code).trim();
        const wSku = codeToSkuMap[mCode] || mCode;
        if(wSku) wixSkusToFetch.push(wSku);
        return { ...item, wixSku: wSku };
    });

    if (wixSkusToFetch.length === 0) {
        return res.status(400).json({ error: 'No valid SKUs found to fetch from Wix' });
    }

    // 3. Запрос товаров из Wix
    const wixProducts = await getProductsBySkus(wixSkusToFetch);
    
    // 4. Сборка Line Items
    const lineItems = [];
    
    for (const item of itemsWithSku) {
        const requestedQty = parseInt(item.quantity || 1, 10);
        const targetSku = item.wixSku;

        const productMatch = wixProducts.find(p => {
            if (String(p.sku) === targetSku) return true;
            if (p.variants) return p.variants.some(v => String(v.variant?.sku) === targetSku);
            return false;
        });

        if (!productMatch) {
            throw new Error(`Product with SKU '${targetSku}' (Murkit Code: ${item.code}) not found in Wix.`);
        }

        let catalogItemId = productMatch.id; 
        let variantId = null;
        let stockData = productMatch.stock;
        let productName = productMatch.name;

        // Если это вариант
        if (String(productMatch.sku) !== targetSku && productMatch.variants) {
            const variantMatch = productMatch.variants.find(v => String(v.variant?.sku) === targetSku);
            if (variantMatch) {
                variantId = variantMatch.variant.id; 
                stockData = variantMatch.stock; 
            }
        }

        // Проверка стока
        if (stockData.trackQuantity && (stockData.quantity < requestedQty)) {
             throw new Error(`Insufficient stock for SKU '${targetSku}'. Requested: ${requestedQty}, Available: ${stockData.quantity}`);
        }
        if (stockData.inStock === false) {
             throw new Error(`SKU '${targetSku}' is marked as Out of Stock in Wix.`);
        }

        const catalogRef = {
            catalogItemId: catalogItemId,
            appId: WIX_STORES_APP_ID
        };
        // Добавляем options только если есть вариант
        if (variantId) {
            catalogRef.options = { variantId: variantId };
        }

        lineItems.push({
            quantity: requestedQty,
            catalogReference: catalogRef,
            productName: {
                original: productName 
            },
            itemType: {
                preset: "PHYSICAL"
            },
            physicalProperties: {
                sku: targetSku,
                shippable: true
            },
            price: {
                amount: fmtPrice(item.price)
            }
        });
    }

    // 5. Подготовка данных заказа
    const currency = "UAH";
    const clientName = getFullName(murkitData.client?.name);
    const recipientName = getFullName(murkitData.recipient?.name);
    const phone = String(murkitData.client?.phone || murkitData.recipient?.phone || "").replace(/\D/g,'');
    const email = murkitData.client?.email || "monomarket@mywoodmood.com";

    const deliveryTitle = `${murkitData.deliveryType || 'Delivery'} (${murkitData.delivery?.settlementName || ''})`;
    const shippingAddress = {
        country: "UA",
        city: String(murkitData.delivery?.settlementName || "City"),
        addressLine: `Nova Poshta: ${murkitData.delivery?.warehouseNumber || '1'}`,
        postalCode: "00000"
    };

    const priceSummary = {
        subtotal: { amount: fmtPrice(murkitData.sum), currency },
        shipping: { amount: "0.00", currency }, 
        tax: { amount: "0.00", currency },
        discount: { amount: "0.00", currency },
        total: { amount: fmtPrice(murkitData.sum), currency }
    };

    const wixOrderPayload = {
        channelInfo: {
            type: "WEB", // Изменено с API на WEB
            externalId: String(murkitData.number)
        },
        lineItems: lineItems,
        priceSummary: priceSummary,
        billingInfo: {
            address: { 
                country: "UA", 
                city: String(murkitData.delivery?.settlementName || "City"),
                addressLine: "Client Address", 
                postalCode: "00000" 
            },
            contactDetails: {
                firstName: clientName.firstName,
                lastName: clientName.lastName,
                phone: phone,
                email: email
            }
        },
        shippingInfo: {
            title: deliveryTitle,
            logistics: {
                shippingDestination: {
                    address: shippingAddress,
                    contactDetails: {
                        firstName: recipientName.firstName,
                        lastName: recipientName.lastName,
                        phone: phone
                    }
                }
            },
            cost: { price: { amount: "0.00", currency } }
        },
        buyerInfo: { email: email },
        paymentStatus: (murkitData.payment_status === 'paid' || String(murkitData.paymentType || '').includes('paid')) ? "PAID" : "NOT_PAID",
        currency: currency,
        weightUnit: "KG"
    };

    // Сохраняем для отладки перед отправкой
    debugPayload = wixOrderPayload;

    // 6. Отправка заказа
    const createdOrder = await createWixOrder(wixOrderPayload);
    
    res.status(200).json({ 
        success: true, 
        wix_order_id: createdOrder.order?.id,
        murkit_number: murkitData.number
    });

  } catch (e) {
    console.error('Murkit Webhook Error:', e.message);
    // ВОЗВРАЩАЕМ JSON С ОШИБКОЙ И ТЕЛОМ ЗАПРОСА
    res.status(500).json({ 
        error: e.message,
        debug_payload_sent_to_wix: debugPayload 
    });
  }
}
