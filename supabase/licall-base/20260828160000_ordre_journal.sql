-- ══════════════════════════════════════════════════════════════
-- Ordre déterministe du journal RDV.
--
-- Bug réel (import ×2) : deux événements créés au même `at` (le
-- « pris » et son résultat, importés ensemble) se départageaient par
-- id UUID — aléatoire. v_rdv_etat rendait parfois « pris » au lieu du
-- résultat, et chaque rejeu réinsérait le résultat (3 389 doublons).
-- Fix : inserted_at = clock_timestamp() (monotone dans une même
-- transaction, contrairement à now()) comme clé de départage.
-- ══════════════════════════════════════════════════════════════

alter table rdv_evenements
  add column inserted_at timestamptz not null default clock_timestamp();

-- Backfill : la sémantique métier de l'import — le « pris » précède
-- toujours son résultat posé au même instant.
update rdv_evenements
  set inserted_at = at + case when statut = 'pris' then interval '0 sec' else interval '1 sec' end;

-- Dédoublonnage des résultats réinsérés par les rejeux (mêmes
-- rdv_id/statut/at/origine) : on garde une seule ligne.
delete from rdv_evenements a
  using rdv_evenements b
  where a.id > b.id
    and a.rdv_id = b.rdv_id
    and a.statut = b.statut
    and a.at = b.at
    and a.origine = b.origine
    and a.origine = 'bot';

create or replace view v_rdv_etat as
  select distinct on (rdv_id)
    rdv_id, statut, motif, mandat, origine, regle, auteur_user_id, at
  from rdv_evenements
  order by rdv_id, at desc, inserted_at desc, id desc;
