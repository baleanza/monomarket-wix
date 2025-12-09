import { 
    createWixOrder, 
    getProductsBySkus, 
    // For deduplication (search by Murkit ID)
    findWixOrderByExternalId, 
    // For status/cancellation (search by Wix ID)
    findWixOrderById, 
    getWixOrderFulfillments, 
    cancelWixOrderById
} from '../lib/wixClient.js'; 
import { ensureAuth } from '../lib/sheetsClient.js'; 

const WIX_STORES_APP_ID = "215238eb-22a5-4c36-9e7b-e7c08025e04e"; 

// === MAPPING FOR ORDER CREATION (Murkit Input -> Wix Title) ===
const MURKIT_TO_WIX_CREATION_MAPPING = {
    "nova-post": "НП Відділення", // Standard for branches and postamats
    "courier-nova-post": "НП Кур'єр"
};

// === MAPPING FOR STATUS RETRIEVAL (Wix Title -> Murkit Output) ===
const WIX_TO_MURKIT_STATUS_MAPPING = {
    "НП Відділення": "nova-post", 
    "НП Кур'єр": "courier-nova-post",
    "НП Поштомат": "nova-post"
};

// === EXISTING HELPER FUNCTIONS ===
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

// readSheetData (EXISTING)
// FIX: Enhanced for robustness against API errors and older JS environments 
// to prevent "Cannot read properties of undefined (reading 'values')" error.
async function readSheetData(sheets, spreadsheetId) {
    let importRes, controlRes;
    
    try {
        [importRes, controlRes] = await Promise.all([
            sheets.spreadsheets.values.get({ spreadsheetId, range: 'Import!A1:ZZ' }),
            sheets.spreadsheets.values.get({ spreadsheetId, range: 'Feed Control List!A1:F' }),
        ]);
    } catch (e) {
        // If Promise.all fails due to Auth/API issues, we re-throw a more informative error
        throw createError(500, `Failed to fetch data from Google Sheets: ${e.message}`, "SHEETS_API_ERROR");
    }

    // Safely access data using traditional checks (compatible with older Node.js runtimes)
    // This prevents the "Cannot read properties of undefined" error if the response object is malformed
    const importValues = (importRes && importRes.data && importRes.data.values) ? importRes.data.values : [];
    const controlValues = (controlRes && controlRes.data && controlRes.data.values) ? controlRes.data.values : [];

    return { 
        importValues: importValues, 
        controlValues: controlValues 
    };
}

