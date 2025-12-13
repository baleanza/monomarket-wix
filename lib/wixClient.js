import fetch from 'node-fetch';
import { requireEnv } from './sheetsClient.js'; 

const WIX_API_BASE = 'https://www.wixapis.com';

function getAccessToken() {
  return requireEnv('WIX_ACCESS_TOKEN');
}

function getSiteId() {
  return requireEnv('WIX_SITE_ID');
}

export function getHeaders() {
  return {
    'Authorization': `Bearer ${getAccessToken()}`,
    'wix-site-id': getSiteId(),
    'Content-Type': 'application/json'
  };
}

// === Оновлення деталей замовлення ===
export async function updateWixOrderDetails(wixOrderId, updates) {
  const payload = { 
    order: {
      id: wixOrderId,
      ...updates
    }
  };
  try {
      const res = await fetch(`${WIX_API_BASE}/ecom/v1/orders/${wixOrderId}`, {
        method: 'POST', 
        headers: getHeaders(),
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        console.log(`WIX Order ${wixOrderId} details updated.`);
        return true;
      }
      return false;
  } catch (e) {
      console.error("Network error updating order:", e);
      return false;
  }
}

// === ДОБАВЛЕНИЕ ОПЛАТЫ ===
export async function addExternalPayment(wixOrderId, amountStr, currency, createdDate) {
    let transactionDate;
    try {
        transactionDate = createdDate ? new Date(createdDate).toISOString() : new Date().toISOString();
    } catch (e) {
        transactionDate = new Date().toISOString();
    }

    const payload = {
        payments: [
            {
                amount: { 
                    amount: String(amountStr), 
                    currency: currency 
                },
                transactionDate: transactionDate,
                regularPaymentDetails: {
                    paymentMethod: "Monomarket", 
                    status: "APPROVED"
                }
            }
        ]
    };

    const url = `${WIX_API_BASE}/ecom/v1/payments/orders/${wixOrderId}/add-payment`;
    
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify(payload)
        });

        const text = await res.text();

        if (!res.ok) {
            console.error(`[DEBUG] !!! FAILED to add payment. Status: ${res.status}`);
            return null;
        }
        return JSON.parse(text);

    } catch (e) {
        console.error("[DEBUG] Network error adding payment:", e);
        return null;
    }
}

// === [FIX] ПОИСК ОПЛАТЫ (по данным debug-payment) ===
// ИСПРАВЛЕНО: Возвращает ЛЮБОЙ найденный платеж, чтобы не ломаться, если статус сменился на VOIDED/REFUNDED.
export async function getWixPaymentDetails(orderId) {
    try {
        const res = await fetch(`${WIX_API_BASE}/ecom/v1/payments/orders/${orderId}`, {
            method: 'GET',
            headers: getHeaders()
        });

        if (!res.ok) {
            console.warn(`[WixClient] Failed to get payment details for order ${orderId}: ${res.status}`);
            return null;
        }

        const data = await res.json();
        
        // Структура: { orderTransactions: { payments: [...] } }
        if (data.orderTransactions && Array.isArray(data.orderTransactions.payments) && data.orderTransactions.payments.length > 0) {
            // Возвращаем ПЕРВЫЙ найденный платёж. 
            // Мы предполагаем, что это наш External Payment, который должен быть источником для Refund.
            return data.orderTransactions.payments[0]; 
        }
        
        return null;
    } catch (e) {
        console.error(`[WixClient] Error fetching payment details: ${e.message}`);
        return null;
    }
}


// === REFUND (Штатный API) ===
export async function createWixRefund(orderId, paymentId, amount, currency) {
    const amountStr = parseFloat(amount).toFixed(2); // Точное форматирование

    const payload = {
        paymentRefunds: [
            {
                paymentId: paymentId,
                amount: amountStr,
                externalRefund: true 
            }
        ]
    };

    console.log(`Creating REFUND for order ${orderId}, payment ${paymentId}, amount: ${amountStr}`);

    try {
        const res = await fetch(`${WIX_API_BASE}/ecom/v1/order-billing/refund-payments`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const text = await res.text();
            console.error(`Refund failed for ${orderId}:`, res.status, text);
            return null;
        }

        const data = await res.json();
        console.log(`Refund created successfully for ${orderId}`);
        return data;
    } catch (e) {
        console.error("Network error creating refund:", e);
        return null;
    }
}


