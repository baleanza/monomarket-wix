import fetch from 'node-fetch';

const WIX_API_URL = 'https://www.wixapis.com/stores/v1';

// Helper to get headers
function getHeaders() {
    return {
        'Authorization': process.env.WIX_API_KEY,
        'wix-site-id': process.env.WIX_SITE_ID,
        'Content-Type': 'application/json'
    };
}

export async function createWixOrder(orderData) {
    const response = await fetch(`${WIX_API_URL}/orders`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ order: orderData })
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Wix API Error (Create Order): ${err}`);
    }
    return await response.json();
}

export async function getProductsBySkus(skus) {
    const response = await fetch('https://www.wixapis.com/stores/v1/products/query', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
            query: {
                filter: {
                    "sku": { "$in": skus }
                },
                paging: { limit: 100 }
            },
            includeVariants: true 
        })
    });
    if (!response.ok) {
        console.error("Wix API Error (Get Products):", await response.text());
        return [];
    }
    const data = await response.json();
    return data.products || [];
}

export async function findWixOrderByExternalId(externalId) {
    const response = await fetch(`${WIX_API_URL}/orders/query`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
            query: {
                filter: {
                    "channelInfo.externalOrderId": { "$eq": String(externalId) }
                }
            }
        })
    });
    
    if (!response.ok) return null;
    const data = await response.json();
    if (data.orders && data.orders.length > 0) {
        return data.orders[0];
    }
    return null;
}

export async function findWixOrderById(wixId) {
    const response = await fetch(`${WIX_API_URL}/orders/${wixId}`, {
        method: 'GET',
        headers: getHeaders()
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.order;
}

export async function getWixOrderFulfillments(wixId) {
    const response = await fetch(`${WIX_API_URL}/orders/${wixId}/fulfillments`, {
        method: 'GET',
        headers: getHeaders()
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.fulfillments;
}

export async function getWixOrderFulfillmentsBatch(orderIds) {
    if (!orderIds || orderIds.length === 0) return [];
    
    // Используем Promise.all для параллельного получения, так как надежного batch-эндпоинта может не быть
    const promises = orderIds.map(id => 
        fetch(`${WIX_API_URL}/orders/${id}/fulfillments`, { headers: getHeaders() })
            .then(res => res.json())
            .then(data => ({ orderId: id, fulfillments: data.fulfillments }))
            .catch(() => ({ orderId: id, fulfillments: [] }))
    );
    return await Promise.all(promises);
}

export async function cancelWixOrderById(wixId) {
    const response = await fetch(`${WIX_API_URL}/orders/${wixId}/cancel`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({}) 
    });
    
    if (response.ok) return { status: 200 };
    
    const errText = await response.text();
    let errJson;
    try { errJson = JSON.parse(errText); } catch(e){}
    
    const code = errJson?.code || 'UNKNOWN';
    return { status: 409, code: code, message: errText };
}

export async function adjustInventory(adjustments) {
    const response = await fetch('https://www.wixapis.com/stores/v2/inventory/items/increment', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
            items: adjustments.map(a => ({
                itemId: a.variantId || a.productId, 
                incrementBy: -1 * Math.abs(a.quantity) 
            }))
        })
    });
    if (!response.ok) {
        throw new Error(`Inventory Error: ${await response.text()}`);
    }
}

export async function updateWixOrderDetails(orderId, fields) {
    const response = await fetch(`${WIX_API_URL}/orders/${orderId}`, {
        method: 'PATCH',
        headers: getHeaders(),
        body: JSON.stringify({ order: fields })
    });
    return response.ok;
}

// === ОБНОВЛЕННАЯ ФУНКЦИЯ ПОИСКА ТРАНЗАКЦИЙ ===
export async function getWixOrderTransactions(orderId) {
    // 1. Основной метод: POST QUERY (как в List Transactions for Multiple Orders)
    // Это надежнее, чем GET
    try {
        const queryResponse = await fetch(`${WIX_API_URL}/transactions/query`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({
                query: {
                    filter: {
                        "orderId": { "$eq": orderId }
                    },
                    paging: { limit: 100 } // Берем с запасом
                }
            })
        });

        if (queryResponse.ok) {
            const data = await queryResponse.json();
            if (data.transactions) {
                return data.transactions;
            }
        } else {
            console.warn(`[WixClient] Transaction Query failed: ${queryResponse.status}`);
        }
    } catch (e) {
        console.error(`[WixClient] Transaction Query Error: ${e.message}`);
    }

    // 2. Запасной метод: GET (если POST не сработал или вернул ошибку API)
    console.log(`[WixClient] Fallback to GET transactions for ${orderId}`);
    const response = await fetch(`${WIX_API_URL}/orders/${orderId}/transactions`, {
        method: 'GET',
        headers: getHeaders()
    });
    
    if (response.ok) {
        const data = await response.json();
        return data.transactions || [];
    }
    
    return [];
}

export async function addExternalPayment(orderId, amount, currency, date = null) {
    const d = date ? new Date(date).toISOString() : new Date().toISOString();
    const response = await fetch(`${WIX_API_URL}/orders/${orderId}/transactions`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
            transaction: {
                type: "ORDER_PAID",
                amount: { amount: String(amount), currency: currency },
                date: d,
                customTransaction: {
                    paymentProviderId: "External / Monobank",
                    paymentMethod: "Card/Cash"
                }
            }
        })
    });
    if (!response.ok) throw new Error(await response.text());
    return await response.json();
}

// === НОВАЯ ФУНКЦИЯ ДЛЯ ПРИНУДИТЕЛЬНОГО ВОЗВРАТА ===
export async function createExternalRefund(orderId, amount, currency, date = null) {
    const d = date ? new Date(date).toISOString() : new Date().toISOString();
    
    // Wix требует уникальный ID провайдера или структуру для Custom транзакций.
    // Создаем транзакцию с типом REFUND
    const response = await fetch(`${WIX_API_URL}/orders/${orderId}/transactions`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
            transaction: {
                type: "REFUND",
                amount: { amount: String(amount), currency: currency },
                date: d,
                customTransaction: {
                    paymentProviderId: "External / Monomarket Refund",
                    paymentMethod: "System"
                }
            }
        })
    });
    
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to create external refund: ${errText}`);
    }
    return await response.json();
}

// Вспомогательная обертка для совместимости со старым кодом, 
// но теперь она использует универсальный createExternalRefund
export async function createWixRefund(orderId, paymentId, amount, currency) {
    return createExternalRefund(orderId, amount, currency);
}
