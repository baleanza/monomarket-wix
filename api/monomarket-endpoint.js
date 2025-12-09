import { 
    createWixOrder, 
    getProductsBySkus, 
    findWixOrderByExternalId, 
    findWixOrderById, 
    getWixOrderFulfillments, 
    cancelWixOrderById,
    adjustInventory,
    getWixOrderFulfillmentsBatch
} from '../lib/wixClient.js';
import { ensureAuth } from '../lib/sheetsClient.js'; 

const WIX_STORES_APP_ID = "215238eb-22a5-4c36-9e7b-e7c08025e04e"; 

// === SHIPPING TITLE CONFIGURATION (for order creation) ===
const SHIPPING_TITLES = {
    BRANCH: "НП Відділення",  
    COURIER: "НП Кур'єр"
};

// === MAPPING FOR STATUS RETRIEVAL (for status fetching) ===
const WIX_TO_MURKIT_STATUS_MAPPING = {
    "НП Відділення": "nova-post", 
    "НП Кур'єр": "courier-nova-post",
    "НП Поштомат": "nova-post"
};

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

// readSheetData (FINAL FIX: Uses ONLY sequential reading with enhanced checks)
async function readSheetData(sheets, spreadsheetId) {
    let importRes, controlRes;
    
    console.log('Sheets: Starting SEQUENTIAL fetch for Import and Feed Control Lists.');
    
    try {
        // FIX: Fetch 1: Import List (Sequential call, restored original successful logic)
        importRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Import!A1:ZZ' });
        
        // FIX: Fetch 2: Control List (Sequential call, restored original successful logic)
        controlRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Feed Control List!A1:F' });
        
    } catch (e) {
        // Log the full error to help with diagnostics
        console.error('Sheets API Call FAILED (Sequential Catch):', e.message);
        throw createError(500, `Failed to fetch data from Google Sheets (API ERROR): ${e.message}`, "SHEETS_API_ERROR");
    }

    // Safely access data, preventing the "Cannot read properties of undefined (reading 'values')" error
    const importValues = (importRes && importRes.data && importRes.data.values) ? importRes.data.values : [];
    const controlValues = (controlRes && controlRes.data && controlRes.data.values) ? controlRes.data.values : [];
    
    // CRITICAL CHECK: If data is unexpectedly empty
    if (importValues.length === 0 || controlValues.length === 0) {
        throw createError(500, 'Sheets: Empty or invalid data retrieved from critical sheets (check data ranges and sheet names).', "SHEETS_DATA_EMPTY");
    }
    
    console.log('Sheets: Data fetched successfully (Sequential).');
    
    return { 
        importValues: importValues, 
        controlValues: controlValues 
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

// --- FUNCTION: Mapping Wix Status to Murkit Response Format ---
function mapWixOrderToMurkitResponse(wixOrder, fulfillments, externalId) {
    const orderStatus = wixOrder.fulfillmentStatus || wixOrder.status;
    const wixShippingLine = wixOrder.shippingInfo?.title || ''; 

    let murkitStatus = 'accepted';
    let murkitCancelStatus = null;
    let shipmentType = null;
    let shipment = null;
    let ttn = null;

    if (wixOrder.status === 'CANCELED') { 
        murkitStatus = 'canceled';
        murkitCancelStatus = 'canceled';
    } 
    else if (orderStatus === 'FULFILLED') {
        murkitStatus = 'sent';
    } 
    else {
        murkitStatus = 'accepted';
    }

    // CHECK IF FULFILLMENT DATA CONTAINS TTN
    if (Array.isArray(fulfillments) && fulfillments.length > 0) {
        const fulfillmentWithTtn = fulfillments
            .find(f => f.trackingInfo && String(f.trackingInfo.trackingNumber || '').trim().length > 0);
        
        if (fulfillmentWithTtn) {
            ttn = String(fulfillmentWithTtn.trackingInfo.trackingNumber).trim();
        }
    }

    const normalizedShippingLine = wixShippingLine.trim();
    if (murkitStatus === 'sent' && ttn) {
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


// --- MAIN HANDLER ---
export default async function handler(req, res) {
    // 0. Initial Auth Check
    if (!checkAuth(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // FIX 1: URL cleanup
    const urlPathFull = req.url;
    const urlPath = urlPathFull.split('?')[0]; 

    // --- 1. PUT Cancel Order Endpoint ---
    const cancelOrderPathMatch = urlPath.match(/\/orders\/([^/]+)\/cancel$/);
    if (req.method === 'PUT' && cancelOrderPathMatch) {
        const wixOrderId = cancelOrderPathMatch[1]; 

        try {
            const cancelResult = await cancelWixOrderById(wixOrderId);

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
                const wixOrder = await findWixOrderById(wixOrderId);
                // Use single GET for cancel check (not performance critical here)
                const fulfillments = await getWixOrderFulfillments(wixOrderId); 
                
                if (!wixOrder) {
                     return res.status(500).json({ message: 'Internal server error: Order status not found after successful cancellation request', code: 'INTERNAL_ERROR' });
                }
                
                const murkitResponse = mapWixOrderToMurkitResponse(wixOrder, fulfillments, wixOrderId);
                return res.status(200).json(murkitResponse);
            }

        } catch (error) {
            console.error('PUT Cancel Order Error:', error);
            return res.status(500).json({ message: 'Internal server error while processing cancellation request', code: 'INTERNAL_ERROR' });
        }
    }
    
    // --- 2. GET Order Endpoint (FINAL FIX: Uses Batch for reliability) ---
    const singleOrderPathMatch = urlPath.match(/\/orders\/([^/]+)$/);
    if (req.method === 'GET' && singleOrderPathMatch) {
        const wixOrderId = singleOrderPathMatch[1];

        try {
            const wixOrder = await findWixOrderById(wixOrderId);

            if (!wixOrder) {
                return res.status(404).json({ message: 'Order does not exist', code: 'NOT_FOUND' });
            }
            
            // FIX: Use reliable batch request, wrapped for a single ID
            const batchResponse = await getWixOrderFulfillmentsBatch([wixOrderId]);
            
            // Expecting [ { orderId: ID, fulfillments: [...] } ]
            const orderFulfillmentData = batchResponse[0];

            const fulfillments = (orderFulfillmentData && orderFulfillmentData.fulfillments) 
                ? orderFulfillmentData.fulfillments : [];


            const murkitResponse = mapWixOrderToMurkitResponse(wixOrder, fulfillments, wixOrderId);
            return res.status(200).json(murkitResponse);

        } catch (error) {
            console.error('GET Order Error:', error);
            return res.status(500).json({ message: 'Internal server error while processing order status', code: 'INTERNAL_ERROR' });
        }
    }

    // --- 3. POST Order Batch Endpoint (UPDATED LOGIC) ---
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

        // 1. Fetch all Orders in parallel
        const orderFetchResults = await Promise.all(orderIds.map(async (wixOrderId) => {
            try {
                const wixOrder = await findWixOrderById(wixOrderId);
                return { id: wixOrderId, order: wixOrder };
            } catch (error) {
                return { id: wixOrderId, error: { message: 'Internal server error while fetching order status', code: 'INTERNAL_ERROR' } };
            }
        }));

        const ordersToProcess = orderFetchResults.filter(r => r.order);
        // Collect errors from order fetching (e.g., 404, network error)
        const errors = orderFetchResults.filter(r => !r.order).map(r => r.error || { id: r.id, message: 'Order not found', code: 'NOT_FOUND' });
        
        const idsToBatch = ordersToProcess.map(r => r.id);
        
        let batchFulfillmentMap = new Map();
        
        // 2. Fetch all Fulfillments in one batch call
        if (idsToBatch.length > 0) {
            try {
                // USE EFFICIENT BATCH REQUEST
                const batchResponse = await getWixOrderFulfillmentsBatch(idsToBatch);
                
                // Map fulfillments back to Order IDs
                if (Array.isArray(batchResponse)) {
                    batchResponse.forEach(orderFulfillmentData => {
                        if (orderFulfillmentData.orderId && Array.isArray(orderFulfillmentData.fulfillments)) {
                            // Map: orderId -> [fulfillment1, fulfillment2, ...]
                            batchFulfillmentMap.set(orderFulfillmentData.orderId, orderFulfillmentData.fulfillments);
                        }
                    });
                }
            } catch (e) {
                console.error('Batch Fulfillment Fetch Error:', e);
                // Errors in batch fulfillment do not stop the process, we continue returning statuses without shipment info
            }
        }
        
        // 3. Map orders and fulfillments to Murkit Response format
        const responses = ordersToProcess.map(result => {
            const fulfillmentsForOrder = batchFulfillmentMap.get(result.id) || [];
            return mapWixOrderToMurkitResponse(result.order, fulfillmentsForOrder, result.id);
        });

        return res.status(200).json({ orders: responses, errors: errors });
    }

    // --- 4. POST LOGIC (Order Creation - RESTORED ORIGINAL WORKING FLOW) ---
    if (req.method === 'POST') {
        
        // Safety check for path
        if (urlPath.includes('/orders/')) {
            return res.status(404).json({ message: 'Not Found' });
        }

        try {
            const murkitData = req.body;
            
            if (!murkitData.number) throw createError(400, 'Missing order number');
            const murkitOrderId = String(murkitData.number);
            console.log(`Processing Murkit Order #${murkitOrderId}`);

            // === STEP 0: DEDUPLICATION ===
            const existingOrder = await findWixOrderByExternalId(murkitOrderId);
            if (existingOrder) {
                console.log(`Order #${murkitOrderId} already exists. ID: ${existingOrder.id}`);
                return res.status(200).json({ "id": existingOrder.number || existingOrder.id });
            }

            // === ITEM VALIDATION ===
            const murkitItems = murkitData.items || [];
            if (murkitItems.length === 0) throw createError(400, 'No items in order');

            const currency = "UAH";

            // 1. Sheets (FIXED implementation of readSheetData is used here)
            const { sheets, spreadsheetId } = await ensureAuth(); 
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
            
            // === CREATE SKU MAP ===
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
            const adjustments = []; 
            
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

                // === STOCK CHECK ===
                if (stockData.inStock === false) {
                     throw createError(409, `Product with code ${item.code} has not enough stock`, "ITEM_NOT_AVAILABLE");
                }
                
                if (stockData.trackQuantity && (stockData.quantity < requestedQty)) {
                     throw createError(409, `Product with code ${item.code} has not enough stock`, "ITEM_NOT_AVAILABLE");
                }

                // === COLLECT INVENTORY ADJUSTMENT DATA ===
                if (stockData.trackQuantity === true) {
                    adjustments.push({
                        productId: catalogItemId,
                        variantId: variantId, 
                        quantity: requestedQty
                    });
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

            const d = murkitData.delivery || {}; 
            const deliveryType = String(murkitData.deliveryType || '');
            
            const npCity = String(d.settlement || d.city || d.settlementName || '').trim();
            const street = String(d.address || '').trim();
            const house = String(d.house || '').trim();
            const flat = String(d.flat || '').trim();
            const npWarehouse = String(d.warehouseNumber || '').trim();

            let extendedFields = {};
            let finalAddressLine = "невідома адреса"; // Unknown address
            let deliveryTitle = "Delivery";

            if (deliveryType.includes('courier')) {
                deliveryTitle = SHIPPING_TITLES.COURIER; 
                
                const addressParts = [];
                if (street) addressParts.push(street);
                if (house) addressParts.push(`буд. ${house}`); // building
                if (flat) addressParts.push(`кв. ${flat}`);   // apartment
                
                finalAddressLine = addressParts.length > 0 
                    ? addressParts.join(', ') 
                    : `Адресна доставка (${npCity})`; // Address delivery

            } else {
                deliveryTitle = SHIPPING_TITLES.BRANCH; 
                
                if (npWarehouse) {
                    finalAddressLine = `Нова Пошта №${npWarehouse}`; // Nova Poshta
                    extendedFields = {
                        "namespaces": {
                            "_user_fields": {
                                "nomer_viddilennya_poshtomatu_novoyi_poshti": npWarehouse // Nova Poshta branch/postamat number
                            }
                        }
                    };
                } else {
                    finalAddressLine = "Нова Пошта (номер не указан)"; // Nova Poshta (number not specified)
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
                    type: "WEB",
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
            
            // === EXPLICIT INVENTORY DEDUCTION ===
            if (adjustments.length > 0) {
                try {
                    await adjustInventory(adjustments);
                } catch (adjErr) {
                    console.error("Warning: Inventory adjustment failed, but order was created.", adjErr);
                }
            }

            res.status(201).json({ 
                "id": createdOrder.order?.id 
            });

        } catch (e) {
            console.error('Murkit Webhook Error (Order Creation Final Catch):', e.message);
            
            const status = e.status || 500;
            
            if (status === 409 && (e.code === 'ITEM_NOT_FOUND' || e.code === 'ITEM_NOT_AVAILABLE')) {
                return res.status(409).json({
                    message: e.message,
                    code: e.code
                });
            }

            res.status(status).json({ 
                error: e.message 
            });
        }
    }

    // 5. Handling unknown routes/methods
    return res.status(404).json({ message: 'Not Found' });
}
