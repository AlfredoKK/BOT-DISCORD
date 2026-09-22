const sheets = require('./sheets');

/**
 * Détecte les ressources déjà utilisées par une AUTRE agence :
 * même calendrier, même onglet de classeur, ou même canal Discord.
 * Une agence = un canal, un calendrier, un onglet. Jamais partagés.
 */
function findAgencyConflicts(agencies, candidateKey, candidate) {
  const conflicts = [];
  for (const [key, cfg] of Object.entries(agencies)) {
    if (key === candidateKey) continue;
    const label = cfg.name || key;
    if (candidate.calendar_id && cfg.calendar_id === candidate.calendar_id) {
      conflicts.push({ type: 'calendrier', with: label, value: candidate.calendar_id });
    }
    if (candidate.spreadsheet_id && candidate.sheet_name
      && cfg.spreadsheet_id === candidate.spreadsheet_id && cfg.sheet_name === candidate.sheet_name) {
      conflicts.push({ type: 'onglet', with: label, value: `${candidate.spreadsheet_id} / ${candidate.sheet_name}` });
    }
    if (candidate.channel_id && cfg.channel_id === candidate.channel_id) {
      conflicts.push({ type: 'canal', with: label, value: candidate.channel_id });
    }
  }
  return conflicts;
}

function formatConflicts(conflicts) {
  return conflicts.map((c) => `- ${c.type} déjà utilisé par **${c.with}** (${c.value})`).join('\n');
}

/**
 * Vérifie que l'onglet existe réellement dans le classeur.
 * Retourne { ok: true } ou { ok: false, reason, tabs }.
 */
async function verifySheetTab(spreadsheetId, sheetName) {
  if (!spreadsheetId) return { ok: false, reason: 'spreadsheet_id manquant', tabs: [] };
  let tabs;
  try {
    tabs = await sheets.listSheetTabs(spreadsheetId);
  } catch (err) {
    return { ok: false, reason: `classeur inaccessible (${err.message})`, tabs: [] };
  }
  if (!sheetName) return { ok: true, tabs, resolved: tabs[0] || '' };
  if (!tabs.includes(sheetName)) {
    return { ok: false, reason: `onglet "${sheetName}" introuvable dans le classeur`, tabs };
  }
  return { ok: true, tabs };
}

/**
 * Message renvoyé aux prospecteurs quand la config Sheets d'une agence est cassée.
 * Aucun événement Calendar ne doit être créé dans ce cas.
 */
function brokenSheetConfigMessage(agency, check) {
  return `🚫 Configuration Sheets invalide pour **${agency.name}** : ${check.reason}. `
    + `Aucun RDV créé. Un administrateur doit corriger avec \`/rdvadmin config\`.`;
}

module.exports = { findAgencyConflicts, formatConflicts, verifySheetTab, brokenSheetConfigMessage };
