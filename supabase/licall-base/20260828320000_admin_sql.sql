-- ══════════════════════════════════════════════════════════════
-- Assistant Data IA (décision CEO 28/08) — admin_sql_lecture().
--
-- Les admins doivent pouvoir sortir N'IMPORTE QUELLE donnée de la
-- base à la demande, en français, via un assistant IA. Le modèle
-- génère du SQL ; cette fonction est SON SEUL point d'exécution.
--
-- Défense en profondeur :
--   1. Parsing minimal (SELECT/WITH, pas de ';', ≤ 5000 caractères)
--      — un premier filtre, PAS la garantie.
--   2. SET LOCAL transaction_read_only = on AVANT l'EXECUTE : la
--      lecture seule est garantie par POSTGRES lui-même. Un
--      INSERT/UPDATE/DELETE/DROP — même enrobé dans un CTE
--      `with x as (delete …)` — échoue avec « cannot execute … in a
--      read-only transaction ». (Repasser en read-write est
--      impossible : Postgres refuse SET transaction_read_only=off
--      après la première requête de la transaction.)
--   3. SET LOCAL statement_timeout = '10s' : une jointure folle ne
--      bloque pas un worker indéfiniment.
--   4. LIMIT 500 appliqué EN SOUS-REQUÊTE :
--      format('… from (select * from (%s) sous limite …)') — ainsi
--      une requête portant son propre ORDER BY / LIMIT reste un SQL
--      valide (un `%s limit 500` naïf produirait `limit 10 limit 500`,
--      erreur de syntaxe).
--   5. EXECUTE service_role uniquement (revoke public/anon/
--      authenticated) : seul le serveur Next (db().rpc) peut appeler,
--      derrière requireRole('admin','ceo').
-- ══════════════════════════════════════════════════════════════

create or replace function admin_sql_lecture(p_query text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- btrim explicite : trim() Postgres ne retire que les espaces, pas les
  -- retours à la ligne — or le modèle envoie souvent un SQL commençant
  -- par '\n', qui échouerait au contrôle SELECT/WITH.
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

  return resultat;
end;
$$;

-- service_role uniquement (rôles anon/authenticated absents d'un
-- Postgres local nu : revoke conditionnel pour rester rejouable).
revoke execute on function admin_sql_lecture(text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function admin_sql_lecture(text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function admin_sql_lecture(text) from authenticated;
  end if;
end $$;
