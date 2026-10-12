const test = require('node:test');
const assert = require('node:assert/strict');

const imp = require('../scripts/import-history');

test('detectExtraColumns repère « Etat » et « TC » quelle que soit leur position', () => {
  const licall = ['PROSPECTEUR', 'VÉHICULE', 'NOM', 'NUMÉRO', 'DATE', 'HEURE', 'CONF', 'BOT', 'EVENT ID', 'UPDATED AT', '', 'Etat', 'TC'];
  assert.deepEqual(imp.detectExtraColumns(licall), { etat: 11, tc: 12 });
  const kk = ['PROSPECTEUR', 'VÉHICULE', 'NOM', 'NUMÉRO', 'DATE', 'HEURE', 'CONF', 'BOT', 'EVENT ID', 'UPDATED AT', 'TC', 'Etat'];
  assert.deepEqual(imp.detectExtraColumns(kk), { etat: 11, tc: 10 });
  assert.deepEqual(imp.detectExtraColumns(['PROSPECTEUR', 'VEHICULE']), { etat: -1, tc: -1 });
});

test('parseSheetRows lit Etat et TC et les expose sur chaque ligne', () => {
  const rows = [
    ['PROSPECTEUR', 'VEHICULE', 'CLIENT', 'TELEPHONE', 'DATE', 'HEURE', 'CONFIRMATION', 'STATUT', 'EVENT_ID', 'UPDATED_AT'],
    ['COLMAR'],
    ['PROSPECTEUR', 'VÉHICULE', 'NOM', 'NUMÉRO', 'DATE', 'HEURE', 'CONF', 'BOT', 'EVENT ID', 'UPDATED AT', '', 'Etat', 'TC'],
    ['🔵 Jean DUPONT', 'Clio', 'DURAND PAUL', '0612345678', '12/10/2026', '14:00', 'CONF', 'PLANIFIÉ', 'abcdefghij1234567890', '12/10/2026 10:00:00', '', 'VENU', '🟢 Marie TC'],
    ['🔵 Jean DUPONT', 'Clio', 'MOREAU LISE', '0612345679', '12/10/2026', '15:00', '', 'PLANIFIÉ', 'abcdefghij1234567891', '', '', '', ''],
  ];
  const { records, columns } = imp.parseSheetRows(rows);
  assert.deepEqual(columns, { etat: 11, tc: 12 });
  const a = records.get('abcdefghij1234567890');
  assert.equal(a.etat, 'VENU');
  assert.equal(a.tc, '🟢 Marie TC');
  assert.equal(records.get('abcdefghij1234567891').etat, '');
});

test('buildRecord : la colonne Etat prime sur STATUT, TC devient conf_par', () => {
  const agency = { key: 'colmar', name: 'COLMAR', channel_id: '123' };
  const sheetRow = { prospecteur: '🔵 Jean DUPONT', client: 'CLIENT A', telephone: '0612345678', date: '12/10/2026', heure: '14:00', confirmation: 'CONF', statut: 'PLANIFIÉ', updatedAt: '', confPar: '', etat: 'PAS VENU', tc: '🟢 Marie TC' };
  const r = imp.buildRecord('evt-1234567890', agency, sheetRow, null);
  assert.equal(r.statut, 'pas_venu');
  assert.equal(r.confPar, 'Marie TC');
  assert.equal(r.agencyName, 'COLMAR');
  const r2 = imp.buildRecord('evt-1234567891', { key: 'x', name: 'MONTPELLIER', channel_id: null }, { ...sheetRow, etat: '', statut: 'ANNULÉ' }, null);
  assert.equal(r2.statut, 'annule');
  assert.equal(r2.channelId, null);
});

test('buildRecord : téléphone Sheets illisible (#ERROR!, 9 chiffres) → repli sur Calendar / zéro rétabli', () => {
  const rdvDb = require('../src/services/rdv-db');
  assert.equal(rdvDb.normalizePhoneE164('612345678'), '+33612345678');
  assert.equal(rdvDb.normalizePhoneE164('#ERROR!'), null);
  const agency = { key: 'colmar', name: 'COLMAR', channel_id: '123' };
  const base = { prospecteur: 'Jean DUPONT', client: 'CLIENT A', date: '12/10/2026', heure: '14:00', confirmation: '', statut: '', updatedAt: '', confPar: '', etat: '', tc: '' };
  const r = imp.buildRecord('evt-1234567890', agency, { ...base, telephone: '612345678' }, null);
  assert.equal(r.telephone, '+33612345678');
  const event = { summary: 'RDV MANDAT - CLIENT A', description: '', start: { dateTime: '2026-10-12T12:00:00Z' }, end: { dateTime: '2026-10-12T13:00:00Z' } };
  const r2 = imp.buildRecord('evt-1234567891', agency, { ...base, telephone: '#ERROR!' }, event);
  assert.equal(r2.telephone, null);
});

