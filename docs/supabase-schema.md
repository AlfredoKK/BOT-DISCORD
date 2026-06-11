# Supabase Source Of Truth For RDV

## Goal

Replace Google Sheets as the business database without touching the bot flow yet.

The target architecture is:

- Google Calendar remains an external operational calendar
- Supabase becomes the source of truth for agencies, RDV, capacity rules, staff, and history
- Sheets becomes optional and can be replaced by views, exports, or dashboards

This repo now contains the first migration at [supabase/migrations/202605150001_initial_business_schema.sql](/Users/jeremyscatigna/discord-support/supabase/migrations/202605150001_initial_business_schema.sql:1).

## Current Reality Mapped

What exists today:

- Agencies live in [data/agencies.json](/Users/jeremyscatigna/discord-support/data/agencies.json:1)
- RDV operational rows live in Google Sheets via [src/services/sheets.js](/Users/jeremyscatigna/discord-support/src/services/sheets.js:1)
- Calendar events live in Google Calendar via [src/services/calendar.js](/Users/jeremyscatigna/discord-support/src/services/calendar.js:1)
- Capacity is derived from agency config plus policy events parsed from Calendar in [src/services/capacity.js](/Users/jeremyscatigna/discord-support/src/services/capacity.js:1)

Current Sheets columns:

- `PROSPECTEUR`
- `VEHICULE`
- `CLIENT`
- `TELEPHONE`
- `DATE`
- `HEURE`
- `CONFIRMATION`
- `STATUT`
- `EVENT_ID`
- `UPDATED_AT`
- `CONF_PAR`

Current RDV payload also contains data that never really fit in the sheet model:

- vehicle make
- vehicle model
- vehicle year
- mileage
- price
- one or more listing links
- internal comment
- Google Calendar color/status
- agency pause / opening hours / caps / temporary blocks

## Design Principles

This schema is built around a few non-negotiable rules:

- One appointment has one immutable internal ID: `appointments.id`
- One appointment also has one stable public ID: `appointments.public_id`
- Google Calendar `eventId` is only an external reference, never the primary key
- A reschedule updates the same appointment row instead of creating a clone
- Active appointments cannot overlap on the same agency/capacity lane
- Appointment duration is derived consistently from `scheduled_start_at`, `scheduled_end_at`, and `slot_minutes`
- Every important mutation can be audited in `appointment_events`
- Capacity rules are structured data, not text parsing forever
- The legacy sheet format becomes a view, not a source of truth
- Deletes are modeled with `deleted_at` plus history, not as a second appointment status

## Core Tables

### `agencies`

Source of truth for:

- agency identity
- timezone, validated against PostgreSQL/Supabase IANA timezone names
- default slot size
- default RDV duration
- default hourly capacity
- default daily capacity
- global pause state

This replaces the operational part of `agencies.json`.

### `agency_discord_channels`

Maps an agency to one or more Discord channels.

Why separate:

- future-proof if one agency gets several channels
- keeps Discord IDs out of the core agency row

### `agency_google_calendars`

Maps an agency to its Google Calendar(s).

Why separate:

- keeps calendar integration as external metadata
- lets us support primary + secondary calendars later
- avoids making a Google identifier the agency primary key

### `agency_legacy_sheet_tabs`

Pure migration metadata.

Why keep it:

- it preserves lineage from old sheet tabs
- it helps one-time imports and validation
- it avoids losing traceability during cutover

### `agency_weekly_opening_windows`

Normalized opening hours with support for multiple windows per day.

This is intentionally better than the current JSON shape because it supports:

- classic opening hours
- split days like `09:00-12:00` and `14:00-19:00`
- midday breaks without hacks

It also includes a no-overlap exclusion constraint, so two active windows cannot collide for the same agency/day.

Opening windows are intentionally same-day only. A nocturnal range such as `22:00-02:00` is out of scope for the current agency operating model and should be represented by an explicit future schema change if the business ever needs overnight hours.

### `agency_availability_rules`

Structured replacement for “policy events” like:

- `STOP RDV`
- `PAS DE RDV`
- `AGENCE FERMÉE`
- `1 RDV/H`
- `6 RDV/J`
- alternating weekly capacity rules

This table supports:

