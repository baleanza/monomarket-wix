import { google } from 'googleapis';

export function getDriveClient(auth) {
  return google.drive({ version: 'v3', auth });
}