test('parseSheetDate accepte jj/mm/aaaa et jj/mm/aa, rejette le reste', () => {
  assert.equal(imp.parseSheetDate('20/01/2026'), '2026-01-20');
  assert.equal(imp.parseSheetDate('5/3/26'), '2026-03-05');
  assert.equal(imp.parseSheetDate('-'), null);
  assert.equal(imp.parseSheetDate('lun. 3/02'), null);
  assert.equal(imp.parseSheetDate(''), null);
});

test('rosterRole : SDR / TL / RH / autres', () => {
  assert.equal(imp.rosterRole('SDR'), 'sdr');
  assert.equal(imp.rosterRole('TL'), 'tl');
  assert.equal(imp.rosterRole('Team Leader'), 'tl');
  assert.equal(imp.rosterRole('RH'), 'rh');
  assert.equal(imp.rosterRole('Stag.'), 'support');
  assert.equal(imp.rosterRole('DATA A.'), 'support');
  assert.equal(imp.rosterRole('✅ En prod'), null);
});

test('parseRosterRows : onglet SDR (état, statut, dates) et onglet ARCHIVE (ÉTAT = rôle)', () => {
  const sdrTab = [
    ['SDR', '', '', 'INFOS SDR'],
    ['NOM', 'PRÉNOM', 'ETAT', 'MAIL', 'NUMÉRO', 'STATUT', 'TL', 'AGENCE(S)', 'DATE 1ER APPEL', 'COMMENTAIRE', 'TRUE / FALSE', 'DATE STOP'],
    ['DUPONT', 'Jean', '✅ En prod', 'Jean.Dupont@Example.com', '06', 'SDR', 'LAURA', 'COLMAR', '20/01/2026', '', 'TRUE', ''],
    ['MARTIN', 'Léa', 'Abandon', 'lea@example.com', '', 'RH', '', '', '-', '', '', '03/04/2026'],
    ['', '', '', 'sans-nom@example.com'],
    ['IDOUX', '28/09/2026', '', 'p@example.com'],
  ];
  const sdr = imp.parseRosterRows(sdrTab, 1);
  assert.equal(sdr.length, 3);
  assert.equal(sdr[2].prenom, '');
  assert.deepEqual(sdr[0], { nom: 'DUPONT', prenom: 'Jean', email: 'jean.dupont@example.com', role: 'sdr', actif: true, rang: 1, date_entree: '2026-01-20', date_sortie: null });
  assert.deepEqual(sdr[1], { nom: 'MARTIN', prenom: 'Léa', email: 'lea@example.com', role: 'rh', actif: false, rang: 1, date_entree: null, date_sortie: '2026-04-03' });

  const archive = [
    ['NOM', 'PRÉNOM', 'MAIL', 'NUMÉRO', 'AGENCE', 'ÉTAT', 'Contrat Signé', 'Date début', 'Date stop'],
    ['BOUIT', 'Nicolas', 'n@example.com', '06', 'TL', 'TL', '❌', '30/11/2025', ''],
    ['BOYER', 'Fred', 'f@example.com', '06', 'ST CANNAT', 'SDR', '', '01/12/2025', '10/04/2026'],
  ];
  const arc = imp.parseRosterRows(archive, 0);
  assert.equal(arc[0].role, 'tl');
  assert.equal(arc[0].actif, false);
  assert.equal(arc[1].role, 'sdr');
  assert.equal(arc[1].date_sortie, '2026-04-10');
  assert.equal(arc[1].rang, 0);
});

test('stagingRows / sqlMerge : agence sans canal, fiche SDR et résolution par onglet', () => {
  const plan = {
    fiches: [{ nom: 'DUPONT', prenom: 'Jean', email: 'j@example.com', role: 'sdr', actif: true, rang: 1, date_entree: null, date_sortie: null }],
    sdrs: [{ alias: 'Jean DUPONT', prenom: 'Jean', nom: 'DUPONT', actif: true }],
    personnes: [['+33612345678', 'CLIENT A']],
    records: [{ eventId: 'e1', channelId: null, agencyName: 'MONTPELLIER', prospecteur: 'Jean DUPONT', telephone: '+33612345678', confPar: null, start: '2026-01-01T10:00:00.000Z', end: '2026-01-01T11:00:00.000Z', typeRdv: 'mandat', confirmation: null, liens: null, commentaire: null, adresse: null, vehicule: null, statut: 'venu', prisAt: '2026-01-01T10:00:00.000Z', resultAt: '2026-01-01T10:00:01.000Z' }],
    stats: {},
  };
  const rows = imp.stagingRows(plan, 'lot-test', false);
  assert.deepEqual(rows.map((r) => r.kind), ['fiche', 'sdr', 'personne', 'rdv']);
  assert.equal(rows[3].payload.agence, 'MONTPELLIER');
  assert.equal(rows[3].payload.channel_id, null);
  const sql = imp.sqlMerge('lot-test', false, {});
  assert.match(sql, /insert into agences \(nom, actif, sheet_onglet\)/);
  assert.match(sql, /kind = 'fiche'/);
  assert.match(sql, /normalise_libelle\(sheet_onglet\) = normalise_libelle\(v\.agence\)/);
  assert.match(sql, /delete from bot_import_staging where lot = 'lot-test'/);
});
