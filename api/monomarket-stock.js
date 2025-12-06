// api/monomarket-stock.js
import { google } from 'googleapis';
import { getInventoryBySkus } from '../lib/wixClient.js';
import { buildStockJson } from '../lib/stockFeedBuilder.js'; 
// ІМПОРТ ВИПРАВЛЕНО
import { ensureAuth, requireEnv } from '../lib/sheetsClient.js'; 

const CACHE_TTL_SECONDS = 300; 

function checkApiKey(req) {
  const apiKey = requireEnv('API_KEY');
  if (!apiKey) return true;
  const headerKey = req.headers['x-api-key'];
  return headerKey && headerKey === apiKey;
}

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

  if (!checkApiKey(req)) {
    res.status(401).send('Unauthorized');
    return;
  }

  try {
    const { sheets, spreadsheetId } = await ensureAuth();
    const { importValues, controlValues, deliveryValues } = await readSheetData(
      sheets,
      spreadsheetId
    );

    const jsonOutput = await buildStockJson(importValues, controlValues, deliveryValues, getInventoryBySkus);

    res.setHeader('Content-Type', "application/json; charset=utf-8");
    res.setHeader('Cache-Control', `public, s-maxage=${CACHE_TTL_SECONDS}, max-age=0`);
    res.status(200).send(jsonOutput);
    
  } catch (e) {
    console.error('Error in /api/monomarket-stock', e);
    // Додаємо детальну інформацію про помилку, щоб було легше діагностувати.
    res.status(502).json({ error: 'Bad Gateway', details: e.message });
  }
}
