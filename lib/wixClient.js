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

// Використовується ТІЛЬКИ для перевірки дублікатів при СТВОРЕННІ замовлення.
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
          fields: ["id", "status", "fulfillmentStatus", "shippingInfo"] 
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

// Отримання інформації про замовлення Wix за власним Wix Order ID
// Використовується для GET status та PUT cancel.
export async function findWixOrderById(wixId) { 
  try {
    const res = await fetch(`${WIX_API_BASE}/ecom/v1/orders/query`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        query: {
          filter: {
            "id": { "$eq": String(wixId) }
          },
          fields: ["id", "status", "fulfillmentStatus", "shippingInfo"] 
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

// Скасування замовлення Wix за власним Wix Order ID
export async function cancelWixOrderById(wixOrderId) { 
    // 1. Пошук ID та статусу замовлення
    // Використовуємо нову функцію пошуку за Wix ID
    const basicOrderInfo = await findWixOrderById(wixOrderId); 

    if (!basicOrderInfo) {
        return { status: 404, wixOrderId: null };
    }

    const wixOrderStatus = basicOrderInfo.status;
    const wixFulfillmentStatus = basicOrderInfo.fulfillmentStatus;

    // 2. Перевірка на конфлікти (409 Conflict)
    if (wixOrderStatus === 'CANCELED') {
        return { status: 409, code: 'ORDER_ALREADY_CANCELED' };
    }
    
    if (wixFulfillmentStatus === 'FULFILLED' || wixFulfillmentStatus === 'DELIVERED') {
        return { status: 409, code: 'CANNOT_CANCEL_ORDER' }; 
    }

    // 3. Виклик Wix Cancel API
    const cancelRes = await fetch(`${WIX_API_BASE}/stores/v1/orders/${wixOrderId}/cancel`, {
        method: 'POST', 
        headers: getHeaders(),
        body: JSON.stringify({
            cancellationReason: 'Canceled by Murkit/Monomarket partner request' 
        })
    });
    
    if (cancelRes.ok) {
        return { status: 200, wixOrderId: wixOrderId }; 
    } 

    const errorText = await cancelRes.text();
    console.error(`Wix Cancel Order Error (ID: ${wixOrderId}): ${errorText}`);
    throw new Error(`Wix API Error during cancellation: ${errorText}`);
}
