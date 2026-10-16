-- ══════════════════════════════════════════════════════════════
-- ANNONCES ÉQUIPE + BIBLIOTHÈQUE DE DOCUMENTS (demandes CEO 31/08).
--
-- 1) annonces_internes : annonces importantes transmises par les
--    admins/CEO, avec ACCUSÉ DE LECTURE obligatoire (case à cocher)
--    par chaque utilisateur des rôles ciblés. Le suivi « qui a lu /
--    qui n'a pas lu » est visible côté CEO/admin.
--    (« internes » pour ne pas confondre avec `annonces` = BWA.)
-- 2) annonces_lectures : journal des accusés (1 ligne par user).
-- 3) documents_internes : documents de formation/documentation stockés
--    dans le bucket Storage `documents` (privé, créé le 31/08), avec
--    VISIBILITÉ PAR RÔLE choisie à l'upload (ceo/admin/tl/sdr).
--    Filtrage TOUJOURS côté serveur ; téléchargement par URL signée.
--
-- RLS activée SANS policy partout : accès service_role uniquement
-- (db.ts) — principe passation « aucune écriture directe du client ».
-- ══════════════════════════════════════════════════════════════

create table annonces_internes (
  id uuid primary key default gen_random_uuid(),
  titre text not null,
  contenu text not null,
  -- Rôles qui DOIVENT accuser lecture (et qui voient l'annonce).
  roles_cibles text[] not null default '{sdr,tl}',
  active boolean not null default true,
  cree_par text,                                   -- nom lisible (trace)
  cree_par_user_id uuid references users(id),
  created_at timestamptz not null default now()
);

create index annonces_internes_active_idx on annonces_internes (active, created_at desc);
alter table annonces_internes enable row level security;

create table annonces_lectures (
  annonce_id uuid not null references annonces_internes(id),
  user_id uuid not null references users(id),
  lu_at timestamptz not null default now(),
  primary key (annonce_id, user_id)
);

alter table annonces_lectures enable row level security;

create table documents_internes (
  id uuid primary key default gen_random_uuid(),
  titre text not null,
  description text,
  chemin text not null,                            -- chemin dans le bucket `documents`
  nom_fichier text not null,                       -- nom d'origine (affichage/téléchargement)
  taille bigint,
  mime text,
  -- Rôles autorisés à VOIR le document (choisis à l'upload).
  roles_visibles text[] not null default '{ceo,admin,tl,sdr}',
  -- false tant que l'upload direct vers Storage n'est pas confirmé.
  actif boolean not null default false,
  uploade_par text,
  uploade_par_user_id uuid references users(id),
  created_at timestamptz not null default now()
);

create index documents_internes_actif_idx on documents_internes (actif, created_at desc);
alter table documents_internes enable row level security;
