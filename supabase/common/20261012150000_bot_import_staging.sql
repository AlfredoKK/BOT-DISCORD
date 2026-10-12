-- ══════════════════════════════════════════════════════════════
-- Zone de dépôt pour l'import d'historique (scripts/import-history.js,
-- mode « stage ») — migration COMMUNE, appliquée aux deux bases.
--
-- Le script dépose les lignes du plan d'import (SDR, clients, RDV) en jsonb,
-- puis un SQL court (merge_<lot>.sql) les fusionne dans les vraies tables de
-- façon idempotente et vide le lot. RLS active sans policy : seul le
-- service_role lit et écrit. Aucune donnée n'y reste après fusion.
-- ══════════════════════════════════════════════════════════════
create table if not exists bot_import_staging (
  id      bigserial primary key,
  lot     text        not null,
  kind    text        not null check (kind in ('sdr', 'personne', 'rdv')),
  payload jsonb       not null,
  at      timestamptz not null default now()
);
create index if not exists bot_import_staging_lot_idx on bot_import_staging (lot, kind);
alter table bot_import_staging enable row level security;
comment on table bot_import_staging is 'Dépôt temporaire de l''import d''historique (scripts/import-history.js --mode stage). Vidé par merge_<lot>.sql.';
