import { getWixOrderFulfillments } from '../lib/wixClient.js';
import { getHeaders } from '../lib/wixClient.js'; // Используем getHeaders для Auth

// Функция для аутентификации (взята из monomarket-endpoint.js)
function checkAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return false;
  const b64auth = authHeader.split(' ')[1];
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
  return login === process.env.MURKIT_USER && password === process.env.MURKIT_PASS;
}

export default async function handler(req, res) {
    // 1. Проверка авторизации
    if (!checkAuth(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // 2. Извлечение Wix ID из пути
    const wixId = req.query.wixId; // req.query.wixId будет соответствовать :wixId из vercel.json
    
    if (!wixId) {
        return res.status(400).json({ error: 'Missing Wix Order ID in path.' });
    }

    console.log(`DEBUG: Fetching fulfillments for Wix ID: ${wixId}`);

    try {
        // 3. Вызов функции просмотра фулфилмента
        const fulfillments = await getWixOrderFulfillments(wixId);

        if (!fulfillments || fulfillments.length === 0) {
            return res.status(200).json({
                orderId: wixId,
                status: 'OK',
                message: 'No fulfillments found or error in data fetching.',
                rawResponse: fulfillments
            });
        }
        
        // 4. Возвращаем необработанные данные
        return res.status(200).json({
            orderId: wixId,
            status: 'OK',
            message: 'Successfully fetched fulfillments.',
            fulfillmentCount: fulfillments.length,
            rawResponse: fulfillments
        });
        
    } catch (e) {
        console.error('DEBUG Fulfillment Error:', e.message);
        return res.status(500).json({
            orderId: wixId,
            status: 'ERROR',
            message: 'Internal server error during fulfillment fetch.',
            details: e.message
        });
    }
}
