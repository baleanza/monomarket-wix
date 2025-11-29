import { google } from 'googleapis';

export function getSheetsClient(auth) {
  return google.sheets({ version: 'v4', auth });
}
