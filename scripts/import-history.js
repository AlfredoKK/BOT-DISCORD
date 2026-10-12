#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// Import de l'historique des RDV (Sheets + Google Calendar) dans la base
// Supabase d'UNE société. Idempotent : rejouable sans doublon.
//
//   node scripts/import-history.js --societe licall --mode dry
//   node scripts/import-history.js --societe licall --mode sql --out supabase/imports/licall
//   node scripts/import-history.js --societe licall --mode apply
//
// Options :
//   --societe licall|kallkall   (obligatoire) base cible = société des agences
//   --mode dry|sql|stage|apply  dry = compte seulement ; sql = écrit des fichiers
//                               SQL idempotents à rejouer (éditeur SQL Supabase,
//                               MCP…) ; stage = dépose les lignes dans la table
//                               bot_import_staging via l'API REST (clé service_role)
//                               et écrit merge_<lot>.sql, un SQL court qui fusionne le
//                               lot dans les vraies tables ; apply = écrit tout via
//                               l'API REST (SUPABASE_<SOCIETE>_URL / _SERVICE_ROLE_KEY)
//   --agence <clé>              une seule agence (clé de agencies.json)
//   --exclude <clé,clé>         agences à ignorer (ex: licall test)
//   --sheets-only               n'importe que les RDV qui ont une ligne Sheets (les
//                               événements Calendar sans ligne sont ignorés)
//   --mode sql-stage            variante compacte du mode sql : fichiers NNN_stage.sql
//                               (dépôt dans bot_import_staging, ~40 Ko chacun) puis
//                               merge_<lot>.sql ; pratique quand on ne dispose que de
//                               l'éditeur SQL
//   --since AAAA-MM-JJ          début de l'historique Calendar (défaut 2025-01-01)
//   --enrich-only               ne touche QUE les RDV déjà en base (colonnes du bot :
//                               fin_at, type_rdv, confirmation, véhicule, liens,
//                               commentaire, adresse, prospecteur brut) — pour Kall
//                               Kall, dont l'historique vient déjà du dashboard.
//   --out <dossier>             dossier des fichiers SQL (mode sql)
//   --lot <id>                  identifiant de lot (défaut <societe>-<horodatage>)
//   --sans-fiche                n'importe pas la fiche SDR (classeur RH « SDR <société> 26 »,
//                               onglets ARCHIVE SDR + SDR : mail, rôle, dates, actif)
//
// Onglets du classeur RDV qui ne correspondent à aucune agence de agencies.json
// (anciennes agences sans canal Discord) : importés aussi, agence créée inactive.
// Colonne « Etat » (VENU / PAS VENU / ANNULÉ / VENDU / SAV, saisie par
// l'équipe) prioritaire sur la colonne STATUT du bot ; colonne « TC » =
// télé-confirmateur (confirme_par_user_id).
//
// Sources par RDV (clé = EVENT_ID Google Calendar) :
//   - ligne Sheets : prospecteur, client, téléphone, date/heure, confirmation,
//     statut, confirmé par, horodatage de création
//   - événement Calendar : heures exactes, type (DOM), véhicule complet,
//     liens / commentaire / adresse, préfixe de statut du titre
// Un événement Calendar « RDV MANDAT » sans ligne Sheets est importé aussi
// (prospecteur inconnu). Une ligne Sheets sans EVENT_ID est rejetée (comptée).
//
// SDR : résolus par alias « bot » (pseudo Discord), créés s'ils manquent ;
// actif = au moins un RDV dans les 60 derniers jours. Clients : clé
// téléphone E.164. Statuts : journal rdv_evenements ('pris' à la création,
// résultat 1 s après l'heure du RDV, comme l'import du dashboard).
// Aucune donnée client n'est affichée dans la console (comptes seulement).
// ══════════════════════════════════════════════════════════════
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const sheets = require('../src/services/sheets');
const { COL } = sheets;
const calendar = require('../src/services/calendar');
const { loadAgencies } = require('../src/utils/rdv-helpers');
const { resolveCompany, getClient, COMPANIES } = require('../src/services/supabase');
const rdvDb = require('../src/services/rdv-db');
const { parseManagedRdvEvent, isManagedRdvTitle, getPrimaryStatusPrefix } = require('../src/utils/rdv-title');
const { isEventDomRdv, DOM_RDV_BUFFER_MINUTES } = require('../src/utils/rdv-helpers');

const ACTIVE_WINDOW_DAYS = 60;
const RDV_BATCH = 300;
const EVENT_BATCH = 1000;
const PERSONNES_BATCH = 1000;

// ── Arguments ──────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { mode: 'dry', since: '2025-01-01', enrichOnly: false, sheetsOnly: false, out: null, agence: null, exclude: [], societe: null, lot: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--societe') args.societe = String(next() || '').toLowerCase();
    else if (a === '--mode') args.mode = String(next() || 'dry');
    else if (a === '--since') args.since = next();
    else if (a === '--agence') args.agence = next();
    else if (a === '--exclude') args.exclude = String(next() || '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
    else if (a === '--out') args.out = next();
    else if (a === '--enrich-only') args.enrichOnly = true;
    else if (a === '--sheets-only') args.sheetsOnly = true;
    else if (a === '--lot') args.lot = next();
    else if (a === '--sans-fiche') args.sansFiche = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else throw new Error(`argument inconnu : ${a}`);
  }
  if (!args.societe || !COMPANIES[args.societe]) throw new Error('--societe licall|kallkall obligatoire');
  if (!['dry', 'sql', 'sql-stage', 'stage', 'apply'].includes(args.mode)) throw new Error('--mode dry|sql|sql-stage|stage|apply');
  if (['sql', 'sql-stage', 'stage'].includes(args.mode) && !args.out) args.out = path.join('supabase', 'imports', args.societe);
  return args;
}

function printHelp() {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 40).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}

// ── Dates ──────────────────────────────────────────────────────

/** AAAA-MM-JJ + HH:MM (heure de Paris) → ISO UTC, été/hiver compris. */
function parisToIso(y, mo, d, h, mn) {
  const utcGuess = Date.UTC(y, mo - 1, d, h, mn);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(utcGuess)).map((p) => [p.type, p.value]));
  const asParis = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return new Date(utcGuess - (asParis - utcGuess)).toISOString();
}