- one-off date/time windows
- recurring weekly rules
- recurring biweekly rules
- full-day closures
- slot blocks
- hourly capacity overrides
- daily capacity overrides

This is the table that should eventually replace parsing Google Calendar titles for business rules.

Rules may overlap intentionally. The `priority` column is the conflict-resolution hook: for example, a full-day default capacity can be overridden by a more specific slot block or lower-numbered priority rule. Because of that, this table does not use the same no-overlap constraint as weekly opening windows.

### `staff_members`, `staff_identities`, `agency_staff_assignments`

These tables normalize the people layer.

They let the business model:

- bot operators
- commercials
- support/admin users
- Discord identities
- Google creator emails
- staff-to-agency assignments

This is important because today:

- `PROSPECTEUR` is just a free text display name
- `CONF_PAR` is also free text
- agenda screenshots infer commercials from `event.creator.email`

Those three concepts should converge on a proper staff model.

### `appointments`

This is the main transactional table and the future source of truth.

Important choices:

- all booking-critical data is stored directly on the row
- customer and vehicle data are snapshots, so history is preserved even if the business later edits a customer or a listing elsewhere
- `version` gives optimistic concurrency control
- `public_id` is the future human/business-facing ID
- rescheduling updates `scheduled_start_at` / `scheduled_end_at` on the same row
- `scheduled_end_at` must equal `scheduled_start_at + slot_minutes`
- `capacity_lane` lets the database enforce no overlap per capacity bucket while still allowing agencies with `2/H`, `3/H`, or `4/H`
- `deleted_at` is the single soft-delete source of truth; there is no `deleted` appointment status

Fields intentionally modeled directly on the appointment:

- customer name
- raw and normalized phone
- vehicle make/model/year
- mileage
- price in cents
- primary listing URL
- internal note
- booking and confirmation actors
- status timestamps

### `appointment_links`

The current bot can carry several URLs in the description. A single `liens` string is not a robust data model.

This table supports:

- multiple links per RDV
- deduplicated URLs
- future labels or ordering

### `appointment_external_refs`

Critical table.

This is where Google Calendar event IDs, Discord message IDs, or legacy Sheets references belong.

Why this matters:

- the business bug history came from treating Google event IDs as if they were the appointment ID
- Supabase must invert that relationship
- the appointment owns the external references, not the reverse

The uniqueness is scoped by:

- provider
- kind
- parent container
- scope
- external ID

That makes it safe for:

- one calendar event per appointment
- several external refs per appointment
- legacy imports

### `appointment_events`

Audit trail for:

- creation
- update
- reschedule
- confirmation change
- status change
- import
- sync result

This is what makes the system debuggable when an ops person says:

- “who changed this?”
- “why did this RDV move?”
- “why is this status wrong?”

### `appointment_slot_holds`

This is the future replacement for the in-memory lock currently used in [src/services/capacity.js](/Users/jeremyscatigna/discord-support/src/services/capacity.js:1).

Why it exists:

- PM2 restart loses memory locks
- horizontal scaling would break in-memory locks
- Supabase needs a persistent reservation layer for race-safe booking

Active holds also use `capacity_lane`, with a GiST exclusion constraint so two in-flight bookings cannot reserve the same lane over an overlapping range.

### `integration_sync_runs`

Operational debug table for integration traffic.

Use it for:

- outbound Calendar writes
- inbound imports
- failure diagnosis
- replay/forensics

`entity_table` is constrained to known internal tables and `(entity_table, entity_id, started_at)` is indexed for debugging. Because the table is polymorphic, `entity_id` cannot be a normal single FK; the migration validates it with a trigger when present.

## Database Safety

### Double Booking

The schema uses GiST exclusion constraints for booking safety:

- `appointments_no_double_booking_per_lane`
- `appointment_slot_holds_no_overlap_per_lane`

The constraint is lane-based instead of agency-only because the business allows multiple concurrent RDV per agency when capacity is greater than one. Application code must allocate a lane inside the same transaction as the insert.

### RLS

All base tables have Row Level Security enabled.

The initial policies are explicit deny-by-default for Supabase `anon` and `authenticated` roles. This keeps the public API closed while the bot/backend uses privileged server-side credentials. Backoffice/user-facing policies should be added only once the auth-to-staff mapping is implemented.

