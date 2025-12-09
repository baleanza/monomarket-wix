import { 
    createWixOrder, 
    getProductsBySkus, 
    findWixOrderByExternalId, 
    getWixOrderFulfillments, 
    cancelWixOrderByExternalId 
} from '../lib/wixClient.js'; 
import { ensureAuth } from '../lib/sheetsClient.js'; 

const WIX_STORES_APP_ID = "215238eb-22a5-4c36-9e7b-e7c08025e04e"; 

// === МАПІНГ ДЛЯ СТВОРЕННЯ ЗАМОВЛЕННЯ (Murkit Input -> Wix Title) ===
const MURKIT_TO_WIX_CREATION_MAPPING = {
    "nova-post": "НП Відділення", // Стандарт для відділень і поштоматів
    "courier-nova-post": "НП Кур'єр"
};

// === МАПІНГ ДЛЯ ОТРИМАННЯ СТАТУСУ (Wix Title -> Murkit Output) ===
// Враховує, що "НП Відділення" та "НП Поштомат" мапляться в "nova-post"
const WIX_TO_MURKIT_STATUS_MAPPING = {
    "НП Відділення": "nova-post", 
    "НП Кур'єр": "courier-nova-post",
    "НП Поштомат": "nova-post"
};

// === ІСНУЮЧІ ХЕЛПЕРИ З ВАШОГО КОДУ ===
function createError(status, message, code = null) {
    const err = new Error(message);
    err.status = status;
    if (code) err.code = code;
    return err;
}

function normalizeSku(sku) {
    if (!sku) return '';
    return String(sku).trim();
}

function checkAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return false;
  const b64auth = authHeader.split(' ')[1];
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
  return login === process.env.MURKIT_USER && password === process.env.MURKIT_PASS;
}

// readSheetData (ІСНУЮЧИЙ)
async function readSheetData(sheets, spreadsheetId) {
  const importRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Import!A1:ZZ' });
  const controlRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Feed Control List!A1:F' });
  return { 
    importValues: importRes.data.values || [], 
    controlValues: controlRes.data.values || [] 
  };
}

// getProductSkuMap (ІСНУЮЧИЙ)
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

// --- ФУНКЦІЯ: Мапінг статусу Wix до формату Murkit ---
function mapWixOrderToMurkitResponse(wixOrder, fulfillments, externalId) {
    const orderStatus = wixOrder.fulfillmentStatus || wixOrder.status;
    const wixShippingLine = wixOrder.shippingInfo?.title || ''; 

    let murkitStatus = 'accepted';
    let murkitCancelStatus = null;
    let shipmentType = null;
    let shipment = null;
    let ttn = null;

    // 1. Обробка скасування
    if (wixOrder.status === 'CANCELED') { 
        murkitStatus = 'canceled';
        murkitCancelStatus = 'canceled';
    } 
    
    // 2. Визначення статусу виконання/відправлення
    else if (orderStatus === 'FULFILLED') {
        murkitStatus = 'sent';
    } 
    else {
        murkitStatus = 'accepted';
    }

    // 3. Обробка Fulfillments (Відправлення) для отримання TTN
    if (Array.isArray(fulfillments) && fulfillments.length > 0) {
        const fulfillmentWithTtn = fulfillments
            .find(f => f.trackingInfo && f.trackingInfo.trackingNumber);
        
        if (fulfillmentWithTtn) {
            ttn = fulfillmentWithTtn.trackingInfo.trackingNumber;
        }
    }

    // 4. Мапінг способу доставки та TTN (Тільки якщо статус 'sent' і є TTN)
    const normalizedShippingLine = wixShippingLine.trim();
    if (murkitStatus === 'sent' && ttn) {
        // Використовуємо WIX_TO_MURKIT_STATUS_MAPPING для зворотного мапінгу
        shipmentType = WIX_TO_MURKIT_STATUS_MAPPING[normalizedShippingLine] || 'nova-post'; 
        shipment = { ttn: ttn };
    }
    
    return {
        id: externalId,
        status: murkitStatus,
        cancelStatus: murkitCancelStatus,
        shipmentType: shipmentType,
        shipment: shipment
    };
}