function parseSheetDateTime(dateStr, timeStr) {
  const m = String(dateStr || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  const t = String(timeStr || '').trim().match(/^(\d{1,2})[:hH](\d{2})/);
  const h = t ? Number(t[1]) : 12;
  const mn = t ? Number(t[2]) : 0;
  const iso = parisToIso(y, Number(m[2]), Number(m[1]), h, mn);
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

/** « 12/10/2026 14:03:25 » (timestamp() du bot, heure de Paris) → ISO ou null. */
function parseUpdatedAt(value) {
  const m = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const iso = parisToIso(Number(m[3]), Number(m[2]), Number(m[1]), Number(m[4]), Number(m[5]));
  const d = new Date(iso);
  if (m[6]) d.setUTCSeconds(Number(m[6]));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ── Lecture d'un onglet ────────────────────────────────────────

function looksLikeHeader(row) {
  const cells = (row || []).map((c) => String(c || '').toUpperCase());
  return cells.some((c) => c.includes('PROSPECTEUR') || c.includes('EVENT'));
}

/**
 * Colonnes au-delà de K, repérées par leur en-tête (ligne 3 des onglets) :
 *   « Etat » = résultat réel saisi par l'équipe (VENU / PAS VENU / ANNULÉ /
 *   VENDU / SAV), prioritaire sur la colonne STATUT du bot (PLANIFIÉ…) ;
 *   « TC »   = télé-confirmateur (nom), colonne K ou M selon l'onglet.
 */
function detectExtraColumns(row) {
  const cells = (row || []).map((c) => rdvDb.stripEmoji(String(c || '')).trim().toUpperCase());
  const etat = cells.findIndex((c) => c === 'ETAT' || c === 'ÉTAT');
  const tc = cells.findIndex((c) => c === 'TC');
  return { etat, tc };
}

function parseSheetRows(rows) {
  const out = new Map();
  let rejected = 0;
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) if (looksLikeHeader(rows[i])) headerIdx = i;
  const extra = detectExtraColumns(rows[headerIdx]);
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    if (row.every((c) => !String(c || '').trim())) continue;
    const eventId = String(row[COL.EVENT_ID] || '').trim();
    if (!eventId || eventId.length < 10) { rejected += 1; continue; }
    out.set(eventId, {
      prospecteur: String(row[COL.PROSPECTEUR] || '').trim(),
      vehicule: String(row[COL.VEHICULE] || '').trim(),
      client: String(row[COL.CLIENT] || '').trim(),
      telephone: String(row[COL.TELEPHONE] || '').trim().replace(/^'/, ''),
      date: String(row[COL.DATE] || '').trim(),
      heure: String(row[COL.HEURE] || '').trim(),
      confirmation: String(row[COL.CONFIRMATION] || '').trim(),
      statut: String(row[COL.STATUT] || '').trim(),
      updatedAt: String(row[COL.UPDATED_AT] || '').trim(),
      confPar: String(row[COL.CONF_PAR] || '').trim(),
      etat: extra.etat >= 0 ? String(row[extra.etat] || '').trim() : '',
      tc: extra.tc >= 0 ? String(row[extra.tc] || '').trim() : '',
    });
  }
  return { records: out, rejected, columns: extra };
}

// ── Fiche SDR (classeur RH « SDR <société> 26 ») ───────────────

const ROSTERS = {
  licall: { spreadsheetId: '1TDii7089ebh0XG9xcy8FyC43cfGfqpXzIeJRrIwytbU', tabs: ['ARCHIVE SDR', 'SDR'] },
  kallkall: { spreadsheetId: '14Ab0jU1JL2IXCn-7covj24G2DPpjpVAQ-dGIDOjihuo', tabs: ['ARCHIVE SDR', 'SDR'] },
};

function parseSheetDate(value) {
  const m = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  const d = new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[1])));
  return Number.isNaN(d.getTime()) || y < 2015 ? null : d.toISOString().slice(0, 10);
}

function rosterRole(raw) {
  const r = rdvDb.stripEmoji(String(raw || '')).trim().toUpperCase();
  if (!r) return null;
  if (r === 'TL' || r.startsWith('TEAM LEAD')) return 'tl';
  if (r === 'RH') return 'rh';
  if (r === 'SDR') return 'sdr';
  if (r === 'TC' || r.startsWith('STAG') || r.startsWith('ST ') || r.startsWith('DATA') || r.startsWith('FORMAT') || r === 'ADMIN' || r === 'COACH') return 'support';
  return null;
}

/** Onglet fiche SDR → lignes { nom, prenom, email, role, actif, date_entree, date_sortie }. */
function parseRosterRows(rows, rang) {
  const h = rows.findIndex((x) => (x || []).some((c) => /^NOM$/i.test(String(c).trim())) && (x || []).some((c) => /PR[ÉE]NOM/i.test(String(c))));
  if (h < 0) return [];
  const hdr = rows[h].map((c) => rdvDb.stripEmoji(String(c || '')).trim().toUpperCase());
  const idx = (re) => hdr.findIndex((c) => re.test(c));
  const col = {
    nom: idx(/^NOM$/), prenom: idx(/^PR[ÉE]NOM$/), mail: idx(/MAIL/), etat: idx(/^[ÉE]TAT$|^ACTIF$/),
    role: idx(/^STATUT$|^R[ÔO]LE$|^ROLE$/), deb: idx(/DATE 1ER APPEL|DATE D[ÉE]BUT|D[ÉE]MARRAGE/), stop: idx(/DATE STOP|DATE FIN/),
  };
  const out = [];
  for (const row of rows.slice(h + 1)) {
    const nom = String(row[col.nom] || '').trim();
    let prenom = String(row[col.prenom] || '').trim();
    if (!nom || !prenom) continue;
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(prenom)) prenom = ''; // cellule décalée (date à la place du prénom)
    const etatRaw = col.etat >= 0 ? String(row[col.etat] || '').trim() : '';
    const etatUp = rdvDb.stripEmoji(etatRaw).trim().toUpperCase();
    // Onglet ARCHIVE Licall : la colonne ÉTAT contient en fait le rôle.
    const roleFromEtat = rosterRole(etatRaw);
    const role = (col.role >= 0 && rosterRole(row[col.role])) || roleFromEtat || 'sdr';
    let actif = false;
    if (etatRaw.startsWith('✅') || etatRaw.startsWith('⚠️') || /^EN PROD/.test(etatUp) || etatUp === 'TRUE') actif = true;
    const email = String(col.mail >= 0 ? row[col.mail] || '' : '').trim().toLowerCase();
    out.push({
      nom, prenom, email: email.includes('@') ? email : null, role, actif, rang,
      date_entree: col.deb >= 0 ? parseSheetDate(row[col.deb]) : null,
      date_sortie: col.stop >= 0 ? parseSheetDate(row[col.stop]) : null,
    });
  }
  return out;
}

async function loadRoster(societe, log) {
  const cfg = ROSTERS[societe];
  if (!cfg) return [];
  const fiches = [];
  for (let i = 0; i < cfg.tabs.length; i++) {
    try {
      const rows = await sheets.getAllRows(cfg.spreadsheetId, cfg.tabs[i], 'AZ');
      const parsed = parseRosterRows(rows, i);
      fiches.push(...parsed);
      log(`→ fiche SDR « ${cfg.tabs[i]} » : ${parsed.length} ligne(s)`);
    } catch (err) {
      log(`   fiche SDR « ${cfg.tabs[i]} » inaccessible : ${err.message}`);
    }
  }
  return fiches;
}

