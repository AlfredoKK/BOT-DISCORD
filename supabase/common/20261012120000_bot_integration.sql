-- ══════════════════════════════════════════════════════════════
-- Intégration bot Discord — migration COMMUNE, appliquée à l'identique
-- sur la base Licall (zvfhhcxsdzyubufmexng) et la base Kall Kall
-- (cegswxmdpsvzqrjplcvy). Les deux bases restent totalement séparées :
-- même structure, zéro donnée partagée, zéro lien.
--
-- Pré-requis : structure du dashboard KallKall (socle + 41 migrations),
-- voir supabase/licall-base/ pour la copie appliquée à Licall.
-- Idempotente : rejouable sans effet de bord.
-- ══════════════════════════════════════════════════════════════

-- ── Agences : liaison Discord et paramètres du bot ─────────────
alter table agences
  add column if not exists discord_channel_id   text,
  add column if not exists discord_guild_id     text,
  add column if not exists spreadsheet_id       text,
  add column if not exists granularite_minutes  integer     not null default 30,
  add column if not exists timezone             text        not null default 'Europe/Paris',
  add column if not exists dom_rdv_enabled      boolean     not null default false,
  add column if not exists sync_sheets          boolean     not null default true,
  add column if not exists updated_at           timestamptz not null default now();

create unique index if not exists agences_discord_channel_uidx
  on agences (discord_channel_id) where discord_channel_id is not null;

comment on column agences.discord_channel_id  is 'Canal Discord #rdv-<agence>. Une agence = un canal, jamais partagé.';
comment on column agences.discord_guild_id    is 'Serveur Discord (Licall ou Kall Kall) qui héberge le canal.';
comment on column agences.spreadsheet_id      is 'TRANSITION : classeur Google Sheets encore écrit en double pendant la bascule. À vider ensuite.';
comment on column agences.sync_sheets         is 'TRANSITION : true = le bot écrit encore dans Sheets pour cette agence.';
comment on column agences.granularite_minutes is 'Pas des créneaux proposés (30 par défaut).';
comment on column agences.dom_rdv_enabled     is 'Autorise /rdv dom (RDV à domicile, créneau 1h30).';

-- ── Utilisateurs (SDR, TL, admins) : identité Discord ──────────
alter table users
  add column if not exists discord_user_id      text,
  add column if not exists discord_display_name text,
  add column if not exists updated_at           timestamptz not null default now();

create unique index if not exists users_discord_user_uidx
  on users (discord_user_id) where discord_user_id is not null;

comment on column users.discord_user_id      is 'Identifiant Discord (snowflake). Rattachement automatique au premier RDV posé, validé par un TL si inconnu.';
comment on column users.discord_display_name is 'Dernier pseudo Discord vu, informatif.';

-- ── RDV : ce que le Sheet ne portait pas proprement ────────────
alter table rdv
  add column if not exists fin_at                    timestamptz,
  add column if not exists type_rdv                  text        not null default 'mandat',
  add column if not exists confirmation              text,
  add column if not exists confirme_par_user_id      uuid references users(id),
  add column if not exists confirme_at               timestamptz,
  add column if not exists commentaire               text,
  add column if not exists liens                     text,
  add column if not exists adresse_dom               text,
  add column if not exists vehicule                  jsonb,
  add column if not exists prospecteur_nom_brut      text,
  add column if not exists booked_by_discord_user_id text,
  add column if not exists updated_at                timestamptz not null default now();

alter table rdv drop constraint if exists rdv_type_rdv_chk;
alter table rdv add constraint rdv_type_rdv_chk
  check (type_rdv in ('mandat', 'mandat_dom'));

alter table rdv drop constraint if exists rdv_confirmation_chk;
alter table rdv add constraint rdv_confirmation_chk
  check (confirmation is null or confirmation in ('jj', 'j1', 'conf', 'non_conf'));

comment on column rdv.confirmation         is 'J/J = jj, J+1 = j1, CONF = conf, NON CONF = non_conf. Distinct du statut (journal rdv_evenements).';
comment on column rdv.vehicule             is 'Instantané saisi par le SDR : {marque, modele, annee, km, prix}. L''annonce liée (annonce_id) reste la référence quand elle existe.';
comment on column rdv.prospecteur_nom_brut is 'Nom affiché Discord au moment de la prise, conservé même si sdr_user_id est résolu plus tard.';
comment on column rdv.type_rdv             is 'mandat = en agence (1h) ; mandat_dom = à domicile (1h30, -15/+15 min).';

-- ── updated_at automatique ─────────────────────────────────────
create or replace function bot_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_agences_updated_at on agences;
create trigger trg_agences_updated_at before update on agences
  for each row execute function bot_touch_updated_at();

drop trigger if exists trg_users_updated_at on users;
create trigger trg_users_updated_at before update on users
  for each row execute function bot_touch_updated_at();

drop trigger if exists trg_rdv_updated_at on rdv;
create trigger trg_rdv_updated_at before update on rdv
  for each row execute function bot_touch_updated_at();

