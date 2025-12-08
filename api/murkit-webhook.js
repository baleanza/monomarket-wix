import { createWixOrder, getProductsBySkus, findWixOrderByExternalId } from '../lib/wixClient.js';
import { ensureAuth } from '../lib/sheetsClient.js'; 

const WIX_STORES_APP_ID = "215238eb-22a5-4c36-9e7b-e7c08025e04e"; 

// === НАСТРОЙКИ НАЗВАНИЙ ДОСТАВКИ ===
const SHIPPING_TITLES = {
    BRANCH: "Нова Пошта (Відділення)", 
    COURIER: "Нова Пошта (Кур'єр)"
};

// Вспомогательная функция для создания ошибок с кодом
function createError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

function checkAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return false;
  const b64auth = authHeader.split(' ')[1];
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
  return login === process.env.MURKIT_USER && password === process.env.MURKIT_PASS;
}

async function readSheetData(sheets, spreadsheetId) {
  const importRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Import!A1:ZZ' });
  const controlRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Feed Control List!A1:F' });
  return { 
    importValues: importRes.data.values || [], 
    controlValues: controlRes.data.values || [] 
  };
}

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

  try {
    const murkitData = req.body;
    
    // Валидация входных данных (400)
    if (!murkitData.number) {
        throw createError(400, 'Missing order number');
    }

    const murkitOrderId = String(murkitData.number);
    console.log(`Processing Murkit Order #${murkitOrderId}`);

    // === ШАГ 0: ДЕДУПЛИКАЦИЯ (200 OK) ===
    const existingOrder = await findWixOrderByExternalId(murkitOrderId);
    if (existingOrder) {
        console.log(`Order #${murkitOrderId} already exists. ID: ${existingOrder.id}`);
        return res.status(200).json({ "id": existingOrder.id });
    }

    // === ВАЛИДАЦИЯ ТОВАРОВ (400) ===
    const murkitItems = murkitData.items || [];
    if (murkitItems.length === 0) {
        throw createError(400, 'No items in order');
    }

    const currency = "UAH";

    // 1. Sheets
    const { sheets, spreadsheetId } = await ensureAuth();
    const { importValues, controlValues } = await readSheetData(sheets, spreadsheetId);
    const codeToSkuMap = getProductSkuMap(importValues, controlValues);
    
    // 2. Resolve SKUs
    const wixSkusToFetch = [];
    const itemsWithSku = murkitItems.map(item => {
        const mCode = String(item.code).trim();
        const wSku = codeToSkuMap[mCode] || mCode;
        if(wSku) wixSkusToFetch.push(wSku);
        return { ...item, wixSku: wSku };
    });

    if (wixSkusToFetch.length === 0) {
        throw createError(400, 'No valid SKUs found to fetch from Wix');
    }

    // 3. Fetch Wix Products
    const wixProducts = await getProductsBySkus(wixSkusToFetch);
    
    // 4. Line Items
    const lineItems = [];
    
    for (const item of itemsWithSku) {
        const requestedQty = parseInt(item.quantity || 1, 10);
        const targetSku = item.wixSku; 

        // Ищем товар
        const productMatch = wixProducts.find(p => {
            if (String(p.sku) === targetSku) return true;
            if (p.variants) return p.variants.some(v => String(v.variant?.sku) === targetSku);
            return false;
        });

        // БИЗНЕС ОШИБКА: Товар не найден (409 Conflict)
        if (!productMatch) {
            throw createError(409, `Product with SKU '${targetSku}' (Murkit Code: ${item.code}) not found in Wix.`);
        }

        let catalogItemId = productMatch.id; 
        let variantId = null;
        let stockData = productMatch.stock;
        let productName = productMatch.name;
        
        let variantChoices = null; 
        let descriptionLines = []; 
        
        // Поиск Варианта
        let matchingVariant = null;
        if (productMatch.variants && productMatch.variants.length > 0) {
            matchingVariant = productMatch.variants.find(v => String(v.variant?.sku) === targetSku);
        }

        if (matchingVariant) {
            variantId = matchingVariant.variant.id; 
            stockData = matchingVariant.stock; 
            
            if (matchingVariant.variant.choices) {
                variantChoices = matchingVariant.variant.choices;
                descriptionLines = Object.entries(variantChoices).map(([k, v]) => ({
                    name: { original: k, translated: k },
                    plainText: { original: v, translated: v },
                    lineType: "PLAIN_TEXT"
                }));
            }
        }

        // БИЗНЕС ОШИБКА: Нет на остатках (409 Conflict)
        if (stockData.inStock === false) {
             throw createError(409, `SKU '${targetSku}' is marked as Out of Stock in Wix.`);
        }

        // БИЗНЕС ОШИБКА: Не хватает количества (409 Conflict)
        if (stockData.trackQuantity && (stockData.quantity < requestedQty)) {
             throw createError(409, `Insufficient stock for SKU '${targetSku}'. Requested: ${requestedQty}, Available: ${stockData.quantity}`);
        }

        // Картинка
        let imageObj = null;
        if (productMatch.media && productMatch.media.mainMedia && productMatch.media.mainMedia.image) {
            imageObj = {
                url: productMatch.media.mainMedia.image.url,
                width: productMatch.media.mainMedia.image.width,
                height: productMatch.media.mainMedia.image.height
            };
        }

        // Формируем Catalog Reference
        const catalogRef = {
            catalogItemId: catalogItemId,
            appId: WIX_STORES_APP_ID
        };

        if (variantId) {
            catalogRef.options = { variantId: variantId };
            if (variantChoices) {
                catalogRef.options.options = variantChoices;
            }
        }

        const lineItem = {
            quantity: requestedQty,
            catalogReference: catalogRef,
            productName: { original: productName },
            descriptionLines: descriptionLines,
            itemType: { preset: "PHYSICAL" },
            physicalProperties: { sku: targetSku, shippable: true },
            price: { amount: fmtPrice(item.price) },
            taxDetails: { taxRate: "0", totalTax: { amount: "0.00", currency: currency } }
        };

        if (imageObj) {
            lineItem.image = imageObj;
        }

        lineItems.push(lineItem);
    }

    // 5. Order Data Preparation
    const clientName = getFullName(murkitData.client?.name);
    const recipientName = getFullName(murkitData.recipient?.name);
    const phone = String(murkitData.client?.phone || murkitData.recipient?.phone || "").replace(/\D/g,'');
    const email = murkitData.client?.email || "monomarket@mywoodmood.com";

    const priceSummary = {
        subtotal: { amount: fmtPrice(murkitData.sum), currency },
        shipping: { amount: "0.00", currency }, 
        tax: { amount: "0.00", currency },
        discount: { amount: "0.00", currency },
        total: { amount: fmtPrice(murkitData.sum), currency }
    };

    // === ЛОГИКА ДОСТАВКИ ===
    const d = murkitData.delivery || {}; 
    const deliveryType = String(murkitData.deliveryType || '');
    
    const npCity = String(d.settlement || d.city || d.settlementName || '').trim();
    const street = String(d.address || '').trim();
    const house = String(d.house || '').trim();
    const flat = String(d.flat || '').trim();
    const npWarehouse = String(d.warehouseNumber || '').trim();

    let extendedFields = {};
    let finalAddressLine = "невідома адреса";
    let deliveryTitle = "Delivery";

    if (deliveryType.includes('courier')) {
        // КУРЬЕР
        deliveryTitle = SHIPPING_TITLES.COURIER; 
        
        const addressParts = [];
        if (street) addressParts.push(street);
        if (house) addressParts.push(`буд. ${house}`);
        if (flat) addressParts.push(`кв. ${flat}`);
        
        finalAddressLine = addressParts.length > 0 
            ? addressParts.join(', ') 
            : `Адресна доставка (${npCity})`;

    } else {
        // ОТДЕЛЕНИЕ
        deliveryTitle = SHIPPING_TITLES.BRANCH; 
        
        if (npWarehouse) {
            finalAddressLine = `Нова Пошта №${npWarehouse}`;
            extendedFields = {
                "namespaces": {
                    "_user_fields": {
                        "nomer_viddilennya_poshtomatu_novoyi_poshti": npWarehouse
                    }
                }
            };
        } else {
            finalAddressLine = "Нова Пошта (номер не указан)";
        }
    }

    const shippingAddress = {
        country: "UA",
        city: npCity || "City",
        addressLine: finalAddressLine, 
        postalCode: "00000"
    };

    const wixOrderPayload = {
        channelInfo: {
            type: "OTHER_PLATFORM",
            externalOrderId: murkitOrderId
        },
        status: "APPROVED",
        lineItems: lineItems,
        priceSummary: priceSummary,
        billingInfo: {
            address: shippingAddress, 
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
        weightUnit: "KG",
        taxIncludedInPrices: false,
        ...(Object.keys(extendedFields).length > 0 ? { extendedFields } : {})
    };

    const createdOrder = await createWixOrder(wixOrderPayload);
    
    // === 201 Created ===
    res.status(201).json({ 
        "id": createdOrder.order?.id
    });

  } catch (e) {
    console.error('Murkit Webhook Error:', e.message);
    
    // Если у ошибки есть статус (400 или 409), используем его. Иначе 500.
    const status = e.status || 500;
    
    res.status(status).json({ 
        error: e.message 
    });
  }
}
