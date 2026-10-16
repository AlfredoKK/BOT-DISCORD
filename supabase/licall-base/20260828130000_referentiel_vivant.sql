-- ══════════════════════════════════════════════════════════════
-- Référentiel vivant — SDR et agences ajoutés / modifiés /
-- « supprimés » en permanence SANS jamais perdre la data.
--
-- Leçon des bases Sheets (KallKall & Licall) : l'identité y est un
-- NOM (onglet d'agence, "🟡 Alan MONTOYA", casse variable) — renommer
-- ou supprimer casse l'historique. Ici l'identité est un id ; les
-- noms sont des alias qui pointent dessus.
--
-- Trois garanties, appliquées PAR LA BASE (pas par la bonne volonté
-- du code) :
--   1. DELETE physiquement impossible sur users / agences / teams.
--      « Supprimer » = actif=false + date_sortie. L'historique reste.
--   2. Toute modification du référentiel est auditée (avant/après).
--   3. Les libellés externes (BOT, OnOff, BWA, onglets) sont des
--      alias : on peut en ajouter sans toucher aux données de faits.
-- ══════════════════════════════════════════════════════════════

-- ── 1. Suppression physique interdite ──────────────────────────

create or replace function interdire_delete()
returns trigger language plpgsql as $$
begin
  raise exception
    'Suppression physique interdite sur % (principe n°3 passation) : mettre actif=false',
    tg_table_name;
end;
$$;

create trigger users_no_delete    before delete on users    for each row execute function interdire_delete();
create trigger agences_no_delete  before delete on agences  for each row execute function interdire_delete();
create trigger teams_no_delete    before delete on teams    for each row execute function interdire_delete();

-- ── 2. Audit du référentiel (avant / après, automatique) ───────

create table referentiel_audit (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  row_id uuid not null,
  action text not null check (action in ('insert','update')),
  avant jsonb,
  apres jsonb,
  auteur_user_id uuid,               -- posé par l'API via set_config
  at timestamptz not null default now()
);
create index referentiel_audit_row_idx on referentiel_audit (table_name, row_id, at desc);

create or replace function auditer_referentiel()
returns trigger language plpgsql as $$
declare auteur uuid;
begin
  -- L'API serveur annonce l'auteur via :
  --   select set_config('app.auteur_user_id', '<uuid>', true);
  begin
    auteur := nullif(current_setting('app.auteur_user_id', true), '')::uuid;
  exception when others then auteur := null;
  end;
  insert into referentiel_audit (table_name, row_id, action, avant, apres, auteur_user_id)
  values (
    tg_table_name,
    coalesce(new.id, old.id),
    lower(tg_op),
    case when tg_op = 'UPDATE' then to_jsonb(old) end,
    to_jsonb(new),
    auteur
  );
  return new;
end;
$$;

create trigger users_audit   after insert or update on users   for each row execute function auditer_referentiel();
create trigger agences_audit after insert or update on agences for each row execute function auditer_referentiel();
create trigger teams_audit   after insert or update on teams   for each row execute function auditer_referentiel();

-- ── 3. Alias : les noms externes pointent vers l'id ────────────

-- Un SDR a autant d'alias que les sources ont d'orthographes :
-- "Samuelle BORDERAN", "SAMUELLE BORDERAN", "🟡 Samuelle BORDERAN"…
-- La normalisation (minuscules, sans accents/emoji) est la clé.
create extension if not exists unaccent;

create or replace function normalise_libelle(brut text)
returns text language sql stable as $$
  select trim(regexp_replace(
           lower(unaccent(coalesce(brut, ''))),
           '[^a-z0-9]+', ' ', 'g'
         ));
$$;

create table users_alias (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  alias text not null,                          -- libellé brut rencontré
  alias_norm text not null,                     -- normalise_libelle(alias)
  source text not null check (source in ('bot','onoff','sheet_kpi','manuel')),
  created_at timestamptz not null default now(),
  unique (alias_norm, source)
);
create index users_alias_user_idx on users_alias (user_id);

create table agences_alias (
  id uuid primary key default gen_random_uuid(),
  agence_id uuid not null references agences(id),
  alias text not null,                          -- "Kall Kall - VM Mulhouse", "MULHOUSE"…
  alias_norm text not null,
  source text not null check (source in ('bot','bwa','gcal','manuel')),
  created_at timestamptz not null default now(),
  unique (alias_norm, source)
);
create index agences_alias_agence_idx on agences_alias (agence_id);

-- Résolution : libellé brut → id (null si inconnu → à créer/rattacher).
create or replace function resoudre_user(brut text, src text)
returns uuid language sql stable as $$
  select user_id from users_alias
  where alias_norm = normalise_libelle(brut) and source = src
  limit 1;
$$;

create or replace function resoudre_agence(brut text, src text)
returns uuid language sql stable as $$
  select agence_id from agences_alias
  where alias_norm = normalise_libelle(brut) and source = src
  limit 1;
$$;

-- ── RLS sur les nouvelles tables ───────────────────────────────
alter table referentiel_audit enable row level security;
alter table users_alias       enable row level security;
alter table agences_alias     enable row level security;
