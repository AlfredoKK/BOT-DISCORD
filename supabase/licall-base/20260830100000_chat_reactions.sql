-- ══════════════════════════════════════════════════════════════
-- Messagerie v2 (demande CEO 30/08) — réactions, réponses, accusés
-- de lecture, suppression, gestion des groupes.
--
--   chat_reactions : un emoji, un message, un user (PK triple, donc
--   pas de doublon possible ; re-cliquer sur sa propre réaction la
--   retire côté API). Suppression en cascade avec le message.
--
--   chat_messages.repond_a_id : réponse citée dans le fil. Le message
--   cité peut être plus ancien que la fenêtre de 200 chargée : l'API
--   va le rechercher séparément.
--
--   chat_messages.supprime_at / supprime_par : suppression DOUCE, à la
--   WhatsApp — la bulle devient « message supprimé », la ligne reste
--   (qui a supprimé quoi est traçable ; le contenu est vidé).
--
--   chat_messages.systeme : ligne d'ambiance du fil (« X a ajouté Y »,
--   « groupe renommé ») — affichée centrée, sans bulle ni auteur.
--
--   users.derniere_activite_at : dernier passage dans le CRM. Sert au
--   point de présence et à l'accusé « distribué » (le destinataire a
--   été actif après l'envoi) — MAJ par /api/chat, au plus une fois
--   par minute.
--
-- Additif pur : aucun code existant ne lit ces objets.
-- ══════════════════════════════════════════════════════════════

create table if not exists chat_reactions (
  message_id uuid not null references chat_messages(id) on delete cascade,
  user_id    uuid not null references users(id),
  emoji      text not null check (char_length(emoji) between 1 and 24),
  at         timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
create index if not exists chat_reactions_message_idx on chat_reactions (message_id);
alter table chat_reactions enable row level security;

alter table chat_messages add column if not exists repond_a_id uuid references chat_messages(id);
alter table chat_messages add column if not exists supprime_at timestamptz;
alter table chat_messages add column if not exists supprime_par uuid references users(id);
alter table chat_messages add column if not exists systeme boolean not null default false;

alter table users add column if not exists derniere_activite_at timestamptz;
