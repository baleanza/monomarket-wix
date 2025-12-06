import fetch from 'node-fetch';

export default async function handler(req, res) {
  const { sku } = req.query;
  const token = process.env.WIX_ACCESS_TOKEN;

  if (!token) {
    return res.status(500).json({ error: 'WIX_ACCESS_TOKEN missing' });
  }

  if (!sku) {
    return res.status(400).json({ error: 'Provide ?sku=...' });
  }

  try {
    // Используем INVENTORY API (оно поддерживает фильтр по SKU)
    const response = await fetch('https://www.wixapis.com/stores/v3/inventory-items/query', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
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

    // Смотрим, что вернулось
    const items = data.inventoryItems || [];
    const item = items[0];

    res.status(200).json({
      method: "inventory-items/query",
      status_code: response.status,
      requested_sku: sku,
      found_count: items.length,
      
      // Самое важное: смотрим, в каких полях спрятан SKU
      first_item_debug: item ? {
        id: item.id,
        externalId: item.externalId, // Часто SKU лежит здесь
        sku_field: item.sku,         // Или здесь
        variants: item.variants
      } : "Not found",

      full_response: data
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
