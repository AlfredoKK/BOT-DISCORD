-- ══════════════════════════════════════════════════════════════
-- Interrupteur « Prospection BWA » par agence (demande CEO 04/09).
--
-- Jusqu'ici le cron bwa-ingest ingérait TOUTES les zones de la liste
-- statique, y compris celles d'agences en pause ou fermées : Nice, en
-- pause depuis fin août, restait la première zone en volume (296 fiches
-- le 04/09) — du stock que des SDR appellent pour une agence qui ne
-- prend plus de RDV. `paused` ne convient pas : il signifie « booking
-- fermé temporairement », pas « arrêter de prospecter ». D'où un flag
-- dédié, explicite, à true par défaut (aucun changement de comportement
-- tant que personne ne le bascule), piloté depuis Gestion des agences.
-- ══════════════════════════════════════════════════════════════

alter table agences
  add column if not exists bwa_ingest boolean not null default true;

comment on column agences.bwa_ingest is
  'false = le cron bwa-ingest ne rafraîchit plus le stock de cette zone (décision volontaire, Gestion des agences).';

-- referentiel_ecrire : la colonne devient modifiable depuis l'écran.
-- Corps identique à 20260828260000 + 'bwa_ingest' dans la liste agences ;
-- search_path figé (pg_temp en dernier) conservé de 20260901121000.
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
                     'agence_ids'];
  elsif p_table = 'agences' then
    allowed := array['nom','actif','tarif_rdv_honore','gcal_calendar_id','contact','bwa_team_id',
                     'max_rdv_heure','opening_hours','sheet_onglet','paused','secteur_cp',
                     'bwa_ingest'];
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
