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
//   --mode dry|sql|apply        dry = compte seulement ; sql = écrit des fichiers
//                               SQL idempotents à rejouer (éditeur SQL Supabase,
//                               MCP…) ; apply = écrit via l'API REST avec la clé
//                               service_role (SUPABASE_<SOCIETE>_URL / _SERVICE_ROLE_KEY)
//   --agence <clé>              une seule agence (clé de agencies.json)
//   --exclude <clé,clé>         agences à ignorer (ex: licall test)
//   --since AAAA-MM-JJ          début de l'historique Calendar (défaut 2025-01-01)
//   --enrich-only               ne touche QUE les RDV déjà en base (colonnes du bot :
//                               fin_at, type_rdv, confirmation, véhicule, liens,
//                               commentaire, adresse, prospecteur brut) — pour Kall
//                               Kall, dont l'historique vient déjà du dashboard.
//   --out <dossier>             dossier des fichiers SQL (mode sql)
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
  const args = { mode: 'dry', since: '2025-01-01', enrichOnly: false, out: null, agence: null, exclude: [], societe: null };
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
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else throw new Error(`argument inconnu : ${a}`);
  }
  if (!args.societe || !COMPANIES[args.societe]) throw new Error('--societe licall|kallkall obligatoire');
  if (!['dry', 'sql', 'apply'].includes(args.mode)) throw new Error('--mode dry|sql|apply');
  if (args.mode === 'sql' && !args.out) args.out = path.join('supabase', 'imports', args.societe);
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
  return cells.some((c) => c.includes('PROSPECTEUR') || c.includes('CLIENT') || c.includes('EVENT'));
}

function parseSheetRows(rows) {
  const out = new Map();
  let rejected = 0;
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) if (looksLikeHeader(rows[i])) headerIdx = i;
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
    });
  }
  return { records: out, rejected };
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
  const statut = (sheetRow && rdvDb.sheetStatutToDb(sheetRow.statut)) || prefixToStatut(prefix) || 'pris';
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
    channelId: agency.channel_id,
    agencyName: agency.name,
    prospecteur: rdvDb.stripEmoji(sheetRow?.prospecteur || '') || null,
    confPar: rdvDb.stripEmoji(sheetRow?.confPar || '') || null,
    clientNom: String(sheetRow?.client || details?.nomClient || '').trim().toUpperCase() || null,
    telephone: rdvDb.normalizePhoneE164(sheetRow?.telephone || details?.telephone || ''),
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

async function buildPlan(args, log) {
  const company = COMPANIES[args.societe];
  const all = loadAgencies();
  const agencies = Object.entries(all)
    .map(([key, cfg]) => ({ key, ...cfg }))
    .filter((a) => resolveCompany(a, a.guild_id || null) === args.societe)
    .filter((a) => !args.agence || a.key === args.agence)
    .filter((a) => !args.exclude.includes(a.key));
  if (agencies.length === 0) throw new Error(`aucune agence ${company.label} dans agencies.json${args.agence ? ` (clé ${args.agence})` : ''}`);

  const since = new Date(`${args.since}T00:00:00Z`);
  if (Number.isNaN(since.getTime())) throw new Error(`--since invalide : ${args.since}`);
  const until = new Date(Date.now() + 400 * 24 * 3600 * 1000);

  const records = new Map();
  const stats = { agences: agencies.length, lignesSheets: 0, rejetsSansEventId: 0, evenementsCalendar: 0, sansDate: 0, parAgence: {} };

  for (const agency of agencies) {
    log(`→ ${agency.name}`);
    let sheetRecords = new Map();
    let rejected = 0;
    try {
      const rows = await sheets.getAllRows(agency.spreadsheet_id, agency.sheet_name);
      ({ records: sheetRecords, rejected } = parseSheetRows(rows));
    } catch (err) {
      log(`   Sheets inaccessible : ${err.message}`);
    }
    let events = [];
    try {
      events = await calendar.listAllEvents(agency.calendar_id, since, until);
    } catch (err) {
      log(`   Calendar inaccessible : ${err.message}`);
    }
    const eventsById = new Map();
    for (const ev of events) {
      if (!ev?.id) continue;
      if (sheetRecords.has(ev.id) || isManagedRdvTitle(ev.summary || '')) eventsById.set(ev.id, ev);
    }
    const ids = new Set([...sheetRecords.keys(), ...eventsById.keys()]);
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

  stats.rdv = records.size;
  stats.sdr = sdrs.size;
  stats.sdrActifs = [...sdrs.values()].filter((s) => s.actif).length;
  stats.personnes = personnes.size;
  stats.sansTelephone = [...records.values()].filter((r) => !r.telephone).length;
  stats.sansProspecteur = [...records.values()].filter((r) => !r.prospecteur).length;
  stats.statuts = {};
  for (const r of records.values()) stats.statuts[r.statut] = (stats.statuts[r.statut] || 0) + 1;

  return { company, agencies, records: [...records.values()], sdrs: [...sdrs.values()], personnes: [...personnes.entries()], stats };
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

// ── Point d'entrée ─────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (m) => console.log(m);
  log(`Import historique ${COMPANIES[args.societe].label} — mode ${args.mode}${args.enrichOnly ? ' (enrich-only)' : ''}, depuis ${args.since}`);
  const plan = await buildPlan(args, log);
  const { parAgence, ...summary } = plan.stats;
  log(JSON.stringify(summary, null, 2));
  if (args.mode === 'sql') emitSql(plan, args, log);
  if (args.mode === 'apply') await applyViaRest(plan, args, log);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`ERREUR : ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, parisToIso, parseSheetDateTime, parseUpdatedAt, parseSheetRows, buildRecord, prefixToStatut, prefixToConf, sqlUsers, sqlPersonnes, sqlRdv, sqlEvents };
