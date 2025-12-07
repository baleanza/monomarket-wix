import { createWixOrder, getProductsBySkus } from '../lib/wixClient.js';
import { ensureAuth } from '../lib/sheetsClient.js'; 

// Constants
const WIX_STORES_APP_ID = "215238eb-22a5-4c36-9e7b-e7c08025e04e"; // Correct ID for Wix Stores Catalog

// Basic Auth Check
function checkAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return false;

  const b64auth = authHeader.split(' ')[1];
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

  return login === process.env.MURKIT_USER && password === process.env.MURKIT_PASS;
}

// Read Google Sheets for Mapping
async function readSheetData(sheets, spreadsheetId) {
  const importRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Import!A1:ZZ' });
  const controlRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Feed Control List!A1:F' });

  return { 
    importValues: importRes.data.values || [], 
    controlValues: controlRes.data.values || [] 
  };
}

// Map: Murkit Code -> Wix SKU
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

// Helper: Format price to string decimal
const fmtPrice = (num) => parseFloat(num || 0).toFixed(2);

// Helper: Parse Names
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
    console.log(`Processing Murkit Order #${murkitData.number}`);

    const murkitItems = murkitData.items || [];
    if (murkitItems.length === 0) return res.status(400).json({ error: 'No items in order' });

    // 1. Load Mapping from Sheets
    const { sheets, spreadsheetId } = await ensureAuth();
    const { importValues, controlValues } = await readSheetData(sheets, spreadsheetId);
    const codeToSkuMap = getProductSkuMap(importValues, controlValues);
    
    // 2. Resolve Wix SKUs
    const wixSkusToFetch = [];
    const itemsWithSku = murkitItems.map(item => {
        const mCode = String(item.code).trim();
        // If map exists use it, otherwise fallback to code itself
        const wSku = codeToSkuMap[mCode] || mCode;
        if(wSku) wixSkusToFetch.push(wSku);
        return { ...item, wixSku: wSku };
    });

    if (wixSkusToFetch.length === 0) {
        return res.status(400).json({ error: 'No valid SKUs found to fetch from Wix' });
    }

    // 3. Fetch Products from Wix to get IDs and Check Stock
    const wixProducts = await getProductsBySkus(wixSkusToFetch);
    
    // 4. Build Line Items with Logic: SKU -> Product ID / Variant ID -> Check Stock
    const lineItems = [];
    
    for (const item of itemsWithSku) {
        const requestedQty = parseInt(item.quantity || 1, 10);
        const targetSku = item.wixSku;

        // Find the product that contains this SKU
        const productMatch = wixProducts.find(p => {
            if (String(p.sku) === targetSku) return true;
            if (p.variants) return p.variants.some(v => String(v.variant?.sku) === targetSku);
            return false;
        });

        if (!productMatch) {
            throw new Error(`Product with SKU '${targetSku}' (Murkit Code: ${item.code}) not found in Wix.`);
        }

        // Determine if it is the main product or a variant
        let catalogItemId = productMatch.id; // The main Product ID
        let variantId = null;
        let stockData = productMatch.stock;
        let productName = productMatch.name;

        // Check if SKU belongs to a specific variant
        if (String(productMatch.sku) !== targetSku && productMatch.variants) {
            const variantMatch = productMatch.variants.find(v => String(v.variant?.sku) === targetSku);
            if (variantMatch) {
                variantId = variantMatch.variant.id; // Specific Variant ID
                stockData = variantMatch.stock; // Variant specific stock
                // Optionally append variant name options if needed, but 'original' name is usually parent name
            }
        }

        // ** CRITICAL: STOCK CHECK **
        // Assuming 'trackInventory' is true. If Wix returns inStock: false or quantity < requested
        if (stockData.trackQuantity && (stockData.quantity < requestedQty)) {
             throw new Error(`Insufficient stock for SKU '${targetSku}'. Requested: ${requestedQty}, Available: ${stockData.quantity}`);
        }
        if (stockData.inStock === false) {
             throw new Error(`SKU '${targetSku}' is marked as Out of Stock in Wix.`);
        }

        // Construct Line Item
        const priceStr = fmtPrice(item.price);
        
        const lineItem = {
            quantity: requestedQty,
            catalogReference: {
                catalogItemId: catalogItemId,
                appId: WIX_STORES_APP_ID,
                options: variantId ? { variantId: variantId } : {}
            },
            productName: {
                original: productName // From Wix, as requested
            },
            itemType: {
                preset: "PHYSICAL"
            },
            physicalProperties: {
                sku: targetSku,
                shippable: true
            },
            price: {
                amount: priceStr // Wix V2 override price
            }
        };

        lineItems.push(lineItem);
    }

    // 5. Prepare Order Totals & Info
    const currency = "UAH"; // Adjust if needed
    const clientName = getFullName(murkitData.client?.name);
    const recipientName = getFullName(murkitData.recipient?.name);
    const phone = String(murkitData.client?.phone || murkitData.recipient?.phone || "").replace(/\D/g,'');
    const email = murkitData.client?.email || "monomarket@mywoodmood.com";

    // Mapping Delivery
    const deliveryTitle = `${murkitData.deliveryType || 'Delivery'} (${murkitData.delivery?.settlementName || ''})`;
    const shippingAddress = {
        country: "UA",
        city: String(murkitData.delivery?.settlementName || "City"),
        addressLine: `Nova Poshta: ${murkitData.delivery?.warehouseNumber || '1'}`,
        postalCode: "00000" // Required field for some validations
    };

    // Calculate Totals (Murkit sends final sums, we trust them for the override)
    const priceSummary = {
        subtotal: { amount: fmtPrice(murkitData.sum), currency },
        shipping: { amount: "0.00", currency }, 
        tax: { amount: "0.00", currency },
        discount: { amount: "0.00", currency },
        total: { amount: fmtPrice(murkitData.sum), currency }
    };

    // 6. Final Payload
    const wixOrderPayload = {
        channelInfo: {
            type: "API",
            externalId: String(murkitData.number)
        },
        lineItems: lineItems,
        priceSummary: priceSummary,
        billingInfo: {
            address: { ...shippingAddress, addressLine: "Client Address" }, // Simplified
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
        paymentStatus: (murkitData.payment_status === 'paid' || String(murkitData.paymentType).includes('mono')) ? "PAID" : "NOT_PAID",
        currency: currency
    };

    // 7. Send to Wix
    const createdOrder = await createWixOrder(wixOrderPayload);
    
    res.status(200).json({ 
        success: true, 
        wix_order_id: createdOrder.order?.id,
        murkit_number: murkitData.number
    });

  } catch (e) {
    console.error('Murkit Webhook Error:', e.message);
    res.status(500).json({ error: e.message });
  }
}
