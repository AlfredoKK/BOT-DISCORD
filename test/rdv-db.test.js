const assert = require('node:assert/strict');
const test = require('node:test');

function mockModule(request, exports) {
  const resolved = require.resolve(request);
  delete require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Pas d'avis Discord pendant les tests
const notices = [];
mockModule('../src/services/alerts', { notifyOps: async (n) => { notices.push(n); return { sent: true }; } });

process.env.SUPABASE_LICALL_URL = 'https://licall.supabase.co';
process.env.SUPABASE_LICALL_SERVICE_ROLE_KEY = 'licall-key';
process.env.SUPABASE_KALLKALL_URL = 'https://kk.supabase.co';
process.env.SUPABASE_KALLKALL_SERVICE_ROLE_KEY = 'kk-key';

delete require.cache[require.resolve('../src/services/supabase')];
delete require.cache[require.resolve('../src/services/rdv-db')];
const supabase = require('../src/services/supabase');
const rdvDb = require('../src/services/rdv-db');

const LICALL_SHEET = '16H-aZ8eV9M5Qd5ZToWFSluZFbtHKdP0wcS3mtBK_mzI';
const KK_SHEET = '1dshz0ZhA44VziYOirOwQj_AQFRJxehsV7yZnZ5LJ0BU';

// ── Base simulée : journalise les appels PostgREST et répond de façon plausible ──

function fakeDb(overrides = {}) {
  const calls = [];
  const state = { users: [], personnes: [], rdv: [], events: [], journal: [] };
  const db = {
    label: 'Test',
    calls,
    state,
    async select(table, params) {
      calls.push(['select', table, params]);
      if (overrides.select) { const r = overrides.select(table, params, state); if (r !== undefined) return r; }
      if (table === 'agences') return [{ id: 'ag-1' }];
      if (table === 'users' && params.discord_user_id) return state.users.filter((u) => `eq.${u.discord_user_id}` === params.discord_user_id);
      if (table === 'personnes') return state.personnes.filter((p) => `eq.${p.telephone_e164}` === params.telephone_e164);
      if (table === 'rdv') return state.rdv.filter((r) => `eq.${r.gcal_event_id}` === params.gcal_event_id);
      if (table === 'v_rdv_etat') {
        const evs = state.events.filter((e) => `eq.${e.rdv_id}` === params.rdv_id);
        return evs.length ? [{ statut: evs[evs.length - 1].statut }] : [];
      }
      return [];
    },
    async insert(table, rows) {
      calls.push(['insert', table, rows]);
      if (table === 'users') { const u = { id: `u-${state.users.length + 1}`, ...rows[0] }; state.users.push(u); return [u]; }
      if (table === 'rdv_evenements') { state.events.push(...rows); return rows; }
      if (table === 'bot_journal') { state.journal.push(...rows); return null; }
      return rows.map((r, i) => ({ id: `${table}-${i}`, ...r }));
    },
    async upsert(table, rows, opts) {
      calls.push(['upsert', table, rows, opts]);
      if (table === 'personnes') {
        for (const r of rows) if (!state.personnes.some((p) => p.telephone_e164 === r.telephone_e164)) state.personnes.push({ id: `p-${state.personnes.length + 1}`, ...r });
        return null;
      }
      if (table === 'rdv') {
        const existing = state.rdv.find((r) => r.gcal_event_id === rows[0].gcal_event_id);
        if (existing) { Object.assign(existing, rows[0]); return [existing]; }
        const created = { id: `rdv-${state.rdv.length + 1}`, ...rows[0] };
        state.rdv.push(created);
        return [created];
      }
      return null;
    },
    async update(table, filters, patch) { calls.push(['update', table, filters, patch]); return [{}]; },
    async remove(table, filters) { calls.push(['remove', table, filters]); return []; },
    async rpc(fn, args) {
      calls.push(['rpc', fn, args]);
      if (overrides.rpc) return overrides.rpc(fn, args, state);
      return null;
    },
  };
  return db;
}

function stubRouting(db, company = 'licall') {
  // getDbForAgency passe par getClient : on branche le client simulé sur la société attendue
  supabase.setClientOverrideForTests(company, db);
  return () => supabase.resetClientCacheForTests();
}

// ── Correspondances ────────────────────────────────────────────

test('sheetStatutToDb / sheetConfToDb : vocabulaire Sheets → base', () => {
  assert.equal(rdvDb.sheetStatutToDb('PLANIFIÉ'), 'pris');
  assert.equal(rdvDb.sheetStatutToDb('planifie'), 'pris');
  assert.equal(rdvDb.sheetStatutToDb('ANNULÉ'), 'annule');
  assert.equal(rdvDb.sheetStatutToDb('ANNULE'), 'annule');
  assert.equal(rdvDb.sheetStatutToDb('VENDU'), 'vendu');
  assert.equal(rdvDb.sheetStatutToDb('PAS VENU'), 'pas_venu');
  assert.equal(rdvDb.sheetStatutToDb('NO SHOW'), 'pas_venu');
  assert.equal(rdvDb.sheetStatutToDb('VENU ✓'), 'venu');
  assert.equal(rdvDb.sheetStatutToDb('S.A.V'), 'sav');
  assert.equal(rdvDb.sheetStatutToDb(''), null);
  assert.equal(rdvDb.sheetStatutToDb('n importe quoi'), null);

  assert.equal(rdvDb.sheetConfToDb('J/J'), 'jj');
  assert.equal(rdvDb.sheetConfToDb('J+1'), 'j1');
  assert.equal(rdvDb.sheetConfToDb('CONF'), 'conf');
  assert.equal(rdvDb.sheetConfToDb('NON CONF'), 'non_conf');
  assert.equal(rdvDb.sheetConfToDb(''), null);
});

test('normalizePhoneE164 : même règle que normalise_telephone (SQL)', () => {
  assert.equal(rdvDb.normalizePhoneE164('06 12 34 56 78'), '+33612345678');
  assert.equal(rdvDb.normalizePhoneE164('+33 6 12 34 56 78'), '+33612345678');
  assert.equal(rdvDb.normalizePhoneE164('0033612345678'), '+33612345678');
  assert.equal(rdvDb.normalizePhoneE164('33612345678'), '+33612345678');
  assert.equal(rdvDb.normalizePhoneE164("'0612345678"), '+33612345678');
  assert.equal(rdvDb.normalizePhoneE164('12345'), null);
  assert.equal(rdvDb.normalizePhoneE164(''), null);
});

test('splitDisplayName / normaliseLibelle / stripEmoji', () => {
  assert.deepEqual(rdvDb.splitDisplayName('🔥 Jean DUPONT'), { prenom: 'Jean', nom: 'DUPONT' });
  assert.deepEqual(rdvDb.splitDisplayName('Marie-Claire DE LA TOUR'), { prenom: 'Marie-Claire', nom: 'DE LA TOUR' });
  assert.deepEqual(rdvDb.splitDisplayName('jean dupont'), { prenom: 'jean', nom: 'dupont' });
  assert.deepEqual(rdvDb.splitDisplayName('Alfredo'), { prenom: 'Alfredo', nom: 'Alfredo' });
  assert.equal(rdvDb.normaliseLibelle('  Élodie  MARTIN-DUBOIS '), 'elodie martin dubois');
  assert.equal(rdvDb.stripEmoji('⭐ Paul ✅'), 'Paul');
});

test('buildVehicule : instantané typé, null si vide', () => {
  assert.deepEqual(rdvDb.buildVehicule({ marque: 'peugeot', modele: '208', annee: '2019', kilometrage: '45 000 km', prix: '9 500€' }),
    { marque: 'PEUGEOT', modele: '208', annee: 2019, km: 45000, prix: 9500 });
  assert.equal(rdvDb.buildVehicule({}), null);
});

// ── Actions ────────────────────────────────────────────────────

test('interrupteur coupé : aucune écriture, aucun avis', async () => {
  delete process.env.DB_WRITE_ENABLED;
  const db = fakeDb();
  const restore = stubRouting(db);
  try {
    const res = await rdvDb.onRdvCreated({ agency: { name: 'ALBI', spreadsheet_id: LICALL_SHEET, channel_id: 'c1' }, eventId: 'ev1' });
    assert.deepEqual(res, { ok: false, skipped: 'désactivé' });
    assert.equal(db.calls.length, 0);
  } finally { restore(); }
});

test('société indéterminable : pas d\'écriture, avis « Base non résolue »', async () => {
  process.env.DB_WRITE_ENABLED = 'true';
  notices.length = 0;
  const db = fakeDb();
  const restore = stubRouting(db);
  try {
    const res = await rdvDb.onRdvCreated({ agency: { name: 'MYSTERE', spreadsheet_id: 'autre', channel_id: 'c9' }, guildId: '42', eventId: 'ev1' });
    assert.equal(res.ok, false);
    assert.match(res.error, /société indéterminable/);
    assert.equal(db.calls.length, 0);
    assert.equal(notices[0].kind, 'Base non résolue');
  } finally { restore(); delete process.env.DB_WRITE_ENABLED; }
});

test('onRdvCreated : SDR créé et rattaché, client par téléphone, rdv + événement pris + journal', async () => {
  process.env.DB_WRITE_ENABLED = 'true';
  notices.length = 0;
  const db = fakeDb();
  const restore = stubRouting(db);
  try {
    const start = new Date('2026-10-20T09:00:00Z');
    const end = new Date('2026-10-20T10:00:00Z');
    const res = await rdvDb.onRdvCreated({
      agency: { name: 'ALBI', spreadsheet_id: LICALL_SHEET, channel_id: 'c1' },
      guildId: '1443725425904848959',
      actor: { discordUserId: '111', displayName: '🚗 Jean DUPONT' },
      eventId: 'evt-123', start, end, typeRdv: 'mandat',
      nomClient: 'martin', telephone: '06 12 34 56 78',
      vehicule: { marque: 'Renault', modele: 'Clio', annee: '2018', kilometrage: '80000', prix: '7000' },
      liens: 'https://x', commentaire: 'ras', confirmation: 'j1', sheetsOk: true,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.company, 'licall');
    assert.equal(res.sdr.created, true);

    const user = db.state.users[0];
    assert.equal(user.discord_user_id, '111');
    assert.equal(user.prenom, 'Jean');
    assert.equal(user.nom, 'DUPONT');
    assert.equal(user.role, 'sdr');

    const rdv = db.state.rdv[0];
    assert.equal(rdv.gcal_event_id, 'evt-123');
    assert.equal(rdv.agence_id, 'ag-1');
    assert.equal(rdv.sdr_user_id, 'u-1');
    assert.equal(rdv.personne_id, 'p-1');
    assert.equal(rdv.debut_at, start.toISOString());
    assert.equal(rdv.fin_at, end.toISOString());
    assert.equal(rdv.confirmation, 'j1');
    assert.equal(rdv.type_rdv, 'mandat');
    assert.equal(rdv.booked_by_discord_user_id, '111');
    assert.equal(rdv.prospecteur_nom_brut, 'Jean DUPONT');
    assert.deepEqual(rdv.vehicule, { marque: 'RENAULT', modele: 'CLIO', annee: 2018, km: 80000, prix: 7000 });
    assert.equal(db.state.personnes[0].telephone_e164, '+33612345678');
    assert.equal(db.state.personnes[0].nom, 'MARTIN');

    assert.deepEqual(db.state.events.map((e) => e.statut), ['pris']);
    assert.equal(db.state.journal.length, 1);
    assert.equal(db.state.journal[0].action, 'add');
    assert.equal(db.state.journal[0].db_ok, true);
    assert.equal(db.state.journal[0].sheets_ok, true);
    assert.equal(db.state.journal[0].gcal_event_id, 'evt-123');
    assert.equal(notices.some((n) => n.kind === 'SDR inconnu créé en base'), true);
  } finally { restore(); delete process.env.DB_WRITE_ENABLED; }
});

test('onRdvCreated : SDR connu par alias → identifiant Discord rattaché, pas de création', async () => {
  process.env.DB_WRITE_ENABLED = 'true';
  const db = fakeDb({ rpc: (fn) => (fn === 'resoudre_user' ? 'u-existant' : null) });
  const restore = stubRouting(db);
  try {
    const res = await rdvDb.onRdvCreated({
      agency: { name: 'ALBI', spreadsheet_id: LICALL_SHEET, channel_id: 'c1' },
      actor: { discordUserId: '222', displayName: 'Paul MARTIN' },
      eventId: 'evt-2', start: new Date(), end: new Date(), nomClient: 'x', telephone: '0611111111',
    });
    assert.equal(res.ok, true);
    assert.equal(res.sdr.created, false);
    assert.equal(res.sdr.linked, true);
    const link = db.calls.find((c) => c[0] === 'update' && c[1] === 'users');
    assert.deepEqual(link[2], { id: 'eq.u-existant', discord_user_id: 'is.null' });
    assert.equal(link[3].discord_user_id, '222');
    assert.equal(db.state.users.length, 0);
  } finally { restore(); delete process.env.DB_WRITE_ENABLED; }
});

test('onRdvStatus : RDV absent → créé à la volée puis annulé ; idempotent sur le statut', async () => {
  process.env.DB_WRITE_ENABLED = 'true';
  const db = fakeDb();
  const restore = stubRouting(db, 'kallkall');
  try {
    const ctx = {
      agency: { name: 'PARIS', spreadsheet_id: KK_SHEET, channel_id: 'c2' },
      actor: { discordUserId: '333', displayName: 'Léa' },
      eventId: 'evt-3', statut: 'annule', start: new Date('2026-11-01T10:00:00Z'), end: new Date('2026-11-01T11:00:00Z'),
      nomClient: 'durand', telephone: '0622222222', typeRdv: 'mandat',
    };
    const first = await rdvDb.onRdvStatus(ctx);
    assert.equal(first.ok, true);
    assert.equal(first.company, 'kallkall');
    assert.deepEqual(db.state.events.map((e) => e.statut), ['pris', 'annule']);
    assert.equal(db.state.users.length, 0, 'un changement de statut ne crée jamais de SDR');

    const second = await rdvDb.onRdvStatus(ctx);
    assert.equal(second.ok, true);
    assert.deepEqual(db.state.events.map((e) => e.statut), ['pris', 'annule'], 'pas de doublon');
  } finally { restore(); delete process.env.DB_WRITE_ENABLED; }
});

test('onRdvConfirmation : confirmation + confirmé par + événement confirme', async () => {
  process.env.DB_WRITE_ENABLED = 'true';
  const db = fakeDb();
  db.state.rdv.push({ id: 'rdv-9', gcal_event_id: 'evt-9' });
  const restore = stubRouting(db);
  try {
    const res = await rdvDb.onRdvConfirmation({
      agency: { name: 'ALBI', spreadsheet_id: LICALL_SHEET, channel_id: 'c1' },
      actor: { discordUserId: '444', displayName: 'Tom LEROY' },
      eventId: 'evt-9', confirmation: 'conf',
    });
    assert.equal(res.ok, true);
    const patch = db.calls.find((c) => c[0] === 'update' && c[1] === 'rdv');
    assert.equal(patch[3].confirmation, 'conf');
    assert.equal(patch[3].confirme_par_user_id, 'u-1');
    assert.ok(patch[3].confirme_at);
    assert.deepEqual(db.state.events.map((e) => e.statut), ['confirme']);
  } finally { restore(); delete process.env.DB_WRITE_ENABLED; }
});

test('onRdvModified : déplacement → statut repris, confirmation recalculée', async () => {
  process.env.DB_WRITE_ENABLED = 'true';
  const db = fakeDb();
  db.state.rdv.push({ id: 'rdv-5', gcal_event_id: 'evt-5', confirmation: 'conf' });
  db.state.events.push({ rdv_id: 'rdv-5', statut: 'pris' });
  const restore = stubRouting(db);
  try {
    const res = await rdvDb.onRdvModified({
      agency: { name: 'ALBI', spreadsheet_id: LICALL_SHEET, channel_id: 'c1' },
      actor: { discordUserId: '555', displayName: 'Ana' },
      eventId: 'evt-5', start: new Date('2026-12-01T10:00:00Z'), end: new Date('2026-12-01T11:00:00Z'),
      nomClient: 'x', telephone: '0633333333', rebook: true, confirmation: null,
    });
    assert.equal(res.ok, true);
    const row = db.state.rdv[0];
    assert.equal(row.confirmation, null);
    assert.equal(row.confirme_par_user_id, null);
    assert.equal(row.debut_at, '2026-12-01T10:00:00.000Z');
    assert.deepEqual(db.state.events.map((e) => e.statut), ['pris', 'pris']);
  } finally { restore(); delete process.env.DB_WRITE_ENABLED; }
});

test('onRdvDeleted : supprime événements puis rdv, le journal garde l\'ID', async () => {
  process.env.DB_WRITE_ENABLED = 'true';
  const db = fakeDb();
  db.state.rdv.push({ id: 'rdv-7', gcal_event_id: 'evt-7' });
  const restore = stubRouting(db);
  try {
    const res = await rdvDb.onRdvDeleted({ agency: { name: 'ALBI', spreadsheet_id: LICALL_SHEET, channel_id: 'c1' }, eventId: 'evt-7' });
    assert.equal(res.ok, true);
    const removes = db.calls.filter((c) => c[0] === 'remove').map((c) => c[1]);
    assert.deepEqual(removes, ['rdv_evenements', 'rdv']);
    assert.equal(db.state.journal[0].gcal_event_id, 'evt-7');
    assert.equal(db.state.journal[0].rdv_id, null);
  } finally { restore(); delete process.env.DB_WRITE_ENABLED; }
});

test('échec base : journal db_ok=false + avis « Base non écrite », jamais d\'exception', async () => {
  process.env.DB_WRITE_ENABLED = 'true';
  notices.length = 0;
  const db = fakeDb();
  db.upsert = async (table) => { if (table === 'rdv') throw new Error('timeout'); return null; };
  const restore = stubRouting(db);
  try {
    const res = await rdvDb.onRdvCreated({
      agency: { name: 'ALBI', spreadsheet_id: LICALL_SHEET, channel_id: 'c1' },
      actor: { discordUserId: '1', displayName: 'A B' }, eventId: 'evt-x', start: new Date(), end: new Date(), telephone: '0644444444',
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /timeout/);
    assert.equal(db.state.journal[0].db_ok, false);
    assert.match(db.state.journal[0].db_erreur, /timeout/);
    assert.equal(notices.some((n) => n.kind === 'Base non écrite'), true);
  } finally { restore(); delete process.env.DB_WRITE_ENABLED; }
});

test('syncAgencyToDb : agence trouvée par canal → mise à jour, sinon création + alias', async () => {
  process.env.DB_WRITE_ENABLED = 'true';
  const agency = { key: 'albi', name: 'ALBI', spreadsheet_id: LICALL_SHEET, channel_id: 'c1', calendar_id: 'cal@x', sheet_name: 'ALBI', max_rdv_heure: 2, paused: true, opening_hours: { 1: 'fermé' } };

  const found = fakeDb();
  let restore = stubRouting(found);
  try {
    const res = await rdvDb.syncAgencyToDb({ agency, guildId: 'g1', action: 'pause' });
    assert.equal(res.ok, true);
    const upd = found.calls.find((c) => c[0] === 'update' && c[1] === 'agences');
    assert.deepEqual(upd[2], { id: 'eq.ag-1' });
    assert.equal(upd[3].paused, true);
    assert.equal(upd[3].max_rdv_heure, 2);
    assert.equal(upd[3].discord_guild_id, 'g1');
    assert.equal(upd[3].gcal_calendar_id, 'cal@x');
    assert.equal(upd[3].actif, true);
    assert.equal(upd[3].nom, undefined, 'ne renomme jamais');
  } finally { restore(); }

  const missing = fakeDb({ select: (table) => (table === 'agences' ? [] : undefined) });
  restore = stubRouting(missing);
  try {
    const res = await rdvDb.syncAgencyToDb({ agency, guildId: 'g1', action: 'config' });
    assert.equal(res.ok, true, JSON.stringify(res));
    const ins = missing.calls.find((c) => c[0] === 'insert' && c[1] === 'agences');
    assert.equal(ins[2][0].nom, 'ALBI');
    assert.equal(ins[2][0].discord_channel_id, 'c1');
    const alias = missing.calls.find((c) => c[0] === 'upsert' && c[1] === 'agences_alias');
    assert.equal(alias[2][0].alias_norm, 'albi');
  } finally { restore(); delete process.env.DB_WRITE_ENABLED; }
});

test('linkSdr : action d\'administration, indépendante de DB_WRITE_ENABLED', async () => {
  delete process.env.DB_WRITE_ENABLED;
  const db = fakeDb({ rpc: (fn, args) => (fn === 'resoudre_user' && args.src === 'bot' ? 'u-42' : null) });
  const restore = stubRouting(db);
  try {
    const res = await rdvDb.linkSdr({ agency: { name: 'ALBI', spreadsheet_id: LICALL_SHEET, channel_id: 'c1' }, discordUserId: '777', displayName: 'Zoé', nom: 'Zoé BLANC' });
    assert.equal(res.ok, true);
    assert.equal(res.created, false);
    const link = db.calls.find((c) => c[0] === 'update' && c[1] === 'users' && c[2].id === 'eq.u-42');
    assert.equal(link[3].discord_user_id, '777');
  } finally { restore(); }
});
