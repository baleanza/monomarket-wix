import { createWixOrder, getHeaders } from '../lib/wixClient.js';
import fetch from 'node-fetch';

const WIX_API_BASE = 'https://www.wixapis.com';

// Функция для получения одного заказа по ID
async function getOrderById(orderId) {
  console.log(`Fetching Order ID: ${orderId}...`);
  
  // Используем GET запрос к ecom/v1/orders/{id}
  const res = await fetch(`${WIX_API_BASE}/ecom/v1/orders/${orderId}`, {
    method: 'GET',
    headers: getHeaders()
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Error ${res.status}: ${text}`);
  }

  return await res.json();
}

// Запуск (можно вызвать локально через node api/get-order-debug.js <ORDER_ID>)
// Или просто захардкодить ID для теста
const TEST_ORDER_ID = "ВСТАВЬТЕ_СЮДА_ID_ВАШЕГО_ТЕСТОВОГО_ЗАКАЗА_ИЗ_WIX"; 

(async () => {
  try {
    if (TEST_ORDER_ID === "ВСТАВЬТЕ_СЮДА_ID_ВАШЕГО_ТЕСТОВОГО_ЗАКАЗА_ИЗ_WIX") {
        console.log("Пожалуйста, впишите реальный ID заказа в файл.");
        return;
    }
    const orderData = await getOrderById(TEST_ORDER_ID);
    console.log("FULL ORDER JSON:");
    console.log(JSON.stringify(orderData, null, 2));
  } catch (e) {
    console.error(e);
  }
})();
