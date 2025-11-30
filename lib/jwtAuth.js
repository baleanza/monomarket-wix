// lib/jwtAuth.js
// Утилита для создания JWT клиента Google из двух env переменных:
// GOOGLE_SERVICE_ACCOUNT_EMAIL и GOOGLE_PRIVATE_KEY

const { google } = require('googleapis');

function normalizePrivateKey(key) {
  if (!key) return key;
  key = key.replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');

  // Если ключ вставлен с реальными переносами, заменим их на \n последовательно,
  // но google.auth.JWT принимает реальный формат с \n внутри строки.
  // Если в Vercel вы вставляете "\\n" (экранированные), заменим \\n -> \n
  key = key.replace(/\\n/g, '\n');

  // Если ключ всё ещё в одну строку с реальными переносами -> уже ок.
  return key;
}

function getJwtClient() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    throw new Error('Environment variables GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY must be set.');
  }

  privateKey = normalizePrivateKey(privateKey);

  const scopes = [
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/drive'
  ];

  const jwtClient = new google.auth.JWT(clientEmail, null, privateKey, scopes, null);
  return jwtClient;
}

module.exports = { getJwtClient };
