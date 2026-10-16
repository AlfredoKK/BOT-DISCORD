-- ══════════════════════════════════════════════════════════════
-- KALL KALL DB — Socle (passation technique 27/08/2026 §3,
-- spec Espace SDR 28/08/2026 §1). Migration initiale.
--
-- Principes non négociables (doc) :
--   1. Le statut d'un RDV est un journal (rdv_evenements), jamais
--      un champ mis à jour. L'état courant est une vue.
--   2. Clé naturelle RDV = gcal_event_id (unique) → upsert rejouable.
--   3. Aucune suppression physique d'utilisateur ni d'agence.
--   4. Une personne = un numéro E.164 unique.
--   5. Aucune écriture directe du client : RLS activée partout,
--      zéro policy anon — seul le service_role (API serveur) passe.
-- ══════════════════════════════════════════════════════════════

-- ── Référentiel ────────────────────────────────────────────────

create table agences (
  id uuid primary key default gen_random_uuid(),
  nom text not null unique,
  actif boolean not null default true,
  tarif_rdv_honore numeric(8,2) not null default 80.00,
  gcal_calendar_id text,
  contact jsonb not null default '{}'::jsonb,
  bwa_team_id uuid unique,          -- teamId BWA Partners (ingestion annonces)
  created_at timestamptz not null default now()
);

create table teams (
  id uuid primary key default gen_random_uuid(),
  nom text not null unique,
  tl_user_id uuid,                  -- FK ajoutée après création de users
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  nom text not null,
  prenom text not null default '',
  email text unique,
  role text not null check (role in ('ceo','tl','sdr','rh','support')),
  team_id uuid references teams(id),
  actif boolean not null default true,
  date_entree date,
  date_sortie date,
  onoff_user_id text,               -- rattachement ligne OnOff
  bot_booker_name text,             -- nom exact côté BOT (matching RG-M2.5)
  created_at timestamptz not null default now()
);

alter table teams
  add constraint teams_tl_fk foreign key (tl_user_id) references users(id);

-- ── Répertoire (le cœur du CRM) ────────────────────────────────

-- Normalisation E.164 côté base : utilisée par les ingestions et la
-- recherche ("0623728845", "06 23 72 88 45" et "+33623728845" = même fiche).
create or replace function normalise_telephone(brut text)
returns text
language sql immutable
as $$
  select case
    when brut is null then null
    else (
      with digits as (
        select regexp_replace(trim(brut), '[^0-9+]', '', 'g') as d
      )
      select case
        when d ~ '^\+[1-9][0-9]{6,14}$' then d
        when d ~ '^00[1-9][0-9]{6,14}$' then '+' || substr(d, 3)
        when d ~ '^0[1-9][0-9]{8}$'     then '+33' || substr(d, 2)
        when d ~ '^33[1-9][0-9]{8}$'    then '+' || d
        else null                        -- non conforme → quarantaine
      end
      from digits
    )
  end;
$$;

create table personnes (
  id uuid primary key default gen_random_uuid(),
  telephone_e164 text unique,       -- clé métier ; null interdit sauf fiche fusionnée
  nom text,                         -- souvent absent : afficher « Vendeur — <ville> »
  ville text,
  code_postal text,
  professionnel boolean not null default false,  -- ≥ 5 annonces actives (paramétrable)
  note text,                        -- seule zone de saisie libre de la fiche
  fusionnee_dans_id uuid references personnes(id),
  created_at timestamptz not null default now(),
  check (telephone_e164 is not null or fusionnee_dans_id is not null),
  check (telephone_e164 is null or telephone_e164 ~ '^\+[1-9][0-9]{6,14}$')
);

create table quarantaine_telephones (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  numero_brut text not null,
  payload jsonb,
  motif text not null,
  at timestamptz not null default now()
);

-- ── Annonces (matière de travail, alimentée par BWA) ───────────

