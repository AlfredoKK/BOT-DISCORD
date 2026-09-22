const assert = require('node:assert/strict');
const test = require('node:test');
const { findAgencyConflicts } = require('../src/services/agency-check');

const agencies = {
  'poitiers - weecars': { name: 'POITIERS - WEECARS', calendar_id: 'thomas@weecars.fr', spreadsheet_id: 'LICALL', sheet_name: 'POITIERS - WEECARS', channel_id: '1' },
  poitiers: { name: 'POITIERS', calendar_id: 'poitiers@vroommarket.fr', spreadsheet_id: 'KALLKALL', sheet_name: 'POITIERS', channel_id: '2' },
};

test('a new agency reusing another agency calendar or sheet tab is flagged', () => {
  const conflicts = findAgencyConflicts(agencies, 'nouvelle', {
    calendar_id: 'thomas@weecars.fr', spreadsheet_id: 'KALLKALL', sheet_name: 'POITIERS', channel_id: '3',
  });
  assert.deepEqual(conflicts.map((c) => [c.type, c.with]), [
    ['calendrier', 'POITIERS - WEECARS'],
    ['onglet', 'POITIERS'],
  ]);
});

test('reconfiguring the same agency key is not a conflict with itself', () => {
  const conflicts = findAgencyConflicts(agencies, 'poitiers', agencies.poitiers);
  assert.deepEqual(conflicts, []);
});

test('same channel id on another key is reported as a channel conflict', () => {
  const conflicts = findAgencyConflicts(agencies, 'paris', { calendar_id: 'x', spreadsheet_id: 'y', sheet_name: 'z', channel_id: '2' });
  assert.deepEqual(conflicts.map((c) => c.type), ['canal']);
});
