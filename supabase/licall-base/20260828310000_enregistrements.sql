-- ══════════════════════════════════════════════════════════════
-- Enregistrements d'appels (pilote résumés IA — décision CEO 28/08) :
--   - bucket privé « enregistrements » : audio des appels « Rdv pris »
--     téléchargé depuis OnOff (l'URL S3 OnOff expire en 600 s — on
--     stocke NOTRE copie, servie uniquement par lien signé côté
--     serveur via GET /api/sdr/enregistrement, rôles tl/admin/ceo) ;
--   - interactions.enregistrement_path : chemin dans le bucket
--     (appels/YYYY/MM/<id-b2b>.mp4), posé par /api/cron/call-resumes
--     dès l'upload — permet de reprendre une transcription échouée
--     sans retélécharger (l'URL OnOff serait morte).
-- RLS : storage.objects est déjà sous RLS sans policy (bucket privé,
-- accès service_role uniquement) ; interactions déjà sous RLS (socle).
-- ══════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public)
values ('enregistrements', 'enregistrements', false)
on conflict (id) do nothing;

alter table interactions
  add column if not exists enregistrement_path text;
