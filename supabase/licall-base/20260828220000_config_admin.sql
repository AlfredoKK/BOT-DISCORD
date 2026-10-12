-- ══════════════════════════════════════════════════════════════
-- Configuration par les admins (décision CEO 28/08) :
--   1. La whitelist de referentiel_ecrire() s'élargit aux colonnes
--      de config des agences : fermer le booking (paused), capacité
--      (max_rdv_heure), horaires, onglet sheet — tout passe par
--      l'API auditée, écrit directement dans Supabase.
--   2. Créer un user crée AUTOMATIQUEMENT son alias « Prénom NOM »
--      (source manuel) : sans lui, le compte ne se résout nulle part
--      (chat, notifications, audit, board).
-- ══════════════════════════════════════════════════════════════

create or replace function referentiel_ecrire(
  p_auteur uuid,
  p_table text,
  p_id uuid,
  p_donnees jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
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
                     'date_entree','date_sortie','onoff_user_id','bot_booker_name'];
  elsif p_table = 'agences' then
    allowed := array['nom','actif','tarif_rdv_honore','gcal_calendar_id','contact','bwa_team_id',
                     'max_rdv_heure','opening_hours','sheet_onglet','paused'];
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

-- Alias automatique à la création d'un user (rien si déjà présent).
create or replace function users_alias_auto()
returns trigger language plpgsql as $$
begin
  insert into users_alias (user_id, alias, alias_norm, source)
  values (
    new.id,
    trim(new.prenom || ' ' || new.nom),
    normalise_libelle(new.prenom || ' ' || new.nom),
    'manuel'
  )
  on conflict (alias_norm, source) do nothing;
  return new;
end;
$$;
create trigger users_alias_auto
  after insert on users
  for each row execute function users_alias_auto();

-- Rattrapage : alias manuel pour les users existants qui n'en ont pas.
insert into users_alias (user_id, alias, alias_norm, source)
select u.id, trim(u.prenom || ' ' || u.nom), normalise_libelle(u.prenom || ' ' || u.nom), 'manuel'
from users u
where not exists (
  select 1 from users_alias a
  where a.alias_norm = normalise_libelle(u.prenom || ' ' || u.nom) and a.source = 'manuel'
)
on conflict (alias_norm, source) do nothing;
