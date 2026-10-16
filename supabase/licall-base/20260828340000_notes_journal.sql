-- ══════════════════════════════════════════════════════════════
-- Journal des notes clients (décision CEO 28/08, vue Activité).
-- personnes.note reste LA note courante (affichage fiche) ; chaque
-- sauvegarde ajoute désormais un événement ici — qui a écrit quoi,
-- quand. Rien n'est jamais modifié ni supprimé (pattern journal).
-- ══════════════════════════════════════════════════════════════

create table personne_note_evenements (
  id uuid primary key default gen_random_uuid(),
  personne_id uuid not null references personnes(id),
  auteur_user_id uuid references users(id),
  note text not null,
  at timestamptz not null default now()
);
create index personne_note_evenements_at_idx on personne_note_evenements (at desc);
create index personne_note_evenements_personne_idx on personne_note_evenements (personne_id);

alter table personne_note_evenements enable row level security;
