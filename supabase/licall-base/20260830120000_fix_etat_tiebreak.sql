-- ══════════════════════════════════════════════════════════════
-- CRITIQUE (PAIE) — Départage déterministe de v_rdv_etat à `at` égal.
--
-- BUG (régression). L'import bot (scripts/import-rdv.ts) insère, pour
-- un même RDV, l'événement 'pris' ET son résultat ('venu'/'pas_venu'/
-- 'annule'/'sav'/'vendu') au MÊME timestamp `at` (= l'heure du RDV).
-- v_rdv_etat fait `distinct on (rdv_id) ... order by at desc, id desc` :
-- à `at` égal le départage tombe sur l'id UUID (aléatoire) → ~50 % du
-- temps 'pris' l'emporte et MASQUE le résultat. Mesuré : la vue ne voit
-- que 651 venus en août au lieu de 1 244 réellement présents dans le
-- journal. Comme v_rdv_remunerables dérive de v_rdv_etat, la paie/
-- cagnotte SOUS-COMPTENT les venus de ~50 %.
--
-- Historique : 20260828160000_ordre_journal.sql avait déjà corrigé ce
-- point via `inserted_at` dans l'ORDER BY. Mais 20260829120000_
-- motifs_non_venue.sql a redéfini la vue en RETIRANT `inserted_at` de
-- l'ORDER BY (retour à `at desc, id desc`) — d'où la réapparition du bug.
--
-- CORRECTIF. On garde `at desc` comme critère PRIMAIRE (un vrai
-- changement d'état ultérieur, saisi via l'app à `at = now()` — donc à
-- timestamp STRICTEMENT postérieur —, reste toujours l'état courant :
-- un 'pas_venu' saisi le soir après coup ne redevient pas 'venu'). On
-- ajoute, UNIQUEMENT à `at` STRICTEMENT égal, un départage par PRIORITÉ
-- DE STATUT : un résultat l'emporte sur 'pris'. `id desc` reste le
-- dernier recours.
--
-- Sûreté prouvée sur les données réelles (30/08) : les seules collisions
-- au même (rdv_id, at) sont 'pris'+résultat (pris+venu, pris+pas_venu,
-- pris+annule, pris+sav, pris+vendu). ZÉRO collision résultat+résultat :
-- l'ordre relatif entre résultats n'est jamais exercé par les données,
-- et aucune paire contradictoire de deux résultats ne partage un `at`.
-- Effet simulé (lecture seule, avant application) : août 651 → 1 240,
-- juillet 788 → 1 649 ; 0 RDV bascule 'venu' → non-venu ; les 1 472
-- bascules sont toutes 'pris' → 'venu' (la réparation attendue).
--
-- Priorité (plus grand = gagne à `at` égal) — un état terminal/résultat
-- prime toujours 'pris' et 'confirme', qui ne sont que des jalons :
--   vendu > sav > venu > pas_venu > annule > confirme > pris
-- ══════════════════════════════════════════════════════════════

create or replace view v_rdv_etat as
  select distinct on (rdv_id)
    rdv_id, statut, motif, mandat, origine, regle, auteur_user_id, at, motif_code
  from rdv_evenements
  order by
    rdv_id,
    at desc,                         -- PRIMAIRE : l'événement le plus récent
    case statut                      -- DÉPARTAGE à `at` STRICTEMENT égal
      when 'vendu'    then 6
      when 'sav'      then 5
      when 'venu'     then 4
      when 'pas_venu' then 3
      when 'annule'   then 2
      when 'confirme' then 1
      when 'pris'     then 0
      else -1
    end desc,
    id desc;                         -- dernier recours (déterminisme total)

comment on view v_rdv_etat is
  'État courant d''un RDV = dernière ligne du journal. Départage à `at` strictement égal par PRIORITÉ DE STATUT (résultat > pris/confirme) : corrige le sous-comptage des venus dû aux events pris+résultat importés au même timestamp. `at desc` reste primaire (un vrai changement ultérieur, à `at` distinct, gagne toujours).';
