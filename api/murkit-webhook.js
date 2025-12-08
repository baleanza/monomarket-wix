import { createWixOrder, getProductsBySkus, findWixOrderByExternalId } from '../lib/wixClient.js';
import { ensureAuth } from '../lib/sheetsClient.js'; 

const WIX_STORES_APP_ID = "215238eb-22a5-4c36-9e7b-e7c08025e04e"; 

// === НАЛАШТУВАННЯ НАЗВ ДОСТАВКИ ===
const SHIPPING_TITLES = {
    BRANCH: "НП Відділення", 
    COURIER: "НП Кур'єр"
};

// Хелпер для створення кастомних помилок
function createError(status, message, code = null) {
    const err = new Error(message);
    err.status = status;
    if (code) err.code = code;
    return err;
}

// Нормалізація SKU: рядок, без пробілів
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
    
    // Валідація номеру замовлення
    if (!murkitData.number) throw createError(400, 'Missing order number');
    const murkitOrderId = String(murkitData.number);
    console.log(`Processing Murkit Order #${murkitOrderId}`);

    // === КРОК 0: ДЕДУПЛІКАЦІЯ ===
    const existingOrder = await findWixOrderByExternalId(murkitOrderId);
    if (existingOrder) {
        console.log(`Order #${murkitOrderId} already exists. ID: ${existingOrder.id}`);
        return res.status(200).json({ "id": existingOrder.number });
    }

    // === ВАЛІДАЦІЯ ТОВАРІВ ===
    const murkitItems = murkitData.items || [];
    if (murkitItems.length === 0) throw createError(400, 'No items in order');

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
    
    // === СТВОРЕННЯ МАПИ SKU (Flattening) ===
    // Щоб точно знаходити варіанти, ми "розгортаємо" структуру Wix в плаский об'єкт
    const skuMap = {};

    wixProducts.forEach(p => {
        // Додаємо батьківський SKU
        const pSku = normalizeSku(p.sku);
        if (pSku) {
            skuMap[pSku] = {
                type: 'product',
                product: p,
                variantData: null
            };
        }

        // Додаємо SKU варіантів
        if (p.variants && p.variants.length > 0) {
            p.variants.forEach(v => {
                const vSku = normalizeSku(v.variant?.sku);
                if (vSku) {
                    skuMap[vSku] = {
                        type: 'variant',
                        product: p,
                        variantData: v
                    };
                }
            });
        }
    });

    // 4. Line Items
    const lineItems = [];
    
    for (const item of itemsWithSku) {
        const requestedQty = parseInt(item.quantity || 1, 10);
        const targetSku = normalizeSku(item.wixSku); // Цільовий SKU

        // МИТТЄВИЙ ПОШУК ПО МАПІ
        const match = skuMap[targetSku];

        // === ПОМИЛКА: ТОВАР НЕ ЗНАЙДЕНО (409) ===
        if (!match) {
            throw createError(409, `Product with code ${item.code} not found`, "ITEM_NOT_FOUND");
        }

        const foundProduct = match.product;
        const foundVariant = match.variantData; // null, якщо це простий товар

        let catalogItemId = foundProduct.id; 
        let variantId = null;
        let stockData = foundProduct.stock; // Дефолт (батьківський)
        let productName = foundProduct.name;
        
        let variantChoices = null; 
        let descriptionLines = []; 
        
        // ЯКЩО ЦЕ ВАРІАНТ
        if (foundVariant) {
            console.log(`[INFO] SKU ${targetSku} confirmed as VARIANT: ${foundVariant.variant.id}`);
            
            variantId = foundVariant.variant.id; 
            stockData = foundVariant.stock; 
            
            // ВАЖЛИВО: Опції лежать в корені об'єкта варіанта (foundVariant.choices)
            if (foundVariant.choices) {
                variantChoices = foundVariant.choices; 
                
                // Формуємо descriptionLines
                descriptionLines = Object.entries(variantChoices).map(([k, v]) => ({
                    name: { original: k, translated: k },
                    plainText: { original: v, translated: v },
                    lineType: "PLAIN_TEXT"
                }));
            }
        } else {
            console.log(`[INFO] SKU ${targetSku} confirmed as SIMPLE PRODUCT`);
        }

        // === ПЕРЕВІРКА СТОКУ (409 ITEM_NOT_AVAILABLE) ===
        
        // 1. Якщо товар помічений як "немає в наявності"
        if (stockData.inStock === false) {
             throw createError(409, `Product with code ${item.code} has not enough stock`, "ITEM_NOT_AVAILABLE");
        }
        
        // 2. Якщо увімкнено трекінг кількості і її не вистачає
        if (stockData.trackQuantity && (stockData.quantity < requestedQty)) {
             throw createError(409, `Product with code ${item.code} has not enough stock`, "ITEM_NOT_AVAILABLE");
        }

        // Картинка
        let imageObj = null;
        if (foundProduct.media && foundProduct.media.mainMedia && foundProduct.media.mainMedia.image) {
            imageObj = {
                url: foundProduct.media.mainMedia.image.url,
                width: foundProduct.media.mainMedia.image.width,
                height: foundProduct.media.mainMedia.image.height
            };
        }

        // Формуємо посилання на каталог
        const catalogRef = {
            catalogItemId: catalogItemId,
            appId: WIX_STORES_APP_ID
        };

        if (variantId) {
            catalogRef.options = { variantId: variantId };
            // Додаємо карту опцій, щоб Wix коректно відобразив варіант
            if (variantChoices) {
                catalogRef.options.options = variantChoices;
            }
        }

        const lineItem = {
            quantity: requestedQty,
            catalogReference: catalogRef,
            productName: { original: productName },
            descriptionLines: descriptionLines, // Передаємо опції
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

    // === ЛОГІКА ДОСТАВКИ ===
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
        // КУР'ЄР
        deliveryTitle = SHIPPING_TITLES.COURIER; 
        
        const addressParts = [];
        if (street) addressParts.push(street);
        if (house) addressParts.push(`буд. ${house}`);
        if (flat) addressParts.push(`кв. ${flat}`);
        
        finalAddressLine = addressParts.length > 0 
            ? addressParts.join(', ') 
            : `Адресна доставка (${npCity})`;

    } else {
        // ВІДДІЛЕННЯ
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
    
    res.status(201).json({ 
        "id": createdOrder.order?.number
    });

  } catch (e) {
    console.error('Murkit Webhook Error:', e.message);
    
    const status = e.status || 500;
    
    // Кастомний формат відповіді для бізнес-помилок 409
    if (status === 409 && (e.code === 'ITEM_NOT_FOUND' || e.code === 'ITEM_NOT_AVAILABLE')) {
        return res.status(409).json({
            message: e.message,
            code: e.code
        });
    }

    // Звичайний формат помилки
    res.status(status).json({ 
        error: e.message 
    });
  }
}
