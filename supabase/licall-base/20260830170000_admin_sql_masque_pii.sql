-- ══════════════════════════════════════════════════════════════
-- Masquage RGPD des PII dans admin_sql_lecture() (audit 30/08).
--
-- PROBLÈME : l'Assistant Data (route /api/admin/assistant) exécute
-- le SQL écrit par le modèle via admin_sql_lecture(), puis renvoie
-- les LIGNES BRUTES au modèle (Vercel AI Gateway → Anthropic). Dès
-- qu'une requête sélectionne des colonnes nominatives
-- (personnes.nom, telephone_e164, email, note ; interactions.contenu
-- / resume ; oppositions.message), ces données personnelles partent
-- chez le fournisseur du modèle. Le prompt n'interdisait que
-- acces_codes.code_hash.
--
-- CORRECTIF (défense en base) : admin_sql_lecture() masque désormais
-- les colonnes PII CONNUES dans le JSON qu'elle renvoie, APRÈS
-- exécution de la requête. L'agrégation reste intacte : count/sum/
-- avg/group by ne produisent pas de colonnes nommées 'nom' /
-- 'telephone_e164' / etc., donc rien n'est masqué sur les chiffres.
--
-- MÉCANISME : masquage PAR NOM DE CLÉ dans le résultat jsonb.
--   • On ne réécrit PAS le SQL (pas d'analyse syntaxique fragile) :
--     on parcourt chaque ligne du résultat et, pour chaque clé
--     appartenant à la liste fermée des colonnes sensibles, on
--     remplace la valeur (pseudonymisation).
--   • nom            → initiales (« Jean Dupont » → « J.D. »)
--   • telephone_e164 / telephone → « +33·····78 » (préfixe + 2 derniers)
--   • email / note / contenu / resume / message → « (masqué) »
--
-- LIMITES ASSUMÉES (le masquage est un filet, pas une preuve) :
--   • Masquage par NOM DE COLONNE : un alias contourne la détection
--     (`select nom as client` ou `select telephone_e164 as tel`
--     renvoie la clé `client` / `tel`, non masquée). D'où le
--     renforcement du system prompt (interdiction de sélectionner des
--     colonnes nominatives, agrégation obligatoire) + le filet côté
--     route (masquage des mêmes clés avant envoi au modèle).
--   • Les PII noyées dans du texte libre (note/contenu) sous une AUTRE
--     colonne, ou dans un jsonb (sources_externes.payload,
--     logs_actions.details), ne sont pas détectées.
--   • Le masquage n'empêche pas une agrégation par PII (group by nom) :
--     elle reste possible mais ne renvoie que des initiales.
-- Ces trous sont couverts en profondeur par le prompt + le filet
-- applicatif ; la base reste la dernière ligne de défense.
-- ══════════════════════════════════════════════════════════════

-- ── Masquage d'une valeur selon le nom de sa colonne ──────────────
create or replace function masque_valeur_pii(p_cle text, p_val text)
returns text
language sql
immutable
as $$
  select case
    when p_val is null then null
    when p_cle in ('telephone_e164', 'telephone') then
      case
        when length(p_val) <= 5 then '·····'
        else left(p_val, 3) || '·····' || right(p_val, 2)
      end
    when p_cle = 'nom' then
      coalesce(
        (
          select string_agg(upper(left(w, 1)) || '.', '')
          from regexp_split_to_table(btrim(p_val), '\s+') as w
          where w <> ''
        ),
        '(masqué)'
      )
    -- email / note / contenu / resume / message et tout autre libellé
    -- sensible : neutralisation complète.
    else '(masqué)'
  end;
$$;

-- ── Masquage des clés PII connues d'une ligne (objet jsonb) ───────
create or replace function masque_ligne_pii(p_obj jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  cle text;
  resultat jsonb := p_obj;
  pii_cles constant text[] := array[
    'nom', 'telephone_e164', 'telephone', 'email',
    'note', 'contenu', 'resume', 'message'
  ];
begin
  if p_obj is null or jsonb_typeof(p_obj) <> 'object' then
    return p_obj;
  end if;
  foreach cle in array pii_cles loop
    -- Ne masque que les valeurs texte réellement présentes ; les nulls
    -- json et les valeurs non-texte (improbable pour ces clés) passent.
    if (resultat ? cle) and jsonb_typeof(resultat -> cle) = 'string' then
      resultat := jsonb_set(
        resultat,
        array[cle],
        to_jsonb(masque_valeur_pii(cle, resultat ->> cle))
      );
    end if;
  end loop;
  return resultat;
end;
$$;

-- ══════════════════════════════════════════════════════════════
-- Redéfinition de admin_sql_lecture() : identique à la 28/08
-- (lecture seule Postgres, timeout 10s, LIMIT 500 en sous-requête,
-- service_role only) + passe de masquage PII sur le résultat.
-- ══════════════════════════════════════════════════════════════
create or replace function admin_sql_lecture(p_query text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- btrim explicite : trim() ne retire pas les retours à la ligne — or
  -- le modèle envoie souvent un SQL commençant par '\n'.
  q text := btrim(coalesce(p_query, ''), E' \t\r\n');
  resultat jsonb;
begin
  if q = '' then
    raise exception 'Requête vide';
  end if;
  if length(q) > 5000 then
    raise exception 'Requête trop longue (max 5000 caractères)';
  end if;
  if position(';' in q) > 0 then
    raise exception 'Point-virgule interdit : une seule requête à la fois';
  end if;
  if upper(q) not like 'SELECT%' and upper(q) not like 'WITH%' then
    raise exception 'Lecture seule : la requête doit commencer par SELECT ou WITH';
  end if;

  -- La garantie réelle : lecture seule et timeout portés par Postgres,
  -- locaux à la transaction de cet appel RPC.
  set local statement_timeout = '10s';
  set local transaction_read_only = on;

  execute format(
    'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) sous limit 500) t',
    q
  ) into resultat;

  -- Passe de masquage RGPD : pseudonymise les colonnes PII connues
  -- ligne par ligne. jsonb_agg sur un résultat vide renvoie null →
  -- coalesce restaure '[]'. Les résultats d'agrégats (count/sum/…)
  -- ne portent aucune clé PII : ils traversent sans être touchés.
  select coalesce(jsonb_agg(masque_ligne_pii(elem)), '[]'::jsonb)
  into resultat
  from jsonb_array_elements(resultat) as elem;

  return resultat;
end;
$$;

-- service_role uniquement (rôles anon/authenticated absents d'un
-- Postgres local nu : revoke conditionnel pour rester rejouable).
revoke execute on function admin_sql_lecture(text) from public;
revoke execute on function masque_valeur_pii(text, text) from public;
revoke execute on function masque_ligne_pii(jsonb) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function admin_sql_lecture(text) from anon;
    revoke execute on function masque_valeur_pii(text, text) from anon;
    revoke execute on function masque_ligne_pii(jsonb) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function admin_sql_lecture(text) from authenticated;
    revoke execute on function masque_valeur_pii(text, text) from authenticated;
    revoke execute on function masque_ligne_pii(jsonb) from authenticated;
  end if;
end $$;
