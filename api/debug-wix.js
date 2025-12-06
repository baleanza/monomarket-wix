import fetch from 'node-fetch';

export default async function handler(req, res) {
  const { sku } = req.query;
  const token = process.env.WIX_ACCESS_TOKEN;

  // 1. Проверяем наличие токена
  if (!token) {
    return res.status(500).json({ error: 'WIX_ACCESS_TOKEN is missing in env variables' });
  }

  // 2. Проверяем, передан ли артикул
  if (!sku) {
    return res.status(400).json({ error: 'Please provide an SKU in url, e.g. ?sku=123' });
  }

  try {
    // 3. Делаем прямой запрос к Wix (тот же метод, что и в рабочем скрипте)
    const response = await fetch('https://www.wixapis.com/stores/v3/products/query', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: {
          filter: { "sku": { "$in": [sku] } }
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

    // 4. Формируем отчет для вас
    const product = data.products && data.products[0];
    
    res.status(200).json({
      status_code: response.status,
      requested_sku: sku,
      found: product ? true : false,
      
      // Самое важное: что Wix думает про сток этого товара
      stock_debug: product ? {
        inStock: product.stock?.inStock,
        quantity: product.stock?.quantity,
        trackQuantity: product.stock?.trackQuantity,
        inventoryStatus: product.stock?.inventoryStatus
      } : "Product not found",

      // Полный ответ от Wix (чтобы увидеть все поля)
      full_wix_response: data
    });

  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
}
