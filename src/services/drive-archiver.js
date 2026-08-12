const { Readable } = require('stream');
const { google } = require('googleapis');

const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const SCOPES = ['https://www.googleapis.com/auth/drive'];

let driveClient = null;
const folderCache = new Map();

function getConfig() {
  return {
    rootFolderId: process.env.GOOGLE_DRIVE_ARCHIVE_ROOT_FOLDER_ID || process.env.DRIVE_ARCHIVE_ROOT_FOLDER_ID || '',
    keyFile: process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS || 'service-account.json',
    serviceAccountJson: process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON || '',
  };
}

function isDriveArchiveConfigured() {
  const config = getConfig();
  return Boolean(config.rootFolderId && (config.serviceAccountJson || config.keyFile));
}

function getDriveClient() {
  if (driveClient) return driveClient;

  const config = getConfig();
  if (!config.rootFolderId) {
    throw new Error('GOOGLE_DRIVE_ARCHIVE_ROOT_FOLDER_ID manquant');
  }

  let authConfig;
  if (config.serviceAccountJson) {
    const credentials = JSON.parse(config.serviceAccountJson);
    if (credentials.private_key) {
      credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
    }
    authConfig = { credentials, scopes: SCOPES };
  } else {
    authConfig = { keyFile: config.keyFile, scopes: SCOPES };
  }

  const auth = new google.auth.GoogleAuth(authConfig);
  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

function escapeDriveQueryString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function sanitizeFolderName(value) {
  return String(value || '')
    .replace(/[\/\\]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim() || 'Agence inconnue';
}

function parisDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
  };
}

function archiveNames(date = new Date()) {
  const parts = parisDateParts(date);
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    monthName: `${parts.year}-${parts.month}`,
    fileName: `${day}.png`,
  };
}

async function findOrCreateFolder(name, parentId) {
  const drive = getDriveClient();
  const cleanName = sanitizeFolderName(name);
  const cacheKey = `${parentId}:${cleanName}`;

  if (folderCache.has(cacheKey)) return folderCache.get(cacheKey);

  const query = [
    `name = '${escapeDriveQueryString(cleanName)}'`,
    `mimeType = '${DRIVE_FOLDER_MIME_TYPE}'`,
    `'${escapeDriveQueryString(parentId)}' in parents`,
    'trashed = false',
  ].join(' and ');

  const existing = await drive.files.list({
    q: query,
    fields: 'files(id, name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const folderId = existing.data.files?.[0]?.id;
  if (folderId) {
    folderCache.set(cacheKey, folderId);
    return folderId;
  }

  const created = await drive.files.create({
    requestBody: {
      name: cleanName,
      mimeType: DRIVE_FOLDER_MIME_TYPE,
      parents: [parentId],
    },
    fields: 'id',
    supportsAllDrives: true,
  });

  folderCache.set(cacheKey, created.data.id);
  return created.data.id;
}

async function archiveScreenshot(imageBuffer, agencyName, options = {}) {
  if (!imageBuffer || imageBuffer.length === 0) return null;
  if (!isDriveArchiveConfigured()) return null;

  const { rootFolderId } = getConfig();
  const date = options.date || new Date();
  const { monthName, fileName } = archiveNames(date);
  const drive = getDriveClient();

  const agencyFolderId = await findOrCreateFolder(agencyName, rootFolderId);
  const monthFolderId = await findOrCreateFolder(monthName, agencyFolderId);
  const media = {
    mimeType: options.mimeType || 'image/png',
    body: Readable.from(imageBuffer),
  };

  const query = [
    `name = '${escapeDriveQueryString(fileName)}'`,
    `'${escapeDriveQueryString(monthFolderId)}' in parents`,
    'trashed = false',
  ].join(' and ');

  const existing = await drive.files.list({
    q: query,
    fields: 'files(id)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const existingFileId = existing.data.files?.[0]?.id;
  if (existingFileId) {
    await drive.files.update({
      fileId: existingFileId,
      media,
      supportsAllDrives: true,
    });
    return existingFileId;
  }

  const created = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [monthFolderId],
    },
    media,
    fields: 'id',
    supportsAllDrives: true,
  });

  return created.data.id;
}

module.exports = {
  archiveNames,
  archiveScreenshot,
  escapeDriveQueryString,
  isDriveArchiveConfigured,
  sanitizeFolderName,
};
