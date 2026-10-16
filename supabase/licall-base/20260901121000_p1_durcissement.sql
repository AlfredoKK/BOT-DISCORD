-- ══════════════════════════════════════════════════════════════
-- P1 — DURCISSEMENT (audit sécurité du 01/09/2026)
--
-- À APPLIQUER APRÈS 20260901120000_p0_confinement.sql.
--
-- Le confinement précédent suffit à fermer l'exposition. Ce qui suit est
-- de la défense en profondeur : si un jour quelqu'un ré-accorde des
-- droits à `anon` (nouveau dev, réglage de dashboard, restauration),
-- ces deux durcissements font que le dégât reste limité.
--
-- IMPACT VÉRIFIÉ : nul pour l'application. `security_invoker = true`
-- fait exécuter la vue avec les droits de l'appelant — ici toujours
-- `service_role`, qui contourne la RLS. Preuve : l'application lit
-- aujourd'hui les 52 tables alors que la RLS y est active sans aucune
-- policy ; ce contournement est justement ce qui rend le changement
-- transparent. Les vues continueront donc de tout renvoyer au backend,
-- et ne renverront rien à un rôle non privilégié.
-- ══════════════════════════════════════════════════════════════


-- ── 1. Les vues cessent d'emprunter les droits de leur propriétaire ──
-- (P0-1 : postgres est propriétaire, donc elles voyaient tout, RLS comprise)
alter view public.v_annonce_etat        set (security_invoker = true);
alter view public.v_consentement_etat   set (security_invoker = true);
alter view public.v_rappels_retard      set (security_invoker = true);
alter view public.v_rdv_etat            set (security_invoker = true);
alter view public.v_rdv_remunerables    set (security_invoker = true);

-- ── 2. search_path figé sur les fonctions SECURITY DEFINER ──
-- (P1-3 : un search_path mutable permet, dans certaines configurations,
--  de faire résoudre un nom d'objet vers un objet injecté)
alter function public.logs_actions_purge(timestamptz, integer)  set search_path = public, pg_temp;
alter function public.admin_sql_lecture(text)                    set search_path = public, pg_temp;
alter function public.chat_liste(uuid)                           set search_path = public, pg_temp;
alter function public.referentiel_ecrire(uuid, text, uuid, jsonb) set search_path = public, pg_temp;

