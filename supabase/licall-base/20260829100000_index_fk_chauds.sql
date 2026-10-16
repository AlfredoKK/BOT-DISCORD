-- ══════════════════════════════════════════════════════════════
-- Index manquants sur les FK des chemins chauds (audit DB 29/08).
-- rdv.personne_id est LA jointure de la fiche client et de la base
-- clients ; les autres portent les agrégats fiche/board. Invisible à
-- 7 000 RDV, pénalisant à 15 000+/an.
-- ══════════════════════════════════════════════════════════════

create index rdv_personne_idx on rdv (personne_id);
create index rdv_annonce_idx on rdv (annonce_id);
create index interactions_annonce_idx on interactions (annonce_id);
create index consentements_annonce_idx on consentements (annonce_id);
-- Partiel : la quasi-totalité des personnes ne sont pas fusionnées.
create index personnes_fusion_idx on personnes (fusionnee_dans_id) where fusionnee_dans_id is not null;
