# Supabase — bases Licall et Kall Kall

## Principe

Deux bases **strictement séparées**, une par société, avec la **même structure** :

| Société | Projet Supabase | Serveur Discord | Classeur Sheets (transition) |
|---|---|---|---|
| Licall | `zvfhhcxsdzyubufmexng` | Licall `1443725425904848959` | `16H-aZ8eV9M5Qd5ZToWFSluZFbtHKdP0wcS3mtBK_mzI` |
| Kall Kall | `cegswxmdpsvzqrjplcvy` (base du dashboard KallKall) | Kall Kall `1445676914667946085` | `1dshz0ZhA44VziYOirOwQj_AQFRJxehsV7yZnZ5LJ0BU` |

Aucune table, vue ou fonction ne relie les deux bases. Le bot possède une
connexion par base et route chaque agence vers la sienne. Un SDR Licall
n'existe pas dans la base Kall Kall, et inversement.

## Structure

La structure de référence est celle du dashboard KallKall
(`AlfredoKK/kallkall-dashboard`, 42 migrations). Elle a été appliquée telle
quelle à la base Licall le 12/10/2026 (copie dans `supabase/licall-base/`),
puis la migration commune `supabase/common/20261012120000_bot_integration.sql`
a été appliquée aux deux bases.

Tables utilisées par le bot :

- `agences` : identité, calendrier Google, plafond horaire, horaires, pause,
  canal Discord, classeur et onglet Sheets (transition).
- `users` : SDR, Team Lead, admins. `discord_user_id` rattache un compte
  Discord ; `users_alias` absorbe les variantes de noms.
- `rdv` : un RDV = une ligne, clé naturelle `gcal_event_id`. Confirmation
  (J/J, J+1, CONF, NON CONF), véhicule, commentaire, liens, type (agence ou
  domicile).
- `rdv_evenements` : journal des statuts (pris, confirmé, venu, pas venu,
  annulé, SAV, vendu). L'état courant est la vue `v_rdv_etat`.
- `personnes` : clients, clé = téléphone E.164.
- `bot_journal` : chaque action du bot avec le résultat Sheets et base,
  pour le rapport de cohérence pendant la transition.
- `v_export_sheet` : export au format de l'ancien Sheet.

Les suppressions physiques d'agences et d'utilisateurs sont interdites par
trigger : « supprimer » = `actif = false`.

## Gestion des agences et des SDR

Trois voies, toutes sur les mêmes tables :

1. Discord : `/rdvadmin config | pause | play | horaires`.
2. Dashboard KallKall, écran « Gestion des agences » (fonction
   `referentiel_ecrire`, auditée dans `referentiel_audit`).
3. Éditeur de tables Supabase, pour Licall en attendant son dashboard.

## Rejouer une évolution de structure

Toute migration future du dashboard KallKall se rejoue sur Licall à
l'identique, puis toute migration du bot (dossier `supabase/common/`) se
rejoue sur les deux bases. Ne jamais appliquer une migration à une seule
des deux bases.

## Archive

`supabase/archive-2026-06/` contient l'ancien schéma d'essai (mai 2026) qui
occupait la base Licall. Il est conservé dans la base dans le schéma
`archive_sandbox_2026_06`, à supprimer après validation de la bascule.
