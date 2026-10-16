// ══════════════════════════════════════════════════════════════
// Rapport de cohérence Sheets ↔ base, pendant la double écriture.
//
// Pour chaque agence (routée vers SA base), on compare les RDV dont la
// date tombe dans la fenêtre [aujourd'hui - 7 j, aujourd'hui + 30 j] :
//   - présents dans Sheets mais absents de la base
//   - présents en base mais absents de Sheets
//   - statut différent (PLANIFIÉ / ANNULÉ / VENDU / PAS VENU…)
//   - confirmation différente (J/J, J+1, CONF, NON CONF)
// Le résumé part dans le canal d'alertes (#alertes-bot) tous les soirs
// (COHERENCE_REPORT_HOUR, défaut 22) et à la demande (/rdvadmin coherence).
// Aucune donnée client n'apparaît dans le rapport : agence + ID événement.
// ══════════════════════════════════════════════════════════════

const sheets = require('./sheets');
const { COL } = sheets;
const { getDbForAgency, inList } = require('./supabase');
const { sheetStatutToDb, sheetConfToDb, resolveAgencyId } = require('./rdv-db');

const DEFAULT_PAST_DAYS = 7;
const DEFAULT_FUTURE_DAYS = 30;
const MAX_LINES = 20;

function parseSheetDate(value) {
  const m = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  const d = new Date(year, Number(m[2]) - 1, Number(m[1]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function ymd(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Ligne Sheets → { eventId, date, statut, confirmation } ou null (pas d'EVENT_ID / hors fenêtre). */
function sheetRowToRecord(row, { from, to }) {
  const eventId = String(row?.[COL.EVENT_ID] || '').trim();
  if (!eventId || eventId.length < 10) return null;
  const date = parseSheetDate(row[COL.DATE]);
  if (!date || date < from || date > to) return null;
  return {
    eventId,
    date: ymd(date),
    statut: sheetStatutToDb(row[COL.STATUT]) || 'pris',
    confirmation: sheetConfToDb(row[COL.CONFIRMATION]),
  };
}

/** Statut vue v_export_sheet (libellé) → code base. */
function dbStatutCode(label) {
  return sheetStatutToDb(label) || 'pris';
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Compare une agence. Retourne { compared, missingInDb, missingInSheet, statutDiff, confDiff, lines, error }.
 */
async function compareAgency(db, agency, { from, to }) {
  const result = { compared: 0, missingInDb: 0, missingInSheet: 0, statutDiff: 0, confDiff: 0, lines: [], error: null };
  let rows;
  try {
    rows = await sheets.getAllRows(agency.spreadsheet_id, agency.sheet_name);
  } catch (err) {
    result.error = `Sheets inaccessible (${err.message})`;
    return result;
  }
  const sheetRecords = new Map();
  for (const row of rows) {
    const rec = sheetRowToRecord(row, { from, to });
    if (rec) sheetRecords.set(rec.eventId, rec);
  }

  const agenceId = await resolveAgencyId(db, agency);
  if (!agenceId) {
    result.error = 'agence introuvable en base';
    return result;
  }

  // Côté base : tous les RDV de l'agence dans la fenêtre + ceux cités par Sheets.
  const dbRecords = new Map();
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(new Date(to).getTime() + 24 * 3600 * 1000).toISOString();
  const inWindow = await db.select('rdv', {
    select: 'id,gcal_event_id,confirmation',
    agence_id: `eq.${agenceId}`,
    and: `(debut_at.gte.${fromIso},debut_at.lt.${toIso})`,
    limit: 5000,
  });
  const inWindowIds = new Set();
  for (const r of inWindow || []) {
    if (!r.gcal_event_id) continue;
    inWindowIds.add(r.gcal_event_id);
    dbRecords.set(r.gcal_event_id, { id: r.id, confirmation: r.confirmation || null, statut: null });
  }

  const missingIds = [...sheetRecords.keys()].filter((id) => !dbRecords.has(id));
  for (const ids of chunk(missingIds, 100)) {
    const found = await db.select('rdv', { select: 'id,gcal_event_id,confirmation', gcal_event_id: inList(ids), limit: ids.length });
    for (const r of found || []) dbRecords.set(r.gcal_event_id, { id: r.id, confirmation: r.confirmation || null, statut: null });
  }

  const rdvIds = [...dbRecords.values()].map((r) => r.id);
  const statutById = new Map();
  for (const ids of chunk(rdvIds, 100)) {
    const etats = await db.select('v_rdv_etat', { select: 'rdv_id,statut', rdv_id: inList(ids), limit: ids.length });
    for (const e of etats || []) statutById.set(e.rdv_id, e.statut);
  }
  for (const rec of dbRecords.values()) rec.statut = statutById.get(rec.id) || 'pris';

  for (const [eventId, s] of sheetRecords) {
    const d = dbRecords.get(eventId);
    result.compared += 1;
    if (!d) {
      result.missingInDb += 1;
      result.lines.push(`${agency.name} · \`${eventId}\` · absent de la base (Sheets : ${s.statut})`);
      continue;
    }
    // 'confirme' côté base équivaut à 'pris' côté Sheets (STATUT ne porte pas la confirmation).
    const dbStatut = d.statut === 'confirme' ? 'pris' : d.statut;
    if (dbStatut !== s.statut) {
      result.statutDiff += 1;
      result.lines.push(`${agency.name} · \`${eventId}\` · statut Sheets ${s.statut} ≠ base ${d.statut}`);
    }
    if ((s.confirmation || null) !== (d.confirmation || null)) {
      result.confDiff += 1;
      result.lines.push(`${agency.name} · \`${eventId}\` · confirmation Sheets ${s.confirmation || '—'} ≠ base ${d.confirmation || '—'}`);
    }
  }
  for (const eventId of inWindowIds) {
    if (!sheetRecords.has(eventId)) {
      result.missingInSheet += 1;
      result.lines.push(`${agency.name} · \`${eventId}\` · en base mais absent de Sheets`);
    }
  }
  return result;
}

/**
 * Lance le rapport sur toutes les agences configurées (une base par société).
 * Retourne le rapport structuré ; `post` = envoi dans le canal d'alertes.
 */
async function runCoherenceReport({ agencies, client, pastDays = DEFAULT_PAST_DAYS, futureDays = DEFAULT_FUTURE_DAYS, post = true, trigger = 'auto' } = {}) {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - pastDays);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + futureDays);

  const perCompany = {};
  const unrouted = [];
  for (const [key, agency] of Object.entries(agencies || {})) {
    const route = getDbForAgency({ key, ...agency }, agency.guild_id || null);
    if (!route.db) {
      unrouted.push(`${agency.name || key} : ${route.reason}`);
      continue;
    }
    const bucket = perCompany[route.company] || (perCompany[route.company] = {
      label: route.label, db: route.db, agencies: 0, errors: [], compared: 0, missingInDb: 0, missingInSheet: 0, statutDiff: 0, confDiff: 0, lines: [],
    });
    bucket.agencies += 1;
    try {
      const r = await compareAgency(route.db, { key, ...agency }, { from, to });
      if (r.error) bucket.errors.push(`${agency.name || key} : ${r.error}`);
      bucket.compared += r.compared;
      bucket.missingInDb += r.missingInDb;
      bucket.missingInSheet += r.missingInSheet;
      bucket.statutDiff += r.statutDiff;
      bucket.confDiff += r.confDiff;
      bucket.lines.push(...r.lines);
    } catch (err) {
      bucket.errors.push(`${agency.name || key} : ${err.message}`);
    }
  }

  const report = { at: now.toISOString(), from: ymd(from), to: ymd(to), trigger, companies: {}, unrouted };
  for (const [company, b] of Object.entries(perCompany)) {
    const { db, ...rest } = b;
    report.companies[company] = rest;
    try {
      await db.insert('bot_journal', [{
        action: 'coherence',
        db_ok: true,
        details: {
          declencheur: trigger, fenetre: { de: report.from, a: report.to }, agences: b.agencies, compares: b.compared,
          absents_base: b.missingInDb, absents_sheets: b.missingInSheet, ecarts_statut: b.statutDiff, ecarts_confirmation: b.confDiff, erreurs: b.errors.length,
        },
      }], { returning: false });
    } catch (err) {
      console.warn(`[Coherence] journal non écrit (${b.label}): ${err.message}`);
    }
  }

  if (post) await postReport(report, client);
  return report;
}

function formatReport(report) {
  const header = `**Rapport de cohérence Sheets ↔ base** — fenêtre ${report.from} → ${report.to}`;
  const blocks = [];
  for (const [, c] of Object.entries(report.companies)) {
    const total = c.missingInDb + c.missingInSheet + c.statutDiff + c.confDiff;
    const icon = total === 0 && c.errors.length === 0 ? '✅' : '⚠️';
    blocks.push([
      `${icon} **${c.label}** — ${c.agencies} agence(s), ${c.compared} RDV comparés`,
      `absents de la base : **${c.missingInDb}** · absents de Sheets : **${c.missingInSheet}** · écarts statut : **${c.statutDiff}** · écarts confirmation : **${c.confDiff}**`,
      ...(c.errors.length ? [`erreurs : ${c.errors.slice(0, 5).join(' ; ')}${c.errors.length > 5 ? ` (+${c.errors.length - 5})` : ''}`] : []),
    ].join('\n'));
  }
  if (Object.keys(report.companies).length === 0) blocks.push('Aucune base configurée : rien à comparer.');
  if (report.unrouted.length) blocks.push(`Agences sans base : ${report.unrouted.slice(0, 5).join(' ; ')}${report.unrouted.length > 5 ? ` (+${report.unrouted.length - 5})` : ''}`);
  const lines = Object.values(report.companies).flatMap((c) => c.lines);
  const detail = lines.length
    ? `\n**Détail (${Math.min(lines.length, MAX_LINES)}/${lines.length})**\n${lines.slice(0, MAX_LINES).map((l) => `- ${l}`).join('\n')}`
    : '';
  return `${header}\n\n${blocks.join('\n\n')}${detail}`;
}

async function postReport(report, client) {
  const text = formatReport(report);
  const totalIssues = Object.values(report.companies).reduce((n, c) => n + c.missingInDb + c.missingInSheet + c.statutDiff + c.confDiff + c.errors.length, 0);
  try {
    const { notifyOps } = require('./alerts');
    await notifyOps({
      kind: totalIssues === 0 ? 'Cohérence Sheets ↔ base : OK' : `Cohérence Sheets ↔ base : ${totalIssues} écart(s)`,
      message: text.slice(0, 1500),
      level: totalIssues === 0 ? 'info' : 'warn',
      context: { commande: 'coherence', sousCommande: report.trigger },
      client,
      force: true,
    });
  } catch (err) {
    console.warn(`[Coherence] envoi Discord échoué: ${err.message}`);
  }
}

function getReportHour(env = process.env) {
  const h = Number(env.COHERENCE_REPORT_HOUR);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 22;
}

module.exports = {
  parseSheetDate,
  sheetRowToRecord,
  dbStatutCode,
  compareAgency,
  runCoherenceReport,
  formatReport,
  getReportHour,
};
