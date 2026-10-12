-- ══════════════════════════════════════════════════════════════
-- Connexion email + mot de passe (décision CEO 28/08).
-- Cohabite avec les codes d'accès (acces_codes) — même référentiel
-- users, même session. Rien n'est stocké en clair :
--   - password_hash : scrypt (N=16384, r=8, p=1, sel 32 o) ;
--   - invitation/reset : sha256 du jeton, avec expiration
--     (invitation 72 h, réinitialisation 30 min), consommés à l'usage.
-- ══════════════════════════════════════════════════════════════

create table auth_credentials (
  user_id uuid primary key references users(id),
  email text not null unique,               -- normalisé en minuscules
  password_hash text,                       -- null tant que non défini
  password_set_at timestamptz,
  invitation_hash text,
  invitation_expires_at timestamptz,
  reset_hash text,
  reset_expires_at timestamptz,
  cree_at timestamptz not null default now(),
  derniere_connexion_at timestamptz
);

alter table auth_credentials enable row level security;
