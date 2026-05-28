const { google } = require('googleapis');
const { getOAuth2Client } = require('./google-auth');

const EVENT_COLORS = {
  green: '10',   // Vert Basilic — RDV MANDAT
  red: '11',     // Tomate — ANNULÉ
  orange: '6',   // Mandarine — VENDU
  gray: '8',     // Graphite — PAS VENU
  grape: '3',    // Violet Raisin — RDV MANDAT DOM
};

async function getCalendarApi() {
  return google.calendar({ version: 'v3', auth: getOAuth2Client() });
}

async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      const delay = Math.pow(2, i) * 1000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function listCalendars() {
  const cal = await getCalendarApi();
  const res = await withRetry(() => cal.calendarList.list());
  return res.data.items.map((c) => ({
    id: c.id,
    name: c.summary,
  }));
}

async function getEventsInRange(calendarId, timeMin, timeMax) {
  const cal = await getCalendarApi();
  const res = await withRetry(() =>
    cal.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 2500,
    })
  );
  return res.data.items || [];
}

async function createEvent(calendarId, { summary, description, start, end, colorId }) {
  const cal = await getCalendarApi();
  const body = {
    summary,
    start: { dateTime: start.toISOString(), timeZone: 'Europe/Paris' },
    end: { dateTime: end.toISOString(), timeZone: 'Europe/Paris' },
    colorId: colorId || EVENT_COLORS.green,
  };
  if (description) body.description = description;
  return withRetry(() =>
    cal.events.insert({
      calendarId,
      requestBody: body,
    })
  );
}

async function updateEvent(calendarId, eventId, updates) {
  const cal = await getCalendarApi();
  return withRetry(() =>
    cal.events.patch({
      calendarId,
      eventId,
      requestBody: updates,
    })
  );
}

async function deleteEvent(calendarId, eventId) {
  const cal = await getCalendarApi();
  return withRetry(() =>
    cal.events.delete({
      calendarId,
      eventId,
    })
  );
}

// Cache for calendar colors (fetched once from API)
let _colorCache = null;

async function getEventColorMap() {
  if (_colorCache) return _colorCache;
  try {
    const cal = await getCalendarApi();
    const res = await withRetry(() => cal.colors.get());
    const eventColors = res.data.event || {};
    _colorCache = {};
    for (const [id, colors] of Object.entries(eventColors)) {
      _colorCache[id] = colors.background;
    }
    console.log('[COLORS] Fetched from API:', _colorCache);
    return _colorCache;
  } catch (err) {
    console.error('[COLORS] Failed to fetch, using fallback:', err.message);
    // Fallback to known Google Calendar colors
    _colorCache = {
      '1': '#a4bdfc', '2': '#7ae7bf', '3': '#dbadff', '4': '#ff887c',
      '5': '#fbd75b', '6': '#ffb878', '7': '#46d6db', '8': '#e1e1e1',
      '9': '#5484ed', '10': '#51b749', '11': '#dc2127',
    };
    return _colorCache;
  }
}

// Get the default color for a specific calendar
async function getCalendarDefaultColor(calendarId) {
  try {
    const cal = await getCalendarApi();
    const res = await withRetry(() => cal.calendarList.get({ calendarId }));
    return res.data.backgroundColor || null;
  } catch (err) {
    return null;
  }
}

async function findEventByClient(calendarId, clientName, date) {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  const events = await getEventsInRange(calendarId, dayStart, dayEnd);
  return events.find((e) =>
    e.summary && e.summary.toLowerCase().includes(clientName.toLowerCase())
  );
}

async function findEventByClientName(calendarId, clientName) {
  // Search in a wide range (past 30 days to future 60 days)
  const timeMin = new Date();
  timeMin.setDate(timeMin.getDate() - 30);
  const timeMax = new Date();
  timeMax.setDate(timeMax.getDate() + 60);

  const events = await getEventsInRange(calendarId, timeMin, timeMax);
  return events.find((e) =>
    e.summary && e.summary.toLowerCase().includes(clientName.toLowerCase())
  );
}

module.exports = {
  EVENT_COLORS,
  getCalendarApi,
  listCalendars,
  getEventsInRange,
  createEvent,
  updateEvent,
  deleteEvent,
  findEventByClient,
  findEventByClientName,
  getEventColorMap,
  getCalendarDefaultColor,
};