create table annonces (
  id uuid primary key default gen_random_uuid(),
  personne_id uuid references personnes(id),   -- null si numéro masqué (hors board)
  source text not null,                        -- ex: LEBONCOIN, LACENTRALE…
  source_id text not null,                     -- id chez BWA : clé d'idempotence
  titre text,
  modele text,
  marque text,
  annee int,
  km int,
  energie text,
  boite text,
  prix numeric(10,2),
  prix_initial numeric(10,2),                  -- conservé à la première vue (baisse)
  url text,
  ville text,
  code_postal text,
  description text,
  en_ligne boolean not null default true,      -- absente du flux 48 h → false
  publiee_at timestamptz,
  maj_at timestamptz,
  importee_at timestamptz not null default now(),
  retiree_at timestamptz,
  agence_id uuid references agences(id),       -- secteur / team BWA d'origine
  unique (source, source_id)
);

create index annonces_personne_idx on annonces (personne_id);
create index annonces_en_ligne_idx on annonces (en_ligne) where en_ligne;

-- Historique de prix : « un prix différent du précédent crée une entrée ».
create table annonces_prix (
  id uuid primary key default gen_random_uuid(),
  annonce_id uuid not null references annonces(id),
  prix numeric(10,2) not null,
  releve_at timestamptz not null default now()
);
create index annonces_prix_idx on annonces_prix (annonce_id, releve_at desc);

-- Journal de statut d'annonce (board) — jamais d'écrasement.
create table annonce_statuts (
  id uuid primary key default gen_random_uuid(),
  annonce_id uuid not null references annonces(id),
  statut text not null check (statut in ('a_contacter','a_rappeler','rdv','non','vendu_ailleurs')),
  motif text,                                  -- obligatoire pour « non » (contrôle API)
  relancable_le date,
  auteur_user_id uuid references users(id),    -- null = automatique (import)
  at timestamptz not null default now()
);
create index annonce_statuts_courant_idx on annonce_statuts (annonce_id, at desc);

-- ── RDV : journal d'événements, pas de colonne statut ──────────

create table rdv (
  id uuid primary key default gen_random_uuid(),
  gcal_event_id text unique,                   -- clé naturelle (26 car. base32hex)
  personne_id uuid references personnes(id),
  annonce_id uuid references annonces(id),
  sdr_user_id uuid references users(id),
  agence_id uuid references agences(id),
  debut_at timestamptz,
  source text not null default 'bot' check (source in ('bot','crm','import')),
  consentement_manquant boolean not null default false,
  created_at timestamptz not null default now()
);
create index rdv_debut_idx on rdv (debut_at);
create index rdv_agence_idx on rdv (agence_id, debut_at);
create index rdv_sdr_idx on rdv (sdr_user_id, debut_at);
create index rdv_consentement_idx on rdv (sdr_user_id) where consentement_manquant;

create table rdv_evenements (
  id uuid primary key default gen_random_uuid(),
  rdv_id uuid not null references rdv(id),
  statut text not null check (statut in ('pris','confirme','venu','pas_venu','annule','sav','vendu')),
  motif text,                                  -- obligatoire pour « pas_venu » (contrôle API)
  mandat text check (mandat in ('signe','sans_mandat')),
  origine text not null check (origine in ('bot','agenda','support','tl','admin','crm')),
  regle text,                                  -- règle d'agenda appliquée le cas échéant
  auteur_user_id uuid references users(id),
  at timestamptz not null default now()
);
create index rdv_evenements_courant_idx on rdv_evenements (rdv_id, at desc);

-- ── Interactions (historique unifié — aucune saisie SDR) ───────

create table interactions (
  id uuid primary key default gen_random_uuid(),
  personne_id uuid not null references personnes(id),
  annonce_id uuid references annonces(id),
  sdr_user_id uuid references users(id),
  type text not null check (type in ('appel','sms')),
  sens text not null check (sens in ('sortant','entrant')),
  at timestamptz not null,
  duree_s int,
  tag text,
  contenu text,
  resume text,
  source text not null check (source in ('onoff','brevo','crm')),
  source_ref text not null,                    -- id de l'événement chez la source
  unique (source, source_ref)
);
create index interactions_personne_idx on interactions (personne_id, at desc);
create index interactions_sdr_idx on interactions (sdr_user_id, at desc);

