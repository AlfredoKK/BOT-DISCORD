-- ══════════════════════════════════════════════════════════════
-- Convention couleurs CEO (28/08) :
--   vert → JAUNE (colorId 5, banane)     = PAS VENU (automatique)
--   vert → ORANGE/ROUGE (6, 11) sans le préfixe bot correspondant
--     (VENDU / ANNULÉ) dans le titre     = DEMANDE DE SAV → ticket
--     admin (logique dans /api/admin/agenda-scan, pas une règle simple).
-- Les règles 6/11 restent des propositions vendu/annule quand le
-- préfixe du bot est présent.
-- ══════════════════════════════════════════════════════════════

insert into regles_agenda (type_signal, valeur, effet_statut, effet_mandat, nature) values
  ('couleur', '5', 'pas_venu', null, 'automatique');
