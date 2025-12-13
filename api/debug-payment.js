import fetch from 'node-fetch';

// Копируем логику заголовков, чтобы файл был независимым
const WIX_API_BASE = 'https://www.wixapis.com';

function getHeaders() {
    return {
        'Authorization': `Bearer ${process.env.WIX_ACCESS_TOKEN}`,
        'wix-site-id': process.env.WIX_SITE_ID,
        'Content-Type': 'application/json'
    };
}

export default async function handler(req, res) {
    // Берем ID из параметров ?id=... или используем проблемный заказ по умолчанию
    const orderId = req.query.id || '9347737c-06e1-457d-8f02-49347d1ee942';

    const results = {
        orderId: orderId,
        checks: []
    };

    const addLog = (method, url, status, data) => {
        results.checks.push({
            method,
            url,
            status,
            data
        });
    };

    try {
        // --- 1. ПРОВЕРКА САМОГО ЗАКАЗА (ECOM V1) ---
        // Чтобы убедиться, что Wix вообще видит этот заказ и какой у него статус оплаты
        const orderRes = await fetch(`${WIX_API_BASE}/ecom/v1/orders/${orderId}`, {
            method: 'GET',
            headers: getHeaders()
        });
        let orderData = {};
        try { orderData = await orderRes.json(); } catch (e) { orderData = { error: 'Parse error' }; }
        addLog('GET Order (Ecom V1)', `/ecom/v1/orders/${orderId}`, orderRes.status, orderData);


        // --- 2. ПРОВЕРКА ОПЛАТ (ECOM V1 - PAYMENTS) ---
        // Это тот метод, который мы пытаемся использовать для VOID
        const paymentsRes = await fetch(`${WIX_API_BASE}/ecom/v1/payments/orders/${orderId}`, {
            method: 'GET',
            headers: getHeaders()
        });
        let paymentsData = {};
        try { paymentsData = await paymentsRes.json(); } catch (e) { paymentsData = { error: 'Parse error' }; }
        addLog('GET Payments (Ecom V1)', `/ecom/v1/payments/orders/${orderId}`, paymentsRes.status, paymentsData);


        // --- 3. ПРОВЕРКА ТРАНЗАКЦИЙ (STORES V1 - OLD SCHOOL) ---
        // Старый надежный метод, чтобы увидеть, есть ли транзакции вообще
        const transRes = await fetch(`${WIX_API_BASE}/stores/v1/orders/${orderId}/transactions`, {
            method: 'GET',
            headers: getHeaders()
        });
        let transData = {};
        try { transData = await transRes.json(); } catch (e) { transData = { error: 'Parse error' }; }
        addLog('GET Transactions (Stores V1)', `/stores/v1/orders/${orderId}/transactions`, transRes.status, transData);


        // --- 4. ПРОВЕРКА ТРАНЗАКЦИЙ (ECOM V1 - QUERY) ---
        // Попытка поиска через query (на всякий случай)
        const queryPayload = {
            query: {
                filter: { "orderId": { "$eq": orderId } }
            }
        };
        const queryRes = await fetch(`${WIX_API_BASE}/ecom/v1/transactions/query`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify(queryPayload)
        });
        let queryData = {};
        try { queryData = await queryRes.json(); } catch (e) { queryData = { error: 'Parse/404 error' }; }
        addLog('POST Query Transactions', `/ecom/v1/transactions/query`, queryRes.status, queryData);

        // Возвращаем полный отчет
        return res.status(200).json(results);

    } catch (error) {
        return res.status(500).json({ 
            error: error.message, 
            stack: error.stack,
            results 
        });
    }
}
