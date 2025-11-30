import { google } from 'googleapis';
import { getSheetsClient } from '../lib/sheetsClient.js';
import { getDriveClient } from '../lib/driveClient.js';
import { buildOffersXml } from '../lib/feedBuilder.js';

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
  const conditions = [`name='${DRIVE_FILE_NAME}'`, 'trashed = false'];

  if (SHARED_DRIVE_FOLDER_ID) {
    conditions.push(`'${SHARED_DRIVE_FOLDER_ID}' in parents`);
  }

  const res = await drive.files.list({
    q: conditions.join(' and '),
    fields: 'files(id, name, modifiedTime)',
    spaces: 'drive',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true
  });

  const files = res.data.files || [];
  if (files.length > 0) {
    return files[0];
  }

  const requestBody = {
    name: DRIVE_FILE_NAME,
    mimeType: 'application/xml'
  };

  if (SHARED_DRIVE_FOLDER_ID) {
    requestBody.parents = [SHARED_DRIVE_FOLDER_ID];
  }

  const createRes = await drive.files.create({
    requestBody,
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
  const importRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Import!A1:ZZ'
  });

  const controlRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Feed Control List!A1:D'
  });

  const importValues = importRes.data.values || [];
  const controlValues = controlRes.data.values || [];

  return { importValues, controlValues };
}

function isFresh(modifiedTime) {
  if (!modifiedTime) return false;
  const modified = new Date(modifiedTime).getTime();
  const now = Date.now();
  return now - modified < CACHE_TTL_SECONDS * 1000;
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

//    const fileMeta = await getOrCreateDriveFile(drive);

//   if (fileMeta.id && isFresh(fileMeta.modifiedTime)) {
//      try {
//        const xml = await readDriveFileContent(drive, fileMeta.id);

//        res.setHeader('Content-Type', "application/xml; charset=utf-8");
//        res.setHeader(
//          'Cache-Control',
//          `public, s-maxage=${CACHE_TTL_SECONDS}, max-age=0`
//        );
//        res.status(200).send(xml);
//        return;
//      } catch (e) {
//        console.error('Failed to read cached XML from Drive, will regenerate', e);
//      }
//    }

    const { importValues, controlValues } = await readSheetData(sheets, spreadsheetId);
    const xml = buildOffersXml(importValues, controlValues);

//    if (fileMeta.id) {
//      try {
//        await writeDriveFileContent(drive, fileMeta.id, xml);
//      } catch (e) {
//        console.error('Failed to write XML to Drive', e);
//     }
//    }

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
