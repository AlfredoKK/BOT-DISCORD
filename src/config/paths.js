const fs = require('fs');
const path = require('path');

// Dossier des données modifiables à chaud (agencies.json, google_token.json).
// - Par défaut : ./data dans le dépôt (comportement historique).
// - En hébergement : DATA_DIR pointe vers un volume persistant (ex: /data),
//   pour que pauses, horaires et configs faits depuis Discord survivent aux déploiements.
const REPO_DATA_DIR = path.join(__dirname, '../../data');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : REPO_DATA_DIR;

const AGENCIES_PATH = path.join(DATA_DIR, 'agencies.json');
const TOKEN_PATH = path.join(DATA_DIR, 'google_token.json');
const SEED_AGENCIES_PATH = path.join(REPO_DATA_DIR, 'agencies.json');

/**
 * Prépare le dossier de données au démarrage :
 * - crée DATA_DIR s'il n'existe pas
 * - copie agencies.json du dépôt vers le volume s'il n'y est pas encore (premier démarrage)
 * - écrit google_token.json depuis GOOGLE_TOKEN_JSON si le fichier est absent
 */
function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(AGENCIES_PATH) && DATA_DIR !== REPO_DATA_DIR && fs.existsSync(SEED_AGENCIES_PATH)) {
    fs.copyFileSync(SEED_AGENCIES_PATH, AGENCIES_PATH);
    console.log(`[Data] agencies.json initialisé depuis le dépôt vers ${AGENCIES_PATH}`);
  }

  if (!fs.existsSync(TOKEN_PATH) && process.env.GOOGLE_TOKEN_JSON) {
    try {
      const parsed = JSON.parse(process.env.GOOGLE_TOKEN_JSON);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(parsed, null, 2));
      console.log(`[Data] google_token.json initialisé depuis GOOGLE_TOKEN_JSON vers ${TOKEN_PATH}`);
    } catch (err) {
      console.error(`[Data] GOOGLE_TOKEN_JSON invalide: ${err.message}`);
    }
  }

  console.log(`[Data] Dossier de données: ${DATA_DIR} | agences: ${fs.existsSync(AGENCIES_PATH) ? 'ok' : 'ABSENT'} | token Google: ${fs.existsSync(TOKEN_PATH) ? 'ok' : 'ABSENT'}`);
}

module.exports = { DATA_DIR, AGENCIES_PATH, TOKEN_PATH, SEED_AGENCIES_PATH, ensureDataDir };
