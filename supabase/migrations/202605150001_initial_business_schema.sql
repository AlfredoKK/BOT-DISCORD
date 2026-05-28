begin;

create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists btree_gist;

create type public.appointment_status as enum (
  'scheduled',
  'canceled',
  'sold',
  'no_show',
  'deleted'
);

create type public.appointment_confirmation_status as enum (
  'pending',
  'same_day',
  'next_day',
  'confirmed',
  'not_confirmed'
);

create type public.appointment_origin as enum (
  'discord_bot',
  'manual_ops',
  'backoffice',
  'api',
  'import_sheets',
  'import_calendar'
);

create type public.actor_source as enum (
  'system',
  'discord',
  'google',
  'manual',
  'api'
);

create type public.identity_provider as enum (
  'discord',
  'google',
  'manual',
  'api'
);

create type public.membership_role as enum (
  'founder',
  'admin',
  'manager',
  'commercial',
  'support',
  'viewer'
);

create type public.external_provider as enum (
  'google_calendar',
  'google_sheets',
  'discord',
  'supabase'
);

create type public.external_ref_kind as enum (
  'calendar_event',
  'sheet_row',
  'sheet_tab',
  'discord_channel',
  'discord_message'
);

create type public.external_sync_state as enum (
  'pending',
  'synced',
  'failed',
  'deleted',
  'stale'
);

create type public.sync_direction as enum (
  'outbound',
  'inbound'
);

create type public.sync_job_status as enum (
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped'
);

create type public.availability_rule_kind as enum (
  'closure',
  'slot_block',
  'hourly_capacity',
  'daily_capacity'
);

create type public.availability_recurrence_kind as enum (
  'none',
  'weekly',
  'biweekly'
);

create type public.appointment_event_type as enum (
  'created',
  'updated',
  'rescheduled',
  'confirmation_changed',
  'status_changed',
  'deleted',
  'link_added',
  'link_removed',
  'note_changed',
  'external_ref_added',
  'external_ref_updated',
  'external_ref_removed',
  'sync_succeeded',
  'sync_failed',
  'imported'
);

create or replace function public.normalize_phone(input text)
returns text
language sql
immutable
as $$
  select regexp_replace(coalesce(input, ''), '\D', '', 'g');
$$;

create or replace function public.handle_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.handle_updated_at_and_version()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  new.version = old.version + 1;
  return new;
end;
$$;

