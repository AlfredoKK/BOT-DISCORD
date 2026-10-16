-- ══════════════════════════════════════════════════════════════
-- Cycle de vie des consentements (note de conception §4, arbitrages
-- CEO 29/08) :
--   - validité 3 ANS après le dernier dépôt (aligné CNIL prospection,
--     le CEO a écarté les 12 mois de la note) — leads entrants inclus
--     (leur consentement web daté suit la même règle) ;
--   - relance à J-30 (notification, renouvellement par nouveau dépôt —
--     le glisser-déposer de la fiche — ou SMS auto plus tard/Brevo) ;
--   - PURGE AUTOMATIQUE avec notification : fiches jamais venues,
--     sans annonce en ligne, inactives 12 mois → ANONYMISATION
--     (jamais de DELETE : le journal reste pour les stats) ;
--   - preuves (fichiers) effacées du storage à 3 ans, métadonnée datée
--     conservée.
--
-- Anonymisation : nom/email/note effacés, telephone_e164 remplacé par
-- son empreinte sha256 (telephone_hash) — si le scrap réimporte la
-- même personne on la RECONNAÎT au lieu de créer un doublon, sans
-- stocker le numéro en clair. Les oppositions STOP ne sont JAMAIS
-- purgées (la liste vit par numéro dans `oppositions`).
-- ══════════════════════════════════════════════════════════════

-- État calculé — la vue fait foi, aucun batch d'expiration à rater.
create view v_consentement_etat as
select
  personne_id,
  max(depose_at) as dernier_depose_at,
  max(depose_at) + interval '3 years' as expire_le
from consentements
group by personne_id;

comment on view v_consentement_etat is
  'Cycle de vie du consentement par personne : validité 3 ans après le DERNIER dépôt (CEO 29/08, aligné CNIL). Valide si expire_le > now() ; « expire bientôt » si < 30 jours. Renouvellement = nouvelle ligne consentements.';

-- Anonymisation (purge) — la fiche reste, l'identité part.
alter table personnes add column anonymisee_at timestamptz;
alter table personnes add column telephone_hash text;
create index personnes_tel_hash_idx on personnes (telephone_hash) where telephone_hash is not null;

-- Une fiche anonymisée n'a plus de téléphone : le check l'admet.
alter table personnes drop constraint personnes_check;
alter table personnes add constraint personnes_check
  check (telephone_e164 is not null or fusionnee_dans_id is not null or anonymisee_at is not null);

comment on column personnes.anonymisee_at is
  'Purge RGPD (cron consentements-cycle) : identité effacée (nom/email/note/téléphone), telephone_hash conservé pour reconnaître un réimport. Jamais posé sur une fiche venue, avec annonce en ligne, active < 12 mois, ou en opposition STOP.';

-- Preuve purgée à 3 ans : le fichier part du storage, la ligne datée reste.
alter table consentements add column fichier_purge_at timestamptz;
