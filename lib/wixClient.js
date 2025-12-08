import fetch from 'node-fetch';
import { requireEnv } from './sheetsClient.js'; 

const WIX_API_BASE = 'https://www.wixapis.com';

function getAccessToken() {
  return requireEnv('WIX_ACCESS_TOKEN');
}

function getSiteId() {
  return requireEnv('WIX_SITE_ID');
}

function getHeaders() {
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
        const variantSku = v.variant?.sku; 
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
          fields: ["id", "channelInfo"] // Нам нужен только ID
        }
      })
    });

    if (!res.ok) {
      console.error("Error searching order:", await res.text());
      return null;
    }

    const data = await res.json();
    if (data.orders && data.orders.length > 0) {
      return data.orders[0]; // Возвращаем найденный заказ
    }
    return null; // Заказ не найден

  } catch (e) {
    console.error("Network error searching order:", e);
    return null;
  }
}

// === НОВАЯ ФУНКЦИЯ ДЛЯ СПИСАНИЯ ОСТАТКОВ ===
export async function adjustInventory(adjustments) {
  if (!adjustments || adjustments.length === 0) return;

  const payload = {
    inventoryAdjustments: adjustments.map(adj => ({
      productId: adj.productId,
      variantId: adj.variantId || null,
      // Отрицательное значение для списания
      adjustment: -Math.abs(adj.quantity), 
      reason: "ORDER_CREATED"
    }))
  };

  console.log('WIX INVENTORY ADJUSTMENT PAYLOAD:', JSON.stringify(payload, null, 2));

  const res = await fetch(`${WIX_API_BASE}/stores/v1/inventory/adjustments`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('WIX INVENTORY API Error Response:', res.status, text);
    throw new Error(`Failed to adjust Wix inventory (${res.status}): ${text}`);
  }

  const jsonResponse = await res.json();
  console.log('WIX INVENTORY API SUCCESS RESPONSE:', JSON.stringify(jsonResponse, null, 2));
  return jsonResponse;
}
