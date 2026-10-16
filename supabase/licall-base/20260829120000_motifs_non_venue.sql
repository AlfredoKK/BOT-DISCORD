-- ══════════════════════════════════════════════════════════════
-- Motifs de non-venue en liste fermée (note de conception §4.10,
-- spec RÉVISÉE par le CEO le 28/08, go le 29/08).
--
-- RÈGLES :
--   1. La liste n'est PAS strictement obligatoire : « des fois on n'a
--      pas la raison » → code 'inconnu' permis.
--   2. RÈGLE AUTOMATIQUE : si le RDV n'a JAMAIS été confirmé (aucun
--      événement 'confirme' dans son journal), le motif est posé
--      AUTOMATIQUEMENT à 'pas_de_conf' par l'API de saisie — sans
--      saisie humaine. C'est LE signal diagnostic n°1 (la conf J-1
--      appartient aux SDR).
--   3. Les 7 motifs de la note restent la base, + pas_de_conf (auto)
--      + inconnu. `motif` (texte libre) reste le commentaire humain.
-- ══════════════════════════════════════════════════════════════

alter table rdv_evenements add column motif_code text
  check (motif_code is null or motif_code in (
    'oubli', 'imprevu', 'vehicule_vendu', 'mauvaise_qualif',
    'mauvaise_adresse', 'agence_injoignable', 'pas_rappele_j1',
    'pas_de_conf', 'inconnu'
  ));

comment on column rdv_evenements.motif_code is
  'Motif de non-venue en liste fermée (événements pas_venu) : 7 motifs déclaratifs + pas_de_conf (posé AUTOMATIQUEMENT quand le RDV n''a aucun événement confirme) + inconnu (raison non connue, permise). motif reste le commentaire libre.';

create index rdv_evenements_motif_code_idx on rdv_evenements (motif_code) where motif_code is not null;

-- v_rdv_etat expose le code (colonne AJOUTÉE EN FIN — le contrat des
-- colonnes existantes ne bouge pas, v_rdv_remunerables inchangée).
create or replace view v_rdv_etat as
  select distinct on (rdv_id)
    rdv_id, statut, motif, mandat, origine, regle, auteur_user_id, at, motif_code
  from rdv_evenements
  order by rdv_id, at desc, id desc;
