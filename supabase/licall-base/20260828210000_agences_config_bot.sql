-- ══════════════════════════════════════════════════════════════
-- Config de pose de RDV par agence (reprise de data/agencies.json
-- du bot Discord — docs/BOT_DISCORD_ANALYSE.md) :
--   max_rdv_heure : pic de chevauchements autorisé sur [h, h+1h[
--   opening_hours : { "1": ["09:00","19:30"], ... } par jour ISO (1=lundi),
--                   absent/null = fermé ce jour
--   sheet_onglet  : nom EXACT de l'onglet du sheet BOT (accents compris)
--   paused        : agence en pause (aucune pose)
-- ══════════════════════════════════════════════════════════════

alter table agences
  add column max_rdv_heure int not null default 2,
  add column opening_hours jsonb,
  add column sheet_onglet text,
  add column paused boolean not null default false;