// === НЕИСПОЛЬЗУЕМЫЕ/УСТАРЕВШИЕ ФУНКЦИИ ===
export async function getWixOrderTransactions(wixOrderId) {
    try {
        const res = await fetch(`${WIX_API_BASE}/ecom/v1/orders/${wixOrderId}/transactions`, {
            method: 'GET',
            headers: getHeaders()
        });
        
        if (!res.ok) return [];
        
        const data = await res.json();
        return data.orderTransactions || [];
    } catch (e) {
        return [];
    }
}
// Заглушка для VOID и принудительного REFUND (чтобы избежать 404/ошибок)
export async function voidWixPayment() { return null; }
export async function createExternalRefund() { return null; }


// ... (Остальные функции без изменений)
export async function fetchAllProducts() { 
  let allProducts = [];
  let skip = 0;
  const limit = 100;
  let hasMore = true;
  const MAX_PAGES = 50; 
  let page = 0;

  while (hasMore && page < MAX_PAGES) {
    try {
      const res = await fetch(`${WIX_API_BASE}/stores/v1/products/query`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          includeVariants: true, 
          includeHiddenProducts: true,
          query: {
            limit: limit,
            skip: skip,
            fields: ["variants", "id", "sku", "name", "priceData", "stock", "options", "productType", "media"] 
          }
        })
      });

      if (!res.ok) break;

      const data = await res.json();
      const products = data.products || [];
      allProducts = allProducts.concat(products);

      if (products.length < limit) hasMore = false; else { skip += limit; page++; }
    } catch (e) { break; }
  }
  return allProducts;
}

export async function getProductsBySkus(skus) {
  if (!skus || skus.length === 0) return [];
  const targetSkus = skus.map(s => String(s).trim());
  const allProducts = await fetchAllProducts();
  return allProducts.filter(p => {
    const pSku = p.sku ? String(p.sku).trim() : '';
    if (targetSkus.includes(pSku)) return true;
    if (p.variants && p.variants.length > 0) {
      return p.variants.some(v => targetSkus.includes(String(v.variant?.sku || '').trim()));
    }
    return false;
  });
}

export async function getInventoryBySkus(skus) {
  if (!skus || skus.length === 0) return [];
  const targetSkus = new Set(skus.map(s => String(s).trim()));
  const allProducts = await fetchAllProducts();
  const inventoryMap = [];

  allProducts.forEach(p => {
    const basePrice = p.priceData?.price || p.price?.price || 0;
    if (p.variants && p.variants.length > 0) {
      p.variants.forEach(v => {
        const vSku = v.variant?.sku ? String(v.variant.sku).trim() : '';
        if (targetSkus.has(vSku)) {
          const stockData = v.stock || {}; 
          inventoryMap.push({
            sku: vSku,
            inStock: (stockData.inStock === true), 
            quantity: (stockData.quantity !== undefined) ? stockData.quantity : 0,
            price: v.variant.priceData?.price || basePrice
          });
          targetSkus.delete(vSku); 
        }
      });
    }
    const pSku = p.sku ? String(p.sku).trim() : '';
    if (targetSkus.has(pSku)) {
      const stockData = p.stock || {}; 
      inventoryMap.push({
        sku: pSku,
        inStock: (stockData.inStock === true), 
        quantity: (stockData.quantity !== undefined) ? stockData.quantity : 0,
        price: basePrice 
      });
      targetSkus.delete(pSku);
    }
  });
  return inventoryMap;
}

