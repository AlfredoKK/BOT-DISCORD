const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const TOKEN_PATH = path.join(__dirname, '../../data/google_token.json');
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/spreadsheets',
];

let oauth2Client = null;

function readStoredToken() {
  if (!fs.existsSync(TOKEN_PATH)) return {};
  return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
}

function persistTokenPatch(tokens, options = {}) {
  try {
    const existing = readStoredToken();
    const updated = { ...existing, ...tokens };
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(updated, null, 2));
  } catch (err) {
    console.error(`[Google Auth] Impossible d'écrire ${TOKEN_PATH}: ${err.message}`);
    if (options.required) throw err;
  }
}

function attachTokenPersistence(client) {
  client.on('tokens', (tokens) => {
    persistTokenPatch(tokens);
  });
}

function getOAuth2Client() {
  if (!oauth2Client) {
    oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      REDIRECT_URI
    );

    // Load existing token if available
    if (fs.existsSync(TOKEN_PATH)) {
      const token = readStoredToken();
      oauth2Client.setCredentials(token);
    }

    attachTokenPersistence(oauth2Client);
  }
  return oauth2Client;
}

function generateAuthUrl() {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
}

async function exchangeCode(code) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  persistTokenPatch(tokens, { required: true });

  return tokens;
}

function isAuthenticated() {
  if (!fs.existsSync(TOKEN_PATH)) return false;
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  return !!(token.access_token && token.refresh_token);
}

module.exports = {
  getOAuth2Client,
  generateAuthUrl,
  exchangeCode,
  isAuthenticated,
};