Public views are marked `security_invoker`, so they do not bypass the underlying table RLS when exposed through Supabase APIs.

## Sheet Replacement Views

### `v_sheet_appointments_export`

This view reproduces the legacy operational list without keeping Sheets as the database.

It exposes:

- `prospecteur`
- `vehicule`
- `client`
- `telephone`
- `date`
- `heure`
- `confirmation`
- `statut`
- `event_id`
- `updated_at`
- `conf_par`

Plus:

- `agency_name`
- `public_id`
- `appointment_id`

This is the bridge that should let the business replace the sheet with:

- Supabase table editor
- a dashboard
- a CSV export
- a BI/reporting layer

### `v_agency_daily_appointment_stats`

This is the first reporting-grade replacement for sheet formulas.

It gives per day / per agency:

- total appointments
- scheduled count
- canceled count
- sold count
- no-show count
- confirmed count
- not-confirmed count
- same-day count
- next-day count

This is the right place to rebuild KPIs instead of writing formulas into raw operational rows.

## Key Invariants

These should stay true during the whole migration:

1. `appointments.id` is immutable.
2. `appointments.public_id` is the future business ID shown to humans.
3. A Google Calendar `eventId` must never be reused as the internal appointment identity.
4. A reschedule updates the same appointment row.
5. External refs can be added, replaced, or deleted without changing the appointment primary key.
6. Operational exports are derived from transactional tables.
7. Capacity rules are structured rows, not magic titles forever.
8. Soft deletion is represented by `deleted_at`, never by a separate `deleted` status.
9. Timezones must be valid IANA timezone names.
10. Public Supabase API access is denied by default via RLS.

## Recommended Migration Path

### Phase 1

Create Supabase and apply the initial migration.

No bot change yet.

Local connection helpers are available for the two Supabase projects:

```bash
npm run supabase:check -- licall
npm run supabase:migrate -- licall
npm run supabase:check -- secondary
npm run supabase:migrate -- secondary
```

The real connection strings must stay in local `.env` only:

```bash
SUPABASE_LICALL_DB_URL=postgresql://postgres:<password>@db.zvfhhcxsdzyubufmexng.supabase.co:5432/postgres
SUPABASE_SECONDARY_DB_URL=postgresql://postgres:<password>@<host>:5432/postgres
```

If you do not have the database password yet, copy
`supabase/migrations/202605150001_initial_business_schema.sql` into the Supabase dashboard SQL editor and run it there.

The current Google Sheets data can also be exported to a SQL import file for the dashboard SQL editor:

```bash
npm run supabase:export-sheets-sql
```

By default it writes `/private/tmp/discord-support-supabase-import.sql`. That file contains customer data and must not be committed.

Useful scoped runs:

```bash
npm run supabase:export-sheets-sql -- --agency villenave
npm run supabase:export-sheets-sql -- --no-calendar --limit 20
```

### Phase 2

Backfill reference data:

- agencies from `agencies.json`
- opening hours from `agencies.json`
- Google calendars from `agencies.json`
- Discord channels from `agencies.json`

### Phase 3

Import historical Sheets rows into `appointments` plus `appointment_external_refs`.

Important rule:

- imported Google `EVENT_ID` values must go into `appointment_external_refs`
- they must not become `appointments.public_id`

### Phase 4

Backfill current Google Calendar events and reconcile:

- missing events
- orphan refs
- duplicate external IDs
- invalid statuses

### Phase 5

Only then update the bot to dual-write:

- Supabase first
- Google Calendar second
- no more Sheets writes

### Phase 6

Replace Sheets reads/exports with:

- `v_sheet_appointments_export`
- dashboards on top of Supabase
- reporting views / materialized views if needed

## What This Schema Solves Immediately

- no more row-shift issues from sheet deletes
- no more “same event ID points to the wrong client” as the core identity model
- no more formulas mixed into raw ops rows
- no more inability to audit reschedules and status changes
- no more inability to model split opening windows and recurring capacity overrides cleanly
- database-level protection against lane-level double booking and overlapping holds
- no ambiguous `status='deleted'` plus `deleted_at` state

## What Stays Out Of Scope For Now

- bot code changes
- permissive RLS policy design for end users
- dashboard implementation
- live sync workers
- automated import scripts

Those are the next layer. The schema here is the base they should be built on.
