// api/monomarket-offers.js
const { readSheets } = require('../lib/sheetsClient');
const { getDrive, findFileByName, readFileContent, uploadOrUpdateFile } = require('../lib/driveClient');
const { buildControlMap, buildOffersXml } = require('../lib/feedBuilder');

const FILE_NAME = 'monomarket-offers.xml';
const DEFAULT_TTL = parseInt(process.env.CACHE_TTL_SECONDS || '7200', 10);

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`${name} is required`);
  return process.env[name];
}

module.exports = async (req, res) => {
  try {
    // optional API key protection
    const API_KEY = process.env.API_KEY;
    if (API_KEY) {
      const key = req.headers['x-api-key'] || req.query.api_key;
      if (key !== API_KEY) return res.status(401).send('Unauthorized');
    }

    // env checks
    requireEnv('GOOGLE_SERVICE_ACCOUNT_KEY');
    requireEnv('SPREADSHEET_ID');

    const drive = await getDrive();
    const existing = await findFileByName(drive, FILE_NAME);

    const now = Date.now();
    if (existing && existing.modifiedTime) {
      const modified = new Date(existing.modifiedTime).getTime();
      if ((now - modified) / 1000 < DEFAULT_TTL) {
        const xml = await readFileContent(drive, existing.id);
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Cache-Control', `public, s-maxage=${DEFAULT_TTL}, max-age=0`);
        return res.status(200).send(xml);
      }
    }

    // rebuild from sheet
    const { importValues, controlValues } = await readSheets(process.env.SPREADSHEET_ID);
    const controlMap = buildControlMap(controlValues);
    const xml = buildOffersXml(importValues, controlMap);

    // upload or update file on Drive
    await uploadOrUpdateFile(drive, FILE_NAME, xml);

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', `public, s-maxage=${DEFAULT_TTL}, max-age=0`);
    return res.status(200).send(xml);
  } catch (err) {
    console.error('feed error', err);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(502).send('Bad Gateway');
  }
};
