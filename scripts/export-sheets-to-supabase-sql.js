#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config();

const agencies = require('../data/agencies.json');
const sheets = require('../src/services/sheets');
const calendar = require('../src/services/calendar');
const { parseManagedRdvEvent } = require('../src/utils/rdv-title');

const DEFAULT_OUTPUT = '/private/tmp/discord-support-supabase-import.sql';
const DEFAULT_SPREADSHEET_ID = null;

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const parsed = {
    output: DEFAULT_OUTPUT,
    agency: null,
    spreadsheetId: DEFAULT_SPREADSHEET_ID,
    noCalendar: false,
    limit: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage(0);
    } else if (arg === '--output') {
      parsed.output = argv[++i];
    } else if (arg === '--agency') {
      parsed.agency = argv[++i];
    } else if (arg === '--spreadsheet-id') {
      parsed.spreadsheetId = argv[++i];
    } else if (arg === '--no-calendar') {
      parsed.noCalendar = true;
    } else if (arg === '--limit') {
      parsed.limit = Number(argv[++i]);
      if (!Number.isInteger(parsed.limit) || parsed.limit <= 0) usage();
    } else {
      usage();
    }
  }

  return parsed;
}

function usage(exitCode = 1) {
  console.error([
    'Usage:',
    '  node scripts/export-sheets-to-supabase-sql.js [--output /private/tmp/import.sql] [--agency villenave] [--spreadsheet-id id] [--no-calendar] [--limit n]',
    '',
    'Examples:',
    '  npm run supabase:export-sheets-sql',
    '  npm run supabase:export-sheets-sql -- --agency villenave --output /private/tmp/villenave.sql',
    '  npm run supabase:export-sheets-sql -- --no-calendar --limit 20',
  ].join('\n'));
  process.exit(exitCode);
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function uuidFrom(input) {
  const hash = crypto.createHash('sha256').update(String(input)).digest();
  hash[6] = (hash[6] & 0x0f) | 0x40;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sqlString(value) {
  if (value === null || value === undefined) return 'null';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlJson(value) {
  return `${sqlString(JSON.stringify(value))}::jsonb`;
}

function sqlBool(value) {
  return value ? 'true' : 'false';
}

function sqlInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? String(Math.trunc(number)) : String(fallback);
}

function cleanText(value) {
  return String(value || '').trim();
}

function normalizePhone(value) {
  return String(value || '').replace(/^\s*'/, '').trim();
}

function normalizeTime(value) {
  const text = cleanText(value).replace(/\s+/g, '');
  let match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (match) return { hour: Number(match[1]), minute: Number(match[2]), normalized: `${match[1].padStart(2, '0')}:${match[2]}` };

  match = text.match(/^(\d{1,2})[hH](\d{2})?$/);
  if (match) {
    const minute = match[2] ? Number(match[2]) : 0;
    return { hour: Number(match[1]), minute, normalized: `${match[1].padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
  }

  match = text.match(/^(\d{1,2})$/);
  if (match) return { hour: Number(match[1]), minute: 0, normalized: `${match[1].padStart(2, '0')}:00` };

  return null;
}

function parseSheetDateTime(dateValue, timeValue) {
  const dateMatch = cleanText(dateValue).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const time = normalizeTime(timeValue);
  if (!dateMatch || !time || time.hour > 23 || time.minute > 59) return null;

  return {
    day: Number(dateMatch[1]),
    month: Number(dateMatch[2]),
    year: Number(dateMatch[3]),
    hour: time.hour,
    minute: time.minute,
    normalizedTime: time.normalized,
  };
}

function timestamptzExpr(parts, timezone) {
  return `make_timestamptz(${parts.year}, ${parts.month}, ${parts.day}, ${parts.hour}, ${parts.minute}, 0, ${sqlString(timezone || 'Europe/Paris')})`;
}

function localMinuteKey(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function allocateCapacityLane(lanes, startKey, endKey, countable = true) {
  if (!countable) return 1;

  for (let lane = 1; lane <= lanes.length; lane++) {
    const intervals = lanes[lane - 1];
    if (!intervals.some(({ start, end }) => overlaps(start, end, startKey, endKey))) {
      intervals.push({ start: startKey, end: endKey });
      return lane;
    }
  }

  lanes.push([{ start: startKey, end: endKey }]);
  return lanes.length;
}

function mapStatus(value) {
  const text = normalizeStatus(value);
  if (text.includes('ANNULE')) return 'canceled';
  if (text.includes('VENDU')) return 'sold';
  if (text.includes('PAS VENU') || text.includes('NO SHOW')) return 'no_show';
  return 'scheduled';
}

function mapConfirmation(value) {
  const text = normalizeStatus(value);
  if (text === 'J/J') return 'same_day';
  if (text === 'J+1') return 'next_day';
  if (text === 'CONF') return 'confirmed';
  if (text === 'NON CONF') return 'not_confirmed';
  return 'pending';
}

function normalizeStatus(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
}

function parseMoneyToCents(value) {
  const digits = String(value || '').replace(/[^\d]/g, '');
  if (!digits) return 0;
  return Number(digits) * 100;
}

function parseInteger(value) {
  const digits = String(value || '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : 0;
}

function uniqueAgencies() {
  const entries = Object.entries(agencies).map(([key, cfg]) => ({ key, cfg }));
  return entries
    .filter(({ key, cfg }) => {
      if (!cfg?.spreadsheet_id || !cfg?.sheet_name) return false;
      if (args.agency && slugify(key) !== slugify(args.agency) && slugify(cfg.name) !== slugify(args.agency)) return false;
      if (args.spreadsheetId && cfg.spreadsheet_id !== args.spreadsheetId) return false;
      return true;
    })
    .sort((a, b) => a.cfg.name.localeCompare(b.cfg.name));
}

async function maybeGetCalendarEvent(agency, eventId, cache) {
  if (args.noCalendar || !eventId || !agency.calendar_id) return null;

  const key = `${agency.calendar_id}:${eventId}`;
  if (cache.has(key)) return cache.get(key);

  try {
    const cal = await calendar.getCalendarApi();
    const event = await cal.events.get({ calendarId: agency.calendar_id, eventId });
    cache.set(key, event.data);
    return event.data;
  } catch (err) {
    cache.set(key, null);
    return null;
  }
}

function openingWindowRows(agencyId, openingHours) {
  const rows = [];
  if (!openingHours) return rows;

  for (const [day, window] of Object.entries(openingHours)) {
    const text = cleanText(window).toLowerCase();
    if (!text || text === 'fermé' || text === 'ferme') continue;
    const match = text.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
    if (!match) continue;
    rows.push(`insert into public.agency_weekly_opening_windows (id, agency_id, day_of_week, opens_at, closes_at)
values (${sqlString(uuidFrom(`opening:${agencyId}:${day}:${text}`))}, ${sqlString(agencyId)}, ${sqlInt(day)}, ${sqlString(match[1])}::time, ${sqlString(match[2])}::time)
on conflict do nothing;`);
  }

  return rows;
}

async function buildSql() {
  const selectedAgencies = uniqueAgencies();
  const lines = [
    '-- Generated by scripts/export-sheets-to-supabase-sql.js',
    '-- Contains customer data from Google Sheets. Do not commit this file.',
    'begin;',
    'set local statement_timeout = 0;',
  ];
  const stats = { agencies: 0, sheetRows: 0, appointments: 0, skipped: 0, agencyReadErrors: 0, calendarEnriched: 0, warnings: 0 };
  const staffNames = new Map();
  const eventCache = new Map();

  for (const { key, cfg } of selectedAgencies) {
    const agencyId = uuidFrom(`agency:${key}:${cfg.name}`);
    stats.agencies += 1;

    lines.push(`insert into public.agencies (id, slug, name, timezone, default_slot_minutes, appointment_duration_minutes, default_hourly_capacity, paused, is_active, metadata)
values (${sqlString(agencyId)}, ${sqlString(slugify(cfg.name || key))}, ${sqlString(cfg.name || key)}, ${sqlString(cfg.timezone || 'Europe/Paris')}, ${sqlInt(cfg.granularite, 30)}, 60, ${sqlInt(cfg.max_rdv_heure, 1)}, ${sqlBool(Boolean(cfg.paused))}, true, ${sqlJson({ import_key: key })})
on conflict (id) do update set
  slug = excluded.slug,
  name = excluded.name,
  timezone = excluded.timezone,
  default_slot_minutes = excluded.default_slot_minutes,
  default_hourly_capacity = excluded.default_hourly_capacity,
  paused = excluded.paused,
  metadata = public.agencies.metadata || excluded.metadata;`);

    if (cfg.channel_id) {
      lines.push(`insert into public.agency_discord_channels (id, agency_id, channel_id, is_primary, is_active, metadata)
values (${sqlString(uuidFrom(`discord:${cfg.channel_id}`))}, ${sqlString(agencyId)}, ${sqlString(cfg.channel_id)}, true, true, ${sqlJson({ source: 'agencies.json' })})
on conflict (channel_id) do update set agency_id = excluded.agency_id, is_active = excluded.is_active;`);
    }

    if (cfg.calendar_id) {
      lines.push(`insert into public.agency_google_calendars (id, agency_id, calendar_id, is_primary, sync_enabled, metadata)
values (${sqlString(uuidFrom(`calendar:${cfg.calendar_id}`))}, ${sqlString(agencyId)}, ${sqlString(cfg.calendar_id)}, true, true, ${sqlJson({ source: 'agencies.json' })})
on conflict (calendar_id) do update set agency_id = excluded.agency_id, sync_enabled = excluded.sync_enabled;`);
    }

    if (cfg.spreadsheet_id && cfg.sheet_name) {
      lines.push(`insert into public.agency_legacy_sheet_tabs (id, agency_id, spreadsheet_id, sheet_name, is_active, metadata)
values (${sqlString(uuidFrom(`sheet-tab:${cfg.spreadsheet_id}:${cfg.sheet_name}`))}, ${sqlString(agencyId)}, ${sqlString(cfg.spreadsheet_id)}, ${sqlString(cfg.sheet_name)}, true, ${sqlJson({ source: 'agencies.json' })})
on conflict (spreadsheet_id, sheet_name) do update set agency_id = excluded.agency_id, is_active = excluded.is_active;`);
    }

    lines.push(...openingWindowRows(agencyId, cfg.opening_hours));

    let rows;
    try {
      rows = await sheets.getAllRows(cfg.spreadsheet_id, cfg.sheet_name);
    } catch (err) {
      stats.agencyReadErrors += 1;
      lines.push(`-- Skipped ${cfg.name || key}: unable to read sheet ${cfg.spreadsheet_id}/${cfg.sheet_name}: ${cleanText(err.message)}`);
      continue;
    }
    const capacityLanes = [];
    for (let i = 0; i < rows.length; i++) {
      if (args.limit && stats.appointments >= args.limit) break;

      const row = rows[i];
      const rowNumber = i + 1;
      const dateValue = row[sheets.COL.DATE];
      const timeValue = row[sheets.COL.HEURE];
      const dateTime = parseSheetDateTime(dateValue, timeValue);
      stats.sheetRows += 1;

      if (!dateTime) {
        stats.skipped += 1;
        continue;
      }

      const eventId = cleanText(row[sheets.COL.EVENT_ID]);
      const calendarEvent = await maybeGetCalendarEvent(cfg, eventId, eventCache);
      const details = calendarEvent ? parseManagedRdvEvent(calendarEvent) : {};
      if (calendarEvent) stats.calendarEnriched += 1;

      const warnings = [];
      if (!calendarEvent && eventId && !args.noCalendar) warnings.push('calendar_event_not_found');
      if (timeValue && dateTime.normalizedTime !== cleanText(timeValue)) warnings.push(`normalized_time:${timeValue}->${dateTime.normalizedTime}`);
      if (!details.marque) warnings.push('vehicle_make_missing');
      if (!details.annee) warnings.push('vehicle_year_missing');

      const prospecteur = cleanText(row[sheets.COL.PROSPECTEUR]);
      const confirmedBy = cleanText(row[sheets.COL.CONF_PAR]);
      if (prospecteur && !staffNames.has(prospecteur)) staffNames.set(prospecteur, uuidFrom(`staff:${prospecteur}`));
      if (confirmedBy && !staffNames.has(confirmedBy)) staffNames.set(confirmedBy, uuidFrom(`staff:${confirmedBy}`));

      const appointmentId = uuidFrom(`appointment:${cfg.spreadsheet_id}:${cfg.sheet_name}:${rowNumber}:${eventId}`);
      const publicId = `rdv_legacy_${crypto.createHash('sha1').update(appointmentId).digest('hex').slice(0, 14)}`;
      const startExpr = timestamptzExpr(dateTime, cfg.timezone);
      const slotMinutes = 60;
      const bookedStaffId = prospecteur ? staffNames.get(prospecteur) : null;
      const confirmedStaffId = confirmedBy ? staffNames.get(confirmedBy) : null;
      const customerName = cleanText(row[sheets.COL.CLIENT]) || details.nomClient || 'UNKNOWN';
      const phone = normalizePhone(row[sheets.COL.TELEPHONE] || details.telephone);
      const vehicleModel = cleanText(details.modele || row[sheets.COL.VEHICULE]) || 'UNKNOWN';
      const vehicleMake = cleanText(details.marque) || 'UNKNOWN';
      const vehicleYear = parseInteger(details.annee) || 1900;
      const vehicleMileage = parseInteger(details.kilometrage);
      const priceCents = parseMoneyToCents(details.prix);
      const primaryLink = cleanText(details.liens || '');
      const internalNote = cleanText(details.commentaire || '');
      const status = mapStatus(row[sheets.COL.STATUT]);
      const confirmation = mapConfirmation(row[sheets.COL.CONFIRMATION]);
      const deletedAt = null;
      const canceledAt = status === 'canceled' ? 'now()' : 'null';
      const soldAt = status === 'sold' ? 'now()' : 'null';
      const noShowAt = status === 'no_show' ? 'now()' : 'null';
      const startKey = localMinuteKey(dateTime);
      const endKey = startKey + slotMinutes * 60 * 1000;
      const capacityLane = allocateCapacityLane(capacityLanes, startKey, endKey, status !== 'canceled');
      if (capacityLane > Number(cfg.max_rdv_heure || 1)) {
        warnings.push(`capacity_lane_exceeds_config:${capacityLane}>${cfg.max_rdv_heure || 1}`);
      }
      stats.warnings += warnings.length;

      lines.push(`insert into public.appointments (
  id, public_id, agency_id, status, confirmation_status, booked_via,
  scheduled_start_at, scheduled_end_at, timezone, slot_minutes, capacity_lane,
  customer_name, customer_phone_raw, vehicle_make, vehicle_model, vehicle_year,
  vehicle_mileage, vehicle_price_cents, primary_listing_url, internal_note,
  booked_by_staff_id, booked_by_name, confirmed_by_staff_id, confirmed_by_name,
  canceled_at, sold_at, no_show_at, deleted_at, metadata
) values (
  ${sqlString(appointmentId)}, ${sqlString(publicId)}, ${sqlString(agencyId)}, ${sqlString(status)}::public.appointment_status, ${sqlString(confirmation)}::public.appointment_confirmation_status, 'import_sheets',
  ${startExpr}, ${startExpr} + interval '${slotMinutes} minutes', ${sqlString(cfg.timezone || 'Europe/Paris')}, ${slotMinutes}, ${capacityLane},
  ${sqlString(customerName)}, ${sqlString(phone || 'UNKNOWN')}, ${sqlString(vehicleMake)}, ${sqlString(vehicleModel)}, ${sqlInt(vehicleYear, 1900)},
  ${sqlInt(vehicleMileage)}, ${sqlInt(priceCents)}, ${primaryLink ? sqlString(primaryLink) : 'null'}, ${internalNote ? sqlString(internalNote) : 'null'},
  ${bookedStaffId ? sqlString(bookedStaffId) : 'null'}, ${prospecteur ? sqlString(prospecteur) : 'null'}, ${confirmedStaffId ? sqlString(confirmedStaffId) : 'null'}, ${confirmedBy ? sqlString(confirmedBy) : 'null'},
  ${canceledAt}, ${soldAt}, ${noShowAt}, ${deletedAt}, ${sqlJson({
        source: 'google_sheets_import',
        spreadsheet_id: cfg.spreadsheet_id,
        sheet_name: cfg.sheet_name,
        row_number: rowNumber,
        raw_confirmation: row[sheets.COL.CONFIRMATION] || '',
        raw_status: row[sheets.COL.STATUT] || '',
        raw_time: timeValue || '',
        warnings,
      })}
)
on conflict (id) do update set
  status = excluded.status,
  confirmation_status = excluded.confirmation_status,
  scheduled_start_at = excluded.scheduled_start_at,
  scheduled_end_at = excluded.scheduled_end_at,
  customer_name = excluded.customer_name,
  customer_phone_raw = excluded.customer_phone_raw,
  vehicle_make = excluded.vehicle_make,
  vehicle_model = excluded.vehicle_model,
  vehicle_year = excluded.vehicle_year,
  vehicle_mileage = excluded.vehicle_mileage,
  vehicle_price_cents = excluded.vehicle_price_cents,
  primary_listing_url = excluded.primary_listing_url,
  internal_note = excluded.internal_note,
  metadata = public.appointments.metadata || excluded.metadata;`);

      lines.push(`insert into public.appointment_external_refs (id, appointment_id, provider, kind, external_parent_id, external_scope, external_id, is_primary, sync_state, metadata)
values (${sqlString(uuidFrom(`sheet-row-ref:${cfg.spreadsheet_id}:${cfg.sheet_name}:${rowNumber}`))}, ${sqlString(appointmentId)}, 'google_sheets', 'sheet_row', ${sqlString(cfg.spreadsheet_id)}, ${sqlString(cfg.sheet_name)}, ${sqlString(String(rowNumber))}, true, 'synced', ${sqlJson({ source: 'google_sheets_import' })})
on conflict (provider, kind, external_parent_id, external_scope, external_id) do update set appointment_id = excluded.appointment_id, sync_state = excluded.sync_state;`);

      if (eventId) {
        lines.push(`insert into public.appointment_external_refs (id, appointment_id, provider, kind, external_parent_id, external_scope, external_id, is_primary, sync_state, metadata)
values (${sqlString(uuidFrom(`calendar-ref:${cfg.calendar_id}:${eventId}`))}, ${sqlString(appointmentId)}, 'google_calendar', 'calendar_event', ${sqlString(cfg.calendar_id || '')}, '', ${sqlString(eventId)}, true, ${calendarEvent ? "'synced'" : "'stale'"}, ${sqlJson({ source: 'google_sheets_import' })})
on conflict (provider, kind, external_parent_id, external_scope, external_id) do update set appointment_id = excluded.appointment_id, sync_state = excluded.sync_state;`);
      }

      if (primaryLink) {
        for (const [linkIndex, url] of primaryLink.split(/\s+/).filter(Boolean).entries()) {
          lines.push(`insert into public.appointment_links (id, appointment_id, url, position)
values (${sqlString(uuidFrom(`link:${appointmentId}:${url}`))}, ${sqlString(appointmentId)}, ${sqlString(url)}, ${linkIndex + 1})
on conflict (appointment_id, url) do nothing;`);
        }
      }

      lines.push(`insert into public.appointment_events (appointment_id, event_type, actor_source, actor_name, metadata)
select ${sqlString(appointmentId)}, 'imported', 'system', 'Sheets import', ${sqlJson({ spreadsheet_id: cfg.spreadsheet_id, sheet_name: cfg.sheet_name, row_number: rowNumber })}
where not exists (
  select 1
  from public.appointment_events
  where appointment_id = ${sqlString(appointmentId)}
    and event_type = 'imported'
    and metadata @> ${sqlJson({ spreadsheet_id: cfg.spreadsheet_id, sheet_name: cfg.sheet_name, row_number: rowNumber })}
);`);
      stats.appointments += 1;
    }

    if (args.limit && stats.appointments >= args.limit) break;
  }

  for (const [name, staffId] of staffNames.entries()) {
    lines.splice(4, 0, `insert into public.staff_members (id, full_name, preferred_display_name, metadata)
values (${sqlString(staffId)}, ${sqlString(name)}, ${sqlString(name)}, ${sqlJson({ source: 'google_sheets_import' })})
on conflict (id) do update set full_name = excluded.full_name, preferred_display_name = excluded.preferred_display_name;`);
  }

  lines.push('commit;');
  lines.push(`-- Stats: ${JSON.stringify(stats)}`);

  return { sql: `${lines.join('\n\n')}\n`, stats };
}

async function main() {
  const { sql, stats } = await buildSql();
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, sql);
  console.log(`Wrote ${args.output}`);
  console.log(JSON.stringify(stats, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
