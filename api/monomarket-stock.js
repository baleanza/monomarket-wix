import { google } from 'googleapis';
import { getSheetsClient } from '../../lib/sheetsClient.js';
import { getInventoryBySkus } from '../../lib/wixClient.js';
import { buildStockXml } from '../../lib/stockFeedBuilder.js';

const CACHE_TTL_SECONDS = 300; // 5 минут CDN-кеша

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing env var ${name}`);
  }
  return v;
}

function checkApiKey(req) {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return true;
  const headerKey = req.headers['x-api-key'];
  return headerKey && headerKey === apiKey;
}

async function ensureAuth() {
  const keyJson = requireEnv('GOOGLE_SERVICE_ACCOUNT_KEY');
  const spreadsheetId = requireEnv('SPREADSHEET_ID');

  const keyObj = JSON.parse(keyJson);

  const jwtClient = new google.auth.JWT(
    keyObj.client_email,
    null,
    keyObj.private_key,
    ['https://www.googleapis.com/auth/spreadsheets.readonly']
  );
  await jwtClient.authorize();

  const sheets = getSheetsClient(jwtClient);
  return { sheets, spreadsheetId };
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

  const importValues = importRes.data.values || [];
  const controlValues = controlRes.data.values || [];

  return { importValues, controlValues };
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
    const { importValues, controlValues } = await readSheetData(
      sheets,
      spreadsheetId
    );

    // 1) достаём из таблицы SKU для сток‑фида
    // 2) получаем по ним остатки с Wix
    // 3) собираем XML
    const xml = await buildStockXml(importValues, controlValues, getInventoryBySkus);

    res.setHeader('Content-Type', "application/xml; charset=utf-8");
    res.setHeader(
      'Cache-Control',
      `public, s-maxage=${CACHE_TTL_SECONDS}, max-age=0`
    );
    res.status(200).send(xml);
  } catch (e) {
    console.error('Error in /api/monomarket-stock', e);
    res.status(502).send('Bad Gateway');
  }
}