-- ── Journal des écritures du bot (double écriture + rapprochement) ──
create table if not exists bot_journal (
  id                 uuid primary key default gen_random_uuid(),
  at                 timestamptz not null default now(),
  action             text not null,          -- add, dom, modifier, annuler, vendu, conf, supprimer, config, pause, play, horaires, rattrapage
  agence_id          uuid references agences(id),
  rdv_id             uuid references rdv(id),
  gcal_event_id      text,
  discord_user_id    text,
  discord_channel_id text,
  sheets_ok          boolean,
  sheets_erreur      text,
  db_ok              boolean,
  db_erreur          text,
  details            jsonb not null default '{}'::jsonb
);
create index if not exists bot_journal_at_idx    on bot_journal (at desc);
create index if not exists bot_journal_event_idx on bot_journal (gcal_event_id);
create index if not exists bot_journal_rdv_idx   on bot_journal (rdv_id);
alter table bot_journal enable row level security;   -- aucune policy : seul le service_role écrit/lit
comment on table bot_journal is 'Trace de chaque action du bot : résultat Sheets et résultat base, pour le rapport de cohérence quotidien pendant la transition, puis l''audit.';

-- ── Vue d''export au format de l''ancien Sheet ──────────────────
-- Remplace définitivement l''onglet par agence : mêmes colonnes, mêmes libellés.
create or replace view v_export_sheet as
select
  coalesce(nullif(trim(u.prenom || ' ' || u.nom), ''), r.prospecteur_nom_brut) as prospecteur,
  r.vehicule ->> 'modele'                                                       as vehicule,
  p.nom                                                                         as client,
  p.telephone_e164                                                              as telephone,
  to_char(r.debut_at at time zone coalesce(a.timezone, 'Europe/Paris'), 'DD/MM/YYYY') as date,
  to_char(r.debut_at at time zone coalesce(a.timezone, 'Europe/Paris'), 'HH24:MI')    as heure,
  case r.confirmation
    when 'jj' then 'J/J' when 'j1' then 'J+1' when 'conf' then 'CONF' when 'non_conf' then 'NON CONF'
  end                                                                           as confirmation,
  case e.statut
    when 'pris'     then 'PLANIFIÉ'
    when 'confirme' then 'PLANIFIÉ'
    when 'annule'   then 'ANNULÉ'
    when 'vendu'    then 'VENDU'
    when 'pas_venu' then 'PAS VENU'
    when 'venu'     then 'VENU'
    when 'sav'      then 'SAV'
    else upper(coalesce(e.statut, 'PLANIFIÉ'))
  end                                                                           as statut,
  r.gcal_event_id                                                               as event_id,
  to_char(r.updated_at at time zone coalesce(a.timezone, 'Europe/Paris'), 'DD/MM/YYYY HH24:MI:SS') as updated_at,
  nullif(trim(cu.prenom || ' ' || cu.nom), '')                                  as conf_par,
  a.nom                                                                         as agence,
  r.type_rdv,
  r.id                                                                          as rdv_id
from rdv r
join agences a         on a.id  = r.agence_id
left join personnes p  on p.id  = r.personne_id
left join users u      on u.id  = r.sdr_user_id
left join users cu     on cu.id = r.confirme_par_user_id
left join v_rdv_etat e on e.rdv_id = r.id;

comment on view v_export_sheet is 'Export au format historique du Sheet (PROSPECTEUR, VEHICULE, CLIENT, TELEPHONE, DATE, HEURE, CONFIRMATION, STATUT, EVENT_ID, UPDATED_AT, CONF_PAR) + agence.';
alter view v_export_sheet set (security_invoker = true);

-- ── referentiel_ecrire : les nouvelles colonnes deviennent éditables ──
-- depuis l''écran « Gestion des agences » du dashboard (même corps que
-- la version 20260904100000 + colonnes bot ; search_path figé conservé).
create or replace function referentiel_ecrire(
  p_auteur uuid,
  p_table text,
  p_id uuid,
  p_donnees jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  allowed text[];
  cols text[];
  collist text;
  sellist text;
  v_id uuid;
begin
  if p_table = 'users' then
    allowed := array['nom','prenom','email','role','team_id','actif',
                     'date_entree','date_sortie','onoff_user_id','bot_booker_name',
                     'agence_ids','discord_user_id','discord_display_name'];
  elsif p_table = 'agences' then
    allowed := array['nom','actif','tarif_rdv_honore','gcal_calendar_id','contact','bwa_team_id',
                     'max_rdv_heure','opening_hours','sheet_onglet','paused','secteur_cp',
                     'bwa_ingest','discord_channel_id','discord_guild_id','spreadsheet_id',
                     'granularite_minutes','timezone','dom_rdv_enabled','sync_sheets'];
  elsif p_table = 'teams' then
    allowed := array['nom','tl_user_id'];
  else
    raise exception 'table non autorisée : %', p_table;
  end if;
  perform set_config('app.auteur_user_id', coalesce(p_auteur::text, ''), true);
  select array_agg(k) into cols
  from jsonb_object_keys(p_donnees) k
  where k = any(allowed);
  if cols is null then
    raise exception 'aucune colonne autorisée dans %', p_donnees::text;
  end if;
  collist := (select string_agg(quote_ident(c), ', ') from unnest(cols) c);
  sellist := (select string_agg('r.' || quote_ident(c), ', ') from unnest(cols) c);
  if p_id is null then
    execute format(
      'insert into %I (%s) select %s from jsonb_populate_record(null::%I, $1) r returning id',
      p_table, collist, sellist, p_table
    ) into v_id using p_donnees;
  else
    execute format(
      'update %I set (%s) = (select %s from jsonb_populate_record(null::%I, $1) r) where id = $2 returning id',
      p_table, collist, sellist, p_table
    ) into v_id using p_donnees, p_id;
    if v_id is null then
      raise exception 'ligne introuvable : %.%', p_table, p_id;
    end if;
  end if;
  return v_id;
end;
$$;
