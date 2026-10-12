-- ══════════════════════════════════════════════════════════════
-- Chat interne (décision CEO 28/08).
-- Périmètres de conversation :
--   dm     : 2 personnes (SDR↔SDR, TL↔SDR, admin/TL/CEO → n'importe qui)
--   team   : canal d'équipe (TL + ses SDR)
--   admin  : canal des admins (+ CEO)
--   groupe : groupe ad hoc (créé par ceo/admin/tl)
-- Le droit d'INITIER est contrôlé par l'API (les SDR n'initient que
-- vers SDR/TL) ; répondre est ouvert à tout membre de la conversation.
-- Les non-lus du chat sont SÉPARÉS des notifications de travail :
-- ils se calculent via conversation_membres.dernier_lu_at (pas de
-- ligne dans `notifications`).
-- ══════════════════════════════════════════════════════════════

create table conversations (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('dm','team','admin','groupe')),
  nom text,                                   -- canaux/groupes ; null pour un dm
  team_id uuid references teams(id),          -- canaux team
  dm_key text unique,                         -- dm : ids des 2 users triés + joints (dédup)
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table conversation_membres (
  conversation_id uuid not null references conversations(id),
  user_id uuid not null references users(id),
  ajoute_at timestamptz not null default now(),
  dernier_lu_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index conversation_membres_user_idx on conversation_membres (user_id);

create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id),
  auteur_user_id uuid not null references users(id),
  contenu text not null,
  created_at timestamptz not null default clock_timestamp()
);
create index chat_messages_conv_idx on chat_messages (conversation_id, created_at desc);

-- Canaux de base : un par team (TL + SDR actifs) + le canal admin (+ CEO).
do $$
declare t record; conv uuid;
begin
  for t in select id, nom, tl_user_id from teams loop
    insert into conversations (type, nom, team_id)
      values ('team', t.nom, t.id) returning id into conv;
    insert into conversation_membres (conversation_id, user_id)
      select conv, u.id from users u
      where u.actif and (u.team_id = t.id or u.id = t.tl_user_id)
      on conflict do nothing;
  end loop;
  insert into conversations (type, nom) values ('admin', 'Admins') returning id into conv;
  insert into conversation_membres (conversation_id, user_id)
    select conv, u.id from users u where u.actif and u.role in ('admin','ceo')
    on conflict do nothing;
end $$;

alter table conversations        enable row level security;
alter table conversation_membres enable row level security;
alter table chat_messages        enable row level security;
