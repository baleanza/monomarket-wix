import { createWixOrder, getProductsBySkus, findWixOrderByExternalId } from '../lib/wixClient.js';
import { ensureAuth } from '../lib/sheetsClient.js'; 

const WIX_STORES_APP_ID = "215238eb-22a5-4c36-9e7b-e7c08025e04e"; 

// === НАСТРОЙКИ НАЗВАНИЙ ДОСТАВКИ ===
const SHIPPING_TITLES = {
    BRANCH: "Нова Пошта (Відділення)", 
    COURIER: "Нова Пошта (Кур'єр)"
};

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

  let debugPayload = null;

  try {
    const murkitData = req.body;
    // Приводим ID к строке для надежности
    const murkitOrderId = String(murkitData.number);
    console.log(`Processing Murkit Order #${murkitOrderId}`);

    // === ШАГ 0: ДЕДУПЛИКАЦИЯ (ПРОВЕРКА НА СУЩЕСТВОВАНИЕ) ===
    // Если заказ уже есть, возвращаем 200 и его ID
    const existingOrder = await findWixOrderByExternalId(murkitOrderId);
    
    if (existingOrder) {
        console.log(`Order #${murkitOrderId} already exists in Wix (ID: ${existingOrder.id}). Skipping creation.`);
        // Возвращаем 200 ОК
        return res.status(200).json({
            "id": existingOrder.id
        });
    }

    // === ЕСЛИ НЕ НАЙДЕН - НАЧИНАЕМ СОЗДАНИЕ ===
    
    const murkitItems = murkitData.items || [];
    if (murkitItems.length === 0) return res.status(400).json({ error: 'No items in order' });

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
        return res.status(400).json({ error: 'No valid SKUs found to fetch from Wix' });
    }

    // 3. Fetch Wix Products
    const wixProducts = await getProductsBySkus(wixSkusToFetch);
    
    // 4. Line Items
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
        
        // Картинка
        let imageObj = null;
        if (productMatch.media && productMatch.media.mainMedia && productMatch.media.mainMedia.image) {
            imageObj = {
                url: productMatch.media.mainMedia.image.url,
                width: productMatch.media.mainMedia.image.width,
                height: productMatch.media.mainMedia.image.height
            };
        }

        // Поиск Варианта и его Опций
        let descriptionLines = [];
        
        if (String(productMatch.sku) !== targetSku && productMatch.variants) {
            const variantMatch = productMatch.variants.find(v => String(v.variant?.sku) === targetSku);
            if (variantMatch) {
                variantId = variantMatch.variant.id; 
                stockData = variantMatch.stock; 
                
                // Формируем descriptionLines (Размер: L и т.д.)
                if (variantMatch.variant.choices) {
                     descriptionLines = Object.entries(variantMatch.variant.choices).map(([optName, optValue]) => ({
                        name: { original: optName, translated: optName },
                        plainText: { original: optValue, translated: optValue }
                    }));
                }
            }
        }

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
        if (variantId) {
            catalogRef.options = { variantId: variantId };
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

    // === ЛОГИКА ДОСТАВКИ (С Курьером) ===
    const d = murkitData.delivery || {}; 
    const deliveryType = String(murkitData.deliveryType || '');
    
    // Извлекаем поля адреса
    const npCity = String(d.settlement || d.city || d.settlementName || '').trim();
    const street = String(d.address || '').trim();
    const house = String(d.house || '').trim();
    const flat = String(d.flat || '').trim();
    const npWarehouse = String(d.warehouseNumber || '').trim();

    let extendedFields = {};
    let finalAddressLine = "невідома адреса";
    let deliveryTitle = "Delivery";

    if (deliveryType.includes('courier')) {
        // === КУРЬЕР ===
        deliveryTitle = SHIPPING_TITLES.COURIER; 
        
        // Сборка полного адреса: Улица, Дом, Квартира
        const addressParts = [];
        if (street) addressParts.push(street);
        if (house) addressParts.push(`буд. ${house}`);
        if (flat) addressParts.push(`кв. ${flat}`);
        
        // Если удалось собрать адрес - используем его, иначе пишем город
        finalAddressLine = addressParts.length > 0 
            ? addressParts.join(', ') 
            : `Адресна доставка (${npCity})`;

    } else {
        // === ОТДЕЛЕНИЕ / ПОЧТОМАТ ===
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

    debugPayload = wixOrderPayload;

    const createdOrder = await createWixOrder(wixOrderPayload);
    
    // === УСПЕХ: 201 Created + ID ===
    res.status(201).json({ 
        "id": createdOrder.order?.id
    });

  } catch (e) {
    console.error('Murkit Webhook Error:', e.message);
    res.status(500).json({ 
        error: e.message,
        // Можно раскомментировать для отладки, но для продакшена лучше убрать
        // debug_payload: debugPayload 
    });
  }
}
