# monomarket-vercel-feed

Serverless feed generator for Monomarket / Murkit. Reads Google Sheets, builds `monomarket-offers.xml` and stores it in Google Drive. The stored file is used as cached static feed and is regenerated no more often than every 2 hours (configurable).

## Files of interest
- `api/monomarket-offers.js` — main endpoint
- `api/monomarket-stock.js` — stub for stock feed (to implement later)
- `lib/sheetsClient.js` — read Google Sheets via service account
- `lib/driveClient.js` — read/write file to Google Drive
- `lib/feedBuilder.js` — build XML from sheet arrays
- `lib/helpers.js` — unit conversion, escaping, booleans
- `tests/helpers.test.js` — basic unit tests

## Environment variables
Set following env vars in Vercel:
- `GOOGLE_SERVICE_ACCOUNT_KEY` — full JSON key (paste contents)
- `SPREADSHEET_ID` — Google Sheets ID
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` — optional (for convenience)
- `CACHE_TTL_SECONDS` — optional, default 7200
- `API_KEY` — optional, protect endpoint by `x-api-key` header

## Setup (quick)
1. Create Google Cloud project, enable Sheets API & Drive API.
2. Create Service Account and JSON key. Copy JSON into `GOOGLE_SERVICE_ACCOUNT_KEY`.
3. Share the spreadsheet with service account email (Viewer or Editor). If you want to allow the function to write the XML file to Drive, grant Drive permission.
4. Deploy to Vercel, set environment variables.
5. Add CNAME in your DNS to point a subdomain to Vercel if you want `feed.yourdomain.com`.

## How it works
- On request `/api/monomarket-offers`, the function checks Drive for `monomarket-offers.xml`.
- If the file exists and is younger than `CACHE_TTL_SECONDS`, it returns the file contents.
- Otherwise it reads `Import` and `Feed Control List` sheets, builds the XML, uploads/updates the file on Drive, and returns the XML.

## Units & rules
- Units for length/weight are expected in Ukrainian: `мм`, `см`, `м`, `г`, `кг`.
- For numeric conversions (height/width/length/weight) the function replaces comma with dot if units are present, then converts:
  - mm → cm: /10
  - m → cm: *100
  - g → kg: /1000
- Output lengths in cm and weight in kg, rounded to 2 decimals.

## Tests
Run local tests:
```bash
node tests/helpers.test.js
