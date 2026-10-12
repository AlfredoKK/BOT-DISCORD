-- ══════════════════════════════════════════════════════════════
-- Messagerie v2, suite (demande CEO 30/08) — pièces jointes, épingle,
-- sondages, statut perso, canaux d'agence.
--
--   chat_messages.piece_jointe : jsonb décrivant CE qui accompagne le
--   message — {type:'image'|'fiche'|'rdv'|'sondage', …}. Un seul objet
--   par message ; le contenu texte reste dans `contenu`.
--
--   chat_messages.epingle_at / epingle_par : le message épinglé en tête
--   de conversation (la consigne du jour). Un seul actif à la fois par
--   conversation — l'API dépingle l'ancien.
--
--   chat_sondage_votes : une voix par personne et par sondage (PK sur
--   (message_id, user_id)), revoter écrase, recliquer retire.
--
--   users.statut_chat : dispo / rdv / pause / nepasderanger. Affiché à
--   côté de l'avatar ; 'nepasderanger' coupe le son des notifications.
--
--   conversations.type 'agence' + agence_id : un canal par agence
--   active, alimenté par /api/admin/chat-canaux (idempotent).
--
--   bucket storage 'chat' : privé, les images passent par
--   /api/chat/fichier qui vérifie l'appartenance à la conversation.
--
-- Additif pur, en dehors de la contrainte de type des conversations
-- qui est étendue (aucune valeur existante n'est perdue).
-- ══════════════════════════════════════════════════════════════

alter table chat_messages add column if not exists piece_jointe jsonb;
alter table chat_messages add column if not exists epingle_at timestamptz;
alter table chat_messages add column if not exists epingle_par uuid references users(id);

create index if not exists chat_messages_epingle_idx
  on chat_messages (conversation_id) where epingle_at is not null;

create table if not exists chat_sondage_votes (
  message_id uuid not null references chat_messages(id) on delete cascade,
  user_id    uuid not null references users(id),
  option_index smallint not null check (option_index between 0 and 5),
  at         timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index if not exists chat_sondage_votes_message_idx on chat_sondage_votes (message_id);
alter table chat_sondage_votes enable row level security;

alter table users add column if not exists statut_chat text
  check (statut_chat in ('dispo', 'rdv', 'pause', 'nepasderanger'));
alter table users add column if not exists statut_chat_at timestamptz;

alter table conversations drop constraint if exists conversations_type_check;
alter table conversations add constraint conversations_type_check
  check (type in ('dm', 'team', 'admin', 'groupe', 'agence'));
alter table conversations add column if not exists agence_id uuid references agences(id);
create unique index if not exists conversations_agence_idx
  on conversations (agence_id) where agence_id is not null;

insert into storage.buckets (id, name, public)
  values ('chat', 'chat', false)
  on conflict (id) do nothing;
