import { google } from 'googleapis';
import { getSheetsClient } from '../lib/sheetsClient.js';
import { getDriveClient } from '../lib/driveClient.js';
import { buildOffersXml } from '../lib/feedBuilder.js';
import { getInventoryBySkus } from '../lib/wixClient.js'; // Добавлен импорт Wix клиента

const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || '7200', 10);
const DRIVE_FILE_NAME = 'monomarket-offers.xml';
const SHARED_DRIVE_FOLDER_ID = process.env.SHARED_DRIVE_FOLDER_ID || null;

function requireEnv(varName) {
  const value = process.env[varName];
  if (!value) {
    console.error(`Missing required env var: ${varName}`);
  }
  return value;
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
  if (!keyJson || !spreadsheetId) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY or SPREADSHEET_ID not configured');
  }

  let keyObj;
  try {
    keyObj = JSON.parse(keyJson);
  } catch (e) {
    console.error('Failed to parse GOOGLE_SERVICE_ACCOUNT_KEY JSON', e);
    throw e;
  }

  const jwtClient = new google.auth.JWT(
    keyObj.client_email,
    null,
    keyObj.private_key,
    [
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/drive.file'
    ]
  );

  await jwtClient.authorize();

  const sheets = getSheetsClient(jwtClient);
  const drive = getDriveClient(jwtClient);

  return { sheets, drive, spreadsheetId };
}

async function getOrCreateDriveFile(drive) {
  if (!SHARED_DRIVE_FOLDER_ID) {
    throw new Error('SHARED_DRIVE_FOLDER_ID is not set');
  }

  const res = await drive.files.list({
    q: [
      `name='${DRIVE_FILE_NAME}'`,
      // Используем папку общего доступа, как в старой версии
      `'${SHARED_DRIVE_FOLDER_ID}' in parents`, 
      'trashed = false'
    ].join(' and '),
    fields: 'files(id, name, modifiedTime)',
    spaces: 'drive',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true
  });

  const files = res.data.files || [];
  if (files.length > 0) {
    return files[0];
  }

  const createRes = await drive.files.create({
    requestBody: {
      name: DRIVE_FILE_NAME,
      mimeType: 'application/xml',
      parents: [SHARED_DRIVE_FOLDER_ID]
    },
    supportsAllDrives: true
  });

  return createRes.data;
}

async function readDriveFileContent(drive, fileId) {
  const res = await drive.files.get(
    {
      fileId,
      alt: 'media',
      supportsAllDrives: true
    },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data).toString('utf-8');
}

async function writeDriveFileContent(drive, fileId, xml) {
  await drive.files.update({
    fileId,
    media: {
      mimeType: 'application/xml',
      body: xml
    },
    supportsAllDrives: true
  });
}

async function readSheetData(sheets, spreadsheetId) {
  const importRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Import!A1:ZZ' });
  const controlRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Feed Control List!A1:F' });
  const deliveryRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Delivery!A1:C' });

  return { 
    importValues: importRes.data.values || [], 
    controlValues: controlRes.data.values || [],
    deliveryValues: deliveryRes.data.values || [] 
  };
}

function isFresh(modifiedTime) {
  if (!modifiedTime) return false;
  const modified = new Date(modifiedTime).getTime();
  const now = Date.now();
  return now - modified < CACHE_TTL_SECONDS * 1000;
}

async function getInventory(importValues, controlValues) {
    const headers = importValues[0] || [];
    const rows = importValues.slice(1);
    const controlHeaders = controlValues[0] || [];
    const controlRows = controlValues.slice(1);

    const idxImportField = controlHeaders.indexOf('Import field');
    const idxFeedName = controlHeaders.indexOf('Feed name');
    
    const fieldMapping = {};
    controlRows.forEach(row => {
        const importField = row[idxImportField];
        const feedName = row[idxFeedName];
        if (importField && feedName) {
            fieldMapping[String(feedName).trim()] = String(importField).trim();
        }
    });

    // 2. Находим индекс колонки SKU
    const skuSheetHeader = fieldMapping['sku'] || 'SKU';
    const skuHeaderIndex = headers.indexOf(skuSheetHeader);
    
    if (skuHeaderIndex === -1) {
        console.warn(`SKU column '${skuSheetHeader}' not found in Import sheet.`);
        return { inventoryMap: {} };
    }

    // 3. Собираем уникальные SKU
    const skus = [];
    rows.forEach(row => {
        const sku = row[skuHeaderIndex] ? String(row[skuHeaderIndex]).trim() : '';
        if (sku) skus.push(sku);
    });

    const uniqueSkus = [...new Set(skus)];

    // 4. Запрашиваем остатки
    const inventory = await getInventoryBySkus(uniqueSkus);
    
    // 5. Создаем карту SKU -> Inventory Item
    const inventoryMap = {};
    inventory.forEach(item => {
        inventoryMap[String(item.sku).trim()] = item;
    });
    
    return { inventoryMap };
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
    const { sheets, drive, spreadsheetId } = await ensureAuth();

    const fileMeta = await getOrCreateDriveFile(drive);

    if (fileMeta.id && isFresh(fileMeta.modifiedTime)) {
      try {
        const xml = await readDriveFileContent(drive, fileMeta.id);

        res.setHeader('Content-Type', "application/xml; charset=utf-8");
        res.setHeader(
          'Cache-Control',
          `public, s-maxage=${CACHE_TTL_SECONDS}, max-age=0`
        );
        res.status(200).send(xml);
        return; 
      } catch (e) {
        console.error('Failed to read cached XML from Drive, will regenerate', e);
      }
    }
    
    const { importValues, controlValues, deliveryValues } = await readSheetData(
      sheets,
      spreadsheetId
    );
    
    const { inventoryMap } = await getInventory(importValues, controlValues);

    const xml = buildOffersXml(importValues, controlValues, deliveryValues, inventoryMap);

    if (fileMeta.id) {
      try {
        await writeDriveFileContent(drive, fileMeta.id, xml);
      } catch (e) {
        console.error('Failed to write XML to Drive', e);
      }
    }

    res.setHeader('Content-Type', "application/xml; charset=utf-8");
    res.setHeader(
      'Cache-Control',
      `public, s-maxage=${CACHE_TTL_SECONDS}, max-age=0`
    );
    res.status(200).send(xml);
  } catch (err) {
    console.error('Error in /api/monomarket-offers', err);
    res.status(502).send('Bad Gateway');
  }
}
