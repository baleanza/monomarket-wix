const { google } = require('googleapis');


function getJwtDriveClientFromEnv() {
const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
if (!key) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is required');
const credentials = JSON.parse(key);
return new google.auth.JWT(
credentials.client_email,
null,
credentials.private_key,
[
'https://www.googleapis.com/auth/drive.file',
'https://www.googleapis.com/auth/drive'
]
);
}


async function getDrive() {
const auth = getJwtDriveClientFromEnv();
await auth.authorize();
return google.drive({ version: 'v3', auth });
}


async function findFileByName(drive, name) {
const res = await drive.files.list({
q: `name='${name.replace("'","\\'")}' and trashed=false`,
fields: 'files(id,name,modifiedTime)'
});
return (res.data.files && res.data.files[0]) || null;
}


async function readFileContent(drive, fileId) {
const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' });
return res.data;
}


async function uploadOrUpdateFile(drive, name, content) {
const existing = await findFileByName(drive, name);
const media = { mimeType: 'application/xml', body: content };
if (existing) {
await drive.files.update({ fileId: existing.id, media }, { fields: 'id,modifiedTime' });
return existing;
} else {
const res = await drive.files.create({ requestBody: { name, mimeType: 'application/xml' }, media, fields: 'id,modifiedTime' });
return res.data;
}
}


module.exports = { getDrive, findFileByName, readFileContent, uploadOrUpdateFile };
