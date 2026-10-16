const assert = require('node:assert/strict');
const test = require('node:test');

function mockModule(request, exports) {
  const resolved = require.resolve(request);
  delete require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const COL = { PROSPECTEUR: 0, VEHICULE: 1, CLIENT: 2, TELEPHONE: 3, DATE: 4, HEURE: 5, CONFIRMATION: 6, STATUT: 7, EVENT_ID: 8, UPDATED_AT: 9, CONF_PAR: 10 };
let sheetRows = [];
mockModule('../src/services/sheets', { COL, getAllRows: async () => sheetRows });
const notices = [];
mockModule('../src/services/alerts', { notifyOps: async (n) => { notices.push(n); return { sent: true }; } });

delete require.cache[require.resolve('../src/services/rdv-db')];
delete require.cache[require.resolve('../src/services/coherence')];
const coherence = require('../src/services/coherence');

function row(eventId, date, statut = 'PLANIFIÉ', conf = '') {
  const r = [];
  r[COL.EVENT_ID] = eventId; r[COL.DATE] = date; r[COL.STATUT] = statut; r[COL.CONFIRMATION] = conf; r[COL.CLIENT] = 'X';
  return r;
}

function fmt(d) {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

test('sheetRowToRecord : fenêtre de dates et correspondances', () => {
  const from = new Date(2026, 9, 5);
  const to = new Date(2026, 10, 11);
  assert.equal(coherence.sheetRowToRecord(row('abcdefghijkl', '01/10/2026'), { from, to }), null, 'hors fenêtre');
  assert.equal(coherence.sheetRowToRecord(row('court', '10/10/2026'), { from, to }), null, 'EVENT_ID invalide');
  assert.deepEqual(coherence.sheetRowToRecord(row('abcdefghijkl', '10/10/2026', 'ANNULÉ', 'CONF'), { from, to }),
    { eventId: 'abcdefghijkl', date: '2026-10-10', statut: 'annule', confirmation: 'conf' });
});

test('compareAgency : absents, écarts de statut et de confirmation, absents de Sheets', async () => {
  const today = new Date();
  const d = fmt(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2));
  sheetRows = [
    ['PROSPECTEUR', 'VEHICULE', 'CLIENT'],
    row('evt-ok-000001', d, 'PLANIFIÉ', 'CONF'),
    row('evt-statut-01', d, 'ANNULÉ', ''),
    row('evt-conf-0001', d, 'PLANIFIÉ', 'NON CONF'),
    row('evt-absent-01', d, 'PLANIFIÉ', ''),
  ];
  const db = {
    async select(table, params) {
      if (table === 'agences') return [{ id: 'ag-1' }];
      if (table === 'rdv' && params.agence_id) {
        return [
          { id: 'r1', gcal_event_id: 'evt-ok-000001', confirmation: 'conf' },
          { id: 'r2', gcal_event_id: 'evt-statut-01', confirmation: null },
          { id: 'r3', gcal_event_id: 'evt-conf-0001', confirmation: 'conf' },
          { id: 'r4', gcal_event_id: 'evt-sheetless', confirmation: null },
        ];
      }
      if (table === 'rdv') return [];
      if (table === 'v_rdv_etat') return [{ rdv_id: 'r1', statut: 'confirme' }, { rdv_id: 'r2', statut: 'pris' }, { rdv_id: 'r3', statut: 'pris' }, { rdv_id: 'r4', statut: 'pris' }];
      return [];
    },
    async rpc() { return null; },
  };
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7);
  const to = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 30);
  const r = await coherence.compareAgency(db, { name: 'ALBI', channel_id: 'c1', spreadsheet_id: 's', sheet_name: 'ALBI' }, { from, to });
  assert.equal(r.error, null);
  assert.equal(r.compared, 4);
  assert.equal(r.missingInDb, 1);
  assert.equal(r.statutDiff, 1, '« confirme » en base vaut « pris » côté Sheets ; ANNULÉ vs pris = écart');
  assert.equal(r.confDiff, 1);
  assert.equal(r.missingInSheet, 1);
  assert.equal(r.lines.length, 4);
  assert.ok(r.lines.every((l) => !l.includes('X')), 'aucun nom de client dans le rapport');
});

test('formatReport : résumé lisible par société', () => {
  const text = coherence.formatReport({
    from: '2026-10-05', to: '2026-11-11', unrouted: [],
    companies: { licall: { label: 'Licall', agencies: 3, compared: 10, missingInDb: 0, missingInSheet: 0, statutDiff: 0, confDiff: 0, errors: [], lines: [] } },
  });
  assert.match(text, /✅ \*\*Licall\*\* — 3 agence\(s\), 10 RDV comparés/);
});

test('getReportHour : défaut 22, borné', () => {
  assert.equal(coherence.getReportHour({}), 22);
  assert.equal(coherence.getReportHour({ COHERENCE_REPORT_HOUR: '7' }), 7);
  assert.equal(coherence.getReportHour({ COHERENCE_REPORT_HOUR: '99' }), 22);
});
