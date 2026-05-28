const assert = require('node:assert/strict');
const test = require('node:test');

const { parseDateTime, formatDate, formatTime } = require('../src/utils/date-utils');

const NOW = new Date(2026, 4, 28, 12, 0, 30);

test('parseDateTime rejects dates before today', () => {
  assert.throws(
    () => parseDateTime('27/05/2026', '18:00', { now: NOW }),
    /Date\/heure dans le passé/
  );
});

test('parseDateTime rejects earlier times on the current day', () => {
  assert.throws(
    () => parseDateTime('28/05/2026', '11:59', { now: NOW }),
    /Date\/heure dans le passé/
  );
});

test('parseDateTime rejects the current minute because the slot has already started', () => {
  assert.throws(
    () => parseDateTime('28/05/2026', '12:00', { now: NOW }),
    /Date\/heure dans le passé/
  );
});

test('parseDateTime accepts future times on the current day', () => {
  const result = parseDateTime('28/05/2026', '12:01', { now: NOW });

  assert.equal(formatDate(result), '28/05/2026');
  assert.equal(formatTime(result), '12:01');
});