export async function createWixOrder(orderData) {
  const payload = { order: orderData };
  const res = await fetch(`${WIX_API_BASE}/ecom/v1/orders`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('WIX API Error Response:', text);
    throw new Error(`Failed to create Wix order (${res.status}): ${text}`);
  }
  return await res.json();
}

export async function findWixOrderByExternalId(externalId) {
  try {
    const res = await fetch(`${WIX_API_BASE}/ecom/v1/orders/query`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        query: {
          filter: { "channelInfo.externalOrderId": { "$eq": String(externalId) } },
          fields: ["id", "number", "channelInfo", "status", "fulfillmentStatus", "shippingInfo", "priceSummary"] 
        }
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.orders && data.orders.length > 0) ? data.orders[0] : null;
  } catch (e) { return null; }
}

export async function findWixOrderById(wixId) { 
  try {
    const res = await fetch(`${WIX_API_BASE}/ecom/v1/orders/${wixId}`, {
      method: 'GET',
      headers: getHeaders()
    });
    if (!res.ok) return null; 
    const data = await res.json();
    return data.order || null; 
  } catch (e) { return null; }
}

export async function getWixOrderFulfillments(wixOrderId) {
    try {
        const res = await fetch(`${WIX_API_BASE}/ecom/v1/fulfillments/orders/${wixOrderId}`, {
            method: 'GET', headers: getHeaders(),
        });
        if (!res.ok) return [];
        const data = await res.json();
        return data.fulfillments || []; 
    } catch (e) { return []; }
}

export async function getWixOrderFulfillmentsBatch(orderIds) {
    if (!orderIds || orderIds.length === 0) return [];
    try {
        const res = await fetch(`${WIX_API_BASE}/ecom/v1/fulfillments/list-by-ids`, {
            method: 'POST', headers: getHeaders(),
            body: JSON.stringify({ orderIds: orderIds })
        });
        if (!res.ok) return [];
        const data = await res.json();
        const ordersWithFulfillments = data.ordersWithFulfillments || [];
        return ordersWithFulfillments;
    } catch (e) { throw e; }
}

export async function cancelWixOrderById(wixOrderId) {
    const basicOrderInfo = await findWixOrderById(wixOrderId); 
    if (!basicOrderInfo) return { status: 404, wixOrderId: null };

    if (basicOrderInfo.status === 'CANCELED') return { status: 409, code: 'ORDER_ALREADY_CANCELED' };
    if (basicOrderInfo.fulfillmentStatus === 'FULFILLED' || basicOrderInfo.fulfillmentStatus === 'DELIVERED') return { status: 409, code: 'CANNOT_CANCEL_ORDER' }; 

    const cancelRes = await fetch(`${WIX_API_BASE}/ecom/v1/orders/${wixOrderId}/cancel`, { 
        method: 'POST', headers: getHeaders(),
        body: JSON.stringify({
            "restockAllItems": true, 
            "cancellationReason": 'Canceled by Monomarket partner request',
            "sendOrderCanceledEmail": true 
        })
    });
    if (cancelRes.ok) return { status: 200, wixOrderId: wixOrderId }; 
    const errorText = await cancelRes.text();
    let errJson;
    try { errJson = JSON.parse(errorText); } catch(e){}
    const code = errJson?.code || 'UNKNOWN';
    
    return { status: 409, code: code, message: errorText };
}

export async function adjustInventory(adjustments) {
    if (!adjustments || adjustments.length === 0) return;
    const inventoryAdjustments = adjustments.map(adj => ({
        inventoryItemId: adj.productId, variantId: adj.variantId, adjustment: -adj.quantity, reason: 'ORDER_PLACED'
    }));
    try {
        const res = await fetch(`${WIX_API_BASE}/inventory/v1/inventoryItems/bulkAdjustQuantity`, {
            method: 'POST', headers: getHeaders(),
            body: JSON.stringify({ inventoryAdjustments: inventoryAdjustments })
        });
        if (!res.ok) throw new Error(`Failed to adjust inventory`);
    } catch (e) { throw e; }
}
