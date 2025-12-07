// api/debug-wix.js
import { getInventoryBySkus, fetchAllProducts } from '../lib/wixClient.js';

export default async function handler(req, res) {
  // Добавлена возможность передать параметр limit для просмотра большего кол-ва товаров
  const { sku, limit: limitQuery } = req.query; 
  const LIMIT = parseInt(limitQuery) || 10; // По умолчанию показываем 10 товаров

  try {
    const startTime = Date.now();
    
    // (1) Получаем сырые данные всех продуктов напрямую из Wix
    const allProductsRaw = await fetchAllProducts(); 
    const durationFetch = Date.now() - startTime;
    
    // --- НОВАЯ ЛОГИКА: Вывод списка всех продуктов (если sku не задан) ---
    if (!sku) {
      const productSummary = allProductsRaw.slice(0, LIMIT).map(p => {
        return {
          id: p.id,
          sku: p.sku || 'No Base SKU',
          name: p.name || 'No Name',
          has_variants: (p.variants && p.variants.length > 0),
          // Извлекаем только ключевые поля вариантов
          variants: p.variants ? p.variants.map(v => ({
              variantId: v.id,
              // КЛЮЧЕВОЕ ПОЛЕ: variant?.sku
              sku: v.variant?.sku || 'No Variant SKU', 
          })) : []
        };
      });

      return res.status(200).json({
        message: `Showing first ${productSummary.length} of ${allProductsRaw.length} products.`,
        total_products_fetched: allProductsRaw.length,
        fetch_duration_ms: durationFetch,
        product_list_summary: productSummary,
        note: "Raw SKU for variants is nested: variants[i].variant.sku. Please verify the 'sku' field in the 'variants' list below."
      });
    }
    // --- КОНЕЦ НОВОЙ ЛОГИКИ ---


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
      
      // КЛЮЧЕВОЙ ДЕБАГ: Сырой объект продукта из Wix
      raw_wix_product_structure: rawProductDebug ? {
          id: rawProductDebug.id,
          sku: rawProductDebug.sku,
          has_variants: (rawProductDebug.variants && rawProductDebug.variants.length > 0),
          // Выводим только данные вариантов, чтобы увидеть структуру:
          variants: rawProductDebug.variants ? rawProductDebug.variants.map(v => ({
              variantId: v.id,
              sku: v.variant?.sku, // Проверьте это поле!
              priceData: v.variant?.priceData,
              stock: v.variant?.stock
          })) : null
      } : "Product containing SKU not found in raw API response",
      
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