function prefixToStatut(prefix) {
  const p = rdvDb.stripEmoji(prefix || '').toUpperCase();
  if (!p) return null;
  if (p.startsWith('ANNUL')) return 'annule';
  if (p === 'VENDU') return 'vendu';
  if (p === 'PAS VENU' || p === 'NO SHOW') return 'pas_venu';
  return null;
}

function prefixToConf(prefix) {
  const p = String(prefix || '').toUpperCase();
  if (p === 'NON CONF') return 'non_conf';
  if (p === 'CONF') return 'conf';
  if (p === 'J/J') return 'jj';
  return null;
}

// ── Construction du plan ───────────────────────────────────────

function buildRecord(eventId, agency, sheetRow, event) {
  const details = event ? parseManagedRdvEvent(event) : null;
  const isDom = event ? isEventDomRdv(event) : false;
  const prefix = event ? getPrimaryStatusPrefix(event.summary || '') : null;

  let start = null;
  let end = null;
  if (event?.start?.dateTime) {
    const s = new Date(event.start.dateTime);
    start = (isDom ? new Date(s.getTime() + DOM_RDV_BUFFER_MINUTES * 60000) : s).toISOString();
    if (event.end?.dateTime) end = new Date(event.end.dateTime).toISOString();
  }
  if (!start && sheetRow) start = parseSheetDateTime(sheetRow.date, sheetRow.heure);
  if (!start) return null;
  if (!end) end = new Date(new Date(start).getTime() + 60 * 60000).toISOString();

  const createdAt = sheetRow ? parseUpdatedAt(sheetRow.updatedAt) : null;
  // Résultat réel (colonne « Etat ») avant le statut du bot (colonne STATUT), avant le titre Calendar.
  const statut = (sheetRow && (rdvDb.sheetStatutToDb(sheetRow.etat) || rdvDb.sheetStatutToDb(sheetRow.statut))) || prefixToStatut(prefix) || 'pris';
  const confirmation = (sheetRow && rdvDb.sheetConfToDb(sheetRow.confirmation)) || prefixToConf(prefix) || null;

  const vehicule = details
    ? rdvDb.buildVehicule({ marque: details.marque, modele: details.modele, annee: details.annee, kilometrage: details.kilometrage, prix: details.prix })
    : (sheetRow?.vehicule ? rdvDb.buildVehicule({ modele: sheetRow.vehicule }) : null);

  const startMs = new Date(start).getTime();
  const prisAt = createdAt && new Date(createdAt).getTime() < startMs ? createdAt : start;
  const resultAt = new Date(Math.max(startMs, new Date(prisAt).getTime()) + 1000).toISOString();

  return {
    eventId,
    agencyKey: agency.key,
    channelId: agency.channel_id || null,
    agencyName: agency.name,
    prospecteur: rdvDb.stripEmoji(sheetRow?.prospecteur || '') || null,
    confPar: rdvDb.stripEmoji(sheetRow?.tc || sheetRow?.confPar || '') || null,
    clientNom: String(sheetRow?.client || details?.nomClient || '').trim().toUpperCase() || null,
    telephone: rdvDb.normalizePhoneE164(sheetRow?.telephone || '') || rdvDb.normalizePhoneE164(details?.telephone || ''),
    start,
    end,
    typeRdv: isDom ? 'mandat_dom' : 'mandat',
    confirmation,
    statut,
    liens: String(details?.liens || '').trim() || null,
    commentaire: String(details?.commentaire || '').trim() || null,
    adresse: String(details?.adresse || '').trim() || null,
    vehicule,
    prisAt,
    resultAt,
    fromSheet: Boolean(sheetRow),
    fromCalendar: Boolean(event),
  };
}

const normKey = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const SKIP_TABS = /^(TOTAL|STATS?\b|STAT\b|KPI)/i;

/**
 * Agences à importer = agences de agencies.json de la société + onglets du
 * classeur RDV qui ne correspondent à aucune d'elles (anciennes agences sans
 * canal Discord : créées en base inactives, sans Calendar). Un onglet dont le
 * nom diffère légèrement du sheet_name (« SANTENY JVVA » / « SANTENY ») est
 * rapproché par nom normalisé.
 */
