# Rapport pour les devs — migration Sheets → Supabase du bot RDV MANDAT

Date : 12 octobre 2026. Dépôt : `AlfredoKK/BOT-DISCORD`, branche `feat/supabase-schema`, PR #14 (ouverte, non mergée). Référence détaillée : [passation-supabase.md](passation-supabase.md).

## En une phrase

Le bot en production fonctionne exactement comme avant (Google Calendar + Google Sheets). Toute la couche Supabase est construite, testée et documentée, mais **éteinte** (`DB_WRITE_ENABLED=false`). La base Licall contient déjà tout l'historique. Il reste à allumer, observer dix jours, enrichir Kall Kall, puis basculer.

## Règle absolue

**Licall = Licall, Kall Kall = Kall Kall, jamais de mélange.** Deux projets Supabase, même structure, aucune table ni fonction qui les relie. Une agence est routée vers une base ou vers aucune.

| Société | Projet Supabase | Rôle |
|---|---|---|
| Licall | `zvfhhcxsdzyubufmexng` | nouvelle base, chargée le 12/10 |
| Kall Kall | `cegswxmdpsvzqrjplcvy` | base de production du dashboard `kallkall-dashboard` |

## Ce qui a été fait

### 1. Structure
- Les 42 migrations du dashboard Kall Kall rejouées à l'identique sur Licall (copies dans `supabase/licall-base/`). L'ancien schéma d'essai de Licall est archivé dans le schéma `archive_sandbox_2026_06`, pas supprimé.
- Trois migrations communes dans `supabase/common/`, appliquées **aux deux bases** : `bot_integration` (colonnes Discord/bot sur `agences`, `users`, `rdv`, table `bot_journal`, vue `v_export_sheet`), `bot_import_staging` (table de dépôt pour les imports) et `bot_import_staging_fiche`.
- Référentiel chargé : 18 agences Licall depuis `agencies.json`, 37 agences Kall Kall reliées à leur canal Discord.

### 2. Code du bot (PR #14)
- `src/services/supabase.js` : client PostgREST sans SDK, une connexion par société, routage par classeur puis par serveur Discord.
- `src/services/rdv-db.js` : double écriture. Chaque action `/rdv` (add, dom, conf, modifier, annuler, vendu, supprimer) écrit d'abord Calendar et Sheets comme avant, puis la base de la société. Idempotent sur `gcal_event_id`, jamais bloquant (une erreur base est journalisée et signalée, la commande Discord répond normalement).
- SDR : rattachement automatique par alias, `/rdvadmin sdr` pour lier un membre Discord à un utilisateur. Agences : `/rdvadmin config | pause | play | horaires | deconfig` mises en miroir dans la base (horaires convertis au format du dashboard, agence retrouvée par nom avant toute création).
- Exploitation : `/rdvadmin db` (état des connexions), `/rdvadmin coherence` et rapport quotidien Sheets ↔ base dans le canal d'alertes, journal `bot_journal`.
- Tout est derrière `DB_WRITE_ENABLED` (défaut `false`). Les changements sous `src/` sont inertes tant que l'interrupteur est éteint.
- 86 tests (`npm test`), sans réseau, avec un faux client PostgREST.

### 3. Import de l'historique Licall (fait le 12/10)
Script `scripts/import-history.js`, mode `sql-stage --sheets-only`, lot `licall-20261012122015`.

