-- ══════════════════════════════════════════════════════════════
-- Fichier client VROOM MARKET (décision CEO 28/08) :
--   1. personnes.etiquettes : étiquettes normalisées et cumulables
--      (vroom_vendeur_mandat, vroom_acheteur, vroom_lead,
--      vroom_estimation, vroom_reserve, …) — un client peut être
--      plusieurs choses à la fois.
--   2. personnes.email : le CSV Vroom a l'email de chaque client —
--      la colonne manquait au CRM.
--   3. sources_externes : TRAÇABILITÉ TOTALE — la ligne source
--      complète (commercial, véhicule, agence, dernière visite…) est
--      conservée en jsonb, rattachée à la personne, idempotente par
--      (source, ref). Interrogeable par l'Assistant Data.
-- ══════════════════════════════════════════════════════════════

alter table personnes add column email text;
alter table personnes add column etiquettes text[];

create table sources_externes (
  id uuid primary key default gen_random_uuid(),
  personne_id uuid not null references personnes(id),
  source text not null,                 -- ex: 'vroom_clients'
  ref text not null,                    -- clé d'idempotence (ex: E.164)
  payload jsonb not null,               -- la ligne source complète
  importee_at timestamptz not null default now(),
  unique (source, ref)
);
create index sources_externes_personne_idx on sources_externes (personne_id);

alter table sources_externes enable row level security;

create index personnes_etiquettes_idx on personnes using gin (etiquettes);
