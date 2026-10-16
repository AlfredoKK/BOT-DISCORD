-- ══════════════════════════════════════════════════════════════
-- Rôle admin + support opérationnel (décision CEO 28/08) :
--   - rôle « admin » : gestion support (saisie des résultats RDV,
--     tickets, SAV) + gestion collaborateurs (accès, liens, contrats).
--     Le CEO voit tout ce que voit l'admin.
--   - tickets : créer / gérer, commentaires, mention de SDR ou TL.
--   - contrats : pièce jointe par collaborateur, envoi tracé.
-- ══════════════════════════════════════════════════════════════

-- ── Rôle admin ─────────────────────────────────────────────────
alter table users drop constraint users_role_check;
alter table users add constraint users_role_check
  check (role in ('ceo','admin','tl','sdr','rh','support'));

-- ── Tickets (support / SAV) ────────────────────────────────────
create table tickets (
  id uuid primary key default gen_random_uuid(),
  sujet text not null,
  description text,
  type text not null default 'support' check (type in ('support','sav','agence','autre')),
  statut text not null default 'ouvert' check (statut in ('ouvert','en_cours','resolu','ferme')),
  priorite text not null default 'normale' check (priorite in ('basse','normale','haute')),
  rdv_id uuid references rdv(id),          -- SAV : rattaché au RDV concerné
  agence_id uuid references agences(id),
  auteur_user_id uuid references users(id),
  assigne_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  maj_at timestamptz not null default now()
);
create index tickets_statut_idx on tickets (statut, maj_at desc);
create index tickets_assigne_idx on tickets (assigne_user_id) where statut in ('ouvert','en_cours');

create table ticket_commentaires (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets(id),
  auteur_user_id uuid references users(id),
  contenu text not null,
  -- SDR / TL tagués dans le commentaire (ids users)
  mentions uuid[] not null default '{}',
  at timestamptz not null default now()
);
create index ticket_commentaires_ticket_idx on ticket_commentaires (ticket_id, at);

create or replace function tickets_maj_at()
returns trigger language plpgsql as $$
begin
  update tickets set maj_at = now() where id = new.ticket_id;
  return new;
end;
$$;
create trigger ticket_commentaire_touch
  after insert on ticket_commentaires
  for each row execute function tickets_maj_at();

-- ── Contrats collaborateurs ────────────────────────────────────
create table contrats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  nom_fichier text not null,
  fichier_path text not null,              -- chemin dans le bucket privé « contrats »
  mime text,
  taille int,
  statut text not null default 'ajoute' check (statut in ('ajoute','envoye','signe')),
  envoye_at timestamptz,
  envoye_a text,                           -- email destinataire
  depose_par uuid references users(id),
  created_at timestamptz not null default now()
);
create index contrats_user_idx on contrats (user_id, created_at desc);

-- ── Buckets de stockage privés ─────────────────────────────────
-- (accès uniquement par lien signé généré côté serveur)
insert into storage.buckets (id, name, public)
values ('contrats', 'contrats', false), ('consentements', 'consentements', false)
on conflict (id) do nothing;

-- ── RLS ────────────────────────────────────────────────────────
alter table tickets              enable row level security;
alter table ticket_commentaires  enable row level security;
alter table contrats             enable row level security;
