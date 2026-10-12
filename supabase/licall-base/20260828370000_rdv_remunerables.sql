-- ══════════════════════════════════════════════════════════════
-- v_rdv_remunerables — LA définition unique du « RDV rémunérable »
-- (note de conception §3 règle 4, décision CEO 28/08).
--
-- LEXIQUE (à ne jamais redéfinir ailleurs) :
--   Un RDV est RÉMUNÉRABLE si et seulement si l'état COURANT de son
--   journal (v_rdv_etat, dernier événement) est STRICTEMENT 'venu'.
--   - 'vendu' (voiture déjà vendue) ne rémunère PAS ;
--   - 'sav' ne rémunère PAS ;
--   - le mois de rattachement est celui de debut_at en Europe/Paris.
--   C'est ce RDV qui déclenche : 80 € facturés à l'agence, 30 € au
--   SDR, la prime, la marge. Résultats, Facturation, Rémunérations
--   et l'Assistant Data DOIVENT lire cette vue — jamais recompter.
-- ══════════════════════════════════════════════════════════════

create view v_rdv_remunerables as
select
  r.id as rdv_id,
  r.personne_id,
  r.agence_id,
  r.sdr_user_id,
  r.debut_at,
  (r.debut_at at time zone 'Europe/Paris')::date as jour_paris,
  to_char(r.debut_at at time zone 'Europe/Paris', 'YYYY-MM') as mois_paris
from rdv r
join v_rdv_etat e on e.rdv_id = r.id
where e.statut = 'venu';

comment on view v_rdv_remunerables is
  'Définition UNIQUE du RDV rémunérable : état courant du journal = ''venu'' strict (vendu et sav ne rémunèrent pas), mois = debut_at en Europe/Paris. Toute vue/écran/facture qui parle d''argent lit cette vue.';
