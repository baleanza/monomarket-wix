import fetch from 'node-fetch';

export default async function handler(req, res) {
  const { sku } = req.query;
  const token = process.env.WIX_ACCESS_TOKEN;
  const siteId = process.env.WIX_SITE_ID;

  if (!token || !siteId) {
    return res.status(500).json({ error: 'Missing WIX_ACCESS_TOKEN or WIX_SITE_ID' });
  }

  if (!sku) return res.status(400).json({ error: 'Provide ?sku=...' });

  try {
    // Тестируем V2 Inventory (совместимый с Catalog V1)
    const response = await fetch('https://www.wixapis.com/stores/v2/inventoryItems/query', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'wix-site-id': siteId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: {
          filter: { 
            "sku": { "$in": [sku] } 
          }
        }
      })
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = { error: "Failed to parse JSON", raw: text };
    }

    res.status(200).json({
      method: "v2/inventoryItems/query", // Показываем, что используем V2
      status_code: response.status,
      site_id_used: siteId,
      found_count: data.inventoryItems ? data.inventoryItems.length : 0,
      first_item: data.inventoryItems ? data.inventoryItems[0] : "Not found",
      full_response: data
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
