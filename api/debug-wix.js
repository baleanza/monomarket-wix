// api/debug-wix.js
import { getInventoryBySkus, fetchAllProducts } from '../lib/wixClient.js';

export default async function handler(req, res) {
  // Добавлена возможность передать параметр limit для просмотра большего кол-ва товаров
  const { sku, limit: limitQuery } = req.query; 
  const LIMIT = parseInt(limitQuery) || 5; // По умолчанию показываем 5 сырых товаров

  try {
    const startTime = Date.now();
    
    // (1) Получаем сырые данные всех продуктов напрямую из Wix
    const allProductsRaw = await fetchAllProducts(); 
    const durationFetch = Date.now() - startTime;
    
    // --- ЛОГИКА: Вывод сырого списка продуктов (если sku не задан) ---
    if (!sku) {
      const rawProductsSlice = allProductsRaw.slice(0, LIMIT);

      return res.status(200).json({
        mode: "Raw Product Dump",
        message: `Showing raw data for first ${rawProductsSlice.length} of ${allProductsRaw.length} products. Use ?sku=... for detailed lookup.`,
        total_products_fetched: allProductsRaw.length,
        fetch_duration_ms: durationFetch,
        // Выводим срез сырых данных
        raw_product_data_slice: rawProductsSlice,
        note: "This is the raw data array received from Wix V1 API. Look inside the 'variants' array for variant details. The SKU for a variant is typically nested in: variants[i].variant.sku"
      });
    }
    // --- КОНЕЦ ЛОГИКИ СРЕЗА ---


    // --- СТАРАЯ ЛОГИКА: Детальная проверка для одного SKU (если sku задан) ---
    const targetSku = String(sku).trim(); 
    let rawProductDebug = null; 

    // (2) Ищем сырой продукт, который содержит искомый SKU
    const foundProduct = allProductsRaw.find(p => {
        // Проверка SKU основного продукта
        if (String(p.sku || '').trim() === targetSku) return true;
        
        // Проверка SKU вариантов
        if (p.variants && p.variants.length > 0) {
            return p.variants.some(v => String(v.variant?.sku || '').trim() === targetSku);
        }
        return false;
    });

    if (foundProduct) {
        rawProductDebug = foundProduct;
    }
    
    // (3) Вызываем основную функцию, чтобы проверить логику обработки
    const results = await getInventoryBySkus([sku]);
    
    const duration = Date.now() - startTime;

    // Ищем результат для конкретного SKU
    const foundItem = results.find(item => String(item.sku).trim() === targetSku);

    // --- ИЗМЕНЕНИЕ: Теперь выводим полный сырой объект, а не упрощенный ---
    const rawProductOutput = rawProductDebug || "Product containing SKU not found in raw API response";
    // --- КОНЕЦ ИЗМЕНЕНИЯ ---

    res.status(200).json({
      test_sku: sku,
      // Состояние после прохождения через вашу логику
      found_in_wix_inventory: !!foundItem, 
      
      stock_status: foundItem ? {
        available: foundItem.inStock,
        quantity: foundItem.quantity,
        price: foundItem.price
      } : "SKU not found in Wix product list",

      execution_time_ms: duration,
      items_found_total: results.length,
      
      // КЛЮЧЕВОЙ ДЕБАГ: Сырой объект продукта из Wix (ПОЛНЫЙ ДАМП)
      raw_wix_product_structure: rawProductOutput,
      
      // Обработанные данные для сравнения
      debug_raw_processed: foundItem 
    });

  } catch (e) {
    res.status(500).json({ 
      error: 'Script failed', 
      message: e.message,
      stack: e.stack
    });
  }
}
