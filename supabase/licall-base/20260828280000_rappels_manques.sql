-- ══════════════════════════════════════════════════════════════
-- Rappels manqués (décision CEO 28/08) — libération automatique.
--
-- Un rappel non fait 24 h après sa date/heure prévue entraîne la
-- LIBÉRATION automatique de la fiche (cron /api/cron/liberer-fiches).
-- `manque_at` marque le rappel comme traité par le cron : il n'est
-- plus une tâche du SDR (la fiche est redevenue libre) et il ne sera
-- pas retraité. JAMAIS de suppression — historique complet conservé.
-- ══════════════════════════════════════════════════════════════

alter table rappels add column manque_at timestamptz;

comment on column rappels.manque_at is
  'Posé par le cron liberer-fiches : rappel non fait 24 h après prevu_at → fiche libérée automatiquement. Jamais retraité ensuite.';

-- Balayage du cron : rappels ouverts (ni faits, ni manqués) par échéance.
create index rappels_a_liberer_idx on rappels (prevu_at)
  where fait_at is null and manque_at is null;

-- v_rappels_retard : un rappel manqué n'est PLUS un retard du SDR —
-- la fiche a été libérée, elle ne pilote plus sa journée.
-- (drop + create : « create or replace » refuserait l'insertion de la
-- colonne manque_at au milieu de la liste des colonnes existantes.)
drop view v_rappels_retard;
create view v_rappels_retard as
  select r.*, a.titre, a.personne_id
  from rappels r
  join annonces a on a.id = r.annonce_id
  where r.fait_at is null and r.manque_at is null and r.prevu_at < now();
