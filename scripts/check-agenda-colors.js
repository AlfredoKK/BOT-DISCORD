#!/usr/bin/env node
// Diagnostic couleurs : liste les événements de la semaine d'une agence avec leur colorId,
// leur créateur et l'accès du bot au calendrier.
// Usage : node scripts/check-agenda-colors.js <clé agence> [S|S+1]
require('dotenv').config();

const agencies = require('../data/agencies.json');
const { getCalendarApi, getEventsInRange, getEventColorMap } = require('../src/services/calendar');
const { getWeekStartSunday, getWeekDaysSunday, formatDate, formatTime } = require('../src/utils/date-utils');

const [agencyKey, semaine = 'S'] = process.argv.slice(2);
const agency = agencies[String(agencyKey || '').toLowerCase()];
if (!agency) {
  console.error(`Agence inconnue: "${agencyKey}". Clés: ${Object.keys(agencies).join(', ')}`);
  process.exit(1);
}

(async () => {
  const cal = await getCalendarApi();
  const colorMap = await getEventColorMap();

  console.log(`\n=== ${agency.name} — calendrier ${agency.calendar_id} ===`);
  try {
    const entry = await cal.calendarList.get({ calendarId: agency.calendar_id });
    console.log(`Dans la liste du compte bot : oui | accessRole=${entry.data.accessRole} | couleur calendrier=${entry.data.backgroundColor}`);
  } catch (err) {
    console.log(`Dans la liste du compte bot : NON (${err.message}) -> les événements sans colorId seront rendus en bleu #039be5`);
  }

  const sunday = getWeekStartSunday(semaine);
  const weekEnd = new Date(getWeekDaysSunday(sunday)[6]);
  weekEnd.setHours(23, 59, 59, 999);
  const events = await getEventsInRange(agency.calendar_id, sunday, weekEnd);

  console.log(`\n${events.length} événement(s) du ${formatDate(sunday)} au ${formatDate(weekEnd)}\n`);
  const stats = { withColor: 0, withoutColor: 0, byColor: {} };
  for (const ev of events) {
    const start = ev.start?.dateTime ? new Date(ev.start.dateTime) : null;
    const when = start ? `${formatDate(start)} ${formatTime(start)}` : `${ev.start?.date || '?'} (journée)`;
    const color = ev.colorId ? `colorId=${ev.colorId} (${colorMap[ev.colorId] || '?'})` : 'colorId=ABSENT';
    if (ev.colorId) { stats.withColor += 1; stats.byColor[ev.colorId] = (stats.byColor[ev.colorId] || 0) + 1; } else stats.withoutColor += 1;
    console.log(`- ${when} | ${color} | créé par ${ev.creator?.email || '?'} | organisateur ${ev.organizer?.email || '?'} | ${String(ev.summary || '').slice(0, 60)}`);
  }
  console.log(`\nAvec colorId: ${stats.withColor} | Sans colorId: ${stats.withoutColor} | Répartition: ${JSON.stringify(stats.byColor)}`);
  console.log('Rappel : le bot crée les RDV avec colorId 10 (vert basilic) et les RDV DOM avec colorId 3 (raisin).');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
