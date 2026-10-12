-- ══════════════════════════════════════════════════════════════
-- FINANCE CEO — compte de résultat mensuel « CHARGE KK ».
--
-- Deux tables pour l'écran Finance (CEO uniquement). Le reste vient
-- de Supabase et n'est JAMAIS ressaisi :
--   • CA (produits)      → finances_mensuelles.montant_ht_eur
--                          (déjà ingéré du sheet « Finances 26 »)
--   • Charge SDR         → v_rdv_remunerables via /api/admin/remunerations
--                          (LA source unique de la paie — jamais recalculée)
--
-- 1) couts_mensuels    : les AUTRES postes de charge, saisis à la main
--    (ON OFF, BWA, Coach/formation, Support, RH, Audisol, Prime,
--    TL FIXE, PRIME TL, TC…). Une ligne = un poste pour un mois.
-- 2) finance_config    : paramètres du mois (taux de provision,
--    override CA éventuel, répartition entre associés de la « Rém »).
--
-- Résultat  = CA − (SDR + Σ charges manuelles)
-- Provision = Résultat × provision_pct
-- Rém       = Résultat − Provision, répartie selon `associes`
-- Marge %   = Résultat / CA
--
-- « Copier depuis le mois précédent » duplique couts_mensuels +
-- finance_config (postes récurrents, provision, associés).
--
-- RLS activée SANS policy : accès service_role uniquement (db.ts).
-- ══════════════════════════════════════════════════════════════

create table couts_mensuels (
  id uuid primary key default gen_random_uuid(),
  mois text not null check (mois ~ '^[0-9]{4}-[0-9]{2}$'),
  libelle text not null,
  montant_eur numeric(12, 2) not null default 0,
  ordre int not null default 0,           -- ordre d'affichage dans le mois
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index couts_mensuels_mois_idx on couts_mensuels (mois);

alter table couts_mensuels enable row level security;
-- Aucune policy : seul service_role (bypass RLS) lit/écrit.

create table finance_config (
  mois text primary key check (mois ~ '^[0-9]{4}-[0-9]{2}$'),
  provision_pct numeric(5, 2) not null default 30,   -- % du résultat mis en provision
  ca_ht_override numeric(12, 2),                      -- si le CA diffère de finances_mensuelles
  -- Répartition de la « Rém » entre associés : [{ nom, part_pct }]
  associes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table finance_config enable row level security;
-- Aucune policy : seul service_role (bypass RLS) lit/écrit.