async function listAgenciesForImport(args, company, log) {
  const all = loadAgencies();
  const fromJson = Object.entries(all)
    .map(([key, cfg]) => ({ key, ...cfg, readTab: cfg.sheet_name }))
    .filter((a) => resolveCompany(a, a.guild_id || null) === args.societe);
  const spreadsheetIds = [...new Set(fromJson.map((a) => a.spreadsheet_id).filter(Boolean))];
  const companySheet = process.env[company.spreadsheetVar] || company.spreadsheetDefault;
  if (companySheet && !spreadsheetIds.includes(companySheet)) spreadsheetIds.push(companySheet);
  const extra = [];
  for (const spreadsheetId of spreadsheetIds) {
    let tabs = [];
    try { tabs = await sheets.listSheetTabs(spreadsheetId); } catch (err) { log(`   onglets illisibles (${spreadsheetId.slice(0, 6)}…) : ${err.message}`); }
    for (const tab of tabs) {
      if (SKIP_TABS.test(tab)) continue;
      const exact = fromJson.find((a) => a.spreadsheet_id === spreadsheetId && a.sheet_name === tab);
      if (exact) continue;
      const near = fromJson.find((a) => a.spreadsheet_id === spreadsheetId && (normKey(a.sheet_name) === normKey(tab) || normKey(a.name) === normKey(tab)));
      if (near) { near.readTab = tab; continue; }
      extra.push({ key: `onglet:${tab.toLowerCase()}`, name: tab, sheet_name: tab, readTab: tab, spreadsheet_id: spreadsheetId, channel_id: null, calendar_id: null, legacy: true });
    }
  }
  const matches = (a, k) => a.key === k || normKey(a.name) === normKey(k) || normKey(a.sheet_name) === normKey(k);
  return [...fromJson, ...extra]
    .filter((a) => !args.agence || matches(a, args.agence))
    .filter((a) => !args.exclude.some((k) => matches(a, k)));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildPlan(args, log) {
  const company = COMPANIES[args.societe];
  const agencies = await listAgenciesForImport(args, company, log);
  if (agencies.length === 0) throw new Error(`aucune agence ${company.label} dans agencies.json${args.agence ? ` (clé ${args.agence})` : ''}`);

  const since = new Date(`${args.since}T00:00:00Z`);
  if (Number.isNaN(since.getTime())) throw new Error(`--since invalide : ${args.since}`);
  const until = new Date(Date.now() + 400 * 24 * 3600 * 1000);

  const records = new Map();
  const stats = { agences: agencies.length, agencesSansCanal: agencies.filter((a) => a.legacy).length, lignesSheets: 0, rejetsSansEventId: 0, evenementsCalendar: 0, sansDate: 0, parAgence: {} };

  for (const agency of agencies) {
    log(`→ ${agency.name}${agency.legacy ? ' (onglet sans canal)' : ''}`);
    let sheetRecords = new Map();
    let rejected = 0;
    try {
      const rows = await sheets.getAllRows(agency.spreadsheet_id, agency.readTab || agency.sheet_name, 'Z');
      const parsed = parseSheetRows(rows);
      ({ records: sheetRecords, rejected } = parsed);
      if (parsed.columns.etat < 0 && sheetRecords.size) log('   (pas de colonne « Etat » : statut = colonne du bot)');
    } catch (err) {
      log(`   Sheets inaccessible : ${err.message}`);
    }
    await sleep(1100); // quota Sheets : 60 lectures/minute
    let events = [];
    if (agency.calendar_id && (!args.sheetsOnly || sheetRecords.size)) {
      try {
        events = await calendar.listAllEvents(agency.calendar_id, since, until);
      } catch (err) {
        log(`   Calendar inaccessible : ${err.message}`);
      }
    }
    const eventsById = new Map();
    for (const ev of events) {
      if (!ev?.id) continue;
      if (sheetRecords.has(ev.id) || isManagedRdvTitle(ev.summary || '')) eventsById.set(ev.id, ev);
    }
    const ids = new Set(args.sheetsOnly ? [...sheetRecords.keys()] : [...sheetRecords.keys(), ...eventsById.keys()]);
    let added = 0;
    for (const id of ids) {
      const rec = buildRecord(id, agency, sheetRecords.get(id) || null, eventsById.get(id) || null);
      if (!rec) { stats.sansDate += 1; continue; }
      records.set(id, rec);
      added += 1;
    }
    stats.lignesSheets += sheetRecords.size;
    stats.rejetsSansEventId += rejected;
    stats.evenementsCalendar += eventsById.size;
    stats.parAgence[agency.name] = { sheets: sheetRecords.size, calendar: eventsById.size, rdv: added, rejets: rejected };
    log(`   Sheets ${sheetRecords.size} (rejets ${rejected}) · Calendar ${eventsById.size} · RDV ${added}`);
  }

  // SDR : nom brut → actif si un RDV dans les 60 derniers jours
  const activeSince = Date.now() - ACTIVE_WINDOW_DAYS * 24 * 3600 * 1000;
  const sdrs = new Map();
  for (const r of records.values()) {
    for (const name of [r.prospecteur, r.confPar]) {
      if (!name || name.length < 2) continue;
      const cur = sdrs.get(name) || { ...rdvDb.splitDisplayName(name), alias: name, actif: false, rdv: 0 };
      if (name === r.prospecteur) {
        cur.rdv += 1;
        if (new Date(r.start).getTime() >= activeSince) cur.actif = true;
      }
      sdrs.set(name, cur);
    }
  }
  const personnes = new Map();
  for (const r of records.values()) {
    if (!r.telephone) continue;
    if (!personnes.has(r.telephone) || (!personnes.get(r.telephone) && r.clientNom)) personnes.set(r.telephone, r.clientNom);
  }

  const fiches = args.sansFiche || args.enrichOnly ? [] : await loadRoster(args.societe, log);

  stats.rdv = records.size;
  stats.sdr = sdrs.size;
  stats.sdrActifs = [...sdrs.values()].filter((s) => s.actif).length;
  stats.fichesSdr = fiches.length;
  stats.fichesSdrActives = fiches.filter((f) => f.actif).length;
  stats.personnes = personnes.size;
  stats.sansTelephone = [...records.values()].filter((r) => !r.telephone).length;
  stats.sansProspecteur = [...records.values()].filter((r) => !r.prospecteur).length;
  stats.sansCanal = [...records.values()].filter((r) => !r.channelId).length;
  stats.statuts = {};
  for (const r of records.values()) stats.statuts[r.statut] = (stats.statuts[r.statut] || 0) + 1;

  return { company, agencies, records: [...records.values()], sdrs: [...sdrs.values()], personnes: [...personnes.entries()], fiches, stats };
}

// ── Émission SQL idempotente ───────────────────────────────────

function q(value) {
  if (value === null || value === undefined) return 'null';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function sqlUsers(plan) {
  const parts = ['-- SDR : création si inconnu (alias bot), rattachement de l\'alias sinon. Idempotent.'];
  for (const s of plan.sdrs) {
    parts.push(
      `with cand as (select ${q(s.alias)}::text as alias, ${q(s.prenom || '')}::text as prenom, ${q(s.nom || s.alias)}::text as nom, ${s.actif ? 'true' : 'false'} as actif),
existing as (select ua.user_id from users_alias ua, cand where ua.alias_norm = normalise_libelle(cand.alias) limit 1),
ins as (insert into users (nom, prenom, role, actif) select nom, prenom, 'sdr', actif from cand where not exists (select 1 from existing) returning id)
insert into users_alias (user_id, alias, alias_norm, source)
select coalesce((select id from ins), (select user_id from existing)), alias, normalise_libelle(alias), 'bot' from cand
on conflict (alias_norm, source) do nothing;`
    );
  }
  return parts.join('\n');
}

function sqlPersonnes(plan) {
  return chunk(plan.personnes, PERSONNES_BATCH).map((batch) =>
    `insert into personnes (telephone_e164, nom) values\n${batch.map(([tel, nom]) => `(${q(tel)}, ${q(nom)})`).join(',\n')}\non conflict (telephone_e164) do update set nom = coalesce(personnes.nom, excluded.nom);`
  );
}

function sqlRdv(plan, enrichOnly) {
  const cols = 'event_id, channel_id, sdr, tel, conf_par, debut_at, fin_at, type_rdv, confirmation, liens, commentaire, adresse, vehicule';
  return chunk(plan.records, RDV_BATCH).map((batch) => {
    const values = batch.map((r) => `(${[
      q(r.eventId), q(r.channelId), q(r.prospecteur), q(r.telephone), q(r.confPar), q(r.start), q(r.end), q(r.typeRdv),
      q(r.confirmation), q(r.liens), q(r.commentaire), q(r.adresse), q(r.vehicule ? JSON.stringify(r.vehicule) : null),
    ].join(', ')})`).join(',\n');
    if (enrichOnly) {
      return `update rdv set
  fin_at = coalesce(rdv.fin_at, v.fin_at::timestamptz),
  type_rdv = v.type_rdv,
  confirmation = coalesce(rdv.confirmation, v.confirmation),
  liens = coalesce(rdv.liens, v.liens),
  commentaire = coalesce(rdv.commentaire, v.commentaire),
  adresse_dom = coalesce(rdv.adresse_dom, v.adresse),
  vehicule = coalesce(rdv.vehicule, v.vehicule::jsonb),
  prospecteur_nom_brut = coalesce(rdv.prospecteur_nom_brut, v.sdr)
from (values\n${values}\n) as v(${cols})
where rdv.gcal_event_id = v.event_id;`;
    }
    return `insert into rdv (gcal_event_id, agence_id, sdr_user_id, personne_id, confirme_par_user_id, debut_at, fin_at, type_rdv, confirmation, liens, commentaire, adresse_dom, vehicule, prospecteur_nom_brut, source)
select v.event_id,
  (select id from agences where discord_channel_id = v.channel_id limit 1),
  (select user_id from users_alias where v.sdr is not null and alias_norm = normalise_libelle(v.sdr) limit 1),
  (select id from personnes where v.tel is not null and telephone_e164 = v.tel limit 1),
  (select user_id from users_alias where v.conf_par is not null and alias_norm = normalise_libelle(v.conf_par) limit 1),
  v.debut_at::timestamptz, v.fin_at::timestamptz, v.type_rdv, v.confirmation, v.liens, v.commentaire, v.adresse, v.vehicule::jsonb, v.sdr, 'bot'
from (values\n${values}\n) as v(${cols})
on conflict (gcal_event_id) do update set
  agence_id = coalesce(excluded.agence_id, rdv.agence_id),
  sdr_user_id = coalesce(excluded.sdr_user_id, rdv.sdr_user_id),
  personne_id = coalesce(excluded.personne_id, rdv.personne_id),
  confirme_par_user_id = coalesce(excluded.confirme_par_user_id, rdv.confirme_par_user_id),
  debut_at = coalesce(excluded.debut_at, rdv.debut_at),
  fin_at = coalesce(excluded.fin_at, rdv.fin_at),
  type_rdv = excluded.type_rdv,
  confirmation = coalesce(excluded.confirmation, rdv.confirmation),
  liens = coalesce(excluded.liens, rdv.liens),
  commentaire = coalesce(excluded.commentaire, rdv.commentaire),
  adresse_dom = coalesce(excluded.adresse_dom, rdv.adresse_dom),
  vehicule = coalesce(excluded.vehicule, rdv.vehicule),
  prospecteur_nom_brut = coalesce(excluded.prospecteur_nom_brut, rdv.prospecteur_nom_brut);`;
  });
}

function sqlEvents(plan) {
  const rows = [];
  for (const r of plan.records) {
    rows.push([r.eventId, 'pris', r.prisAt]);
    if (r.statut !== 'pris') rows.push([r.eventId, r.statut, r.resultAt]);
  }
  return chunk(rows, EVENT_BATCH).map((batch) =>
    `insert into rdv_evenements (rdv_id, statut, origine, at)
select r.id, v.statut, 'bot', v.at::timestamptz
from (values\n${batch.map(([e, s, at]) => `(${q(e)}, ${q(s)}, ${q(at)})`).join(',\n')}\n) as v(event_id, statut, at)
join rdv r on r.gcal_event_id = v.event_id
where not exists (select 1 from rdv_evenements e where e.rdv_id = r.id and e.statut = v.statut);`
  );
}

function sqlJournal(plan, args) {
  const details = { ...plan.stats, societe: args.societe, enrich_only: args.enrichOnly, since: args.since, genere_le: new Date().toISOString() };
  delete details.parAgence;
  return `insert into bot_journal (action, db_ok, details) values ('import_historique', true, ${q(JSON.stringify(details))}::jsonb);`;
}

function emitSql(plan, args, log) {
  fs.mkdirSync(args.out, { recursive: true });
  const files = [];
  const write = (name, content) => {
    const file = path.join(args.out, name);
    fs.writeFileSync(file, `${content}\n`);
    files.push(file);
  };
  let n = 0;
  const num = () => String(++n).padStart(3, '0');
  if (!args.enrichOnly) {
    write(`${num()}_users.sql`, sqlUsers(plan));
    for (const s of sqlPersonnes(plan)) write(`${num()}_personnes.sql`, s);
  }
  for (const s of sqlRdv(plan, args.enrichOnly)) write(`${num()}_rdv.sql`, s);
  if (!args.enrichOnly) for (const s of sqlEvents(plan)) write(`${num()}_evenements.sql`, s);
  write(`${num()}_journal.sql`, sqlJournal(plan, args));
  log(`${files.length} fichier(s) SQL écrits dans ${args.out} (à rejouer dans l'ordre, sur la base ${plan.company.label} UNIQUEMENT)`);
  return files;
}

// ── Application directe via l'API REST ─────────────────────────

async function applyViaRest(plan, args, log) {
  const db = getClient(args.societe);
  if (!db) throw new Error(`variables ${plan.company.urlVar} / ${plan.company.keyVar} absentes`);

  const agenceIds = new Map();
  for (const a of plan.agencies) {
    const id = await rdvDb.resolveAgencyId(db, a);
    if (!id) throw new Error(`agence « ${a.name} » introuvable dans la base ${plan.company.label}`);
    agenceIds.set(a.key, id);
  }

  const sdrIds = new Map();
  if (!args.enrichOnly) {
    for (const s of plan.sdrs) {
      const res = await rdvDb.resolveSdr(db, { displayName: s.alias }, { createIfMissing: true, actif: s.actif });
      sdrIds.set(s.alias, res.id);
    }
    log(`SDR résolus : ${sdrIds.size}`);
  }

  let done = 0;
  let events = 0;
  for (const r of plan.records) {
    if (args.enrichOnly) {
      const existing = await rdvDb.getRdvByEventId(db, r.eventId);
      if (!existing) continue;
      await db.update('rdv', { id: `eq.${existing.id}` }, {
        fin_at: r.end, type_rdv: r.typeRdv, liens: r.liens, commentaire: r.commentaire, adresse_dom: r.adresse,
        vehicule: r.vehicule, prospecteur_nom_brut: r.prospecteur, ...(existing.confirmation ? {} : { confirmation: r.confirmation }),
      });
      done += 1;
      continue;
    }
    const personneId = await rdvDb.ensurePersonne(db, { nom: r.clientNom, telephone: r.telephone });
    const rdvId = await rdvDb.upsertRdv(db, rdvDb.buildRdvRow({
      eventId: r.eventId,
      agenceId: agenceIds.get(r.agencyKey),
      sdrUserId: r.prospecteur ? sdrIds.get(r.prospecteur) || null : null,
      personneId,
      start: r.start,
      end: r.end,
      typeRdv: r.typeRdv,
      confirmation: r.confirmation,
      liens: r.liens,
      commentaire: r.commentaire,
      adresse: r.adresse,
      vehicule: r.vehicule,
      prospecteurNom: r.prospecteur,
    }));
    const existingEvents = await db.select('rdv_evenements', { select: 'statut', rdv_id: `eq.${rdvId}` });
    const have = new Set((existingEvents || []).map((e) => e.statut));
    if (!have.has('pris')) { await rdvDb.addEvent(db, { rdvId, statut: 'pris', at: r.prisAt }); events += 1; }
    if (r.statut !== 'pris' && !have.has(r.statut)) { await rdvDb.addEvent(db, { rdvId, statut: r.statut, at: r.resultAt }); events += 1; }
    done += 1;
    if (done % 100 === 0) log(`   ${done}/${plan.records.length}`);
  }
  await rdvDb.writeJournal(db, { action: 'import_historique', dbOk: true, details: { ...plan.stats, parAgence: undefined, societe: args.societe, enrich_only: args.enrichOnly, mode: 'apply' } });
  log(`RDV écrits : ${done}, événements de statut insérés : ${events}`);
}

// ── Dépôt dans bot_import_staging + SQL de fusion ──────────────

function stagingRows(plan, lot, enrichOnly) {
  const rows = [];
  if (!enrichOnly) {
    for (const f of plan.fiches || []) rows.push({ lot, kind: 'fiche', payload: f });
    for (const s of plan.sdrs) rows.push({ lot, kind: 'sdr', payload: { alias: s.alias, prenom: s.prenom || '', nom: s.nom || s.alias, actif: s.actif } });
    for (const [tel, nom] of plan.personnes) rows.push({ lot, kind: 'personne', payload: { tel, nom } });
  }
  for (const r of plan.records) {
    rows.push({ lot, kind: 'rdv', payload: {
      event_id: r.eventId, channel_id: r.channelId, agence: r.agencyName, sdr: r.prospecteur, tel: r.telephone, conf_par: r.confPar,
      debut_at: r.start, fin_at: r.end, type_rdv: r.typeRdv, confirmation: r.confirmation, liens: r.liens,
      commentaire: r.commentaire, adresse: r.adresse, vehicule: r.vehicule, statut: r.statut, pris_at: r.prisAt, result_at: r.resultAt,
    } });
  }
  return rows;
}

/** SQL de fusion d'un lot déposé dans bot_import_staging (idempotent, à rejouer sur la bonne base). */
function sqlMerge(lot, enrichOnly, journalDetails) {
  const L = q(lot);
  const parts = [`-- Fusion du lot ${lot} depuis bot_import_staging (${enrichOnly ? 'enrich-only' : 'complet'}). Idempotent.`];
  if (!enrichOnly) {
    // Agences des onglets sans canal Discord : créées inactives (nom = onglet).
    parts.push(`insert into agences (nom, actif, sheet_onglet)
select distinct payload->>'agence', false, payload->>'agence'
from bot_import_staging s where lot = ${L} and kind = 'rdv' and nullif(payload->>'agence', '') is not null
  and not exists (select 1 from agences a where a.discord_channel_id = s.payload->>'channel_id'
                                             or normalise_libelle(a.nom) = normalise_libelle(s.payload->>'agence')
                                             or normalise_libelle(a.sheet_onglet) = normalise_libelle(s.payload->>'agence'));`);
    // Fiche SDR (classeur RH) : rapprochée par nom complet (les deux ordres) ou mail ;
    // ARCHIVE (rang 0) puis SDR (rang 1) : l'onglet courant a le dernier mot.
    parts.push(`do $$
declare f record; v_id uuid; v_mail text;
begin
  for f in select payload->>'nom' as nom, payload->>'prenom' as prenom, lower(payload->>'email') as email,
                  coalesce(payload->>'role', 'sdr') as role, coalesce((payload->>'actif')::boolean, false) as actif,
                  (payload->>'date_entree')::date as date_entree, (payload->>'date_sortie')::date as date_sortie
           from bot_import_staging where lot = ${L} and kind = 'fiche'
           order by (payload->>'rang')::int, id loop
    select id into v_id from users where normalise_libelle(prenom || ' ' || nom) = normalise_libelle(f.prenom || ' ' || f.nom) limit 1;
    if v_id is null then
      select user_id into v_id from users_alias
       where alias_norm in (normalise_libelle(f.prenom || ' ' || f.nom), normalise_libelle(f.nom || ' ' || f.prenom)) limit 1;
    end if;
    if v_id is null and f.email is not null then
      select id into v_id from users where lower(email) = f.email limit 1;
    end if;
    v_mail := case when f.email is not null and not exists (select 1 from users u where lower(u.email) = f.email and u.id is distinct from v_id) then f.email end;
    if v_id is null then
      insert into users (nom, prenom, email, role, actif, date_entree, date_sortie)
      values (f.nom, f.prenom, v_mail, f.role, f.actif, f.date_entree, f.date_sortie) returning id into v_id;
    else
      update users set
        email = coalesce(users.email, v_mail),
        role = case when users.role = 'sdr' then f.role else users.role end,
        actif = f.actif,
        date_entree = coalesce(users.date_entree, f.date_entree),
        date_sortie = coalesce(f.date_sortie, users.date_sortie)
      where id = v_id;
    end if;
  end loop;
end $$;`);
    parts.push(`do $$
declare c record; v_id uuid;
begin
  for c in select distinct payload->>'alias' as alias, payload->>'prenom' as prenom, payload->>'nom' as nom, coalesce((payload->>'actif')::boolean, false) as actif
           from bot_import_staging where lot = ${L} and kind = 'sdr' loop
    select user_id into v_id from users_alias where alias_norm = normalise_libelle(c.alias) limit 1;
    if v_id is null then
      select user_id into v_id from users_alias where alias_norm = normalise_libelle(c.prenom || ' ' || c.nom) limit 1;
    end if;
    if v_id is null then
      -- fiche SDR importée juste avant : même personne, « Prénom NOM » ou « NOM Prénom »
      select id into v_id from users
       where normalise_libelle(prenom || ' ' || nom) in (normalise_libelle(c.alias), normalise_libelle(c.nom || ' ' || c.prenom))
          or normalise_libelle(nom || ' ' || prenom) = normalise_libelle(c.alias)
       order by actif desc limit 1;
    end if;
    if v_id is null then
      insert into users (nom, prenom, role, actif) values (c.nom, c.prenom, 'sdr', c.actif) returning id into v_id;
    end if;
    insert into users_alias (user_id, alias, alias_norm, source) values (v_id, c.alias, normalise_libelle(c.alias), 'bot')
    on conflict (alias_norm, source) do nothing;
  end loop;
end $$;`);
    parts.push(`insert into personnes (telephone_e164, nom)
select distinct on (payload->>'tel') payload->>'tel', nullif(payload->>'nom', '')
from bot_import_staging where lot = ${L} and kind = 'personne' and payload->>'tel' is not null
order by payload->>'tel', (payload->>'nom') is null
on conflict (telephone_e164) do update set nom = coalesce(personnes.nom, excluded.nom);`);
  }
  // fin_at absent = début + 60 min ; pris_at absent = début ; result_at = greatest(début, pris) + 1 s.
  const v = `(select payload->>'event_id' as event_id, payload->>'channel_id' as channel_id, nullif(payload->>'agence', '') as agence, nullif(payload->>'sdr', '') as sdr, payload->>'tel' as tel,
      nullif(payload->>'conf_par', '') as conf_par, (payload->>'debut_at')::timestamptz as debut_at,
      coalesce((payload->>'fin_at')::timestamptz, (payload->>'debut_at')::timestamptz + interval '60 minutes') as fin_at, payload->>'type_rdv' as type_rdv,
      payload->>'confirmation' as confirmation, payload->>'liens' as liens, payload->>'commentaire' as commentaire, payload->>'adresse' as adresse,
      case when payload->'vehicule' is null or payload->'vehicule' = 'null'::jsonb then null else payload->'vehicule' end as vehicule,
      coalesce(payload->>'statut', 'pris') as statut,
      coalesce((payload->>'pris_at')::timestamptz, (payload->>'debut_at')::timestamptz) as pris_at,
      greatest((payload->>'debut_at')::timestamptz, coalesce((payload->>'pris_at')::timestamptz, (payload->>'debut_at')::timestamptz)) + interval '1 second' as result_at
    from (select distinct on (payload->>'event_id') payload from bot_import_staging where lot = ${L} and kind = 'rdv' order by payload->>'event_id', id desc) s)`;
  if (enrichOnly) {
    parts.push(`update rdv set
  fin_at = coalesce(rdv.fin_at, v.fin_at),
  type_rdv = v.type_rdv,
  confirmation = coalesce(rdv.confirmation, v.confirmation),
  liens = coalesce(rdv.liens, v.liens),
  commentaire = coalesce(rdv.commentaire, v.commentaire),
  adresse_dom = coalesce(rdv.adresse_dom, v.adresse),
  vehicule = coalesce(rdv.vehicule, v.vehicule),
  prospecteur_nom_brut = coalesce(rdv.prospecteur_nom_brut, v.sdr)
from ${v} as v
where rdv.gcal_event_id = v.event_id;`);
  } else {
    parts.push(`insert into rdv (gcal_event_id, agence_id, sdr_user_id, personne_id, confirme_par_user_id, debut_at, fin_at, type_rdv, confirmation, liens, commentaire, adresse_dom, vehicule, prospecteur_nom_brut, source)
select v.event_id,
  coalesce((select id from agences where v.channel_id is not null and discord_channel_id = v.channel_id limit 1),
           (select id from agences where v.agence is not null and normalise_libelle(sheet_onglet) = normalise_libelle(v.agence) limit 1),
           (select id from agences where v.agence is not null and normalise_libelle(nom) = normalise_libelle(v.agence) limit 1)),
  (select user_id from users_alias where v.sdr is not null and alias_norm = normalise_libelle(v.sdr) limit 1),
  (select id from personnes where v.tel is not null and telephone_e164 = v.tel limit 1),
  (select user_id from users_alias where v.conf_par is not null and alias_norm = normalise_libelle(v.conf_par) limit 1),
  v.debut_at, v.fin_at, v.type_rdv, v.confirmation, v.liens, v.commentaire, v.adresse, v.vehicule, v.sdr, 'bot'
from ${v} as v
on conflict (gcal_event_id) do update set
  agence_id = coalesce(excluded.agence_id, rdv.agence_id),
  sdr_user_id = coalesce(excluded.sdr_user_id, rdv.sdr_user_id),
  personne_id = coalesce(excluded.personne_id, rdv.personne_id),
  confirme_par_user_id = coalesce(excluded.confirme_par_user_id, rdv.confirme_par_user_id),
  debut_at = coalesce(excluded.debut_at, rdv.debut_at),
  fin_at = coalesce(excluded.fin_at, rdv.fin_at),
  type_rdv = excluded.type_rdv,
  confirmation = coalesce(excluded.confirmation, rdv.confirmation),
  liens = coalesce(excluded.liens, rdv.liens),
  commentaire = coalesce(excluded.commentaire, rdv.commentaire),
  adresse_dom = coalesce(excluded.adresse_dom, rdv.adresse_dom),
  vehicule = coalesce(excluded.vehicule, rdv.vehicule),
  prospecteur_nom_brut = coalesce(excluded.prospecteur_nom_brut, rdv.prospecteur_nom_brut);`);
    parts.push(`insert into rdv_evenements (rdv_id, statut, origine, at)
select r.id, e.statut, 'bot', e.at
from ${v} as v
join rdv r on r.gcal_event_id = v.event_id
cross join lateral (values ('pris', v.pris_at), (v.statut, v.result_at)) as e(statut, at)
where e.statut is not null and e.statut <> '' and e.at is not null
  and not (e.statut = 'pris' and e.at = v.result_at)
  and not exists (select 1 from rdv_evenements x where x.rdv_id = r.id and x.statut = e.statut);`);
  }
  parts.push(`insert into bot_journal (action, db_ok, details) values ('import_historique', true, ${q(JSON.stringify(journalDetails))}::jsonb);`);
  parts.push(`delete from bot_import_staging where lot = ${L};`);
  return parts.join('\n\n');
}

/** ISO sans millisecondes (plus court, même instant). */
function shortIso(iso) {
  return iso ? String(iso).replace(/\.\d{3}Z$/, 'Z') : null;
}

/**
 * Mode sql-stage : dépôt compact dans bot_import_staging par fichiers SQL
 * (tableaux positionnels jsonb → objets reconstruits côté SQL), puis fusion.
 */
function emitStageSql(plan, args, log) {
  const lot = args.lot || `${args.societe}-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;
  // Index d'agence = couple (canal Discord ou null, nom d'onglet) reconstruit par CASE côté SQL.
  const agences = [...new Map(plan.records.map((r) => [`${r.channelId || ''}|${r.agencyName}`, { channelId: r.channelId, name: r.agencyName }])).values()];
  const chanIdx = new Map(agences.map((a, i) => [`${a.channelId || ''}|${a.name}`, i]));
  const files = [];
  fs.mkdirSync(args.out, { recursive: true });
  let n = 0;
  const write = (name, content) => {
    const file = path.join(args.out, `${String(++n).padStart(3, '0')}_${name}.sql`);
    fs.writeFileSync(file, `${content}\n`);
    files.push(file);
  };
  const L = q(lot);
  const stageInsert = (kind, expr, jsonArray) =>
    `insert into bot_import_staging (lot, kind, payload)\nselect ${L}, '${kind}', ${expr}\nfrom jsonb_array_elements(${q(jsonArray)}::jsonb) as a;`;

  if (!args.enrichOnly) {
    for (const batch of chunk(plan.fiches || [], 150)) {
      const fiches = batch.map((f) => [f.nom, f.prenom, f.email, f.role, f.actif ? 1 : 0, f.date_entree, f.date_sortie, f.rang]);
      write('stage_fiche', stageInsert('fiche', "jsonb_build_object('nom', a->>0, 'prenom', a->>1, 'email', a->>2, 'role', a->>3, 'actif', (a->>4) = '1', 'date_entree', a->>5, 'date_sortie', a->>6, 'rang', (a->>7)::int)", JSON.stringify(fiches)));
    }
    const sdrs = plan.sdrs.map((s) => [s.alias, s.prenom || '', s.nom || s.alias, s.actif ? 1 : 0]);
    write('stage_sdr', stageInsert('sdr', "jsonb_build_object('alias', a->>0, 'prenom', a->>1, 'nom', a->>2, 'actif', (a->>3) = '1')", JSON.stringify(sdrs)));
    for (const batch of chunk(plan.personnes, 1200)) {
      write('stage_personnes', stageInsert('personne', "jsonb_build_object('tel', a->>0, 'nom', a->>1)", JSON.stringify(batch)));
    }
  }
  // Compact : fin_at omis quand = début + 60 min, pris_at omis quand = début,
  // result_at toujours dérivé (greatest(début, pris) + 1 s) par merge_<lot>.sql.
  const rdvRows = plan.records.map((r) => {
    const startMs = new Date(r.start).getTime();
    const endDefault = new Date(r.end).getTime() === startMs + 60 * 60000;
    const prisDefault = new Date(r.prisAt).getTime() === startMs;
    return [
      r.eventId, chanIdx.get(`${r.channelId || ''}|${r.agencyName}`), r.prospecteur, r.telephone, r.confPar, shortIso(r.start), endDefault ? null : shortIso(r.end),
      r.typeRdv === 'mandat_dom' ? 1 : 0, r.confirmation, r.liens, r.commentaire, r.adresse,
      r.vehicule ? [r.vehicule.marque, r.vehicule.modele, r.vehicule.annee, r.vehicule.km, r.vehicule.prix] : null,
      r.statut === 'pris' ? null : r.statut, prisDefault ? null : shortIso(r.prisAt),
    ];
  });
  const chanCase = `case a->>1 ${agences.map((c, i) => `when '${i}' then ${q(c.channelId)}`).join(' ')} end`;
  const agenceCase = `case a->>1 ${agences.map((c, i) => `when '${i}' then ${q(c.name)}`).join(' ')} end`;
  const rdvExpr = `jsonb_build_object(
    'event_id', a->>0, 'channel_id', ${chanCase}, 'agence', ${agenceCase}, 'sdr', a->>2, 'tel', a->>3, 'conf_par', a->>4,
    'debut_at', a->>5, 'fin_at', a->>6, 'type_rdv', case when a->>7 = '1' then 'mandat_dom' else 'mandat' end,
    'confirmation', a->>8, 'liens', a->>9, 'commentaire', a->>10, 'adresse', a->>11,
    'vehicule', case when a->12 is null or a->12 = 'null'::jsonb then null else jsonb_build_object('marque', a->12->>0, 'modele', a->12->>1, 'annee', (a->12->>2)::int, 'km', (a->12->>3)::int, 'prix', (a->12->>4)::int) end,
    'statut', coalesce(a->>13, 'pris'), 'pris_at', a->>14)`;
  for (const batch of chunk(rdvRows, args.rowsPerFile || 45)) {
    write('stage_rdv', stageInsert('rdv', rdvExpr, JSON.stringify(batch)));
  }
  const { parAgence, ...details } = plan.stats;
  const mergeFile = path.join(args.out, `merge_${lot}.sql`);
  fs.writeFileSync(mergeFile, `${sqlMerge(lot, args.enrichOnly, { ...details, societe: args.societe, lot, enrich_only: args.enrichOnly, sheets_only: args.sheetsOnly, since: args.since })}\n`);
  log(`Lot ${lot} : ${files.length} fichier(s) de dépôt + ${mergeFile}, à rejouer dans l'ordre sur la base ${plan.company.label} UNIQUEMENT.`);
  return { lot, files, mergeFile };
}

async function stageViaRest(plan, args, log) {
  const company = COMPANIES[args.societe];
  const url = String(process.env[company.urlVar] || '').trim().replace(/\/+$/, '');
  const key = String(process.env[company.keyVar] || '').trim();
  if (!url || !key) throw new Error(`${company.urlVar} et ${company.keyVar} requis`);
  const lot = `${args.societe}-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;
  const rows = stagingRows(plan, lot, args.enrichOnly);
  let sent = 0;
  for (const batch of chunk(rows, 500)) {
    const res = await fetch(`${url}/rest/v1/bot_import_staging`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`dépôt refusé (${res.status}) : ${(await res.text()).slice(0, 300)}`);
    sent += batch.length;
    if (sent % 2000 === 0 || sent === rows.length) log(`   déposé ${sent}/${rows.length}`);
  }
  const { parAgence, ...details } = plan.stats;
  fs.mkdirSync(args.out, { recursive: true });
  const file = path.join(args.out, `merge_${lot}.sql`);
  fs.writeFileSync(file, `${sqlMerge(lot, args.enrichOnly, { ...details, societe: args.societe, lot, enrich_only: args.enrichOnly, since: args.since })}\n`);
  log(`Lot ${lot} déposé (${rows.length} lignes). Fusion : rejouer ${file} sur la base ${company.label} UNIQUEMENT.`);
  return { lot, file, rows: rows.length };
}

// ── Point d'entrée ─────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (m) => console.log(m);
  log(`Import historique ${COMPANIES[args.societe].label} — mode ${args.mode}${args.enrichOnly ? ' (enrich-only)' : ''}, depuis ${args.since}`);
  const plan = await buildPlan(args, log);
  const { parAgence, ...summary } = plan.stats;
  log(JSON.stringify(summary, null, 2));
  if (args.mode === 'sql') emitSql(plan, args, log);
  if (args.mode === 'sql-stage') emitStageSql(plan, args, log);
  if (args.mode === 'stage') await stageViaRest(plan, args, log);
  if (args.mode === 'apply') await applyViaRest(plan, args, log);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`ERREUR : ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, parisToIso, parseSheetDateTime, parseUpdatedAt, parseSheetDate, parseSheetRows, parseRosterRows, rosterRole, detectExtraColumns, buildRecord, buildPlan, prefixToStatut, prefixToConf, sqlUsers, sqlPersonnes, sqlRdv, sqlEvents, stagingRows, sqlMerge, emitStageSql };
