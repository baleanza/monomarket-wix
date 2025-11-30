const { google } = require('googleapis');
const { getJwtClient } = require('./jwtAuth');

async function readSheets(spreadsheetId) {
  if (!spreadsheetId) throw new Error('Spreadsheet ID is required');
  const auth = getJwtClient();
  // authorize explicitly to surface auth errors early
  await auth.authorize();

  const sheets = google.sheets({ version: 'v4', auth });

  const importRange = 'Import!A1:ZZ1000';
  const controlRange = 'Feed Control List!A1:D1000';

  const resp = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: [importRange, controlRange],
  });

  const importValues = (resp.data.valueRanges && resp.data.valueRanges[0] && resp.data.valueRanges[0].values) || [];
  const controlValues = (resp.data.valueRanges && resp.data.valueRanges[1] && resp.data.valueRanges[1].values) || [];

  return { importValues, controlValues };
}

module.exports = { readSheets };
