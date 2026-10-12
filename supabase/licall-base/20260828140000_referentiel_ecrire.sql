-- ══════════════════════════════════════════════════════════════
-- referentiel_ecrire() — point d'écriture unique du référentiel
-- (users / agences / teams) pour l'API admin.
--
-- Pourquoi une fonction et pas des UPDATE directs : l'auteur de la
-- modification doit atterrir dans referentiel_audit (set_config est
-- local à la transaction — impossible à garantir en deux requêtes
-- PostgREST). Ici, config + écriture vivent dans LA MÊME transaction.
-- Colonnes whitelistées : le JSON reçu ne peut toucher que ce qui
-- est prévu (jamais id, jamais created_at).
-- ══════════════════════════════════════════════════════════════

create or replace function referentiel_ecrire(
  p_auteur uuid,
  p_table text,
  p_id uuid,          -- null = création
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
    allowed := array['nom','actif','tarif_rdv_honore','gcal_calendar_id','contact','bwa_team_id'];
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

-- Exposée uniquement au service_role (l'API serveur) — pas d'accès
-- anon/authenticated, cohérent avec la RLS fermée. (Rôles absents
-- d'un Postgres nu : revoke conditionnel pour rester rejouable en local.)
do $$ begin
  revoke execute on function referentiel_ecrire(uuid, text, uuid, jsonb) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function referentiel_ecrire(uuid, text, uuid, jsonb) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function referentiel_ecrire(uuid, text, uuid, jsonb) from authenticated;
  end if;
end $$;
