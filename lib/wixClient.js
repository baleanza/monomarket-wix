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
  return requireEnv('WIX_SITE_ID'); // Новая функция
}

// Общие заголовки для всех запросов
function getHeaders() {
  return {
    'Authorization': `Bearer ${getAccessToken()}`,
    'wix-site-id': getSiteId(), // ВАЖНО: Добавляем ID сайта
    'Content-Type': 'application/json'
  };
}

// Поиск товаров по SKU (для вебхука)
export async function getProductsBySkus(skus) {
  if (!skus || skus.length === 0) return [];

  try {
    const res = await fetch(`${WIX_API_BASE}/stores/v3/products/query`, {
      method: 'POST',
      headers: getHeaders(), // Используем общие заголовки
      body: JSON.stringify({
        query: {
          filter: { sku: { $in: skus } }
        }
      })
    });

    if (!res.ok) {
      console.error('Wix Products Query Error:', res.status, await res.text());
      return [];
    }

    const data = await res.json();
    return data.products || [];
  } catch (e) {
    console.error('Network error requesting Wix Products:', e);
    return [];
  }
}

// Получение остатков (для фида stock)
export async function getInventoryBySkus(skus) {
  if (!skus || skus.length === 0) return [];
  
  const stringSkus = skus.map(s => String(s).trim());
  
  try {
    const res = await fetch(`${WIX_API_BASE}/stores/v3/inventory-items/query`, {
      method: 'POST',
      headers: getHeaders(), // Используем общие заголовки с Site ID
      body: JSON.stringify({
        query: {
          filter: { 
            "product.variantSku": { "$in": stringSkus } 
          },
          fields: ['id', 'product', 'stock'] 
        }
      })
    });

    if (!res.ok) {
        console.error('Wix Inventory Error:', res.status, await res.text());
        return [];
    }

    const data = await res.json();
    const items = data.inventoryItems || [];

    return items.map(item => {
        const itemSku = item.product?.variantSku || item.product?.sku || item.externalId;
        return {
            sku: itemSku,
            inStock: item.stock ? item.stock.inStock : false,
            quantity: item.stock ? item.stock.quantity : 0
        };
    });

  } catch (e) {
    console.error('Network error requesting Wix Inventory:', e);
    return [];
  }
}

// Создание заказа
export async function createWixOrder(orderData) {
  const res = await fetch(`${WIX_API_BASE}/stores/v3/orders`, {
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
