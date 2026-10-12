-- ══════════════════════════════════════════════════════════════
-- FINANCES MENSUELLES — facturation agences (décision CEO 28/08 :
-- abandon progressif des Google Sheets).
--
-- Une ligne par (agence, mois). Source : onglets « FINANCES 26 »
-- et « ARCHIVE FINANCE 26 » du sheet CEO « KALLKALL Finances 26 »
-- (1mszl0T6gne7qzWJ39vaVt64y7J_MQv31eHIX5ReCcsY).
--
-- Mapping VÉRIFIÉ sur le sheet LIVE le 28/08/2026 (les deux
-- onglets partagent le même en-tête, 40 colonnes) :
--   A AGENCES   B MOIS ('07/26')
--   C BOOKÉ  D PASSÉ  E À VENIR  G VENU  I PAS VENU  K ANNULÉ
--   M VENDU  O SAV                       (F/H/J/L/N/P = % dérivés)
--   R GOAL  S PU HT (80/99/65 €)  T THÉORIQUE  U VENU (= RDV RÉEL,
--     base de facturation : HT = U × S)
--   W HT  X TTC  Y STOCK HT  Z PERDU HT
--   AB OK FAC (« ok 45 »)  AC DATE ENVOI  AD PAIEMENT CLIENT (date)
--   AE Ajout Facture (commentaire d'ajustement)  AM email agence
--
-- ⚠️ Écarts vs mapping proposé initialement (snapshots partiels) :
--   pas de statut_facture 'PAYE/FA ENVOYE' ni part_sdr/marge_brute
--   par agence dans ces onglets (c'est le format « Finances 25 »,
--   hors scope). Le statut est DÉRIVÉ : payee_le → PAYÉ,
--   facture_envoyee_le → FA ENVOYÉE, ok_fac → OK FAC, sinon —.
--
-- Le mois COURANT évolue chaque jour → upsert en mode UPDATE
-- (jamais de doublon, unique (agence_id, mois)).
-- RLS activée SANS policy : accès service_role uniquement (db.ts).
-- ══════════════════════════════════════════════════════════════

create table finances_mensuelles (
  id uuid primary key default gen_random_uuid(),
  agence_id uuid not null references agences(id),
  mois text not null check (mois ~ '^[0-9]{4}-[0-9]{2}$'),

  -- Compteurs booking (bloc gauche du sheet)
  booke int not null default 0,
  passe int not null default 0,
  a_venir int not null default 0,
  venu int not null default 0,
  pas_venu int not null default 0,
  annule int not null default 0,
  vendu int not null default 0,
  sav int not null default 0,

  -- Facturation (bloc droit du sheet)
  goal int,                          -- objectif RDV du mois
  tarif_eur numeric(8,2),            -- PU HT (80 € standard, 99 € Blois, 65 € Villebon…)
  theorique int,                     -- prorata du goal à date
  rdv_reel int,                      -- « RDV RÉEL / VENU » = base de facturation
  montant_ht_eur numeric(10,2),      -- HT = rdv_reel × tarif
  montant_ttc_eur numeric(10,2),
  stock_ht_eur numeric(10,2),        -- à venir valorisés
  perdu_ht_eur numeric(10,2),        -- bookés non venus valorisés
  ok_fac text,                       -- validation agence (« ok 45 »)
  facture_envoyee_le date,           -- DATE ENVOI
  payee_le date,                     -- PAIEMENT CLIENT
  commentaire text,                  -- Ajout Facture (ajustements manuels)
  email_agence text,

  source_onglet text not null,       -- 'FINANCES 26' | 'ARCHIVE FINANCE 26'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (agence_id, mois)
);

create index finances_mensuelles_mois_idx on finances_mensuelles (mois);
create index finances_mensuelles_agence_idx on finances_mensuelles (agence_id);

alter table finances_mensuelles enable row level security;
-- Aucune policy : seul service_role (bypass RLS) lit/écrit — principe passation.
