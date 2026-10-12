-- ══════════════════════════════════════════════════════════════
-- Règles d'agenda — correction après analyse du bot Discord
-- (docs/BOT_DISCORD_ANALYSE.md).
--
-- ⚠️ La règle « couleur 10 (vert basilic) = venu » de la passation
-- est FAUSSE : le bot pose le vert 10 à la CRÉATION de chaque RDV.
-- L'appliquer marquerait « venu » (et facturerait 80 €) tous les RDV.
-- Désactivée. Les signaux fiables sont les MENTIONS posées à la main
-- par les agences dans les titres : OK M / MANDAT OK / NON M /
-- NON MANDAT / SANS MANDAT.
--
-- Garantie passation §5(c) : l'automatisme ne se déclenche jamais
-- dans un sens FAVORABLE à l'agence. « venu » facture l'agence →
-- automatique OK. « pas_venu » / « vendu » ne facturent pas →
-- PROPOSITION uniquement (couleurs 8 graphite et 6 mandarine).
-- ══════════════════════════════════════════════════════════════

update regles_agenda set actif = false
  where type_signal = 'couleur' and valeur = '10';

insert into regles_agenda (type_signal, valeur, effet_statut, effet_mandat, nature) values
  ('mention', 'MANDAT OK',   'venu', 'signe',       'automatique'),
  ('mention', 'OK MANDAT',   'venu', 'signe',       'automatique'),
  ('mention', 'NON MANDAT',  'venu', 'sans_mandat', 'automatique'),
  ('mention', 'SANS MANDAT', 'venu', 'sans_mandat', 'automatique'),
  ('couleur', '8',  'pas_venu', null, 'proposition'),   -- graphite (manuel agences)
  ('couleur', '6',  'vendu',    null, 'proposition'),   -- mandarine (VENDU)
  ('couleur', '11', 'annule',   null, 'proposition');   -- tomate (ANNULÉ)
