-- ══════════════════════════════════════════════════════════════
-- logs_actions_purge — purge CONTRÔLÉE du journal d'audit append-only.
--
-- CONTEXTE : logs_actions est append-only (migration 20260829110000) :
-- le trigger logs_actions_no_update lève une exception sur TOUT update
-- ou delete — « un log qui peut être modifié n'est pas un log ». Mais
-- l'audit RGPD 30/08 impose une DURÉE DE CONSERVATION (12 mois proposés) :
-- il faut donc pouvoir supprimer les lignes ANCIENNES, sans jamais
-- rouvrir la porte à la modification de l'audit récent.
--
-- APPROCHE RETENUE (la plus sûre) : assouplissement CIBLÉ du trigger,
-- verrouillé par DEUX conditions cumulatives — ni l'une ni l'autre seule
-- ne suffit :
--   (a) un drapeau de transaction (GUC local) posé UNIQUEMENT par la
--       fonction de purge dédiée — une commande DELETE « à la main »
--       reste refusée, car le drapeau n'est pas armé ;
--   (b) un PLANCHER D'INVIOLABILITÉ en dur : même drapeau armé, on ne
--       peut JAMAIS supprimer une ligne de moins de 12 mois.
-- UPDATE reste totalement interdit dans tous les cas. Le drapeau est
-- transaction-local (is_local = true) : il ne fuit pas hors de la purge.
--
-- La purge s'AUTO-AUDITE : la fonction insère (append-only respecté) une
-- ligne logs_actions 'logs_actions_purge' avec le nombre supprimé.
--
-- Pourquoi ce choix plutôt qu'une simple fonction SECURITY DEFINER qui
-- « DELETE » : un DELETE déclenche le trigger quel que soit le rôle
-- (même owner/superuser) — SECURITY DEFINER ne le contourne pas. Il faut
-- donc que le trigger LUI-MÊME connaisse et borne l'exception. Le plancher
-- vit dans le trigger (et non seulement dans la fonction) : l'inviolabilité
-- de l'audit récent est garantie EN BASE, pas seulement par l'appelant.
-- ══════════════════════════════════════════════════════════════

-- Plancher d'inviolabilité : aucune ligne plus récente que cet âge ne peut
-- être supprimée, même par la purge. Aligné sur la rétention proposée
-- (12 mois, à valider par le CEO). Centralisé ici pour rester cohérent
-- entre le trigger et la fonction.
create or replace function logs_actions_plancher_retention()
returns interval language sql immutable as $$
  select interval '12 months';
$$;

-- Trigger append-only ASSOUPLI : autorise le DELETE d'une ligne ancienne
-- UNIQUEMENT quand la purge dédiée a armé son drapeau. Tout le reste (tout
-- UPDATE, tout DELETE non armé, tout DELETE d'une ligne récente) est refusé.
create or replace function logs_actions_append_only()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE'
     and current_setting('kallkall.purge_logs_actions', true) = 'on'
     and old.at < now() - logs_actions_plancher_retention()
  then
    return old; -- purge auditée d'une ligne ancienne : autorisée
  end if;
  raise exception 'logs_actions est append-only : ni update ni delete (hors purge de rétention auditée des lignes anciennes)';
end;
$$;

-- Le trigger existant (logs_actions_no_update, before update or delete)
-- pointe déjà sur cette fonction : la remplacer ci-dessus suffit, pas
-- besoin de recréer le trigger.

-- Fonction de purge dédiée : SEUL point d'entrée autorisé à supprimer.
--   @param avant  supprime les lignes strictement plus vieilles que cette
--                 borne. Bornée en dur au plancher : si `avant` est null ou
--                 plus récent que « now() - plancher », on retombe sur le
--                 plancher (on ne peut pas purger plus récent que la loi).
--   @param lot    plafond de lignes supprimées par appel (borne la charge ;
--                 le cron rappelle jour après jour pour drainer un backlog).
--   @return       nombre de lignes réellement supprimées.
create or replace function logs_actions_purge(avant timestamptz, lot integer default 20000)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
  plancher timestamptz := now() - logs_actions_plancher_retention();
begin
  if avant is null or avant > plancher then
    avant := plancher; -- jamais purger une ligne de moins de 12 mois
  end if;
  if lot is null or lot < 1 then
    lot := 20000;
  end if;

  -- Arme le drapeau UNIQUEMENT le temps de cette transaction (is_local).
  perform set_config('kallkall.purge_logs_actions', 'on', true);

  delete from logs_actions
  where id in (
    select id from logs_actions
    where at < avant
    order by at asc
    limit lot
  );
  get diagnostics n = row_count;

  -- Referme le drapeau (par prudence ; il retomberait de toute façon en fin
  -- de transaction).
  perform set_config('kallkall.purge_logs_actions', 'off', true);

  -- Auto-audit de la purge (INSERT = append-only respecté).
  insert into logs_actions (action, acteur, role, details)
  values (
    'logs_actions_purge',
    'systeme',
    'systeme',
    jsonb_build_object('avant', avant, 'supprimees', n, 'lot', lot)
  );

  return n;
end;
$$;

comment on function logs_actions_purge(timestamptz, integer) is
  'Purge de rétention RGPD du journal d''audit append-only : supprime les lignes plus vieilles que `avant` (bornée au plancher d''inviolabilité de 12 mois), par lots de `lot`, en armant le drapeau transaction-local que seul le trigger assoupli reconnaît. S''auto-audite. Appelée par /api/cron/purge-retention.';

-- Réservé au service_role (le cron l'appelle via la clé service_role qui
-- bypasse la RLS). On révoque explicitement l'accès public/anon/authenticated.
revoke all on function logs_actions_purge(timestamptz, integer) from public;
