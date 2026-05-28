const assert = require('node:assert/strict');
const test = require('node:test');

const CALENDAR_ID = 'agency@example.com';

function event(id, summary, start, end) {
  return {
    id,
    summary,
    start: { dateTime: start },
    end: { dateTime: end },
  };
}

function allDayEvent(id, summary, date) {
  const end = new Date(`${date}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);

  return {
    id,
    summary,
    start: { date },
    end: { date: end.toISOString().slice(0, 10) },
  };
}

function agency(overrides = {}) {
  return {
    name: 'TEST AGENCY',
    calendar_id: CALENDAR_ID,
    max_rdv_heure: 4,
    ...overrides,
  };
}

function loadCapacity(events = []) {
  const calendarPath = require.resolve('../src/services/calendar');
  const capacityPath = require.resolve('../src/services/capacity');

  delete require.cache[capacityPath];
  delete require.cache[calendarPath];

  require.cache[calendarPath] = {
    id: calendarPath,
    filename: calendarPath,
    loaded: true,
    exports: {
      getEventsInRange: async (calendarId) => {
        assert.equal(calendarId, CALENDAR_ID);
        return events;
      },
    },
  };

  return require('../src/services/capacity');
}

test('early 07:15 2 RDV/H marker applies all day and blocks saturated 18:15 slot', async () => {
  const capacity = loadCapacity([
    event('policy', '2 RDV / H', '2026-05-26T07:15:00+02:00', '2026-05-26T08:15:00+02:00'),
    event('rdv-1', 'RDV MANDAT - A - 0600000001 - PEUGEOT - 208 - 2020 - 50000 KM - 9000EUR', '2026-05-26T18:00:00+02:00', '2026-05-26T19:00:00+02:00'),
    event('rdv-2', 'CONF - RDV MANDAT - B - 0600000002 - RENAULT - CLIO - 2021 - 40000 KM - 10000EUR', '2026-05-26T18:00:00+02:00', '2026-05-26T19:00:00+02:00'),
  ]);

  const result = await capacity.isSlotAvailable(
    agency({ max_rdv_heure: 4 }),
    new Date('2026-05-26T18:15:00+02:00')
  );

  assert.equal(result.available, false);
  assert.equal(result.count, 2);
  assert.equal(result.max, 2);
  assert.match(result.reason, /Creneau complet|Créneau complet/);
});

test('2 RDV/H blocks 18:00 when two active RDVs already start at 18:15', async () => {
  const capacity = loadCapacity([
    event('policy', '2/H', '2026-05-26T07:15:00+02:00', '2026-05-26T08:15:00+02:00'),
    event('rdv-1', 'RDV MANDAT - A - 0600000001 - PEUGEOT - 208 - 2020 - 50000 KM - 9000EUR', '2026-05-26T18:15:00+02:00', '2026-05-26T19:15:00+02:00'),
    event('rdv-2', 'J/J - RDV MANDAT - B - 0600000002 - RENAULT - CLIO - 2021 - 40000 KM - 10000EUR', '2026-05-26T18:15:00+02:00', '2026-05-26T19:15:00+02:00'),
  ]);

  const result = await capacity.isSlotAvailable(
    agency({ max_rdv_heure: 4 }),
    new Date('2026-05-26T18:00:00+02:00')
  );

  assert.equal(result.available, false);
  assert.equal(result.count, 2);
  assert.equal(result.max, 2);
});

test('timeline check allows back-to-back existing RDVs that never exceed capacity with candidate', async () => {
  const capacity = loadCapacity([
    event('rdv-1', 'RDV MANDAT - A - 0600000001 - PEUGEOT - 208 - 2020 - 50000 KM - 9000EUR', '2026-05-26T17:30:00+02:00', '2026-05-26T18:30:00+02:00'),
    event('rdv-2', 'RDV MANDAT - B - 0600000002 - RENAULT - CLIO - 2021 - 40000 KM - 10000EUR', '2026-05-26T18:30:00+02:00', '2026-05-26T19:30:00+02:00'),
  ]);

  const result = await capacity.isSlotAvailable(
    agency({ max_rdv_heure: 2 }),
    new Date('2026-05-26T18:00:00+02:00')
  );

  assert.equal(result.available, true);
  assert.equal(result.count, 1);
  assert.equal(result.max, 2);
});

test('pending holds count across overlapping starts, not only identical 30 minute slot keys', async () => {
  const capacity = loadCapacity([
    event('rdv-1', 'RDV MANDAT - A - 0600000001 - PEUGEOT - 208 - 2020 - 50000 KM - 9000EUR', '2026-05-26T18:00:00+02:00', '2026-05-26T19:00:00+02:00'),
  ]);
  const release = capacity.reserveSlot(CALENDAR_ID, new Date('2026-05-26T18:15:00+02:00'));

  try {
    const result = await capacity.isSlotAvailable(
      agency({ max_rdv_heure: 2 }),
      new Date('2026-05-26T18:30:00+02:00')
    );

    assert.equal(result.available, false);
    assert.equal(result.count, 2);
    assert.equal(result.max, 2);
  } finally {
    release();
  }
});

test('non-counting statuses do not consume hourly capacity', async () => {
  const capacity = loadCapacity([
    event('cancelled', 'ANNULE - RDV MANDAT - A - 0600000001 - PEUGEOT - 208 - 2020 - 50000 KM - 9000EUR', '2026-05-26T18:00:00+02:00', '2026-05-26T19:00:00+02:00'),
    event('sold', 'VENDU - RDV MANDAT - B - 0600000002 - RENAULT - CLIO - 2021 - 40000 KM - 10000EUR', '2026-05-26T18:00:00+02:00', '2026-05-26T19:00:00+02:00'),
    event('no-show', 'PAS VENU - RDV MANDAT - C - 0600000003 - FIAT - 500 - 2022 - 30000 KM - 11000EUR', '2026-05-26T18:00:00+02:00', '2026-05-26T19:00:00+02:00'),
  ]);

  const result = await capacity.isSlotAvailable(
    agency({ max_rdv_heure: 1 }),
    new Date('2026-05-26T18:00:00+02:00')
  );

  assert.equal(result.available, true);
  assert.equal(result.count, 0);
  assert.equal(result.max, 1);
});

test('all-day PAS DE RDV blocks the requested slot', async () => {
  const capacity = loadCapacity([
    allDayEvent('blocked', 'PAS DE RDV', '2026-05-26'),
  ]);

  const result = await capacity.isSlotAvailable(
    agency({ max_rdv_heure: 4 }),
    new Date('2026-05-26T18:00:00+02:00')
  );

  assert.equal(result.available, false);
  assert.match(result.reason, /PAS DE RDV/);
});

test('non-overlapping PAS DE RDV policy does not count as an RDV', async () => {
  const capacity = loadCapacity([
    event('blocked-lunch', 'PAS DE RDV', '2026-05-26T12:00:00+02:00', '2026-05-26T14:00:00+02:00'),
  ]);

  const result = await capacity.isSlotAvailable(
    agency({ max_rdv_heure: 1, max_rdv_jour: 1 }),
    new Date('2026-05-26T18:00:00+02:00')
  );

  assert.equal(result.available, true);
  assert.equal(result.count, 0);
  assert.equal(result.dayCount, 0);
});

test('daily max policy blocks once active RDVs reach the day limit', async () => {
  const capacity = loadCapacity([
    event('daily-policy', '2 RDV/J', '2026-05-26T07:15:00+02:00', '2026-05-26T08:15:00+02:00'),
    event('rdv-1', 'RDV MANDAT - A - 0600000001 - PEUGEOT - 208 - 2020 - 50000 KM - 9000EUR', '2026-05-26T10:00:00+02:00', '2026-05-26T11:00:00+02:00'),
    event('rdv-2', 'RDV MANDAT - B - 0600000002 - RENAULT - CLIO - 2021 - 40000 KM - 10000EUR', '2026-05-26T12:00:00+02:00', '2026-05-26T13:00:00+02:00'),
  ]);

  const result = await capacity.isSlotAvailable(
    agency({ max_rdv_heure: 4 }),
    new Date('2026-05-26T18:00:00+02:00')
  );

  assert.equal(result.available, false);
  assert.equal(result.count, 2);
  assert.equal(result.max, 2);
  assert.match(result.reason, /Journee complete|Journée complète/);
});
