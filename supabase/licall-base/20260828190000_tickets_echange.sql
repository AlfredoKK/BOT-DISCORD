-- ══════════════════════════════════════════════════════════════
-- Tickets = fils d'échange (décision CEO 28/08) :
--   - discussion support/admin ↔ SDR concerné ↔ TL du SDR ;
--   - pièces jointes (audio d'appel, captures…) en bucket privé ;
--   - clôture par l'admin AVEC décision, notifiée au SDR.
-- ══════════════════════════════════════════════════════════════

alter table tickets
  add column decision text,
  add column clos_par uuid references users(id),
  add column clos_at timestamptz;

create table ticket_fichiers (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets(id),
  commentaire_id uuid references ticket_commentaires(id),
  nom_fichier text not null,
  path text not null,               -- chemin bucket privé « tickets »
  mime text,
  taille int,
  depose_par uuid references users(id),
  created_at timestamptz not null default now()
);
create index ticket_fichiers_ticket_idx on ticket_fichiers (ticket_id, created_at);

insert into storage.buckets (id, name, public)
values ('tickets', 'tickets', false)
on conflict (id) do nothing;

alter table ticket_fichiers enable row level security;
