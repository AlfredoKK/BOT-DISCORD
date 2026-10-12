-- ══════════════════════════════════════════════════════════════
-- Abandon des Google Sheets (décision CEO 28/08) — étape auth :
-- les codes d'accès (PIN) sortent du sheet « SDR KALL KALL » et
-- vivent en base, HASHÉS (sha-256) — le sheet n'en garde que
-- l'historique. users est déjà le référentiel.
-- ══════════════════════════════════════════════════════════════

create table acces_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  code_hash text not null unique,        -- sha256(code), jamais le code en clair
  actif boolean not null default true,
  cree_at timestamptz not null default now(),
  derniere_connexion_at timestamptz
);
create index acces_codes_user_idx on acces_codes (user_id) where actif;

alter table acces_codes enable row level security;
