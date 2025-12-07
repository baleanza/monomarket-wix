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

// Изменена на export для целей отладки
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
          // Явное включение вариантов и скрытых продуктов
          includeVariants: true, 
          includeHiddenProducts: true,
          query: {
            limit: limit,
            skip: skip,
            fields: ["variants", "id", "sku", "name", "priceData", "stock", "options", "productType"] 
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
        // Доступ к SKU через v.variant?.sku
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
  // **** ДОБАВЛЕНО ДЛЯ ОТЛАДКИ (Печатает FINAL PAYLOAD перед отправкой) ****
  console.log('WIX FINAL PAYLOAD:', JSON.stringify({ order: orderData }, null, 2));
  // ********************************************************************
    
  const res = await fetch(`${WIX_API_BASE}/stores/v2/orders`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ order: orderData })
  });

  if (!res.ok) {
    const text = await res.text();
    // Выводим полный текст ответа Wix, который может содержать детали ошибки
    console.error('WIX API Error Response:', text);
    throw new Error(`Failed to create Wix order: ${res.status} ${text}`);
  }

  return await res.json();
}
