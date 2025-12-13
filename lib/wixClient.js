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

// === Оновлення примітки (залишаємо як додатковий маркер) ===
export async function updateWixOrderNote(wixOrderId, noteText) {
  const payload = { 
    order: {
      id: wixOrderId,
      buyerNote: noteText 
    }
  };
  try {
    const res = await fetch(`${WIX_API_BASE}/ecom/v1/orders/${wixOrderId}`, {
        method: 'POST', 
        headers: getHeaders(),
        body: JSON.stringify(payload)
    });
    if (res.ok) console.log(`WIX Note updated for ${wixOrderId}`);
  } catch (e) {
    console.error("Failed to update note:", e);
  }
}

// === НОВА ФУНКЦІЯ: Отримання транзакцій замовлення ===
export async function getWixOrderTransactions(wixOrderId) {
    try {
        const res = await fetch(`${WIX_API_BASE}/ecom/v1/orders/${wixOrderId}/transactions`, {
            method: 'GET',
            headers: getHeaders()
        });
        
        if (!res.ok) {
            console.error(`Error fetching transactions for ${wixOrderId}:`, res.status, await res.text());
            return [];
        }
        
        const data = await res.json();
        return data.orderTransactions || [];
    } catch (e) {
        console.error("Network error fetching transactions:", e);
        return [];
    }
}

// === НОВА ФУНКЦІЯ: Створення повернення (Refund) ===
export async function createWixRefund(orderId, paymentId, amount, currency) {
    // Використовуємо externalRefund: true, щоб просто змінити статус у Wix, 
    // не чіпаючи реальні гроші (бо оплата була зовнішня/карткою не через Wix Payments)
    const payload = {
        paymentRefunds: [
            {
                paymentId: paymentId,
                amount: String(amount),
                externalRefund: true 
            }
        ]
    };

    console.log(`Creating REFUND for order ${orderId}, payment ${paymentId}, amount ${amount}`);

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
// =======================================================

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

      if (!res.ok) {
        console.error('Wix Products V1 Error:', res.status, await res.text());
        break;
      }

      const data = await res.json();
      const products = data.products || [];
      
      allProducts = allProducts.concat(products);

      if (products.length < limit) {
        hasMore = false;
      } else {
        skip += limit;
        page++;
      }
    } catch (e) {
      console.error('Network error fetching products page:', e);
      break;
    }
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
      return p.variants.some(v => {
        const variantDetails = v.variant; 
        const variantSku = variantDetails?.sku; 
        return targetSkus.includes(String(variantSku || '').trim());
      });
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
        const variantDetails = v.variant; 
        if (!variantDetails) return;
        
        const vSku = variantDetails.sku ? String(variantDetails.sku).trim() : '';
        
        if (targetSkus.has(vSku)) {
          const stockData = v.stock || {}; 
          const variantPrice = variantDetails.priceData?.price || variantDetails.price?.price || basePrice;
          
          inventoryMap.push({
            sku: vSku,
            inStock: (stockData.inStock === true), 
            quantity: (stockData.quantity !== undefined) ? stockData.quantity : 0,
            price: variantPrice
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
  
  console.log('WIX REQUEST PAYLOAD:', JSON.stringify(payload, null, 2));
    
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

  const jsonResponse = await res.json();
  console.log('WIX API SUCCESS RESPONSE:', JSON.stringify(jsonResponse, null, 2));

  return jsonResponse;
}

export async function findWixOrderByExternalId(externalId) {
  try {
    const res = await fetch(`${WIX_API_BASE}/ecom/v1/orders/query`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        query: {
          filter: {
            "channelInfo.externalOrderId": { "$eq": String(externalId) } 
          },
          fields: ["id", "number", "channelInfo", "status", "fulfillmentStatus", "shippingInfo", "priceSummary"] 
        }
      })
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("Error searching order:", text);
      if (res.status >= 500) throw new Error(`Wix API error during order search: ${text}`); 
      return null;
    }

    const data = await res.json();
    return (data.orders && data.orders.length > 0) ? data.orders[0] : null;

  } catch (e) {
    console.error("Network error searching order:", e);
    throw new Error(`Network error while searching Wix order: ${e.message}`);
  }
}

export async function findWixOrderById(wixId) { 
  try {
    const res = await fetch(`${WIX_API_BASE}/ecom/v1/orders/${wixId}`, {
      method: 'GET',
      headers: getHeaders()
    });

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      const text = await res.text();
      console.error("Error fetching order by ID:", text);
      return null; 
    }

    const data = await res.json();
    return data.order || null; 

  } catch (e) {
    console.error("Network error fetching order by ID:", e);
    return null;
  }
}

