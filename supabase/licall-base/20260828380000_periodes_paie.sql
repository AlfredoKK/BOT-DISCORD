-- ══════════════════════════════════════════════════════════════
-- Gel des périodes de paie (note de conception §4.2, décision CEO
-- 28/08) : « une prime affichée le vendredi soir ne bouge plus
-- jamais ».
--
-- Modèle :
--   periodes_paie                 — l'état d'un mois : ouverte | gelee.
--                                   Le gel est DÉFINITIF (pas de dégel).
--   remunerations_gel             — le SNAPSHOT ligne à ligne écrit au
--                                   moment du gel, depuis
--                                   v_rdv_remunerables (LA définition du
--                                   venu rémunérable — jamais recompté).
--                                   Un mois gelé est servi depuis ici,
--                                   jamais recalculé.
--   remunerations_regularisations — une saisie tardive sur un mois GELÉ
--                                   ne réécrit JAMAIS le passé : l'écart
--                                   (calcul courant vs snapshot, net des
--                                   régularisations déjà émises) devient
--                                   une ligne ici, imputée sur le
--                                   premier mois ouvert (celui qu'on est
--                                   en train de geler).
--
-- RLS activée partout, ZÉRO policy (pattern maison) : seul le
-- serveur Next via service_role lit/écrit.
-- ══════════════════════════════════════════════════════════════

create table periodes_paie (
  mois text primary key check (mois ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  statut text not null default 'ouverte' check (statut in ('ouverte', 'gelee')),
  gelee_at timestamptz,
  gelee_par uuid references users(id),
  created_at timestamptz not null default now(),
  -- Un mois gelé porte forcément sa date de gel.
  check (statut = 'ouverte' or gelee_at is not null)
);
comment on table periodes_paie is
  'État de chaque mois de paie (YYYY-MM). Gel DÉFINITIF par le CEO : aucun dégel, jamais.';

create table remunerations_gel (
  id uuid primary key default gen_random_uuid(),
  mois text not null references periodes_paie(mois),
  sdr_user_id uuid not null references users(id),
  nb_venus integer not null check (nb_venus >= 0),
  montant_eur numeric(10, 2) not null,
  detail jsonb,
  created_at timestamptz not null default now(),
  unique (mois, sdr_user_id)
);
comment on table remunerations_gel is
  'Snapshot ligne à ligne des rémunérations au moment du gel (source : v_rdv_remunerables). Jamais modifié ensuite.';

create table remunerations_regularisations (
  id uuid primary key default gen_random_uuid(),
  mois_origine text not null references periodes_paie(mois),
  mois_imputation text not null references periodes_paie(mois),
  sdr_user_id uuid not null references users(id),
  delta_venus integer not null,
  delta_eur numeric(10, 2) not null,
  motif text not null,
  created_at timestamptz not null default now(),
  -- Le passé ne bouge jamais : une régularisation s'impute forcément
  -- sur un mois POSTÉRIEUR au mois gelé d'origine.
  check (mois_imputation > mois_origine)
);
comment on table remunerations_regularisations is
  'Écarts détectés sur un mois GELÉ (saisie tardive) : le snapshot d''origine ne bouge pas, le delta s''impute sur le premier mois ouvert.';

create index remunerations_gel_mois_idx on remunerations_gel (mois);
create index remu_regul_imputation_idx on remunerations_regularisations (mois_imputation);
create index remu_regul_origine_sdr_idx on remunerations_regularisations (mois_origine, sdr_user_id);

alter table periodes_paie enable row level security;
alter table remunerations_gel enable row level security;
alter table remunerations_regularisations enable row level security;

-- ── Reprise de l'existant ───────────────────────────────────────
-- Les mois déjà figés par l'ancien mécanisme (remunerations.figee,
-- RG-A5 — en prod : 2026-06) deviennent des périodes gelées avec leur
-- snapshot copié tel quel : leurs montants annoncés ne bougent pas.
insert into periodes_paie (mois, statut, gelee_at)
select periode, 'gelee', coalesce(min(figee_at), now())
from remunerations
where figee
group by periode
on conflict (mois) do nothing;

insert into remunerations_gel (mois, sdr_user_id, nb_venus, montant_eur, detail)
select
  periode,
  user_id,
  venus,
  total,
  jsonb_build_object(
    'base', base,
    'primes', primes,
    'challenges', challenges,
    'source', 'reprise remunerations.figee (ancien RG-A5)'
  )
from remunerations
where figee
on conflict (mois, sdr_user_id) do nothing;

-- ── Garde-fou backfill (relecture 28/08 soir) ─────────────────
-- Les snapshots de 2026-06 ET 2026-07 viennent de l'ANCIEN système
-- (sheets figés) : juin n'est pas couvert par le journal (43 vs 1623)
-- et juillet a été PAYÉ sur la base sheet (1663 vs 1650 au journal) —
-- re-comparer émettrait des régularisations fantômes ou reprendrait
-- rétroactivement de l'argent déjà versé. Décision : les mois payés
-- pré-CRM restent tels qu'annoncés ; le gel CRM commence avec août. Une période non `recomparable`
-- a pour seule vérité son snapshot — la boucle de gel l'ignore.
alter table periodes_paie add column recomparable boolean not null default true;
update periodes_paie set recomparable = false where mois <= '2026-07';
comment on column periodes_paie.recomparable is
  'false = snapshot issu du backfill pré-CRM : le journal ne peut pas recalculer ce mois, on ne le recompare jamais.';
