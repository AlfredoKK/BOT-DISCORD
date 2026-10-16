-- ══════════════════════════════════════════════════════════════
-- oppositions — LA liste d'opposition au démarchage (décision CEO
-- 28/08, reprise du projet « sms-onoff » DANS le CRM).
--
-- RÈGLES (RGPD art. 21 — droit d'opposition) :
--   - Un STOP reçu par SMS = opposition HORODATÉE. Le numéro ne doit
--     PLUS JAMAIS être contacté (ni SMS, ni appel sortant). Seule
--     exception : un appel ENTRANT de la personne.
--   - L'opposition vit au niveau du NUMÉRO, pas de la fiche : elle
--     survit aux fusions, suppressions et réimports (le scrap qui
--     recrée une fiche ne doit jamais faire perdre le STOP).
--   - La fiche n'est JAMAIS supprimée : elle reste, verrouillée
--     (bandeau 🛑, exclue du board, pose de RDV refusée) — c'est la
--     preuve que le droit a été honoré.
--   - DELETE interdit par trigger : une opposition ne se lève pas.
--   - Détection STRICTE (src/lib/oppositions.ts, estVraiStop) : mot
--     « STOP » entier sur un SMS REÇU, en EXCLUANT les réactions aux
--     messages (« J'ai aimé "…" ») qui recitent notre propre mention
--     STOP — source de faux positifs dans l'ancien projet sms-onoff.
--   - Règle d'or : TOUT futur module d'envoi (Brevo…) doit vérifier
--     cette table AU MOMENT DE L'ENVOI, jamais à l'import.
-- ══════════════════════════════════════════════════════════════

create table oppositions (
  id uuid primary key default gen_random_uuid(),
  telephone_e164 text not null unique,
  premier_stop_at timestamptz not null,
  dernier_stop_at timestamptz not null,
  nb_stop int not null default 1,
  message text,                                 -- le dernier SMS STOP reçu
  source text not null check (source in ('sms', 'manuel', 'import')),
  interaction_id uuid references interactions(id),  -- SMS source si connu
  auteur_user_id uuid references users(id),     -- qui a posé un STOP manuel
  created_at timestamptz not null default now(),
  check (telephone_e164 ~ '^\+[1-9][0-9]{6,14}$')
);

comment on table oppositions is
  'Liste d''opposition au démarchage (STOP SMS, RGPD art. 21). Clé = numéro E.164, indépendante des fiches. Jamais supprimée (trigger). Tout envoi sortant vérifie cette table au moment de l''envoi.';

-- Une opposition ne se supprime JAMAIS (même principe que le référentiel).
create or replace function oppositions_interdire_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'Suppression interdite : une opposition (STOP) ne se lève pas — RGPD art. 21';
end;
$$;

create trigger oppositions_no_delete
  before delete on oppositions
  for each row execute function oppositions_interdire_delete();

alter table oppositions enable row level security;