-- ── Consentements (registre) ───────────────────────────────────

create table consentements (
  id uuid primary key default gen_random_uuid(),
  personne_id uuid not null references personnes(id),
  annonce_id uuid references annonces(id),
  fichier_url text not null,                   -- stockage privé, accès par lien signé
  mime text,
  taille int,
  origine text not null check (origine in ('depot_manuel','sms_recu')),
  depose_par uuid references users(id),
  depose_at timestamptz not null default now()
);
create index consentements_personne_idx on consentements (personne_id);

-- Dépôt d'une pièce → lève consentement_manquant sur les RDV de la
-- personne, sans intervention manuelle (spec §8, recette).
create or replace function lever_consentement_manquant()
returns trigger language plpgsql as $$
begin
  update rdv set consentement_manquant = false
  where personne_id = new.personne_id and consentement_manquant;
  return new;
end;
$$;
create trigger consentement_depose
  after insert on consentements
  for each row execute function lever_consentement_manquant();

-- ── Attribution, verrous, rappels (spec §4-5) ──────────────────

create table attributions (
  id uuid primary key default gen_random_uuid(),
  annonce_id uuid not null references annonces(id),
  sdr_user_id uuid not null references users(id),
  attribuee_at timestamptz not null default now(),
  liberee_at timestamptz,
  motif_liberation text
);
-- Une annonce a AU PLUS une attribution active → « déjà prise » au
-- lieu d'un doublon en cas de clics simultanés.
create unique index attributions_active_uniq on attributions (annonce_id) where liberee_at is null;
create index attributions_sdr_idx on attributions (sdr_user_id) where liberee_at is null;

create table verrous (
  personne_id uuid primary key references personnes(id),
  sdr_user_id uuid not null references users(id),
  expire_at timestamptz not null
);
-- Pose du verrou côté API :
--   insert … on conflict (personne_id) do update set sdr_user_id=…, expire_at=…
--   where verrous.expire_at < now() or verrous.sdr_user_id = excluded.sdr_user_id;

create table rappels (
  id uuid primary key default gen_random_uuid(),
  annonce_id uuid not null references annonces(id),
  sdr_user_id uuid not null references users(id),
  prevu_at timestamptz not null,
  fait_at timestamptz,
  created_at timestamptz not null default now()
);
-- Compteur de retards : indicateur de tête de l'écran SDR.
create index rappels_retard_idx on rappels (sdr_user_id, prevu_at) where fait_at is null;

-- ── Argent (V2 — structure posée dès le socle) ─────────────────

create table remunerations (
  periode text not null,                       -- 'YYYY-MM'
  user_id uuid not null references users(id),
  venus int not null default 0,
  base numeric(10,2) not null default 0,
  primes numeric(10,2) not null default 0,
  challenges numeric(10,2) not null default 0,
  total numeric(10,2) not null default 0,
  figee boolean not null default false,        -- jamais recalculer un mois clos
  figee_at timestamptz,
  primary key (periode, user_id)
);

create table factures_sdr (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  periode text not null,
  montant numeric(10,2) not null,
  statut text not null default 'attendue' check (statut in ('attendue','recue','validee','payee')),
  piece_url text,
  created_at timestamptz not null default now(),
  unique (user_id, periode)
);

-- ── Saisie du soir & agenda (passation §5) ─────────────────────

create table journees_verrouillees (
  date date primary key,
  verrouille_par uuid not null references users(id),
  verrouille_at timestamptz not null default now()
);

-- Règles d'agenda stockées en base, modifiables par l'admin.
create table regles_agenda (
  id uuid primary key default gen_random_uuid(),
  type_signal text not null check (type_signal in ('couleur','mention','suppression','deplacement')),
  valeur text,                                 -- colorId ou mention normalisée
  effet_statut text,                           -- statut rdv_evenements produit
  effet_mandat text check (effet_mandat in ('signe','sans_mandat')),
  nature text not null check (nature in ('automatique','proposition')),
  actif boolean not null default true,
  created_at timestamptz not null default now()
);

