const test = require('node:test');
const assert = require('node:assert/strict');

const { listAgendaAgencies, shouldAlertForFailures } = require('../src/services/scheduler');

test('listAgendaAgencies : les agences en pause reçoivent aussi l\'agenda automatique', () => {
  const agencies = {
    tours: { name: 'TOURS', channel_id: 'c1' },
    douai: { name: 'DOUAI', channel_id: 'c2', paused: true },
    albi: { name: 'ALBI', channel_id: 'c3', paused: true },
  };
  const keys = listAgendaAgencies(agencies).map(([key]) => key);
  assert.deepEqual(keys, ['tours', 'douai', 'albi'], 'la pause ne retire pas l\'agence de l\'envoi');
  assert.deepEqual(listAgendaAgencies({}), []);
  assert.deepEqual(listAgendaAgencies(undefined), []);
});

test('shouldAlertForFailures : seuil de 3 agences ou 30 %', () => {
  assert.equal(shouldAlertForFailures(0, 50), false);
  assert.equal(shouldAlertForFailures(2, 50), false);
  assert.equal(shouldAlertForFailures(3, 50), true);
  assert.equal(shouldAlertForFailures(2, 5), true);
});
