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
            // ДОБАВЛЕНО ПОЛЕ "media" ЧТОБЫ ПОЛУЧИТЬ ФОТО
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

// ОНОВЛЕНА ФУНКЦІЯ: Отримання базової інформації про замовлення Wix за зовнішнім ID (Murkit Order ID)
export async function findWixOrderByExternalId(externalId) {
  try {
    const res = await fetch(`${WIX_API_BASE}/ecom/v1/orders/query`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        query: {
          filter: {
            // Зберігаємо оригінальний фільтр, але оновлюємо поля
            "channelInfo.externalOrderId": { "$eq": String(externalId) }
          },
          // ОНОВЛЕНІ поля: додано status, fulfillmentStatus та shippingInfo для назви доставки
          fields: ["id", "status", "fulfillmentStatus", "shippingInfo"] 
        }
      })
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("Error searching order:", text);
      // Кидаємо помилку для обробки в monomarket-endpoint, якщо це помилка API, а не 404
      if (res.status >= 500) throw new Error(`Wix API error during order search: ${text}`); 
      return null;
    }

    const data = await res.json();
    if (data.orders && data.orders.length > 0) {
      return data.orders[0];
    }
    return null;

  } catch (e) {
    console.error("Network error searching order:", e);
    throw new Error(`Network error while searching Wix order: ${e.message}`);
  }
}

// НОВА ФУНКЦІЯ: Отримання інформації про відправлення (Fulfillments) за Wix Order ID
// Використовує /ecom/v1/fulfillments/orders/{wixOrderId} для отримання TTN
export async function getWixOrderFulfillments(wixOrderId) {
    const fulfillmentsRes = await fetch(`${WIX_API_BASE}/ecom/v1/fulfillments/orders/${wixOrderId}`, {
        method: 'GET',
        headers: getHeaders(),
    });

    if (fulfillmentsRes.status === 404) {
        return []; 
    }
    
    if (!fulfillmentsRes.ok) {
        const errorText = await fulfillmentsRes.text();
        console.error(`Wix Fulfillments Error (ID: ${wixOrderId}): ${errorText}`);
        return []; 
    }

    const data = await fulfillmentsRes.json();
    return data.fulfillments || [];
}


// НОВА ФУНКЦІЯ: Скасування замовлення Wix за зовнішнім ID
export async function cancelWixOrderByExternalId(externalId) {
    // 1. Пошук ID та статусу замовлення
    // Використовуємо ОНОВЛЕНУ функцію findWixOrderByExternalId
    const basicOrderInfo = await findWixOrderByExternalId(externalId);

    if (!basicOrderInfo) {
        return { status: 404, wixOrderId: null };
    }

    const wixOrderId = basicOrderInfo.id;
    const wixOrderStatus = basicOrderInfo.status;
    const wixFulfillmentStatus = basicOrderInfo.fulfillmentStatus;

    // 2. Перевірка на конфлікти (409 Conflict) згідно з Murkit
    if (wixOrderStatus === 'CANCELED') {
        return { status: 409, code: 'ORDER_ALREADY_CANCELED' };
    }
    
    if (wixFulfillmentStatus === 'FULFILLED' || wixFulfillmentStatus === 'DELIVERED') {
        return { status: 409, code: 'CANNOT_CANCEL_ORDER' }; 
    }

    // 3. Виклик Wix Cancel API
    const cancelRes = await fetch(`${WIX_API_BASE}/stores/v1/orders/${wixOrderId}/cancel`, {
        method: 'POST', // Wix використовує POST для скасування
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
