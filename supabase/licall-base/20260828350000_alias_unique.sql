-- ══════════════════════════════════════════════════════════════
-- Audit sécurité 28/08 (MINEUR 2) : resoudreAuteur — qui porte le
-- scoping SDR (activité, notes, périmètre d'écriture) — résout
-- « Prénom NOM » via users_alias. Un homonyme rattaché à un AUTRE
-- user ferait deviner la résolution. Ceinture (code : refus bruyant
-- si ambigu) ET bretelles (DB : ce trigger). Un index unique simple
-- est impossible : les doublons même-user sont légitimes (un alias
-- par source bot/onoff/sheet — 428 lignes, 227 alias, 0 collision
-- inter-users au 28/08). La règle exacte : un alias_norm ne peut
-- jamais pointer vers deux users différents.
-- ══════════════════════════════════════════════════════════════

create or replace function users_alias_un_seul_user() returns trigger as $$
begin
  if exists (
    select 1 from users_alias
    where alias_norm = new.alias_norm and user_id <> new.user_id
  ) then
    raise exception 'users_alias : « % » est déjà rattaché à un autre user — homonyme interdit (audit 28/08)', new.alias_norm;
  end if;
  return new;
end $$ language plpgsql;

create trigger users_alias_un_seul_user
before insert or update on users_alias
for each row execute function users_alias_un_seul_user();
