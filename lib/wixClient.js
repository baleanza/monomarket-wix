import fetch from 'node-fetch';

const WIX_API_BASE = 'https://www.wixapis.com';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

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

// 1. Поиск товаров (Используем V1 API)
export async function getProductsBySkus(skus) {
  if (!skus || skus.length === 0) return [];

  try {
    // V1 Product Query
    const res = await fetch(`${WIX_API_BASE}/stores/v1/products/query`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        query: {
          filter: { sku: { $in: skus } }
        }
      })
    });

    if (!res.ok) {
      console.error('Wix Products V1 Error:', res.status, await res.text());
      return [];
    }

    const data = await res.json();
    return data.products || [];
  } catch (e) {
    console.error('Network error requesting Wix Products:', e);
    return [];
  }
}

// 2. Получение остатков (Используем V2 Inventory API - это стандарт для Catalog V1)
export async function getInventoryBySkus(skus) {
  if (!skus || skus.length === 0) return [];
  
  const stringSkus = skus.map(s => String(s).trim());
  
  try {
    // Обратите внимание: stores/v2/inventoryItems (camelCase, не inventory-items)
    const res = await fetch(`${WIX_API_BASE}/stores/v2/inventoryItems/query`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        query: {
          // В старом каталоге поле обычно называется просто 'sku'
          filter: { 
            "sku": { "$in": stringSkus } 
          }
        }
      })
    });

    if (!res.ok) {
        console.error('Wix Inventory V2 Error:', res.status, await res.text());
        return [];
    }

    const data = await res.json();
    const items = data.inventoryItems || [];

    return items.map(item => {
        // В V2 API структура немного другая
        // item.variants[0].sku или item.sku
        let itemSku = item.sku; 
        
        // Если это вариант товара, SKU может быть глубже
        if (!itemSku && item.variants && item.variants.length > 0) {
            itemSku = item.variants[0].sku;
        }

        return {
            sku: itemSku,
            // В V2 поле называется isStock или trackQuantity + quantity
            inStock: item.inStock === true, 
            quantity: item.quantity || 0
        };
    });

  } catch (e) {
    console.error('Network error requesting Wix Inventory:', e);
    return [];
  }
}

// 3. Создание заказа (Используем V2 Orders API)
export async function createWixOrder(orderData) {
  // Эндпоинт V2
  const res = await fetch(`${WIX_API_BASE}/stores/v2/orders`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ order: orderData })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create Wix order: ${res.status} ${text}`);
  }

  return await res.json();
}
