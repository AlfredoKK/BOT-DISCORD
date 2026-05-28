const { getEventsInRange } = require('./calendar');
const {
  NON_COUNTING_PREFIXES,
  getLeadingStatusPrefixes,
  isCountableManagedRdvTitle,
  stripStatusPrefixes,
} = require('../utils/rdv-title');

// Simple in-memory lock to prevent race conditions on concurrent bookings
const _pendingHolds = new Map();
const RDV_DURATION_MS = 60 * 60 * 1000;

function holdKey(calendarId, dateTime) {
  return `${calendarId}:${new Date(dateTime).getTime()}`;
}

function dayRange(dateTime) {
  const start = new Date(dateTime);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

function getEventBounds(event) {
  if (event.start?.dateTime) {
    const start = new Date(event.start.dateTime);
    const end = event.end?.dateTime ? new Date(event.end.dateTime) : new Date(start.getTime() + RDV_DURATION_MS);
    return { start, end };
  }

  if (event.start?.date) {
    const start = new Date(`${event.start.date}T00:00:00`);
    const end = event.end?.date ? new Date(`${event.end.date}T00:00:00`) : new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { start, end };
  }

  return null;
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

function parsePolicyEvent(summary) {
  const normalized = normalizeText(summary);
  const hourlyMatch = normalized.match(/(\d+)\s*(?:RDV\s*)?\/\s*H\b/);
  const dailyMatch = normalized.match(/(\d+)\s*(?:RDV\s*)?\/\s*J(?:OUR)?\b/) || normalized.match(/(\d+)\s*RDV\s*MAX\s*JOUR\b/);

  return {
    normalized,
    hourlyMax: hourlyMatch ? Number(hourlyMatch[1]) : null,
    dailyMax: dailyMatch ? Number(dailyMatch[1]) : null,
    blocksSlot: /\bPAS\s+DE\s+RDV\b/.test(normalized) || /\bPLUS\s+DE\s+RDV\b/.test(normalized),
    blocksDay: /\bSTOP\s+RDV\b/.test(normalized),
    agencyClosed: /\bAGENCE\s+FERMEE?\b/.test(normalized),
  };
}

function isDayWideHourlyMarker(bounds) {
  const durationMs = bounds.end.getTime() - bounds.start.getTime();
  const startMinutes = bounds.start.getHours() * 60 + bounds.start.getMinutes();
  const endMinutes = bounds.end.getHours() * 60 + bounds.end.getMinutes();

  return !Number.isNaN(durationMs)
    && durationMs > 0
    && durationMs <= 3 * 60 * 60 * 1000
    && startMinutes < 10 * 60
    && endMinutes <= 12 * 60;
}

function isAllDayEvent(event) {
  return Boolean(event.start?.date && !event.start?.dateTime);
}

function isNonCountingRdvTitle(title) {
  const prefixes = getLeadingStatusPrefixes(title);
  return prefixes.some((prefix) => NON_COUNTING_PREFIXES.includes(prefix));
}

function isCapacityRdvTitle(title) {
  if (isCountableManagedRdvTitle(title)) return true;
  if (isNonCountingRdvTitle(title)) return false;

  const baseTitle = normalizeText(stripStatusPrefixes(title));
  return /\bRDV\b/.test(baseTitle);
}

function getPendingRdvEvents(calendarId, dayStart, dayEnd) {
  const result = [];

  for (const hold of _pendingHolds.values()) {
    if (hold.calendarId !== calendarId) continue;
    if (!overlaps(hold.start.getTime(), hold.end.getTime(), dayStart, dayEnd)) continue;

    for (let i = 0; i < hold.count; i++) {
      result.push({
        event: { id: `pending:${hold.start.getTime()}:${i}`, summary: '[pending RDV]' },
        start: hold.start,
        end: hold.end,
        pending: true,
      });
    }
  }

  return result;
}

function findHourlyCapacityBreach(events, candidateStart, candidateEnd, max) {
  const candidateStartMs = candidateStart.getTime();
  const candidateEndMs = candidateEnd.getTime();
  const relevant = events.filter(({ start, end }) =>
    overlaps(start.getTime(), end.getTime(), candidateStartMs, candidateEndMs)
  );

  if (relevant.length === 0) {
    return { breached: false, count: 0, max, events: [] };
  }

  const points = new Set([candidateStartMs, candidateEndMs]);
  for (const { start, end } of relevant) {
    points.add(Math.max(start.getTime(), candidateStartMs));
    points.add(Math.min(end.getTime(), candidateEndMs));
  }

  const sortedPoints = Array.from(points).sort((a, b) => a - b);
  let peak = { count: 0, events: [] };

  for (let i = 0; i < sortedPoints.length - 1; i++) {
    const from = sortedPoints[i];
    const to = sortedPoints[i + 1];
    if (from >= to) continue;

    const active = relevant.filter(({ start, end }) =>
      start.getTime() < to && end.getTime() > from
    );

    if (active.length > peak.count) {
      peak = { count: active.length, events: active, from, to };
    }

    if (active.length >= max) {
      return {
        breached: true,
        count: active.length,
        max,
        events: active,
        from,
        to,
      };
    }
  }

  return { breached: false, count: peak.count, max, events: peak.events };
}

/**
 * Check if a time slot is available for an agency.
 *
 * Algorithm:
 * 1. Load the whole day of calendar events
 * 2. Read marker events from the calendar (STOP RDV, PAS DE RDV, 1 RDV/H, 6 RDV/J, etc.)
 * 3. Count actual managed RDV events for the slot and the day
 * 4. Include pending in-flight bookings to avoid race conditions
 */
async function isSlotAvailable(agency, dateTime, options = {}) {
  const { excludeEventId } = options;
  const baseHourlyMax = Number.isFinite(agency.max_rdv_heure) ? agency.max_rdv_heure : 1;
  const baseDailyMax = Number.isFinite(agency.max_rdv_jour) ? agency.max_rdv_jour : null;
  const { start: queryStart, end: queryEnd } = dayRange(dateTime);

  const events = await getEventsInRange(agency.calendar_id, queryStart, queryEnd);

  // 60-min window matching event duration — any event starting before slotEnd (slotStart + 1h)
  // and ending after slotStart counts as overlapping.
  const slotStart = dateTime.getTime();
  const slotEnd = slotStart + RDV_DURATION_MS;
  const dayStart = queryStart.getTime();
  const dayEnd = queryEnd.getTime();
  let effectiveHourlyMax = baseHourlyMax;
  let effectiveDailyMax = baseDailyMax;

  const rdvEvents = [];

  for (const ev of events) {
    if (excludeEventId && ev.id === excludeEventId) continue;
    const bounds = getEventBounds(ev);
    if (!bounds) continue;

    const policy = parsePolicyEvent(ev.summary || '');
    const eventStart = bounds.start.getTime();
    const eventEnd = bounds.end.getTime();

    if (policy.blocksDay && overlaps(eventStart, eventEnd, dayStart, dayEnd)) {
      console.log(`[CAPACITY] Day blocked by policy "${ev.summary}" for ${agency.name}`);
      return {
        available: false,
        reason: `Journée bloquée par le calendrier: **${ev.summary}**`,
      };
    }

    if (policy.agencyClosed) {
      if (isAllDayEvent(ev)) {
        console.log(`[CAPACITY] Day blocked by all-day closure "${ev.summary}" for ${agency.name}`);
        return {
          available: false,
          reason: `Journée bloquée par le calendrier: **${ev.summary}**`,
        };
      }

      if (overlaps(eventStart, eventEnd, slotStart, slotEnd)) {
        console.log(`[CAPACITY] Slot blocked by closure "${ev.summary}" for ${agency.name}`);
        return {
          available: false,
          reason: `Créneau bloqué par le calendrier: **${ev.summary}**`,
        };
      }
    }

    if (policy.blocksSlot && overlaps(eventStart, eventEnd, slotStart, slotEnd)) {
      console.log(`[CAPACITY] Slot blocked by policy "${ev.summary}" for ${agency.name}`);
      return {
        available: false,
        reason: `Créneau bloqué par le calendrier: **${ev.summary}**`,
      };
    }

    const hourlyPolicyApplies = policy.hourlyMax !== null
      && (isAllDayEvent(ev) || isDayWideHourlyMarker(bounds) || overlaps(eventStart, eventEnd, slotStart, slotEnd));

    if (hourlyPolicyApplies) {
      effectiveHourlyMax = Math.min(effectiveHourlyMax, policy.hourlyMax);
    }

    if (policy.dailyMax !== null && overlaps(eventStart, eventEnd, dayStart, dayEnd)) {
      effectiveDailyMax = effectiveDailyMax === null
        ? policy.dailyMax
        : Math.min(effectiveDailyMax, policy.dailyMax);
    }

    if (
      policy.hourlyMax !== null
      || policy.dailyMax !== null
      || policy.blocksSlot
      || policy.blocksDay
      || policy.agencyClosed
    ) {
      continue;
    }

    if (isCapacityRdvTitle(ev.summary || '')) {
      rdvEvents.push({ event: ev, start: bounds.start, end: bounds.end });
    }
  }

  const pendingRdvEvents = getPendingRdvEvents(agency.calendar_id, dayStart, dayEnd);
  const capacityEvents = rdvEvents.concat(pendingRdvEvents);
  const hourlyBreach = findHourlyCapacityBreach(capacityEvents, dateTime, new Date(slotEnd), effectiveHourlyMax);

  const sameDay = capacityEvents.filter(({ start }) => {
    const ts = start.getTime();
    return ts >= dayStart && ts < dayEnd;
  });

  const calendarDayCount = rdvEvents.filter(({ start }) => {
    const ts = start.getTime();
    return ts >= dayStart && ts < dayEnd;
  }).length;
  const pendingDayCount = sameDay.length - calendarDayCount;
  const totalDayCount = sameDay.length;

  console.log(
    `[CAPACITY] ${agency.name} ${dateTime.toISOString()} -> peak ${hourlyBreach.count}/${effectiveHourlyMax} | day ${calendarDayCount}+${pendingDayCount}/${effectiveDailyMax ?? '∞'}`
  );
  for (const ev of hourlyBreach.events) {
    console.log(`  - ${ev.event.summary} (${ev.start.toISOString()} → ${ev.end.toISOString()})`);
  }

  if (effectiveDailyMax !== null && totalDayCount >= effectiveDailyMax) {
    return {
      available: false,
      count: totalDayCount,
      max: effectiveDailyMax,
      reason: `Journée complète ! (${totalDayCount}/${effectiveDailyMax} RDV max sur la journée)`,
    };
  }

  if (hourlyBreach.breached) {
    return {
      available: false,
      count: hourlyBreach.count,
      max: effectiveHourlyMax,
      reason: `Créneau complet ! (${hourlyBreach.count}/${effectiveHourlyMax} RDV déjà sur ce créneau)`,
    };
  }

  return {
    available: true,
    count: hourlyBreach.count,
    max: effectiveHourlyMax,
    dayCount: totalDayCount,
    dayMax: effectiveDailyMax,
  };
}

/**
 * Mark a slot as having a pending booking (call before creating the event).
 * Returns a release function to call after the event is created (or on error).
 */
function reserveSlot(calendarId, dateTime) {
  const key = holdKey(calendarId, dateTime);
  const existing = _pendingHolds.get(key);
  if (existing) {
    existing.count += 1;
  } else {
    const start = new Date(dateTime);
    _pendingHolds.set(key, {
      calendarId,
      start,
      end: new Date(start.getTime() + RDV_DURATION_MS),
      count: 1,
    });
  }

  // Auto-release after 30 seconds as safety net
  const timer = setTimeout(() => releaseSlot(calendarId, dateTime), 30000);

  return () => {
    clearTimeout(timer);
    releaseSlot(calendarId, dateTime);
  };
}

function releaseSlot(calendarId, dateTime) {
  const key = holdKey(calendarId, dateTime);
  const current = _pendingHolds.get(key);
  if (!current) return;

  if (current.count <= 1) {
    _pendingHolds.delete(key);
  } else {
    current.count -= 1;
  }
}

module.exports = { isSlotAvailable, reserveSlot };