-- Titres non reconnus contenant un motif proche : découverte des
-- conventions locales sans développement.
create table agenda_titres_non_reconnus (
  id uuid primary key default gen_random_uuid(),
  agence_id uuid references agences(id),
  gcal_event_id text,
  titre text not null,
  at timestamptz not null default now()
);

-- ── Ingestion : journal d'imports, rejets jamais silencieux ────

create table imports_journal (
  id uuid primary key default gen_random_uuid(),
  source text not null,                        -- bwa | onoff | brevo | sheet_rdv | sheet_finances
  demarre_at timestamptz not null default now(),
  termine_at timestamptz,
  recues int not null default 0,
  creees int not null default 0,
  maj int not null default 0,
  rejetees int not null default 0,
  details jsonb not null default '{}'::jsonb
);

create table imports_rejets (
  id uuid primary key default gen_random_uuid(),
  import_id uuid references imports_journal(id),
  source text not null,
  payload jsonb,
  motif text not null,
  at timestamptz not null default now()
);

-- ── Paramètres (spec §10 — modifiables sans développeur) ───────

create table parametres (
  cle text primary key,
  valeur text not null,
  description text
);

insert into parametres (cle, valeur, description) values
  ('verrou_fiche_minutes',        '15',  'Durée du verrou de fiche, prolongé tant que le SDR agit'),
  ('tentatives_injoignable',      '3',   'Appels et SMS sans réponse confondus'),
  ('relance_apres_non_jours',     '90',  'Délai de relance après un « Non » (modulable par motif)'),
  ('liberation_annonce_jours',    '14',  'Libération auto d''une annonce sans interaction'),
  ('seuil_professionnel_annonces','5',   'Annonces actives → marquage professionnel'),
  ('hors_ligne_apres_heures',     '48',  'Absence du flux BWA → en_ligne = false'),
  ('consentement_taille_max_mo',  '5',   'Taille max d''une pièce (images et PDF)'),
  ('consentement_regularisation_heures','48','Au-delà, remontée dans la liste du TL'),
  ('remuneration_venu_eur',       '30',  'Rémunération SDR par venu'),
  ('facturation_venu_eur',        '80',  'Facturation agence par RDV honoré');

-- Règles d'agenda initiales (passation §5).
insert into regles_agenda (type_signal, valeur, effet_statut, effet_mandat, nature) values
  ('couleur',      '10',    'venu', null,           'automatique'),  -- vert basilic
  ('mention',      'OK M',  'venu', 'signe',        'automatique'),
  ('mention',      'NON M', 'venu', 'sans_mandat',  'automatique'),
  ('suppression',  null,    'annule', null,         'proposition'),
  ('deplacement',  null,    null,   null,           'proposition');  -- report → support

-- ── Vues d'état courant ────────────────────────────────────────

-- L'état courant d'un RDV = dernière ligne du journal.
create view v_rdv_etat as
  select distinct on (rdv_id)
    rdv_id, statut, motif, mandat, origine, regle, auteur_user_id, at
  from rdv_evenements
  order by rdv_id, at desc, id desc;

-- L'état courant du board = dernière ligne de statut par annonce.
create view v_annonce_etat as
  select distinct on (annonce_id)
    annonce_id, statut, motif, relancable_le, auteur_user_id, at
  from annonce_statuts
  order by annonce_id, at desc, id desc;

-- Rappels en retard (l'indicateur de tête du board).
create view v_rappels_retard as
  select r.*, a.titre, a.personne_id
  from rappels r
  join annonces a on a.id = r.annonce_id
  where r.fait_at is null and r.prevu_at < now();

-- ── RLS : tout fermé, seul le service_role (API serveur) passe ─

do $$
declare t record;
begin
  for t in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;
-- Aucune policy créée volontairement : anon et authenticated ne
-- lisent ni n'écrivent rien. Le service_role bypasse la RLS —
-- c'est le principe n°5 (aucune écriture directe du client).