| Donnée | Résultat en base |
|---|---|
| RDV | 2 551 (toutes les lignes des 22 onglets du classeur, du 01/07 au 02/11/2026) |
| Statuts | 1 145 venus, 703 pas venus, 419 annulés, 38 vendus, 73 SAV, 173 en attente (colonne « Etat » saisie par l'équipe) |
| Utilisateurs | 386 (fiche RH `SDR LC 26` + SDR des onglets), 50 actifs, 370 avec mail |
| Clients | 2 392 (26 RDV sans téléphone exploitable) |
| Agences | 22, dont 4 créées inactives pour les onglets sans canal Discord (MONTPELLIER, TOULOUSE ×2, TRÉGUNC) |

Non importé, volontairement : les ~2 400 événements Calendar sans ligne Sheets (pas de prospecteur ni de statut réel), et les classeurs Finances / KPI (agrégats recalculables depuis `rdv`).

### 4. Documentation
- [passation-supabase.md](passation-supabase.md) : architecture, modèle de données, SDR, agences, exploitation, allumage et retour arrière, import, bascule, règles, tests.
- [supabase.md](supabase.md) : principe des deux bases et procédure pour rejouer une migration.

## État de la base Kall Kall (vérifié le 12/10)

Déjà là, par le cron `import-sheets-rdv` du dashboard (tous les jours à 18 h) : 33 756 RDV avec leurs statuts réels, 61 agences, 409 utilisateurs.

Manque, parce que le cron ne lit pas ces colonnes : confirmation (J/J, J+1, CONF, NON CONF), véhicule, liens, commentaire, télé-confirmateur (0 sur 33 756), et la fiche RH `SDR KK 26` (9 mails sur 409 utilisateurs). Un RDV est daté de 2036 : faute de frappe à corriger dans le classeur.

## Ce qu'il reste à faire, dans l'ordre

1. **Merger la PR #14.** Aucun effet en production tant que `DB_WRITE_ENABLED` est à `false`.
2. **Railway** : ajouter `SUPABASE_LICALL_SERVICE_ROLE_KEY` et `SUPABASE_KALLKALL_SERVICE_ROLE_KEY` (clés `service_role`, jamais `anon`), sans poser `DB_WRITE_ENABLED`. Redéployer, puis `/rdvadmin db` doit afficher les deux bases connectées.
3. **Enrichir Kall Kall** : avec la clé Kall Kall dans le `.env` local, lancer `node scripts/import-history.js --societe kallkall --mode stage --enrich-only` puis rejouer le `merge_<lot>.sql` produit. Cela ajoute confirmation, véhicule, télé-confirmateur et la fiche SDR sans toucher aux statuts du dashboard.
4. **Allumer** : `DB_WRITE_ENABLED=true`. Dans le canal de l'agence `LICALL TEST`, enchaîner `/rdv add`, `conf`, `modifier`, `annuler`, `supprimer` avec des données fictives ; l'embed doit afficher « Base Licall : synchronisé ». Lancer `/rdvadmin coherence`.
5. **Dix jours de double écriture** : lire le rapport quotidien dans le canal d'alertes, corriger les écarts (SDR non rattachés, agences sans canal). Retour arrière à tout moment : `DB_WRITE_ENABLED=false`.
6. **Bascule** (section 9 de la passation, rien n'est commencé) : lire agences et SDR depuis la base au lieu de `agencies.json`, couper Sheets agence par agence avec `agences.sync_sheets`, retirer les contrôles d'onglet, remplacer l'export par `v_export_sheet`, désactiver le cron `import-sheets-rdv` du dashboard, supprimer `agencies.json` et le schéma `archive_sandbox_2026_06`.

## Points de vigilance

- `/rdv supprimer` fait un `delete` physique sur `rdv`. Si une table du dashboard Kall Kall référence `rdv.id` sans `on delete cascade`, la suppression échouera côté base (journalisée, non bloquante). À vérifier avant l'allumage.
- Horaires : le bot stocke `{ "0": "fermé", "1": "09:00-19:30" }`, la base attend `{ "1": ["09:00","19:30"] }`. La conversion vers la base est faite ; à la bascule, lire avec `fromDbOpeningHours`.
- Fiche RH Licall : un homonyme (même nom, deux mails) a été fusionné sur la première fiche.
- Les agences configurées avant ce commit n'ont pas de `guild_id` dans `agencies.json` : le routage passe alors par le classeur.
- Pas de dashboard Licall : l'édition se fait dans l'éditeur de tables Supabase.
- Les fichiers `supabase/imports/` ne se commitent jamais (noms et téléphones de clients).