// --- ОСНОВНИЙ ОБРОБНИК (Handler) ---
export default async function handler(req, res) {
    if (!checkAuth(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const urlPath = req.url;

    // --- 1. PUT Cancel Order Endpoint ---
    const cancelOrderPathMatch = urlPath.match(/\/orders\/([^/]+)\/cancel$/);
    if (req.method === 'PUT' && cancelOrderPathMatch) {
        const murkitOrderId = cancelOrderPathMatch[1]; 

        try {
            const cancelResult = await cancelWixOrderByExternalId(murkitOrderId);

            if (cancelResult.status === 404) {
                 return res.status(404).json({ message: 'Order does not exist', code: 'NOT_FOUND' });
            }
            if (cancelResult.status === 409) {
                let message;
                if (cancelResult.code === 'ORDER_ALREADY_CANCELED') {
                    message = 'Order already canceled';
                } else if (cancelResult.code === 'CANNOT_CANCEL_ORDER') {
                    message = 'Order already completed';
                } else {
                    message = 'Cannot cancel order';
                }
                 return res.status(409).json({ message: message, code: cancelResult.code });
            }
            
            if (cancelResult.status === 200) {
                const wixOrder = await findWixOrderByExternalId(murkitOrderId);
                const fulfillments = await getWixOrderFulfillments(cancelResult.wixOrderId);
                
                if (!wixOrder) {
                     return res.status(500).json({ message: 'Internal server error: Order status not found after successful cancellation request', code: 'INTERNAL_ERROR' });
                }
                
                const murkitResponse = mapWixOrderToMurkitResponse(wixOrder, fulfillments, murkitOrderId);
                return res.status(200).json(murkitResponse);
            }

        } catch (error) {
            console.error('PUT Cancel Order Error:', error);
            return res.status(500).json({ message: 'Internal server error while processing cancellation request', code: 'INTERNAL_ERROR' });
        }
    }
    
    // --- 2. GET Order Endpoint (Отримання статусу одного замовлення) ---
    const singleOrderPathMatch = urlPath.match(/\/orders\/([^/]+)$/);
    if (req.method === 'GET' && singleOrderPathMatch) {
        const murkitOrderId = singleOrderPathMatch[1];

        try {
            const wixOrder = await findWixOrderByExternalId(murkitOrderId);

            if (!wixOrder) {
                return res.status(404).json({ message: 'Order does not exist', code: 'NOT_FOUND' });
            }
            
            const fulfillments = await getWixOrderFulfillments(wixOrder.id);

            const murkitResponse = mapWixOrderToMurkitResponse(wixOrder, fulfillments, murkitOrderId);
            return res.status(200).json(murkitResponse);

        } catch (error) {
            console.error('GET Order Error:', error);
            return res.status(500).json({ message: 'Internal server error while processing order status', code: 'INTERNAL_ERROR' });
        }
    }

    // --- 3. POST Order Batch Endpoint (Отримання статусу кількох замовлень) ---
    if (req.method === 'POST' && urlPath.includes('/orders/batch')) {
        let orderIds;
        try {
            orderIds = req.body && req.body.orders;
            if (!Array.isArray(orderIds) || orderIds.length === 0) {
                return res.status(400).json({ message: 'Invalid or empty "orders" array in request body', code: 'BAD_REQUEST' });
            }
        } catch (e) {
            return res.status(400).json({ message: 'Invalid JSON body or missing "orders" array', code: 'BAD_REQUEST' });
        }

        const responses = [];
        const errors = [];
        
        await Promise.all(orderIds.map(async (murkitOrderId) => {
            try {
                const wixOrder = await findWixOrderByExternalId(murkitOrderId);

                if (!wixOrder) {
                    errors.push({ id: murkitOrderId, message: 'Order does not exist', code: 'NOT_FOUND' });
                } else {
                    const fulfillments = await getWixOrderFulfillments(wixOrder.id);
                    responses.push(mapWixOrderToMurkitResponse(wixOrder, fulfillments, murkitOrderId));
                }

            } catch (error) {
                console.error(`POST Order Batch Error for ID ${murkitOrderId}:`, error);
                errors.push({ id: murkitOrderId, message: 'Internal server error while fetching order status', code: 'INTERNAL_ERROR' });
            }
        }));

        return res.status(200).json({ orders: responses, errors: errors });
    }

    // --- 4. ІСНУЮЧА ЛОГІКА POST (Створення замовлення) ---
    if (req.method === 'POST') {
        
        if (urlPath.includes('/orders/')) {
            return res.status(404).json({ message: 'Not Found' });
        }

        try {
            const murkitData = req.body;
            
            if (!murkitData.number) throw createError(400, 'Missing order number');
            const murkitOrderId = String(murkitData.number);
            console.log(`Processing Murkit Order #${murkitOrderId}`);

            // === КРОК 0: ДЕДУПЛІКАЦІЯ ===
            const existingOrder = await findWixOrderByExternalId(murkitOrderId);
            if (existingOrder) {
                console.log(`Order #${murkitOrderId} already exists. ID: ${existingOrder.id}`);
                // Повертаємо 200 зі знайденим ID
                return res.status(200).json({ "id": existingOrder.id });
            }

            // === ВАЛІДАЦІЯ ТОВАРІВ ===
            const murkitItems = murkitData.items || [];
            if (murkitItems.length === 0) throw createError(400, 'No items in order');

            const currency = "UAH";

            // 1. Sheets
            const sheets = await ensureAuth();
            const { importValues, controlValues } = await readSheetData(sheets, process.env.SHEETS_ID);
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
            
            // === СТВОРЕННЯ МАПИ SKU (Flattening) ===
            const skuMap = {};

            wixProducts.forEach(p => {
                const pSku = normalizeSku(p.sku);
                if (pSku) {
                    skuMap[pSku] = { type: 'product', product: p, variantData: null };
                }

                if (p.variants && p.variants.length > 0) {
                    p.variants.forEach(v => {
                        const vSku = normalizeSku(v.variant?.sku);
                        if (vSku) {
                            skuMap[vSku] = { type: 'variant', product: p, variantData: v };
                        }
                    });
                }
            });

            // 4. Line Items
            const lineItems = [];
            for (const item of itemsWithSku) {
                const requestedQty = parseInt(item.quantity || 1, 10);
                const targetSku = normalizeSku(item.wixSku);

                const match = skuMap[targetSku];

                if (!match) {
                    throw createError(409, `Product with code ${item.code} not found`, "ITEM_NOT_FOUND");
                }

                const foundProduct = match.product;
                const foundVariant = match.variantData; 

                let catalogItemId = foundProduct.id; 
                let variantId = null;
                let stockData = foundProduct.stock;
                let productName = foundProduct.name;
                
                let variantChoices = null; 
                let descriptionLines = []; 
                
                if (foundVariant) {
                    variantId = foundVariant.variant.id; 
                    stockData = foundVariant.stock; 
                    
                    if (foundVariant.choices) {
                        variantChoices = foundVariant.choices; 
                        
                        descriptionLines = Object.entries(variantChoices).map(([k, v]) => ({
                            name: { original: k, translated: k },
                            plainText: { original: v, translated: v },
                            lineType: "PLAIN_TEXT"
                        }));
                    }
                }

                // === ПЕРЕВІРКА СТОКУ (409 ITEM_NOT_AVAILABLE) ===
                if (stockData.inStock === false || (stockData.trackQuantity && (stockData.quantity < requestedQty))) {
                     throw createError(409, `Product with code ${item.code} has not enough stock`, "ITEM_NOT_AVAILABLE");
                }

                let imageObj = null;
                if (foundProduct.media && foundProduct.media.mainMedia && foundProduct.media.mainMedia.image) {
                    imageObj = {
                        url: foundProduct.media.mainMedia.image.url,
                        width: foundProduct.media.mainMedia.image.width,
                        height: foundProduct.media.mainMedia.image.height
                    };
                }

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

            // === ЛОГІКА ДОСТАВКИ (ОНОВЛЕНО) ===
            const d = murkitData.delivery || {}; 
            // Ключ - це рядок "nova-post" або "courier-nova-post"
            const deliveryTypeKey = String(murkitData.deliveryType || 'nova-post').toLowerCase(); 
            
            // Використовуємо мапінг для встановлення коректної Wix назви
            const deliveryTitle = MURKIT_TO_WIX_CREATION_MAPPING[deliveryTypeKey] || "Delivery"; 

            const npCity = String(d.settlement || d.city || d.settlementName || '').trim();
            const street = String(d.address || '').trim();
            const house = String(d.house || '').trim();
            const flat = String(d.flat || '').trim();
            const npWarehouse = String(d.warehouseNumber || '').trim();

            let extendedFields = {};
            let finalAddressLine = "невідома адреса";

            if (deliveryTypeKey.includes('courier')) {
                // КУР'ЄР
                const addressParts = [];
                if (street) addressParts.push(street);
                if (house) addressParts.push(`буд. ${house}`);
                if (flat) addressParts.push(`кв. ${flat}`);
                
                finalAddressLine = addressParts.length > 0
                    ? addressParts.join(', ') 
                    : `Адресна доставка (${npCity})`;

            } else {
                // ВІДДІЛЕННЯ/ПОШТОМАТ (мапиться в Wix як "НП Відділення")
                if (npWarehouse) {
                    finalAddressLine = `Нова Пошта №${npWarehouse}`;
                    extendedFields = {
                        "namespaces": {
                            "_user_fields": {
                                // Використовуємо поле для номера відділення/поштомату
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
                    title: deliveryTitle, // ВИКОРИСТОВУЄМО ОНОВЛЕНИЙ deliveryTitle
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
            
            return res.status(201).json({ 
                "id": createdOrder.order?.id
            });

        } catch (e) {
            console.error('Murkit Webhook Error:', e.message);
            
            const status = e.status || 500;
            
            if (status === 409 && (e.code === 'ITEM_NOT_FOUND' || e.code === 'ITEM_NOT_AVAILABLE')) {
                return res.status(409).json({
                    message: e.message,
                    code: e.code
                });
            }

            return res.status(status).json({ 
                error: e.message 
            });
        }
    }

    // 5. Обробка невідомих маршрутів/методів
    return res.status(404).json({ message: 'Not Found' });
}