create table public.agencies (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null unique,
  timezone text not null default 'Europe/Paris',
  default_slot_minutes smallint not null default 30 check (default_slot_minutes in (15, 30, 60)),
  appointment_duration_minutes smallint not null default 60 check (appointment_duration_minutes > 0),
  default_hourly_capacity integer not null default 1 check (default_hourly_capacity > 0),
  default_daily_capacity integer null check (default_daily_capacity is null or default_daily_capacity > 0),
  paused boolean not null default false,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.staff_members (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  preferred_display_name text null,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.staff_identities (
  id uuid primary key default gen_random_uuid(),
  staff_member_id uuid not null references public.staff_members(id) on delete cascade,
  provider public.identity_provider not null,
  external_user_id text null,
  external_email citext null,
  external_display_name text null,
  is_primary boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint staff_identities_identity_presence_chk check (
    external_user_id is not null
    or external_email is not null
    or external_display_name is not null
  )
);

create unique index staff_identities_provider_user_idx
  on public.staff_identities(provider, external_user_id)
  where external_user_id is not null;

create unique index staff_identities_provider_email_idx
  on public.staff_identities(provider, external_email)
  where external_email is not null;

create unique index staff_identities_primary_per_provider_idx
  on public.staff_identities(staff_member_id, provider)
  where is_primary;

create table public.agency_staff_assignments (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  staff_member_id uuid not null references public.staff_members(id) on delete cascade,
  role public.membership_role not null default 'commercial',
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agency_id, staff_member_id)
);

create table public.agency_discord_channels (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  channel_id text not null unique,
  guild_id text null,
  channel_name text null,
  is_primary boolean not null default true,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index agency_discord_channels_one_primary_idx
  on public.agency_discord_channels(agency_id)
  where is_primary and is_active;

create table public.agency_google_calendars (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  calendar_id text not null unique,
  calendar_name text null,
  calendar_time_zone text null,
  is_primary boolean not null default true,
  sync_enabled boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index agency_google_calendars_one_primary_idx
  on public.agency_google_calendars(agency_id)
  where is_primary and sync_enabled;

create table public.agency_legacy_sheet_tabs (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  spreadsheet_id text not null,
  sheet_name text not null,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (spreadsheet_id, sheet_name)
);

create table public.agency_weekly_opening_windows (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  opens_at time not null,
  closes_at time not null,
  opens_minute integer generated always as (((extract(hour from opens_at)::integer * 60) + extract(minute from opens_at)::integer)) stored,
  closes_minute integer generated always as (((extract(hour from closes_at)::integer * 60) + extract(minute from closes_at)::integer)) stored,
  sort_order smallint not null default 1,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agency_weekly_opening_windows_order_chk check (opens_at < closes_at)
);

create index agency_weekly_opening_windows_agency_day_idx
  on public.agency_weekly_opening_windows(agency_id, day_of_week, sort_order)
  where is_active;

alter table public.agency_weekly_opening_windows
  add constraint agency_weekly_opening_windows_no_overlap
  exclude using gist (
    agency_id with =,
    day_of_week with =,
    int4range(opens_minute, closes_minute, '[)') with &&
  )
  where (is_active);

create table public.agency_availability_rules (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  kind public.availability_rule_kind not null,
  label text not null,
  starts_at timestamptz null,
  ends_at timestamptz null,
  applies_all_day boolean not null default false,
  local_start_time time null,
  local_end_time time null,
  day_of_week smallint null check (day_of_week is null or day_of_week between 0 and 6),
  recurrence_kind public.availability_recurrence_kind not null default 'none',
  recurrence_interval_weeks smallint not null default 1 check (recurrence_interval_weeks > 0),
  recurrence_anchor_date date null,
  valid_from date null,
  valid_until date null,
  hourly_capacity integer null check (hourly_capacity is null or hourly_capacity > 0),
  daily_capacity integer null check (daily_capacity is null or daily_capacity > 0),
  priority smallint not null default 100,
  source_provider public.external_provider not null default 'supabase',
  is_active boolean not null default true,
  external_reference jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agency_availability_rules_kind_payload_chk check (
    (kind = 'hourly_capacity' and hourly_capacity is not null and daily_capacity is null)
    or (kind = 'daily_capacity' and daily_capacity is not null and hourly_capacity is null)
    or (kind in ('closure', 'slot_block') and hourly_capacity is null and daily_capacity is null)
  ),
  constraint agency_availability_rules_shape_chk check (
    (
      recurrence_kind = 'none'
      and starts_at is not null
      and ends_at is not null
      and starts_at < ends_at
      and day_of_week is null
      and local_start_time is null
      and local_end_time is null
    )
    or
    (
      recurrence_kind <> 'none'
      and starts_at is null
      and ends_at is null
      and day_of_week is not null
      and valid_from is not null
      and (valid_until is null or valid_until >= valid_from)
      and (
        applies_all_day
        or (
          local_start_time is not null
          and local_end_time is not null
          and local_start_time < local_end_time
        )
      )
    )
  ),
  constraint agency_availability_rules_biweekly_anchor_chk check (
    recurrence_kind <> 'biweekly' or recurrence_anchor_date is not null
  )
);

create index agency_availability_rules_active_idx
  on public.agency_availability_rules(agency_id, kind, priority, recurrence_kind)
  where is_active;

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  public_id text not null unique default ('rdv_' || encode(gen_random_bytes(9), 'hex')),
  agency_id uuid not null references public.agencies(id) on delete restrict,
  status public.appointment_status not null default 'scheduled',
  confirmation_status public.appointment_confirmation_status not null default 'pending',
  booked_via public.appointment_origin not null default 'discord_bot',
  scheduled_start_at timestamptz not null,
  scheduled_end_at timestamptz not null,
  timezone text not null default 'Europe/Paris',
  slot_minutes smallint not null default 60 check (slot_minutes > 0),
  customer_name text not null,
  customer_phone_raw text not null,
  customer_phone_normalized text generated always as (public.normalize_phone(customer_phone_raw)) stored,
  vehicle_make text not null,
  vehicle_model text not null,
  vehicle_year integer not null check (vehicle_year between 1900 and 2100),
  vehicle_mileage integer not null check (vehicle_mileage >= 0),
  vehicle_price_cents bigint not null check (vehicle_price_cents >= 0),
  vehicle_price_currency text not null default 'EUR' check (char_length(vehicle_price_currency) = 3),
  primary_listing_url text null,
  internal_note text null,
  status_reason text null,
  booked_by_staff_id uuid null references public.staff_members(id) on delete set null,
  booked_by_name text null,
  confirmed_by_staff_id uuid null references public.staff_members(id) on delete set null,
  confirmed_by_name text null,
  last_modified_by_staff_id uuid null references public.staff_members(id) on delete set null,
  last_modified_by_name text null,
  canceled_at timestamptz null,
  sold_at timestamptz null,
  no_show_at timestamptz null,
  deleted_at timestamptz null,
  version integer not null default 1 check (version > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointments_time_order_chk check (scheduled_start_at < scheduled_end_at)
);

create index appointments_agency_start_idx
  on public.appointments(agency_id, scheduled_start_at desc);

create index appointments_status_start_idx
  on public.appointments(status, scheduled_start_at desc);

create index appointments_confirmation_idx
  on public.appointments(confirmation_status, scheduled_start_at desc);

create index appointments_phone_idx
  on public.appointments(customer_phone_normalized);

create index appointments_active_idx
  on public.appointments(agency_id, scheduled_start_at desc)
  where deleted_at is null;

create table public.appointment_links (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  url text not null,
  label text null,
  position smallint not null default 1 check (position > 0),
  created_by_staff_id uuid null references public.staff_members(id) on delete set null,
  created_by_name text null,
  created_at timestamptz not null default now(),
  unique (appointment_id, url)
);

create table public.appointment_external_refs (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  provider public.external_provider not null,
  kind public.external_ref_kind not null,
  external_parent_id text not null default '',
  external_scope text not null default '',
  external_id text not null,
  is_primary boolean not null default false,
  sync_state public.external_sync_state not null default 'pending',
  last_synced_at timestamptz null,
  last_error_at timestamptz null,
  last_error_message text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, kind, external_parent_id, external_scope, external_id)
);

create unique index appointment_external_refs_primary_idx
  on public.appointment_external_refs(appointment_id, provider, kind)
  where is_primary;

create index appointment_external_refs_lookup_idx
  on public.appointment_external_refs(provider, kind, external_parent_id, external_scope, external_id);

create table public.appointment_events (
  id bigint generated always as identity primary key,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  event_type public.appointment_event_type not null,
  actor_source public.actor_source not null default 'system',
  actor_staff_id uuid null references public.staff_members(id) on delete set null,
  actor_name text null,
  request_id uuid null,
  before_state jsonb not null default '{}'::jsonb,
  after_state jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index appointment_events_appointment_created_idx
  on public.appointment_events(appointment_id, created_at desc);

create table public.appointment_slot_holds (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  appointment_id uuid null references public.appointments(id) on delete set null,
  hold_start_at timestamptz not null,
  hold_end_at timestamptz not null,
  requested_by_source public.actor_source not null default 'system',
  requested_by_staff_id uuid null references public.staff_members(id) on delete set null,
  requested_by_name text null,
  expires_at timestamptz not null,
  released_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint appointment_slot_holds_time_order_chk check (hold_start_at < hold_end_at),
  constraint appointment_slot_holds_expiry_chk check (expires_at > created_at)
);

create index appointment_slot_holds_lookup_idx
  on public.appointment_slot_holds(agency_id, hold_start_at, expires_at)
  where released_at is null;

create table public.integration_sync_runs (
  id uuid primary key default gen_random_uuid(),
  provider public.external_provider not null,
  direction public.sync_direction not null,
  entity_table text not null,
  entity_id uuid null,
  external_ref_id uuid null references public.appointment_external_refs(id) on delete set null,
  action text not null,
  status public.sync_job_status not null default 'pending',
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  error_message text null,
  started_at timestamptz not null default now(),
  finished_at timestamptz null
);

create index integration_sync_runs_entity_idx
  on public.integration_sync_runs(entity_table, entity_id, started_at desc);

create index integration_sync_runs_status_idx
  on public.integration_sync_runs(status, started_at desc);

create trigger trg_agencies_updated_at
before update on public.agencies
for each row
execute function public.handle_updated_at();

create trigger trg_staff_members_updated_at
before update on public.staff_members
for each row
execute function public.handle_updated_at();

create trigger trg_staff_identities_updated_at
before update on public.staff_identities
for each row
execute function public.handle_updated_at();

create trigger trg_agency_staff_assignments_updated_at
before update on public.agency_staff_assignments
for each row
execute function public.handle_updated_at();

create trigger trg_agency_discord_channels_updated_at
before update on public.agency_discord_channels
for each row
execute function public.handle_updated_at();

create trigger trg_agency_google_calendars_updated_at
before update on public.agency_google_calendars
for each row
execute function public.handle_updated_at();

create trigger trg_agency_legacy_sheet_tabs_updated_at
before update on public.agency_legacy_sheet_tabs
for each row
execute function public.handle_updated_at();

create trigger trg_agency_weekly_opening_windows_updated_at
before update on public.agency_weekly_opening_windows
for each row
execute function public.handle_updated_at();

create trigger trg_agency_availability_rules_updated_at
before update on public.agency_availability_rules
for each row
execute function public.handle_updated_at();

create trigger trg_appointments_updated_at_version
before update on public.appointments
for each row
execute function public.handle_updated_at_and_version();

create trigger trg_appointment_external_refs_updated_at
before update on public.appointment_external_refs
for each row
execute function public.handle_updated_at();

create or replace view public.v_appointments_current as
select
  ap.id,
  ap.public_id,
  ap.agency_id,
  ag.slug as agency_slug,
  ag.name as agency_name,
  ap.status,
  ap.confirmation_status,
  ap.booked_via,
  ap.scheduled_start_at,
  ap.scheduled_end_at,
  ap.timezone,
  ap.customer_name,
  ap.customer_phone_raw,
  ap.customer_phone_normalized,
  ap.vehicle_make,
  ap.vehicle_model,
  ap.vehicle_year,
  ap.vehicle_mileage,
  ap.vehicle_price_cents,
  ap.vehicle_price_currency,
  ap.primary_listing_url,
  ap.internal_note,
  ap.booked_by_name,
  ap.confirmed_by_name,
  ap.last_modified_by_name,
  cal.external_parent_id as google_calendar_id,
  cal.external_id as google_calendar_event_id,
  ap.created_at,
  ap.updated_at,
  ap.version
from public.appointments ap
join public.agencies ag
  on ag.id = ap.agency_id
left join lateral (
  select aer.external_parent_id, aer.external_id
  from public.appointment_external_refs aer
  where aer.appointment_id = ap.id
    and aer.provider = 'google_calendar'
    and aer.kind = 'calendar_event'
    and aer.is_primary
  order by aer.created_at desc
  limit 1
) cal on true;

create or replace view public.v_sheet_appointments_export as
select
  ag.name as agency_name,
  coalesce(ap.booked_by_name, booked.full_name, '') as prospecteur,
  upper(ap.vehicle_model) as vehicule,
  upper(ap.customer_name) as client,
  ap.customer_phone_raw as telephone,
  to_char(ap.scheduled_start_at at time zone coalesce(nullif(ap.timezone, ''), ag.timezone), 'DD/MM/YYYY') as date,
  to_char(ap.scheduled_start_at at time zone coalesce(nullif(ap.timezone, ''), ag.timezone), 'HH24:MI') as heure,
  case ap.confirmation_status
    when 'same_day' then 'J/J'
    when 'next_day' then 'J+1'
    when 'confirmed' then 'CONF'
    when 'not_confirmed' then 'NON CONF'
    else ''
  end as confirmation,
  case ap.status
    when 'scheduled' then 'PLANIFIÉ'
    when 'canceled' then 'ANNULÉ'
    when 'sold' then 'VENDU'
    when 'no_show' then 'PAS VENU'
    when 'deleted' then 'SUPPRIMÉ'
  end as statut,
  cal.external_id as event_id,
  to_char(ap.updated_at at time zone coalesce(nullif(ap.timezone, ''), ag.timezone), 'DD/MM/YYYY HH24:MI:SS') as updated_at,
  coalesce(ap.confirmed_by_name, confirmed.full_name, '') as conf_par,
  ap.public_id,
  ap.id as appointment_id
from public.appointments ap
join public.agencies ag
  on ag.id = ap.agency_id
left join public.staff_members booked
  on booked.id = ap.booked_by_staff_id
left join public.staff_members confirmed
  on confirmed.id = ap.confirmed_by_staff_id
left join lateral (
  select aer.external_id
  from public.appointment_external_refs aer
  where aer.appointment_id = ap.id
    and aer.provider = 'google_calendar'
    and aer.kind = 'calendar_event'
    and aer.is_primary
  order by aer.created_at desc
  limit 1
) cal on true
where ap.deleted_at is null;

create or replace view public.v_agency_daily_appointment_stats as
select
  ap.agency_id,
  ag.slug as agency_slug,
  ag.name as agency_name,
  ((ap.scheduled_start_at at time zone coalesce(nullif(ap.timezone, ''), ag.timezone))::date) as local_service_date,
  count(*) as total_appointments,
  count(*) filter (where ap.status = 'scheduled') as scheduled_count,
  count(*) filter (where ap.status = 'canceled') as canceled_count,
  count(*) filter (where ap.status = 'sold') as sold_count,
  count(*) filter (where ap.status = 'no_show') as no_show_count,
  count(*) filter (where ap.confirmation_status = 'confirmed') as confirmed_count,
  count(*) filter (where ap.confirmation_status = 'not_confirmed') as not_confirmed_count,
  count(*) filter (where ap.confirmation_status = 'same_day') as same_day_count,
  count(*) filter (where ap.confirmation_status = 'next_day') as next_day_count
from public.appointments ap
join public.agencies ag
  on ag.id = ap.agency_id
where ap.deleted_at is null
group by
  ap.agency_id,
  ag.slug,
  ag.name,
  ((ap.scheduled_start_at at time zone coalesce(nullif(ap.timezone, ''), ag.timezone))::date);

comment on table public.appointments is 'Source of truth for one appointment. Reschedules update the same row and same internal ID; external Google IDs are references, not primary keys.';
comment on table public.appointment_external_refs is 'Maps an appointment to external systems such as Google Calendar, legacy Google Sheets, or Discord.';
comment on view public.v_sheet_appointments_export is 'Operational projection that reproduces the legacy Google Sheets list without making Sheets the source of truth.';

commit;
