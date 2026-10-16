-- ══════════════════════════════════════════════════════════════
-- P0 — CONFINEMENT DE LA DATA API (audit sécurité du 01/09/2026)
--
-- CONTEXTE VÉRIFIÉ DANS LE DÉPÔT : l'application est backend-only.
-- Aucune variable NEXT_PUBLIC_*, aucune clé anon configurée, le client
-- Supabase n'est importé que par src/lib/db.ts (service_role) et ce
-- fichier n'est jamais importé par un composant client. Les rôles
-- `anon` et `authenticated` ne servent donc À RIEN dans ce projet.
--
-- Plutôt que de corriger une par une les cinq vues et la RPC de purge
-- signalées par l'audit, on retire le périmètre entier à ces deux rôles.
-- Cela neutralise d'un coup P0-1 (vues en security_invoker=false),
-- P0-2 (logs_actions_purge exécutable publiquement) et P1-1 (privilèges
-- par défaut sur les futurs objets) — et rend inoffensif tout objet créé
-- plus tard sans y penser.
--
-- IMPACT ATTENDU : aucun. `service_role` conserve tous ses droits et
-- contourne la RLS (vérifié : l'application lit les 52 tables alors que
-- la RLS est active sans aucune policy). Rollback en une commande, voir
-- ROLLBACK_SECURITY.md.
--
-- HORS PÉRIMÈTRE VOLONTAIRE : le schéma `storage`. Les URL signées des
-- buckets `documents` et `enregistrements` transitent par le service
-- Storage, dont le modèle d'autorisation est distinct ; y toucher sans
-- test dédié risquerait de casser le téléchargement des documents et
-- l'écoute des enregistrements. À traiter séparément, après test.
-- ══════════════════════════════════════════════════════════════


-- ── 1. Retrait de l'accès au schéma public ──────────────────
revoke usage on schema public from anon, authenticated;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- EXECUTE est accordé à PUBLIC par défaut en PostgreSQL : révoquer
-- seulement anon/authenticated ne suffirait pas, ils héritent de PUBLIC.
-- On révoque donc à PUBLIC, puis on redonne explicitement à service_role.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

-- ── 2. Les objets FUTURS ne reçoivent plus rien ─────────────
-- Sans ça, la prochaine table créée serait de nouveau exposée.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

-- ── 3. Rappel explicite sur la purge destructive (P0-2) ─────
-- Déjà couvert par le bloc ci-dessus ; écrit en clair pour que
-- l'intention reste lisible et survive à un futur GRANT malheureux.
revoke all on function public.logs_actions_purge(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.logs_actions_purge(timestamptz, integer)
  to service_role;

