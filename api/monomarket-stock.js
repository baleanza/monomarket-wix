// api/monomarket-stock.js
import { google } from 'googleapis';
import { getInventoryBySkus } from '../lib/wixClient.js';
import { buildStockJson } from '../lib/stockFeedBuilder.js'; 
import { ensureAuth, requireEnv, cleanPrice } from '../lib/sheetsClient.js'; // Добавлен cleanPrice для buildStockJson

const CACHE_TTL_SECONDS = 300; 

// Функция checkApiKey удалена

async function readSheetData(sheets, spreadsheetId) {
  const importRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Import!A1:ZZ'
  });

  const controlRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Feed Control List!A1:F'
  });

  const deliveryRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Delivery!A1:C'
  });

  return { 
    importValues: importRes.data.values || [], 
    controlValues: controlRes.data.values || [],
    deliveryValues: deliveryRes.data.values || [] 
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  // Проверка авторизации удалена

  try {
    const { sheets, spreadsheetId } = await ensureAuth();
    const { importValues, controlValues, deliveryValues } = await readSheetData(
      sheets,
      spreadsheetId
    );
    
    // Передаем cleanPrice в buildStockJson
    const jsonOutput = await buildStockJson(importValues, controlValues, deliveryValues, getInventoryBySkus, cleanPrice);

    res.setHeader('Content-Type', "application/json; charset=utf-8");
    res.setHeader('Cache-Control', `public, s-maxage=${CACHE_TTL_SECONDS}, max-age=0`);
    res.status(200).send(jsonOutput);
    
  } catch (e) {
    console.error('Error in /api/monomarket-stock', e);
    res.status(502).json({ error: 'Bad Gateway', details: e.message });
  }
}