export async function getWixOrderFulfillments(wixOrderId) {
    try {
        const res = await fetch(`${WIX_API_BASE}/ecom/v1/fulfillments/orders/${wixOrderId}`, {
            method: 'GET', 
            headers: getHeaders(),
        });

        if (res.status === 404) {
            return []; 
        }

        if (!res.ok) {
            const errorText = await res.text();
            console.error(`Wix Fulfillments GET Error (ID: ${wixOrderId}): ${errorText}`);
            if (res.status >= 500) throw new Error(`Wix API error during fulfillment GET: ${errorText}`);
            return [];
        }

        const data = await res.json();
        return data.fulfillments || []; 
        
    } catch (e) {
        console.error("Network error fetching fulfillments:", e);
        return [];
    }
}

export async function getWixOrderFulfillmentsBatch(orderIds) {
    if (!orderIds || orderIds.length === 0) return [];
    
    try {
        const res = await fetch(`${WIX_API_BASE}/ecom/v1/fulfillments/list-by-ids`, {
            method: 'POST', 
            headers: getHeaders(),
            body: JSON.stringify({
                orderIds: orderIds
            })
        });

        if (!res.ok) {
            const errorText = await res.text();
            console.error(`Wix Fulfillments Batch Error: ${errorText}`);
            if (res.status >= 500) throw new Error(`Wix API error during fulfillment batch: ${errorText}`);
            return [];
        }

        const data = await res.json();
        
        const fulfillmentsList = [];
        if (data.ordersWithFulfillments) {
             data.ordersWithFulfillments.forEach(order => {
                if (order.fulfillments && order.fulfillments.length > 0) {
                    order.fulfillments.forEach(f => {
                         fulfillmentsList.push({ ...f, orderId: order.orderId });
                    });
                }
             });
        }
        
        return data.ordersWithFulfillments || []; 
        
    } catch (e) {
        console.error("Network error fetching fulfillments batch:", e);
        throw e;
    }
}


export async function cancelWixOrderById(wixOrderId) {
    const basicOrderInfo = await findWixOrderById(wixOrderId); 

    if (!basicOrderInfo) {
        return { status: 404, wixOrderId: null };
    }

    const wixOrderStatus = basicOrderInfo.status;
    const wixFulfillmentStatus = basicOrderInfo.fulfillmentStatus;

    if (wixOrderStatus === 'CANCELED') {
        return { status: 409, code: 'ORDER_ALREADY_CANCELED' };
    }
    
    if (wixFulfillmentStatus === 'FULFILLED' || wixFulfillmentStatus === 'DELIVERED') {
        return { status: 409, code: 'CANNOT_CANCEL_ORDER' }; 
    }

    const cancelRes = await fetch(`${WIX_API_BASE}/ecom/v1/orders/${wixOrderId}/cancel`, { 
        method: 'POST', 
        headers: getHeaders(),
        body: JSON.stringify({
            "restockAllItems": true, 
            "cancellationReason": 'Canceled by Monomarket partner request',
            "sendOrderCanceledEmail": true 
        })
    });
    
    if (cancelRes.ok) {
        return { status: 200, wixOrderId: wixOrderId }; 
    } 

    const errorText = await cancelRes.text();
    console.error(`Wix Cancel Order Error (ID: ${wixOrderId}): ${errorText}`);
    throw new Error(`Wix API Error during cancellation: ${errorText}`);
}

export async function adjustInventory(adjustments) {
    if (!adjustments || adjustments.length === 0) return;

    const inventoryAdjustments = adjustments.map(adj => {
        return {
            inventoryItemId: adj.productId, 
            variantId: adj.variantId,
            adjustment: -adj.quantity, 
            reason: 'ORDER_PLACED'
        };
    });

    try {
        const res = await fetch(`${WIX_API_BASE}/inventory/v1/inventoryItems/bulkAdjustQuantity`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({ 
                inventoryAdjustments: inventoryAdjustments 
            })
        });

        if (!res.ok) {
            const text = await res.text();
            console.error('WIX Inventory Adjustment Error:', res.status, text);
            throw new Error(`Failed to adjust inventory (${res.status}): ${text}`);
        }
    } catch (e) {
        console.error('Network error during inventory adjustment:', e.message);
        throw e;
    }
}
