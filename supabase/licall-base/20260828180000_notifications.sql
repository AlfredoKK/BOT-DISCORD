-- ══════════════════════════════════════════════════════════════
-- Notifications internes (décision CEO 28/08) : un SAV validé par
-- le support notifie le SDR concerné, avec le motif. Table générique
-- pour les usages futurs (mentions de tickets, consentements…).
-- ══════════════════════════════════════════════════════════════

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  type text not null default 'info' check (type in ('sav','ticket','info')),
  titre text not null,
  message text,
  lien text,                       -- id de vue du dashboard (ex: 'sdr-rdv')
  rdv_id uuid references rdv(id),
  lue boolean not null default false,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on notifications (user_id, lue, created_at desc);

alter table notifications enable row level security;
