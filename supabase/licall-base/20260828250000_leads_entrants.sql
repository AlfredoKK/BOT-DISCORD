-- ══════════════════════════════════════════════════════════════
-- Leads entrants — landing page Vroom Market (décision CEO 28/08).
-- Les formulaires « Contact » et « Estimation » du site sont des
-- demandes de contact CONSENTIES : chaque soumission devient
--   1. une personne (avec code postal → rattachement secteur),
--   2. un consentement daté (date de la soumission), SANS fichier :
--      la preuve est la soumission elle-même, tracée dans details,
--   3. pour les demandes d'estimation / de vente : une annonce
--      source 'landing' sur le board de prospection (tag LEAD
--      ENTRANT — à distinguer de LeBonCoin / LaCentrale).
-- ══════════════════════════════════════════════════════════════

-- Consentement sans fichier de preuve (formulaire web)
alter table consentements alter column fichier_url drop not null;
alter table consentements drop constraint consentements_origine_check;
alter table consentements add constraint consentements_origine_check
  check (origine in ('depot_manuel','sms_recu','formulaire_web'));

-- Trace de la soumission (objet, message, email…) + clé d'idempotence
alter table consentements add column details jsonb;
alter table consentements add column source_ref text;
create unique index consentements_source_ref_uniq
  on consentements (origine, source_ref);

-- Un consentement web reste valable sans fichier, mais un dépôt manuel
-- ou SMS doit toujours porter sa preuve.
alter table consentements add constraint consentements_preuve_check
  check (origine = 'formulaire_web' or fichier_url is not null);
