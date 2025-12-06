// lib/sheetsClient.js
import { google } from 'googleapis';

// Експортуємо requireEnv
export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

// Експортуємо getSheetsClient
export function getSheetsClient(auth) {
  // Це просто функція, яка повертає клієнт Sheets
  return google.sheets({ version: 'v4', auth });
}

// Експортуємо ensureAuth
export async function ensureAuth() {
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

// Експортуємо cleanPrice
export function cleanPrice(val) {
  if (!val) return 0;
  let str = String(val).trim().replace(/\s/g, '').replace(',', '.');
  return parseFloat(str.replace(/[^0-9.]/g, '')) || 0;
}
