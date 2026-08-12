const { DAY_ABBREVS, formatDate, formatTime } = require('./date-utils');

const DISCORD_CONTENT_LIMIT = 1900;

function buildAgendaHeader(agencyName, weekLabel, dateRange, events, commercials) {
  return `**Agenda ${agencyName}** - ${weekLabel}\n${dateRange}\n${events.length} événement(s) | ${commercials.size} commercial(aux)`;
}

function getEventStart(event) {
  if (!event?.start?.dateTime) return null;
  const date = new Date(event.start.dateTime);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getEventEnd(event) {
  if (event?.end?.dateTime) {
    const date = new Date(event.end.dateTime);
    if (!Number.isNaN(date.getTime())) return date;
  }

  const start = getEventStart(event);
  return start ? new Date(start.getTime() + 30 * 60_000) : null;
}

function truncateLine(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function buildAgendaFallbackContent(agencyName, weekLabel, dateRange, events, commercials) {
  const sortedEvents = [...events]
    .map((event) => ({ event, start: getEventStart(event), end: getEventEnd(event) }))
    .filter((item) => item.start)
    .sort((a, b) => a.start - b.start);

  const lines = [
    buildAgendaHeader(agencyName, weekLabel, dateRange, events, commercials),
    '',
    "L'image n'a pas pu être envoyée à Discord. Version texte:",
  ];

  if (sortedEvents.length === 0) {
    lines.push('Aucun événement cette semaine.');
    return lines.join('\n');
  }

  let currentDay = '';
  let included = 0;

  for (const { event, start, end } of sortedEvents) {
    const day = `${DAY_ABBREVS[start.getDay()]} ${formatDate(start)}`;
    if (day !== currentDay) {
      currentDay = day;
      lines.push('', `**${day}**`);
    }

    const timeRange = end ? `${formatTime(start)}-${formatTime(end)}` : formatTime(start);
    const summary = truncateLine(event.summary || 'Sans titre', 110);
    const line = `- ${timeRange} ${summary}`;
    const candidate = [...lines, line].join('\n');

    if (candidate.length > DISCORD_CONTENT_LIMIT) break;

    lines.push(line);
    included += 1;
  }

  if (included < sortedEvents.length) {
    const remaining = sortedEvents.length - included;
    const suffix = `\n... ${remaining} autre(s) événement(s). Relancez /agenda pour tenter de recevoir l'image.`;
    while (lines.join('\n').length + suffix.length > DISCORD_CONTENT_LIMIT && lines.length > 4) {
      lines.pop();
    }
    lines.push(`... ${remaining} autre(s) événement(s). Relancez /agenda pour tenter de recevoir l'image.`);
  }

  return lines.join('\n');
}

module.exports = { buildAgendaFallbackContent, buildAgendaHeader };
