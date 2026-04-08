const { getEventsInRange } = require('./calendar');

// Simple in-memory lock to prevent race conditions on concurrent bookings
const _pendingSlots = new Map();

function slotKey(calendarId, dateTime) {
  const d = new Date(dateTime);
  return `${calendarId}:${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${Math.floor(d.getMinutes() / 30)}`;
}

/**
 * Check if a time slot is available for an agency.
 *
 * Algorithm:
 * 1. Query events for a range covering the requested slot
 * 2. Count events that truly overlap with the 30-min slot [slotStart, slotStart+30min]
 *    - An event overlaps if: eventStart < slotEnd AND eventEnd > slotStart
 *    - Events ending exactly at slotStart do NOT overlap (back-to-back is fine)
 * 3. Also count pending (in-flight) bookings for the same slot
 * 4. If count >= max_rdv_heure → slot is full
 */
async function isSlotAvailable(calendarId, dateTime, maxRdvHeure) {
  // Query the full hour containing the slot (+ 1 hour margin for safety)
  const queryStart = new Date(dateTime);
  queryStart.setMinutes(0, 0, 0);
  const queryEnd = new Date(queryStart);
  queryEnd.setHours(queryEnd.getHours() + 2);

  const events = await getEventsInRange(calendarId, queryStart, queryEnd);

  // The 30-min slot we're checking
  const slotStart = dateTime.getTime();
  const slotEnd = slotStart + 30 * 60 * 1000;

  // Count ONLY RDV events that genuinely overlap with our 30-min slot.
  // Non-RDV events (absences, notes, CT, livraisons, etc.) do NOT count toward capacity.
  // Cancelled/vendu/no-show RDV events are also excluded.
  const overlapping = events.filter((ev) => {
    if (!ev.start || !ev.start.dateTime) return false;
    const title = (ev.summary || '').toUpperCase();

    // Only count events that look like RDV (created by the bot)
    const isRdv = title.includes('RDV MANDAT') || title.includes('RDV ') || title.startsWith('CONF ') || title.startsWith('NON CONF ');
    if (!isRdv) return false;

    // Exclude cancelled/vendu/no-show
    if (title.startsWith('ANNULÉ') || title.startsWith('ANNULE') ||
        title.startsWith('PAS VENU') || title.startsWith('NO SHOW') ||
        title.startsWith('VENDU')) return false;

    const evStart = new Date(ev.start.dateTime).getTime();
    const evEnd = ev.end && ev.end.dateTime
      ? new Date(ev.end.dateTime).getTime()
      : evStart + 30 * 60 * 1000;
    return evStart < slotEnd && evEnd > slotStart;
  });

  // Add pending concurrent bookings for the same slot
  const key = slotKey(calendarId, dateTime);
  const pending = _pendingSlots.get(key) || 0;
  const totalCount = overlapping.length + pending;

  console.log(`[CAPACITY] Slot ${dateTime.toISOString()} → ${overlapping.length} calendar + ${pending} pending = ${totalCount}/${maxRdvHeure}`);
  for (const ev of overlapping) {
    console.log(`  - ${ev.summary} (${ev.start.dateTime} → ${ev.end?.dateTime})`);
  }

  if (totalCount >= maxRdvHeure) {
    return { available: false, count: totalCount, max: maxRdvHeure };
  }

  return { available: true, count: totalCount, max: maxRdvHeure };
}

/**
 * Mark a slot as having a pending booking (call before creating the event).
 * Returns a release function to call after the event is created (or on error).
 */
function reserveSlot(calendarId, dateTime) {
  const key = slotKey(calendarId, dateTime);
  _pendingSlots.set(key, (_pendingSlots.get(key) || 0) + 1);

  // Auto-release after 30 seconds as safety net
  const timer = setTimeout(() => releaseSlot(calendarId, dateTime), 30000);

  return () => {
    clearTimeout(timer);
    releaseSlot(calendarId, dateTime);
  };
}

function releaseSlot(calendarId, dateTime) {
  const key = slotKey(calendarId, dateTime);
  const current = _pendingSlots.get(key) || 0;
  if (current <= 1) {
    _pendingSlots.delete(key);
  } else {
    _pendingSlots.set(key, current - 1);
  }
}

module.exports = { isSlotAvailable, reserveSlot };