// getProductSkuMap (EXISTING)
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

    // 1. Cancellation processing
    if (wixOrder.status === 'CANCELED') { 
        murkitStatus = 'canceled';
        murkitCancelStatus = 'canceled';
    } 
    
    // 2. Fulfillment/Shipment status determination
    else if (orderStatus === 'FULFILLED') {
        murkitStatus = 'sent';
    } 
    else {
        murkitStatus = 'accepted';
    }

    // 3. Process Fulfillments to get the TTN (Tracking Number)
    if (Array.isArray(fulfillments) && fulfillments.length > 0) {
        const fulfillmentWithTtn = fulfillments
            // FIX: Search for fulfillment where trackingNumber is a non-empty string.
            .find(f => f.trackingInfo && String(f.trackingInfo.trackingNumber || '').trim().length > 0);
        
        if (fulfillmentWithTtn) {
            // Assign the cleaned, non-empty TTN
            ttn = String(fulfillmentWithTtn.trackingInfo.trackingNumber).trim();
        }
    }

    // 4. Mapping shipping method and TTN (Only if status is 'sent' AND TTN is available)
    const normalizedShippingLine = wixShippingLine.trim();
    if (murkitStatus === 'sent' && ttn) {
        shipmentType = WIX_TO_MURKIT_STATUS_MAPPING[normalizedShippingLine] || 'nova-post'; 
        shipment = { ttn: ttn };
    }
    
    // The Murkit response ID should be the Wix ID
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
    if (!checkAuth(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const urlPathFull = req.url;
    // FIX 1: Clean URL path from query parameters that Vercel might add (like ?path=...)
    const urlPath = urlPathFull.split('?')[0]; 

    // --- 1. PUT Cancel Order Endpoint ---
    const cancelOrderPathMatch = urlPath.match(/\/orders\/([^/]+)\/cancel$/);
    if (req.method === 'PUT' && cancelOrderPathMatch) {
        // Wix Order ID
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
                // Search by Wix ID
                const wixOrder = await findWixOrderById(wixOrderId);
                const fulfillments = await getWixOrderFulfillments(wixOrderId);
                
                if (!wixOrder) {
                     return res.status(500).json({ message: 'Internal server error: Order status not found after successful cancellation request', code: 'INTERNAL_ERROR' });
                }
                
                // Murkit response ID should be Wix ID
                const murkitResponse = mapWixOrderToMurkitResponse(wixOrder, fulfillments, wixOrderId);
                return res.status(200).json(murkitResponse);
            }

        } catch (error) {
            console.error('PUT Cancel Order Error:', error);
            return res.status(500).json({ message: 'Internal server error while processing cancellation request', code: 'INTERNAL_ERROR' });
        }
    }
    
    // --- 2. GET Order Endpoint (Get status of a single order) ---
    const singleOrderPathMatch = urlPath.match(/\/orders\/([^/]+)$/);
    if (req.method === 'GET' && singleOrderPathMatch) {
        // Wix Order ID
        const wixOrderId = singleOrderPathMatch[1];

        try {
            // Search by Wix ID
            const wixOrder = await findWixOrderById(wixOrderId);

            if (!wixOrder) {
                return res.status(404).json({ message: 'Order does not exist', code: 'NOT_FOUND' });
            }
            
            const fulfillments = await getWixOrderFulfillments(wixOrderId);

            // Murkit response ID should be Wix ID
            const murkitResponse = mapWixOrderToMurkitResponse(wixOrder, fulfillments, wixOrderId);
            return res.status(200).json(murkitResponse);

        } catch (error) {
            console.error('GET Order Error:', error);
            return res.status(500).json({ message: 'Internal server error while processing order status', code: 'INTERNAL_ERROR' });
        }
    }

    // --- 3. POST Order Batch Endpoint (Get status of multiple orders) ---
    if (req.method === 'POST' && urlPath.includes('/orders/batch')) {
        let orderIds; // Wix Order IDs
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
        
        await Promise.all(orderIds.map(async (wixOrderId) => {
            try {
                // Search by Wix ID
                const wixOrder = await findWixOrderById(wixOrderId);

                if (!wixOrder) {
                    errors.push({ id: wixOrderId, message: 'Order does not exist', code: 'NOT_FOUND' });
                } else {
                    const fulfillments = await getWixOrderFulfillments(wixOrderId);
                    responses.push(mapWixOrderToMurkitResponse(wixOrder, fulfillments, wixOrderId));
                }

            } catch (error) {
                console.error(`POST Order Batch Error for ID ${wixOrderId}:`, error);
                errors.push({ id: wixOrderId, message: 'Internal server error while fetching order status', code: 'INTERNAL_ERROR' });
            }
        }));

        return res.status(200).json({ orders: responses, errors: errors });
    }

    // --- 4. EXISTING POST LOGIC (Order Creation) ---
    if (req.method === 'POST') {
        
        if (urlPath.includes('/orders/')) {
            return res.status(404).json({ message: 'Not Found' });
        }

        try {
            const murkitData = req.body;
            
            if (!murkitData.number) throw createError(400, 'Missing order number');
            const murkitOrderId = String(murkitData.number);
            console.log(`Processing Murkit Order #${murkitOrderId}`);

            // === STEP 0: DEDUPLICATION ===
            // SEARCH HERE BY Murkit ID
            const existingOrder = await findWixOrderByExternalId(murkitOrderId);
            if (existingOrder) {
                console.log(`Order #${murkitOrderId} already exists. ID: ${existingOrder.id}`);
                // Return Wix ID
                return res.status(200).json({ "id": existingOrder.id });
            }

            // === ITEM VALIDATION ===
            const murkitItems = murkitData.items || [];
            if (murkitItems.length === 0) throw createError(400, 'No items in order');

            const currency = "UAH";

            // 1. Sheets
            const sheets = await ensureAuth();
            // This call is now more robust against API response issues
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
            
            // === CREATE SKU MAP (Flattening) ===
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

                // === STOCK CHECK (409 ITEM_NOT_AVAILABLE) ===
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

            // === DELIVERY LOGIC ===
            const d = murkitData.delivery || {}; 
            const deliveryTypeKey = String(murkitData.deliveryType || 'nova-post').toLowerCase(); 
            
            const deliveryTitle = MURKIT_TO_WIX_CREATION_MAPPING[deliveryTypeKey] || "Delivery"; 

            const npCity = String(d.settlement || d.city || d.settlementName || '').trim();
            const street = String(d.address || '').trim();
            const house = String(d.house || '').trim();
            const flat = String(d.flat || '').trim();
            const npWarehouse = String(d.warehouseNumber || '').trim();

            let extendedFields = {};
            let finalAddressLine = "unknown address";

            if (deliveryTypeKey.includes('courier')) {
                // COURIER
                const addressParts = [];
                if (street) addressParts.push(street);
                if (house) addressParts.push(`буд. ${house}`);
                if (flat) addressParts.push(`кв. ${flat}`);
                
                finalAddressLine = addressParts.length > 0
                    ? addressParts.join(', ') 
                    : `Address Delivery (${npCity})`;

            } else {
                // BRANCH/POSTAMAT (mapped in Wix as "НП Відділення")
                if (npWarehouse) {
                    finalAddressLine = `Nova Poshta №${npWarehouse}`;
                    extendedFields = {
                        "namespaces": {
                            "_user_fields": {
                                // Field used for branch/postamat number
                                "nomer_viddilennya_poshtomatu_novoyi_poshti": npWarehouse
                            }
                        }
                    };
                } else {
                    finalAddressLine = "Nova Poshta (number not specified)";
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
                    externalOrderId: murkitOrderId // Store Murkit ID here
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
            
            // RETURN OUR ID (WIX ID)
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

    // 5. Handling unknown routes/methods
    return res.status(404).json({ message: 'Not Found' });
}
