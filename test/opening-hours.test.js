const assert = require('node:assert/strict');
const test = require('node:test');

const { isWithinOpeningHours } = require('../src/services/opening-hours');

test('agencies without explicit opening_hours use the default business guardrail', () => {
  const result = isWithinOpeningHours(
    { name: 'GARIDECH' },
    new Date('2026-08-12T20:00:00+02:00')
  );

  assert.equal(result.open, false);
  assert.match(result.reason, /09:00 à 19:30/);
});

test('a one-hour RDV must finish before agency closing time', () => {
  const result = isWithinOpeningHours(
    { name: 'TEST', opening_hours: { 3: '10:00-20:00' } },
    new Date('2026-08-12T20:00:00+02:00')
  );

  assert.equal(result.open, false);
  assert.match(result.reason, /10:00 à 20:00/);
});

test('custom opening_hours still allow valid slots', () => {
  const result = isWithinOpeningHours(
    { name: 'TEST', opening_hours: { 3: '10:00-20:00' } },
    new Date('2026-08-12T19:00:00+02:00')
  );

  assert.equal(result.open, true);
});
