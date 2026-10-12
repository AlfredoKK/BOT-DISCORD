-- ══════════════════════════════════════════════════════════════
-- logs_actions — journal d'audit unifié des actions (demande CEO
-- 29/08 : « en cas de soucis, triches ou autre on peut tout
-- retrouver avec l'assistant IA »).
--
-- QUI (acteur, rôle, IP) a fait QUOI (action, cible) QUAND, avec le
-- contexte utile en jsonb. APPEND-ONLY : update et delete interdits
-- par trigger — un log qui peut être modifié n'est pas un log.
-- Écrit uniquement côté serveur (src/lib/journal-actions.ts),
-- best-effort : un log raté ne bloque JAMAIS l'action métier.
-- Complète (sans remplacer) les journaux métier existants :
-- rdv_evenements, annonce_statuts, referentiel_audit, oppositions…
-- ══════════════════════════════════════════════════════════════

create table logs_actions (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  acteur_user_id uuid references users(id),
  acteur text,                       -- « Prénom Nom » même si non rattaché
  role text,                         -- ceo | admin | tl | sdr | systeme
  action text not null,              -- slug : 'login', 'export_clients', 'rdv_pose'…
  cible text,                        -- id / référence de l'objet touché
  details jsonb,                     -- contexte (jamais de mot de passe ni de jeton)
  ip text
);

comment on table logs_actions is
  'Journal d''audit unifié (append-only, écrit serveur uniquement) : qui a fait quoi, quand, sur quoi. Actions notables : login / login_echec / logout / mdp_reset_demande / mdp_reset / invitation / export_clients / import_clients / rdv_pose / rdv_confirme / rdv_statut / rdv_reattribue / annonce_statut / note / opposition_manuelle / consentement_depot / paie_gel / onoff_token_renouvele.';

create index logs_actions_at_idx on logs_actions (at desc);
create index logs_actions_acteur_idx on logs_actions (acteur_user_id, at desc);
create index logs_actions_action_idx on logs_actions (action, at desc);

create or replace function logs_actions_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'logs_actions est append-only : ni update ni delete';
end;
$$;

create trigger logs_actions_no_update
  before update or delete on logs_actions
  for each row execute function logs_actions_append_only();

alter table logs_actions enable row level security;
