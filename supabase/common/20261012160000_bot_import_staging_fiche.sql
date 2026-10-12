-- ══════════════════════════════════════════════════════════════
-- bot_import_staging : nouveau type de ligne « fiche » (fiche SDR du
-- classeur RH : nom, prénom, mail, rôle, actif, dates d'entrée/sortie).
-- À appliquer sur les DEUX bases (Licall et Kall Kall).
-- ══════════════════════════════════════════════════════════════
alter table bot_import_staging drop constraint if exists bot_import_staging_kind_check;
alter table bot_import_staging
  add constraint bot_import_staging_kind_check check (kind in ('sdr', 'personne', 'rdv', 'fiche'));
