-- ══════════════════════════════════════════════════════════════
-- Bugs techniques (décision CEO 28/08) : quand une pose de RDV (ou
-- tout autre flux) échoue pour une raison TECHNIQUE — agenda Google
-- non partagé, sheet KO, écriture DB échouée — un rapport est créé
-- ici, dédupliqué par `signature`, et les admins sont notifiés.
-- Les refus MÉTIER (créneau plein, STOP RDV…) n'entrent JAMAIS ici.
-- Écritures via src/lib/bug-report.ts (signalerBug) uniquement.
-- ══════════════════════════════════════════════════════════════

create table bug_reports (
  id uuid primary key default gen_random_uuid(),
  survenu_at timestamptz not null default now(),   -- 1ère occurrence
  source text not null,                            -- ex 'rdv_pose'
  signature text not null,                         -- clé de dédup, ex 'agenda_404|<agence_id>'
  occurrences int not null default 1,
  derniere_at timestamptz not null default now(),  -- dernière occurrence
  contexte jsonb not null default '{}'::jsonb,     -- sdr, agence, créneau, payload minimal
  erreur text,                                     -- message brut
  cause text not null,                             -- diagnostic lisible
  solution text not null,                          -- action concrète
  statut text not null default 'ouvert' check (statut in ('ouvert','resolu')),
  resolu_par uuid references users(id),
  resolu_at timestamptz
);

-- Dédup : recherche « bug ouvert même signature < 24 h ».
create index bug_reports_dedup_idx on bug_reports (signature, statut, derniere_at desc);
-- Vue admin : liste des bugs ouverts, plus récents d'abord.
create index bug_reports_ouverts_idx on bug_reports (statut, derniere_at desc);

alter table bug_reports enable row level security;
-- Zéro policy (comme partout) : seul le service_role passe.

-- La cloche accepte le type 'bug' (notification in-app aux admins).
alter table notifications drop constraint if exists notifications_type_check;
alter table notifications add constraint notifications_type_check
  check (type in ('sav','ticket','info','bug'));
