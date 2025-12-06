import { createWixOrder, getProductsBySkus } from '../lib/wixClient.js';

// Проверка Basic Auth (Логин/Пароль, которые вы зададите в Murkit)
function checkAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return false;

  const b64auth = authHeader.split(' ')[1];
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

  const expectedUser = process.env.MURKIT_USER;
  const expectedPass = process.env.MURKIT_PASS;

  return login === expectedUser && password === expectedPass;
}

export default async function handler(req, res) {
  // Murkit шлет POST запрос
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  // 1. Проверяем авторизацию
  if (!checkAuth(req)) {
    console.warn('Unauthorized access attempt to Murkit Webhook');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const murkitData = req.body;
    console.log('New Order from Murkit:', JSON.stringify(murkitData, null, 2));

    // Проверка, что заказ вообще содержит товары
    const murkitItems = murkitData.items || [];
    if (murkitItems.length === 0) {
      res.status(400).json({ error: 'No items in order' });
      return;
    }

    // 2. Собираем все SKU из заказа Murkit
    const skus = murkitItems.map(item => item.code).filter(Boolean);

    // 3. Ищем эти товары в Wix, чтобы получить их ID
    const wixProducts = await getProductsBySkus(skus);
    
    // Создаем карту: SKU -> Wix Product ID
    const skuToIdMap = {};
    wixProducts.forEach(p => {
      skuToIdMap[p.sku] = p.id;
    });

    // 4. Формируем Line Items для Wix
    const lineItems = murkitItems.map(item => {
        const wixId = skuToIdMap[item.code];
        
        if (!wixId) {
            console.warn(`SKU ${item.code} not found in Wix, adding as custom item (stock won't decrease automatically)`);
            return {
                name: item.name || `Item ${item.code}`,
                quantity: parseInt(item.quantity || 1, 10),
                price: {
                    amount: String(item.price || 0),
                    currency: "UAH"
                }
            };
        }

        return {
            catalogReference: {
                catalogItemId: wixId,
                appId: "1380b703-ce81-ff05-f115-39571d94dfcd", // Wix Stores App ID
            },
            quantity: parseInt(item.quantity || 1, 10),
            price: {
                amount: String(item.price || 0),
                currency: "UAH"
            }
        };
    });

    // 5. Собираем данные получателя
    const recipient = murkitData.recipient || {};
    const delivery = murkitData.delivery || {};
    
    // Формируем объект заказа Wix
    const wixOrderPayload = {
      channelInfo: {
        type: "API",
        externalId: String(murkitData.id) // ID заказа в Murkit
      },
      lineItems: lineItems,
      billingInfo: {
        address: {
          country: "UA",
          // В Murkit город/адрес могут приходить по-разному, пробуем найти
          city: delivery.city || recipient.city || "Kyiv", 
          addressLine1: delivery.address || recipient.address || "TBD",
          email: recipient.email || "no-email@example.com",
          firstName: recipient.firstName || recipient.name || "Client",
          lastName: recipient.lastName || "",
          phone: recipient.phone || ""
        }
      },
      // Ставим статус оплаты
      paymentStatus: murkitData.payment_status === 'paid' ? 'PAID' : 'NOT_PAID',
    };

    // 6. Отправляем в Wix
    const createdOrder = await createWixOrder(wixOrderPayload);
    console.log('Order created in Wix:', createdOrder.order?.id);

    // 7. Отвечаем Murkit успешным статусом
    res.status(200).json({ 
        success: true, 
        wix_order_id: createdOrder.order?.id 
    });

  } catch (e) {
    console.error('Error processing Murkit webhook:', e);
    // Возвращаем ошибку 500, чтобы Murkit знал, что что-то пошло не так
    // (он может попробовать переотправить позже, зависит от настроек)
    res.status(500).json({ error: e.message });
  }
}
