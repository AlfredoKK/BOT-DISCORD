-- ══════════════════════════════════════════════════════════════
-- Perf (audit de charge 28/08, cible 200 users simultanés).
--
-- 1) chat_liste(p_user) : la liste du chat en UNE requête SQL
--    (jointures latérales) au lieu de 2 requêtes PAR conversation
--    (N+1 : dernier message + count non-lus). Appelée par
--    GET /api/chat via .rpc() — polling ChatBadge/Chat.
--
-- 2) Index manquants sur les chemins chauds :
--    - rappels (annonce_id) partiel : GET /api/sdr/board fait
--      .in('annonce_id', …).is('fait_at', null) — seul l'index
--      (sdr_user_id, prevu_at) existait.
--    - annonces board partiel : en_ligne + personne_id non null,
--      trié publiee_at desc = exactement la requête du board.
--    - notifications (user_id, created_at desc) : la cloche trie
--      par created_at sans filtrer sur lue ; l'index existant
--      (user_id, lue, created_at) ne sert pas ce tri.
-- ══════════════════════════════════════════════════════════════

create or replace function chat_liste(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',         c.id,
        'type',       c.type,
        'nom',        c.nom,
        'created_at', c.created_at,
        'membres',    m.ids,
        'dernier',    d.msg,
        'non_lus',    coalesce(n.cnt, 0)
      )
      order by coalesce(d.at, c.created_at) desc
    ),
    '[]'::jsonb
  )
  from conversation_membres cm
  join conversations c on c.id = cm.conversation_id
  cross join lateral (
    select coalesce(jsonb_agg(cm2.user_id), '[]'::jsonb) as ids
    from conversation_membres cm2
    where cm2.conversation_id = c.id
  ) m
  left join lateral (
    select jsonb_build_object(
             'contenu', msg.contenu,
             'auteur_user_id', msg.auteur_user_id,
             'at', msg.created_at
           ) as msg,
           msg.created_at as at
    from chat_messages msg
    where msg.conversation_id = c.id
    order by msg.created_at desc
    limit 1
  ) d on true
  left join lateral (
    select count(*) as cnt
    from chat_messages msg
    where msg.conversation_id = c.id
      and msg.auteur_user_id <> p_user
      and (cm.dernier_lu_at is null or msg.created_at > cm.dernier_lu_at)
  ) n on true
  where cm.user_id = p_user;
$$;

-- service_role uniquement (principe « aucune écriture directe du client »)
revoke execute on function chat_liste(uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function chat_liste(uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function chat_liste(uuid) from authenticated;
  end if;
end $$;

-- ── Index manquants ────────────────────────────────────────────

create index if not exists rappels_annonce_ouvert_idx
  on rappels (annonce_id, prevu_at)
  where fait_at is null;

create index if not exists annonces_board_idx
  on annonces (publiee_at desc)
  where en_ligne and personne_id is not null;

create index if not exists notifications_user_recent_idx
  on notifications (user_id, created_at desc);
