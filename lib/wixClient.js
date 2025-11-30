import fetch from 'node-fetch';

const WIX_OAUTH_URL = 'https://www.wix.com/oauth/access';
const WIX_API_BASE = 'https://www.wixapis.com';

async function getAccessToken() {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.WIX_CLIENT_ID,
    client_secret: process.env.WIX_CLIENT_SECRET,
    refresh_token: process.env.WIX_REFRESH_TOKEN
  });

  const res = await fetch(WIX_OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Wix OAuth error: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.access_token;
}

export async function getInventoryBySkus(skus) {
  if (!skus || skus.length === 0) return [];

  const accessToken = await getAccessToken();

  const res = await fetch(
    `${WIX_API_BASE}/stores/v3/inventory-items/query`,
    {
      method: 'POST',
      headers: {
        Authorization: accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: {
          filter: {
            sku: { $in: skus }
          }
        }
      })
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Wix inventory error: ${res.status} ${text}`);
  }

  const data = await res.json();
  // data.inventoryItems: [{ id, sku, trackQuantity, inStock, quantity, ... }]
  return data.inventoryItems || [];
}
