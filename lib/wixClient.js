import fetch from 'node-fetch';

const WIX_API_BASE = 'https://www.wixapis.com';
const ACCOUNT_ID = process.env.WIX_ACCOUNT_ID; 
const SITE_ID = process.env.WIX_SITE_ID;       

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing env var ${name}`);
  }
  return v;
}

function getAccessToken() {
  return requireEnv('WIX_ACCESS_TOKEN');
}

export async function getInventoryBySkus(skus) {
  if (!skus || skus.length === 0) return [];

  const accessToken = getAccessToken();
  
  try {
    const res = await fetch(`${WIX_API_BASE}/stores/v3/inventory-items/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: {
          filter: { sku: { $in: skus } }
        }
      })
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('Wix Inventory Error:', res.status, text);
      return []; // Возвращаем пустой массив, чтобы не ронять весь фид
    }

    const data = await res.json();
    return data.inventoryItems || data.items || [];
  } catch (e) {
    console.error('Network error requesting Wix:', e);
    return [];
  }
}

export async function createWixOrder(orderData) {
  const accessToken = getAccessToken();


  const res = await fetch(`${WIX_API_BASE}/stores/v3/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      order: orderData
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create Wix order: ${res.status} ${text}`);
  }

  return await res.json();
}
