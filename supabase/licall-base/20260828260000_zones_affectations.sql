-- ══════════════════════════════════════════════════════════════
-- Zones & affectations (décision CEO 28/08) :
--   1. agences.secteur_cp : préfixes de codes postaux couverts par
--      l'agence (ex {'28'} ou {'59500','593'}). Éditable par les
--      admins (whitelist referentiel_ecrire) → les leads entrants
--      sont rattachés automatiquement par CP, y compris quand une
--      agence est créée APRÈS l'arrivée des leads.
--   2. users.agence_ids : affectation d'un SDR à une ou plusieurs
--      agences/zones. Un SDR non affecté ne voit AUCUNE fiche du
--      board et ne peut pas choisir de zone.
-- ══════════════════════════════════════════════════════════════

alter table agences add column secteur_cp text[];
alter table users add column agence_ids uuid[];

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
                     'date_entree','date_sortie','onoff_user_id','bot_booker_name',
                     'agence_ids'];
  elsif p_table = 'agences' then
    allowed := array['nom','actif','tarif_rdv_honore','gcal_calendar_id','contact','bwa_team_id',
                     'max_rdv_heure','opening_hours','sheet_onglet','paused','secteur_cp'];
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

-- Secteurs par défaut : le département de la ville de chaque agence.
-- Les départements partagés (59, 91, 13, 33) laissent le lead « ambigu »
-- (non rattaché, visible de tous) tant que les admins n'affinent pas les
-- préfixes dans Gestion des agences.
update agences set secteur_cp = v.cp::text[]
from (values
  ('ANNECY',           '{74}'), ('BÉZIERS',        '{34}'), ('BLOIS',          '{41}'),
  ('BOURGOIN JAILLEUX','{38}'), ('BUCHELAY',       '{78}'), ('CAEN',           '{14}'),
  ('CHAMBERY',         '{73}'), ('CHANTILLY',      '{60}'), ('CHARTRES',       '{28}'),
  ('COLOMBES',         '{92}'), ('DOUAI',          '{59}'), ('ETAMPES',        '{91}'),
  ('HERBLAY',          '{95}'), ('LA CIOTAT',      '{13}'), ('LA ROCHELLE',    '{17}'),
  ('LILLE',            '{59}'), ('LIMOGES',        '{87}'), ('LYON NORD',      '{69}'),
  ('MARSEILLE',        '{13}'), ('MERIGNAC',       '{33}'), ('MONTAUBAN',      '{82}'),
  ('MULHOUSE',         '{68}'), ('NICE',           '{06}'), ('ORLÉANS',        '{45}'),
  ('PARIS 15',         '{75}'), ('PAU',            '{64}'), ('REIMS',          '{51}'),
  ('RENNES',           '{35}'), ('ROANNE',         '{42}'), ('ROUEN',          '{76}'),
  ('STRASBOURG',       '{67}'), ('TOULOUSE NORD',  '{31}'), ('TOURS',          '{37}'),
  ('VALENCE',          '{26}'), ('VILLEBON',       '{91}'), ('VILLENAVE',      '{33}')
) as v(nom, cp)
where normalise_libelle(agences.nom) = normalise_libelle(v.nom) and agences.actif;
