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

// Вспомогательная функция для получения ВСЕХ товаров
// Обходит ограничения V1 API на фильтрацию
async function fetchAllProducts() {
  let allProducts = [];
  let skip = 0;
  const limit = 100;
  let hasMore = true;

  // Защита от бесконечного цикла (максимум 20 страниц = 2000 товаров)
  // Если товаров больше, можно увеличить
  const MAX_PAGES = 20; 
  let page = 0;

  while (hasMore && page < MAX_PAGES) {
    try {
      console.log(`Fetching Wix products page ${page + 1} (skip: ${skip})...`);
      
      const res = await fetch(`${WIX_API_BASE}/stores/v1/products/query`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          query: {
            limit: limit,
            skip: skip
            // Мы убрали 'filter', чтобы не вызывать ошибку 400
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
        hasMore = false; // Это была последняя страница
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

// Поиск товаров по SKU (для вебхука)
export async function getProductsBySkus(skus) {
  // Скачиваем все и фильтруем в памяти
  const allProducts = await fetchAllProducts();
  return allProducts.filter(p => skus.includes(p.sku));
}

// Получение остатков (для фида stock)
export async function getInventoryBySkus(skus) {
  if (!skus || skus.length === 0) return [];
  
  // 1. Скачиваем ВСЕ товары магазина
  const allProducts = await fetchAllProducts();
  console.log(`Total products fetched: ${allProducts.length}`);

  const inventoryMap = [];

  // 2. Проходим по всем скачанным товарам и ищем совпадения с нашим списком SKU
  allProducts.forEach(p => {
    // Проверяем варианты (если есть)
    if (p.variants && p.variants.length > 0) {
      p.variants.forEach(v => {
        if (skus.includes(v.sku)) {
          inventoryMap.push({
            sku: v.sku,
            inStock: v.inStock,
            quantity: v.quantity
          });
        }
      });
    }

    // Проверяем основной SKU
    if (p.sku && skus.includes(p.sku)) {
      inventoryMap.push({
        sku: p.sku,
        inStock: p.inStock,
        quantity: p.quantity
      });
    }
  });

  return inventoryMap;
}

// Создание заказа
export async function createWixOrder(orderData) {
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
