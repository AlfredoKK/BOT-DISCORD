# Passation — bot RDV MANDAT et bases Supabase

Document de passation pour le développeur qui reprend le bot Discord « RDV MANDAT » (dépôt `AlfredoKK/BOT-DISCORD`). Il décrit le chantier Sheets → Supabase tel qu'il est dans le code au 12/10/2026 (commit `34b979f`, branche `feat/supabase-schema`), plus un travail en cours non commité sur l'import d'historique, signalé comme tel en section 8. Chaque nom de fichier, de fonction, de colonne ou de valeur cité ici existe dans le dépôt ou dans le SQL. Aucune clé, aucun token, aucune donnée client n'y figure.

---

## 1. Ce qu'on fait et pourquoi

### Le point de départ

Le bot (Node.js CommonJS, `discord.js` v14, `googleapis`) prend des RDV de rachat de voiture pour des agences, depuis des commandes slash dans un canal Discord par agence. Chaque RDV est écrit :

- dans Google Calendar, événement au titre encodé `RDV MANDAT - CLIENT - TEL - MARQUE - MODELE - ANNEE - KM - PRIX` (préfixe `RDV MANDAT DOM` pour un RDV à domicile, préfixes de statut `ANNULÉ`, `VENDU`, `CONF`, `NON CONF`, `J/J` devant) ;
- dans Google Sheets, un onglet par agence, colonnes dans l'ordre de `COL` (`src/services/sheets.js`) : `PROSPECTEUR, VEHICULE, CLIENT, TELEPHONE, DATE, HEURE, CONFIRMATION, STATUT, EVENT_ID, UPDATED_AT, CONF_PAR`.

La configuration des agences vit dans `data/agencies.json` (volume Railway `/data`, voir `src/config/paths.js`).

### Le point d'arrivée

Le bot écrit dans Supabase. Il y a **deux bases, une par société, strictement séparées**, avec la même structure :

| Société | Projet Supabase | Rôle |
|---|---|---|
| Licall | `zvfhhcxsdzyubufmexng` | nouvelle base, structure copiée du dashboard |
| Kall Kall | `cegswxmdpsvzqrjplcvy` | base de production du dashboard `AlfredoKK/kallkall-dashboard` |

Règle absolue : **Licall = Licall, Kall Kall = Kall Kall, jamais de mélange.** Aucune table, vue ou fonction ne relie les deux bases. Un SDR Licall n'existe pas dans la base Kall Kall, et inversement. Le code ne possède aucun chemin qui écrirait dans « les deux » : une agence est routée vers une base ou vers aucune.

### Calendrier en 4 étapes

| Étape | Contenu | État |
|---|---|---|
| 1 | Schéma : structure du dashboard appliquée à Licall, puis migration commune `supabase/common/20261012120000_bot_integration.sql` sur les deux bases. Référentiel agences chargé dans les deux bases. | **Fait** le 12/10/2026 |
| 1 bis | Import de l'historique Licall (lignes Sheets de tous les onglets + fiche SDR du classeur RH) via `scripts/import-history.js` mode `sql-stage`, fichiers rejoués sur la base Licall. | **Fait** le 12/10/2026 (lot `licall-20261012122015`) |
| 2 | Double écriture Sheets + base dans le bot, derrière l'interrupteur `DB_WRITE_ENABLED` (défaut `false`). Rattachement des SDR, journal `bot_journal`, rapport de cohérence, commandes `/rdvadmin db`, `coherence`, `sdr`. | **Code fait, interrupteur coupé.** Le patron dit quand l'allumer. |
| 3 | Dix jours de double écriture avec rapport de cohérence quotidien à 22 h (Paris) dans le canal d'alertes. | À faire |
| 4 | Bascule : le bot lit agences et SDR depuis la base, arrêt des écritures Sheets, suppression de `data/agencies.json`, désactivation du cron `import-sheets-rdv` du dashboard Kall Kall. | À faire |

Pendant les étapes 2 et 3, **Sheets reste la référence**. La base est une copie qu'on vérifie. Couper `DB_WRITE_ENABLED` ramène au comportement d'avant sans autre action.

---

## 2. Architecture

### Flux d'une commande `/rdv add`

```
Discord : /rdv add (src/commands/rdv.js → handleAdd)
  │
  ├─ requireAgency(interaction)          agence du canal (data/agencies.json)
  ├─ verifySheetTab(...)                 refus si l'onglet Sheets n'existe pas
  ├─ Google Calendar : createEvent       → eventId (clé naturelle de tout le reste)
  ├─ Google Sheets   : appendRowVerified → ligne [PROSPECTEUR … CONF_PAR], STATUT 'PLANIFIÉ'
  │                                        sheetStatus = 'Synchronisé' | 'Erreur: …'
  ├─ Base : rdvDb.onRdvCreated(ctx)      (src/services/rdv-db.js)
  │     ├─ isDbWriteEnabled() false ?    → { ok:false, skipped:'désactivé' }, rien d'autre
  │     ├─ getDbForAgency(agency, guildId) → base Licall OU Kall Kall OU aucune
  │     ├─ resolveAgencyId               agences.discord_channel_id → alias 'bot' → sheet_onglet
  │     ├─ resolveSdr                    users.discord_user_id → resoudre_user(pseudo,'bot') → création
  │     ├─ ensurePersonne                personnes.telephone_e164 (E.164) → id ou null
  │     ├─ upsertRdv                     rdv ON CONFLICT (gcal_event_id)
  │     ├─ addEventIfNeeded              rdv_evenements statut 'pris' (si pas déjà l'état courant)
  │     └─ writeJournal                  bot_journal : sheets_ok / db_ok / erreurs / details
  │
  ├─ Avis #alertes-bot (notifyOps)       seulement en cas d'échec ou de SDR créé
  └─ Embed Discord                       champ « Sheets » + champ « Base Licall|Kall Kall »
```

Les autres sous-commandes suivent le même schéma : `handleDom` → `onRdvCreated` (type `mandat_dom`), `handleAnnuler` / `handleVendu` → `onRdvStatus`, `handleConf` → `onRdvConfirmation`, `handleModifier` → `onRdvModified`, `handleSupprimer` → `onRdvDeleted`. L'écriture base vient toujours **après** Calendar et Sheets, et n'est **jamais bloquante** : une exception dans `rdv-db.js` est attrapée, journalisée, signalée, et la commande Discord répond normalement.

### Modules et rôle

| Fichier | Rôle |
|---|---|
| `src/services/supabase.js` | Client PostgREST minimal (fetch natif, sans dépendance), configuration des deux sociétés (`COMPANIES`), routage `resolveCompany` / `getDbForAgency`, interrupteur `isDbWriteEnabled`, cache de clients, `setClientOverrideForTests`. |
| `src/services/rdv-db.js` | Toute l'écriture métier : correspondances Sheets ↔ base, normalisations (téléphone, libellé, pseudo), `resolveSdr`, `ensurePersonne`, `upsertRdv`, journal des statuts, `bot_journal`, actions `on*`, miroir agences `syncAgencyToDb` / `unlinkAgencyInDb`, `linkSdr`. |
| `src/services/coherence.js` | Rapport Sheets ↔ base par agence et par société (`compareAgency`, `runCoherenceReport`, `formatReport`, `getReportHour`). |
| `src/services/scheduler.js` | Envoi des agendas (existant) + `maybeRunCoherence` : rapport quotidien quand `DB_WRITE_ENABLED=true`. |
| `src/services/calendar.js` | Ajout de `listAllEvents` (pagination complète) pour l'import d'historique. |
| `src/commands/rdv.js` | Commandes prospecteur ; appelle `rdvDb.on*` après chaque écriture Sheets ; `dbContext`, `dbField`, `sheetsOutcome`, `eventPayload`. |
| `src/commands/rdvadmin.js` | Commandes admin ; `mirrorAgency` vers la table `agences` ; `handleDb`, `handleCoherence`, `handleSdr`. |
| `scripts/import-history.js` | Import idempotent de l'historique d'une société (modes `dry` / `sql` / `apply`). |
| `supabase/common/20261012120000_bot_integration.sql` | Migration commune (colonnes bot, `bot_journal`, `v_export_sheet`, `referentiel_ecrire`). |
| `supabase/common/20261012150000_bot_import_staging.sql` | **Non commité, en cours.** Table `bot_import_staging (lot, kind, payload jsonb)` : zone de dépôt temporaire pour l'import d'historique en mode `stage`. |
| `supabase/licall-base/` | Copie des 42 migrations du dashboard appliquées à la base Licall (référence de structure, ne pas modifier). |
| `docs/supabase.md` | Résumé court du principe deux bases. |

### Routage société

`resolveCompany(agency, guildId, env)` dans `src/services/supabase.js`, dans cet ordre :

1. `agency.societe` explicite (`'licall'` ou `'kallkall'`) ; aucune entrée de `data/agencies.json` ne le porte aujourd'hui, c'est une porte de sortie manuelle.
2. `agency.spreadsheet_id` égal au classeur de la société : `LICALL_SPREADSHEET_ID` (défaut `16H-aZ8eV9M5Qd5ZToWFSluZFbtHKdP0wcS3mtBK_mzI`) ou `KALLKALL_SPREADSHEET_ID` (défaut `1dshz0ZhA44VziYOirOwQj_AQFRJxehsV7yZnZ5LJ0BU`). **C'est le critère effectif** : toutes les agences actuelles ont l'un de ces deux classeurs.
3. Le serveur Discord, `guildId` de l'interaction ou `agency.guild_id` : `LICALL_GUILD_ID` (défaut `1443725425904848959`) ou `KALLKALL_GUILD_ID` (défaut `1445676914667946085`). Le classeur l'emporte sur le serveur (test `resolveCompany : classeur Sheets → société`).
4. Sinon `null`.

`getDbForAgency` renvoie `{ company, label, db, reason }`. Si `company` est `null` : **aucune écriture nulle part**, `runAction` journalise `[DB] <action>: société indéterminable…` dans la console et envoie l'avis « Base non résolue » dans le canal d'alertes. Si la société est connue mais ses variables `SUPABASE_*` absentes : même traitement, raison `base <Société> non configurée`. Il n'existe pas de base « par défaut ».

Les clients PostgREST sont créés paresseusement et mis en cache par société (`getClient`). Délai réseau : `DEFAULT_TIMEOUT_MS` = 15 000 ms. Toute réponse non 2xx lève une `Error` lisible `Supabase <status> [code]: message — details`.

---

## 3. Modèle de données utilisé par le bot

Structure de référence : socle du dashboard (`supabase/licall-base/20260828120000_socle.sql` et suivants), complétée par la migration commune. Seules les tables et colonnes que le bot touche sont décrites.

### `agences`

Socle : `id`, `nom` (unique), `actif`, `gcal_calendar_id`, `max_rdv_heure`, `opening_hours` (jsonb), `sheet_onglet`, `paused`. Ajouts bot : `discord_channel_id` (index unique partiel `agences_discord_channel_uidx`), `discord_guild_id`, `spreadsheet_id` (transition), `granularite_minutes` (défaut 30), `timezone` (défaut `Europe/Paris`), `dom_rdv_enabled`, `sync_sheets` (transition, défaut `true`), `updated_at` (trigger `trg_agences_updated_at`).

Alias : `agences_alias (agence_id, alias, alias_norm, source)` avec `source in ('bot','bwa','gcal','manuel')`, unique sur `(alias_norm, source)`. Résolution : `resoudre_agence(brut, src)`.

### `users`

Socle : `id`, `nom`, `prenom`, `email`, `role in ('ceo','tl','sdr','rh','support')`, `team_id`, `actif`, `date_entree`, `date_sortie`, `bot_booker_name`. Ajouts bot : `discord_user_id` (index unique partiel `users_discord_user_uidx`), `discord_display_name`, `updated_at`.

### `users_alias`

`(user_id, alias, alias_norm, source)` avec `source in ('bot','onoff','sheet_kpi','manuel')`, unique sur `(alias_norm, source)`. Le bot écrit la source `'bot'` avec le pseudo Discord tel quel. Résolution : `resoudre_user(brut, src)` qui compare `normalise_libelle(brut)` à `alias_norm`. La fonction JS `normaliseLibelle` dans `rdv-db.js` reproduit la même règle (minuscules, sans accents, tout non alphanumérique remplacé par un espace).

### `personnes`

Clients. Clé métier `telephone_e164` (unique, contrainte `^\+[1-9][0-9]{6,14}$`), `nom`. La fonction SQL `normalise_telephone` et la fonction JS `normalizePhoneE164` appliquent la même règle (06… → +336…, 0033… → +33…, 33… → +33…, sinon `null`). Un téléphone non normalisable donne `personne_id = null` sur le RDV, jamais une fiche fausse.

### `rdv`

Socle : `id`, `gcal_event_id` (**unique, clé naturelle**), `personne_id`, `annonce_id`, `sdr_user_id`, `agence_id`, `debut_at`, `source in ('bot','crm','import')`, `created_at`. Ajouts bot : `fin_at`, `type_rdv in ('mandat','mandat_dom')`, `confirmation` (voir ci-dessous), `confirme_par_user_id`, `confirme_at`, `commentaire`, `liens`, `adresse_dom`, `vehicule` jsonb `{marque, modele, annee, km, prix}`, `prospecteur_nom_brut`, `booked_by_discord_user_id`, `updated_at`.

Le bot écrit toujours `source = 'bot'` (`buildRdvRow`). Pour un RDV DOM, `debut_at` est l'heure réelle du RDV, pas l'heure de début de l'événement Calendar (qui commence `DOM_RDV_BUFFER_MINUTES` = 15 min avant) ; la fonction `eventTimes` dans `rdv.js` et `buildRecord` dans l'import appliquent le même décalage.

### `rdv_evenements`

Journal des statuts, jamais de colonne statut sur `rdv` : `(rdv_id, statut, motif, mandat, origine, regle, auteur_user_id, at)`. `statut in ('pris','confirme','venu','pas_venu','annule','sav','vendu')`, `origine in ('bot','agenda','support','tl','admin','crm')`. Le bot écrit `origine = 'bot'`.

### Vue `v_rdv_etat`

État courant = dernière ligne du journal par `rdv_id` (`distinct on`, `at desc`, départage par priorité `vendu > sav > venu > pas_venu > annule > confirme > pris`, définition finale dans `supabase/licall-base/20260830120000_fix_etat_tiebreak.sql`). Le bot la lit dans `currentStatut` et dans `coherence.js`.

### Vue `v_export_sheet`

Définie dans la migration commune. Reproduit l'onglet Sheets colonne par colonne : `prospecteur, vehicule, client, telephone, date, heure, confirmation, statut, event_id, updated_at, conf_par` + `agence`, `type_rdv`, `rdv_id`. Dates et heures en fuseau `agences.timezone`. `security_invoker = true`.

### `bot_journal`

`(id, at, action, agence_id, rdv_id, gcal_event_id, discord_user_id, discord_channel_id, sheets_ok, sheets_erreur, db_ok, db_erreur, details jsonb)`. RLS activée sans policy : seul le `service_role` lit et écrit. Valeurs d'`action` écrites par le code : `add`, `dom`, `annuler`, `vendu`, `conf`, `modifier`, `supprimer`, `config`, `pause`, `play`, `horaires`, `deconfig`, `coherence`, `import_historique`.

### Correspondances Sheets ↔ base

`STATUT` Sheets → `rdv_evenements.statut` (`sheetStatutToDb`, table `STATUT_SHEET_TO_DB`) :

| Sheets (après `normalizeLabel` : sans accent, majuscules) | base |
|---|---|
| `PLANIFIE`, `A VENIR`, `EN ATTENTE`, préfixe `PLANIFI` | `pris` |
| `ANNULE`, préfixe `ANNUL` | `annule` |
| `VENDU`, préfixe `VENDU` | `vendu` |
| `PAS VENU`, `NO SHOW`, `ABSENT`, `ABSENTE`, `PV`, `NO-SHOW`, `NOSHOW` | `pas_venu` |
| `VENU`, `VENUE`, `V`, préfixe `VENU` | `venu` |
| `SAV`, `S.A.V` | `sav` |
| autre | `null` (traité comme `pris` par le rapport de cohérence) |

Le statut `confirme` n'a pas d'équivalent dans `STATUT` Sheets : il est posé par `/rdv conf CONF`. Le rapport de cohérence et `v_export_sheet` le ramènent à `PLANIFIÉ` / `pris`.

`CONFIRMATION` Sheets → `rdv.confirmation` (`sheetConfToDb`, `CONF_SHEET_TO_DB`, contrainte `rdv_confirmation_chk`) :

| Sheets | base |
|---|---|
| `J/J`, `JJ` | `jj` |
| `J+1`, `J1` | `j1` |
| `CONF`, `CONFIRME` | `conf` |
| `NON CONF`, `NONCONF`, `NON CONFIRME` | `non_conf` |
| vide | `null` |

Sens inverse : `CONF_DB_TO_SHEET` et le `case` de `v_export_sheet`.

### Clé naturelle et idempotence

- `rdv.gcal_event_id` est unique. `upsertRdv` fait un `POST` PostgREST avec `on_conflict=gcal_event_id` et `Prefer: resolution=merge-duplicates`. Rejouer `/rdv add` pour le même événement met à jour la ligne, ne la duplique pas.
- `addEventIfNeeded` n'insère un événement de statut que s'il diffère de l'état courant (`v_rdv_etat`). Rejouer `/rdv annuler` deux fois ne produit qu'un `annule` (test `onRdvStatus : … idempotent sur le statut`). Exception voulue : `onRdvModified` avec `rebook = true` insère toujours un `pris` (le RDV a changé de date).
- `ensurePersonne` : `upsert` sur `telephone_e164` avec `resolution=ignore-duplicates`, puis `select`. Le nom n'est renseigné que si la fiche n'en a pas.
- `users_alias` / `agences_alias` : `upsert` avec `ignoreDuplicates` sur `(alias_norm, source)`.
- Les fichiers SQL de `scripts/import-history.js` utilisent `on conflict (gcal_event_id) do update set … coalesce(excluded.x, rdv.x)` et `where not exists` pour les événements : rejouables.

### Interdiction de suppression physique

Trigger `interdire_delete()` (fichier `supabase/licall-base/20260828130000_referentiel_vivant.sql`) sur `users`, `agences`, `teams` (`users_no_delete`, `agences_no_delete`, `teams_no_delete`). Un `DELETE` lève `Suppression physique interdite sur <table> (principe n°3 passation) : mettre actif=false`. Le bot ne tente jamais de `DELETE` sur ces tables : `unlinkAgencyInDb` fait `actif = false, discord_channel_id = null`.

Seul `onRdvDeleted` (`/rdv supprimer`) fait des `DELETE`, sur `rdv_evenements` puis `rdv`, après avoir mis `bot_journal.rdv_id` à `null`. `bot_journal` garde la trace par `gcal_event_id`.

---

## 4. Gestion des SDR

### Rattachement automatique (`resolveSdr` dans `rdv-db.js`)

Appelé par `onRdvCreated` et `onRdvConfirmation` avec `createIfMissing = true`, par `onRdvStatus` et `onRdvModified` avec `createIfMissing = false` (un changement de statut ne crée jamais de compte). L'acteur est `{ discordUserId, displayName }` construit par `actorOf(interaction)` : `interaction.member.displayName`, sinon `globalName`, sinon `username`.

1. `users.discord_user_id = <id Discord>` → trouvé : on met à jour `discord_display_name` si le pseudo a changé, et on s'arrête.
2. Sinon `resoudre_user(<pseudo sans emoji>, 'bot')` → trouvé : on pose `discord_user_id` sur ce compte **seulement s'il est encore `null`** (`update … discord_user_id=is.null`). Résultat `linked: true`.
3. Sinon, si `createIfMissing` et pseudo d'au moins 2 caractères : `insert users (nom, prenom, role='sdr', actif, discord_user_id, discord_display_name)` + alias `'bot'` = pseudo. `splitDisplayName` coupe « Prénom NOM » : les mots entièrement en capitales forment le nom, le reste le prénom ; un seul mot → prénom = nom = ce mot. Résultat `created: true` → avis « SDR inconnu créé en base » (niveau `info`) dans le canal d'alertes.

`stripEmoji` retire les emojis et décorations du pseudo avant toute comparaison ou insertion.

### Commande `/rdvadmin sdr membre:<@membre> [nom:<Prénom NOM>]`

`handleSdr` → `rdvDb.linkSdr`. À lancer **dans le canal d'une agence de la bonne société** : c'est l'agence qui choisit la base. Indépendant de `DB_WRITE_ENABLED` (action d'administration explicite, test `linkSdr : action d'administration…`).

1. Cible = `nom` si donné, sinon le pseudo du membre.
2. `resoudre_user(cible, 'bot')`, puis `resoudre_user(cible, 'manuel')`.
3. Si rien : création `role='sdr'`, `actif=true`.
4. Tout autre compte portant déjà ce `discord_user_id` est détaché (`discord_user_id = null`), puis le compte cible reçoit `discord_user_id` et `discord_display_name`.
5. Alias `'bot'` = pseudo Discord (erreur avalée si l'alias est pris).

Réponse éphémère : base, nom résolu, rôle, `inactif` le cas échéant, `compte créé` si création.

### Pièges

- **Homonymes.** Trigger `users_alias_un_seul_user` (fichier `supabase/licall-base/20260828350000_alias_unique.sql`) : un `alias_norm` ne peut jamais pointer vers deux `users` différents, toutes sources confondues. Dans `resolveSdr` et `linkSdr`, l'`upsert` sur `users_alias` est suivi de `.catch(() => {})` : si le pseudo est déjà l'alias d'un autre compte, le compte est créé ou rattaché **sans alias**, silencieusement. Le prochain RDV de ce membre passera par `discord_user_id` (étape 1), donc le rattachement tient ; mais la résolution par nom restera sur l'autre compte.
- Deux membres Discord avec le même pseudo et sans `discord_user_id` connu seront résolus vers le même `users.id` à l'étape 2. Le premier prend l'identifiant Discord, le second reste `linked: false` et ses RDV sont attribués au premier. Corriger avec `/rdvadmin sdr nom:…`.
- `users.role` est contraint : le bot ne crée que des `sdr`. Un Team Lead qui pose un RDV est créé en `sdr` si inconnu ; corriger le rôle dans le dashboard ou l'éditeur.
- `users.actif` : `resolveSdr` crée `actif = true` depuis le bot, mais l'import d'historique crée `actif = false` pour les SDR sans RDV dans les 60 derniers jours (`ACTIVE_WINDOW_DAYS`).

---

## 5. Gestion des agences

### Commandes Discord et miroir en base

Toutes dans `src/commands/rdvadmin.js`, réservées aux rôles `admin` / `team lead` (`requireAdmin`, `src/utils/permissions.js`). Elles écrivent d'abord `data/agencies.json` (`saveAgencies`), puis appellent `mirrorAgency` → `rdvDb.syncAgencyToDb` (ou `unlinkAgencyInDb`). Le miroir ne se fait que si `DB_WRITE_ENABLED=true` ; il n'est jamais bloquant ; son résultat s'affiche (« Base Licall : synchronisée » ou « ⚠️ erreur »).

| Commande | agencies.json | Table `agences` (via `agencyToDbPatch`) |
|---|---|---|
| `config agence calendar_id spreadsheet_id max_rdv_heure [sheet_name]` | entrée créée/remplacée, `guild_id` posé | trouvée par `discord_channel_id` puis `resoudre_agence(nom,'bot')` → `update` ; sinon `insert` + alias `'bot'`. `actif = true`. |
| `deconfig` | entrée supprimée | `discord_channel_id = null`, `actif = false` (jamais de `DELETE`) |
| `pause` | `paused = true` | `paused = true` |
| `play` | `paused` retiré | `paused = false` |
| `horaires lundi:… dimanche:…` | `opening_hours` | `opening_hours` copié tel quel |

Colonnes posées à chaque `syncAgencyToDb` : `gcal_calendar_id`, `spreadsheet_id`, `sheet_onglet`, `discord_channel_id`, `discord_guild_id`, `granularite_minutes`, `timezone`, `dom_rdv_enabled`, `paused`, `opening_hours`, `max_rdv_heure` (si > 0). **Jamais `nom`** : le bot ne renomme pas une agence existante (test `syncAgencyToDb : … ne renomme jamais`).

### Les trois voies d'édition

Toutes sur les mêmes tables, aucune n'est prioritaire par construction :

1. **Discord**, commandes ci-dessus. Source de vérité du bot jusqu'à la bascule : `agencies.json`.
2. **Dashboard Kall Kall**, écran « Gestion des agences », fonction SQL `referentiel_ecrire(p_auteur, p_table, p_id, p_donnees)` redéfinie dans la migration commune pour autoriser les colonnes bot (`discord_channel_id`, `discord_guild_id`, `spreadsheet_id`, `granularite_minutes`, `timezone`, `dom_rdv_enabled`, `sync_sheets` sur `agences` ; `discord_user_id`, `discord_display_name` sur `users`). Chaque écriture est auditée dans `referentiel_audit` (trigger `auditer_referentiel`).
3. **Éditeur de tables Supabase** pour Licall, en attendant un dashboard Licall.

Pendant la transition, une modification faite par les voies 2 ou 3 **n'a aucun effet sur le bot** : il lit `agencies.json`. Inversement, une commande Discord avec `DB_WRITE_ENABLED=false` ne touche pas la base. Les deux peuvent diverger ; `/rdvadmin coherence` ne compare pas le référentiel, seulement les RDV.

### Ce qui reste dans `data/agencies.json` jusqu'à la bascule

Tout ce que le bot lit : `name`, `calendar_id`, `spreadsheet_id`, `sheet_name`, `channel_id`, `max_rdv_heure`, `granularite`, `timezone`, `opening_hours`, `paused`, `dom_rdv_enabled`, et `guild_id` pour les agences configurées après ce commit. Lecteurs : `loadAgencies`, `getAgencyByChannel`, `requireAgency` (`src/utils/rdv-helpers.js`), utilisés par `rdv.js`, `rdvadmin.js`, `agenda.js`, `scheduler.js`. `agences.sync_sheets` existe en base mais **aucun code JS ne le lit encore**.

---

## 6. Exploitation

### Variables d'environnement ajoutées (`.env.example`)

| Variable | Défaut | Rôle |
|---|---|---|
| `SUPABASE_LICALL_URL` | — | URL du projet Licall (`https://zvfhhcxsdzyubufmexng.supabase.co`) |
| `SUPABASE_LICALL_SERVICE_ROLE_KEY` | — | clé `service_role` Licall. Jamais la clé `anon`. |
| `SUPABASE_KALLKALL_URL` | — | URL du projet Kall Kall (`https://cegswxmdpsvzqrjplcvy.supabase.co`) |
| `SUPABASE_KALLKALL_SERVICE_ROLE_KEY` | — | clé `service_role` Kall Kall |
| `DB_WRITE_ENABLED` | `false` | interrupteur de la double écriture. `parseBool` : `false`, `0`, `non`, `no`, `off` = coupé ; toute autre valeur non vide = allumé. |
| `COHERENCE_REPORT_HOUR` | `22` | heure (Paris, 0–23) du rapport quotidien ; hors bornes → 22 |
| `LICALL_GUILD_ID` | `1443725425904848959` | serveur Discord Licall (routage de secours) |
| `KALLKALL_GUILD_ID` | `1445676914667946085` | serveur Discord Kall Kall |
| `LICALL_SPREADSHEET_ID` | `16H-aZ8eV9M5Qd5ZToWFSluZFbtHKdP0wcS3mtBK_mzI` | classeur Licall (routage principal) |
| `KALLKALL_SPREADSHEET_ID` | `1dshz0ZhA44VziYOirOwQj_AQFRJxehsV7yZnZ5LJ0BU` | classeur Kall Kall |

Les avis Discord dépendent des variables existantes `ALERT_CHANNEL_ID`, `ALERTS_ENABLED`, `OPS_NOTICES_ENABLED` (défaut `true`), `NOTICE_COOLDOWN_MINUTES` (défaut 30, déduplication par signature `kind|message`).

Les clés `service_role` donnent tous les droits sur la base et contournent la RLS. Elles ne vont que dans Railway et dans un `.env` local ignoré par git.

### `/rdvadmin db`

`handleDb`. Réponse éphémère :

- état de l'interrupteur (`🟢 ACTIVE` / `⚪ coupée`) et heure du rapport ;
- par société : `❌ non configurée` (variables manquantes), `⚠️ configurée mais injoignable (erreur)`, ou `✅ N agences actives, N RDV, 24 h : N écriture(s) ok / N en échec` (comptages `count` PostgREST sur `agences actif=true`, `rdv`, `bot_journal db_ok`) ;
- nombre d'agences du bot routées vers chaque société, et liste des agences sans société déterminable.

Fonctionne avec l'interrupteur coupé : c'est la commande pour vérifier les clés avant d'allumer.

### `/rdvadmin coherence`

`handleCoherence` → `runCoherenceReport({ trigger: 'manuel', post: true })`. Fonctionne dès que les bases sont configurées, même interrupteur coupé (utile pour mesurer l'écart initial). Résumé éphémère, rapport complet dans le canal d'alertes.

### Rapport quotidien

`maybeRunCoherence` dans `scheduler.js`, vérifié toutes les 60 s : seulement si `isDbWriteEnabled()`, à `COHERENCE_REPORT_HOUR:00` Paris, une fois par jour (`lastCoherenceDay`), jamais deux en parallèle (`coherenceRunning`). Fenêtre comparée : `[aujourd'hui − 7 j, aujourd'hui
+ 30 j]` (`DEFAULT_PAST_DAYS`, `DEFAULT_FUTURE_DAYS`), sur la colonne `DATE` côté Sheets et `debut_at` côté base.

Pour chaque agence routée, `compareAgency` compte : `missingInDb` (ligne Sheets avec `EVENT_ID` sans ligne `rdv`), `missingInSheet` (RDV en base dans la fenêtre sans ligne Sheets), `statutDiff` (après mapping, `confirme` compté comme `pris`), `confDiff`. Les lignes de détail ne contiennent que **nom d'agence + ID d'événement** (test `aucun nom de client dans le rapport`), 20 lignes au plus (`MAX_LINES`). Chaque société reçoit une ligne `bot_journal` `action = 'coherence'` avec les totaux dans `details`.

Envoi via `notifyOps` avec `force: true` (pas de déduplication), titre `Cohérence Sheets ↔ base : OK` (niveau `info`) ou `Cohérence Sheets ↔ base : N écart(s)` (niveau `warn`).

### Avis dans le canal d'alertes

Émis par `notify` dans `rdv-db.js`, via `notifyOps` (embed court, pas d'e-mail, pas de pièce jointe, dédupliqué 30 min par signature) :

| Titre (`kind`) | Niveau | Quand | Champ « Conseil » |
|---|---|---|---|
| `Base non résolue` | `error` | société indéterminable ou variables `SUPABASE_*` absentes pour cette société | vérifier le classeur Sheets de l'agence ou le serveur Discord, puis les variables |
| `Base non écrite` | `error` | exception pendant l'écriture (agence introuvable en base, contrainte, délai, HTTP) ; message = `<action> (<eventId>): <erreur>` | vérifier `SUPABASE_*` et `/rdvadmin db` ; la ligne sera vue par le rapport de cohérence |
| `SDR inconnu créé en base` | `info` | `resolveSdr` a créé un compte | un Team Lead peut corriger avec `/rdvadmin sdr` |

Le champ « Utilisateur » de l'embed porte le pseudo Discord du SDR, jamais le client. Les avis existants (`Sheets non écrit`, `Sheets non mis à jour`, `Config Sheets invalide`, `Configuration refusée`) restent inchangés.

### Lire `bot_journal`

Dans l'éditeur SQL de **la** base concernée (une requête par base, ne jamais les joindre). Les colonnes `details` sont du jsonb.

Échecs des 24 dernières heures :

```sql
select at, action, gcal_event_id, discord_channel_id, sheets_ok, db_erreur
from bot_journal
where at >= now() - interval '24 hours'
  and (db_ok = false or sheets_ok = false)
order by at desc;
```

Actions par agence sur 7 jours :

```sql
select a.nom as agence, j.action, count(*) as n,
       count(*) filter (where j.db_ok) as db_ok,
       count(*) filter (where j.sheets_ok) as sheets_ok
from bot_journal j
left join agences a on a.id = j.agence_id
where j.at >= now() - interval '7 days'
group by a.nom, j.action
order by a.nom, j.action;
```

Historique des rapports de cohérence :

```sql
select at, details ->> 'declencheur' as declencheur,
       details -> 'fenetre' as fenetre,
       details ->> 'compares' as compares,
       details ->> 'absents_base' as absents_base,
       details ->> 'absents_sheets' as absents_sheets,
       details ->> 'ecarts_statut' as ecarts_statut,
       details ->> 'ecarts_confirmation' as ecarts_confirmation
from bot_journal
where action = 'coherence'
order by at desc;
```

Export au format Sheets d'une agence (remplace l'onglet) :

```sql
select * from v_export_sheet
where agence = 'NOM AGENCE'
order by date desc, heure desc;
```

---

## 7. Allumer la double écriture, et revenir en arrière

### Pré-requis

- Les deux bases sont à jour (migration commune appliquée aux deux).
- Chaque agence du bot existe dans sa base avec `discord_channel_id` renseigné (fait le 12/10/2026 pour les deux bases). Sans ça, `resolveAgencyId` renvoie `null` et chaque action donne `Base non écrite : agence « X » introuvable dans la base …`.
- `ALERT_CHANNEL_ID` pointe sur le canal d'alertes.

### Checklist d'allumage

1. Dans Railway, projet `bot-discord-rdv`, service du bot, ajouter les variables `SUPABASE_LICALL_URL`, `SUPABASE_LICALL_SERVICE_ROLE_KEY`, `SUPABASE_KALLKALL_URL`, `SUPABASE_KALLKALL_SERVICE_ROLE_KEY` (clés `service_role` prises dans les paramètres API de chaque projet Supabase). Ne pas encore poser `DB_WRITE_ENABLED`.
2. Redéployer. Lancer `/rdvadmin db` : les deux sociétés doivent être `✅` avec des comptages, et aucune agence « sans société déterminable ».
3. Lancer `/rdvadmin coherence` une première fois pour connaître l'écart de départ (Kall Kall : l'historique vient du cron du dashboard ; Licall : de l'import du 12/10).
4. Poser `DB_WRITE_ENABLED=true`, redéployer.
5. Dans le canal de l'agence `LICALL TEST` (clé `licall test`, classeur Licall, onglet `LICALL TEST`), faire un `/rdv add` de test avec des données fictives. L'embed doit afficher `Base Licall : Synchronisé`. Enchaîner `/rdv conf`, `/rdv modifier`, `/rdv annuler`, puis `/rdv supprimer` pour nettoyer.
6. Vérifier dans l'éditeur SQL **Licall** : `select * from v_export_sheet where agence = 'LICALL TEST' order by updated_at desc limit 5;` et `select at, action, db_ok, sheets_ok from bot_journal order by at desc limit 10;`.
7. Relancer `/rdvadmin coherence`. Le rapport doit être `OK` pour `LICALL TEST`.
8. Surveiller le canal d'alertes les premiers jours : `Base non écrite` et `SDR inconnu créé en base` sont attendus au début (SDR jamais vus), `Base non résolue` ne doit jamais apparaître.

### Retour arrière

`DB_WRITE_ENABLED=false` dans Railway, redéployer. Rien d'autre :

- aucune écriture base, aucun avis base, aucun rapport quotidien ;
- l'embed n'affiche plus le champ « Base » (`dbField` renvoie `null` sur `skipped`) ;
- Sheets et Calendar n'ont jamais cessé d'être écrits : ils restent la référence ;
- les lignes déjà écrites en base restent ; à la reprise, l'idempotence sur `gcal_event_id` et le rapport de cohérence rattrapent ce qui a été manqué pour les RDV encore dans la fenêtre. `onRdvStatus`, `onRdvConfirmation` et `onRdvModified` recréent un RDV absent à la volée depuis les données Calendar (`rattrape: true` dans `details`).

Les clés peuvent rester en place : sans interrupteur, seules `/rdvadmin db`, `/rdvadmin coherence` et `/rdvadmin sdr` les utilisent.

---

## 8. Import de l'historique

### Script

`scripts/import-history.js` (alias `npm run import:historique --`). Lit `data/agencies.json`, filtre les agences de la société demandée avec `resolveCompany`, puis pour chaque agence : toutes les lignes de l'onglet Sheets (`sheets.getAllRows`) et tous les événements Calendar depuis `--since` jusqu'à J+400 (`calendar.listAllEvents`). Clé de fusion : `EVENT_ID` Sheets = `id` Calendar.

```
node scripts/import-history.js --societe licall   --mode dry
node scripts/import-history.js --societe licall   --mode sql --exclude "licall test"
node scripts/import-history.js --societe kallkall --mode sql --enrich-only
node scripts/import-history.js --societe licall   --mode apply --agence albi
```

| Option | Effet |
|---|---|
| `--societe licall\|kallkall` | obligatoire, base cible |
| `--mode dry` | compte seulement, n'écrit rien |
| `--mode sql` | écrit des fichiers SQL numérotés dans `--out` (défaut `supabase/imports/<societe>`) : `NNN_users.sql`, `NNN_personnes.sql`, `NNN_rdv.sql`, `NNN_evenements.sql`, `NNN_journal.sql`, à rejouer **dans l'ordre, sur la base de cette société uniquement** |
| `--mode apply` | écrit directement via PostgREST avec `SUPABASE_<SOCIETE>_*` (lot par lot, log tous les 100 RDV) |
| `--agence <clé>` | une seule agence (clé de `agencies.json`) |
| `--exclude <clé,clé>` | agences ignorées (ex. `"licall test"`) |
| `--since AAAA-MM-JJ` | début de l'historique Calendar, défaut `2025-01-01` |
| `--enrich-only` | ne touche **que** les RDV déjà en base : `fin_at`, `type_rdv`, `confirmation` (si vide), `liens`, `commentaire`, `adresse_dom`, `vehicule`, `prospecteur_nom_brut`. Pas de `users`, pas de `personnes`, pas d'événements. Prévu pour Kall Kall, dont les RDV viennent du cron du dashboard. |
| `--sheets-only` | n'importe que les RDV qui ont une ligne Sheets (les événements Calendar sans ligne sont ignorés). C'est le mode utilisé pour Licall. |
| `--mode sql-stage` | fichiers `NNN_stage_*.sql` compacts (~13 Ko, 45 RDV chacun, dépôt dans `bot_import_staging`) + `merge_<lot>.sql` qui fusionne le lot dans les vraies tables et le vide |
| `--mode stage` | dépôt dans `bot_import_staging` via PostgREST (clé `service_role`), puis `merge_<lot>.sql` à rejouer |
| `--lot <id>` | identifiant du lot de staging (défaut `<societe>-<horodatage>`) ; permet de compléter un lot déjà déposé |
| `--sans-fiche` | ne lit pas le classeur RH (fiche SDR) |
| `--rows-per-file N` | RDV par fichier `stage_rdv` (défaut 45) |

Ce qui est importé par RDV (`buildRecord`) : heures exactes et type DOM depuis Calendar (sinon `DATE`/`HEURE` Sheets, 12:00 si l'heure manque), statut = colonne **« Etat »** Sheets (résultat réel saisi par l'équipe : VENU / PAS VENU / ANNULÉ / VENDU / SAV) sinon `STATUT` (colonne H du bot, qui ne connaît que PLANIFIÉ / ANNULÉ / VENDU) sinon préfixe du titre Calendar (`prefixToStatut`) sinon `pris`, confirmation = `CONFIRMATION` Sheets sinon préfixe (`prefixToConf`), véhicule depuis le titre Calendar sinon la colonne `VEHICULE`, prospecteur depuis Sheets, `confirme_par` = colonne **« TC »** (télé-confirmateur) sinon `CONF_PAR`. Téléphone : colonne Sheets normalisée (un numéro à 9 chiffres a perdu son zéro à cause du format numérique de Sheets → `+33` + 9 chiffres), sinon celui du titre Calendar (`#ERROR!` dans Sheets).

**Onglets.** Le script lit **tous** les onglets du classeur (`listSheetTabs`), pas seulement ceux de `agencies.json`. Les colonnes « Etat » et « TC » sont repérées par leur en-tête (ligne 3), car leur position varie d'un onglet à l'autre (`detectExtraColumns`). Un onglet dont le nom ne correspond à aucune agence configurée (comparaison sans accents ni ponctuation, `normKey`) est importé comme agence **sans canal Discord** : créée en base `actif = false`, `sheet_onglet` = nom de l'onglet, sans alias. Sur Licall : MONTPELLIER, TOULOUSE - AGORA CARS, TOULOUSE SUD - SIMPLICICAR, TRÉGUNC, VELAUX (agences fermées ou jamais configurées dans le bot). Les onglets `TOTAL`, `STATS`, `KPI` sont ignorés (`SKIP_TABS`). Un onglet dont le nom diffère légèrement de `sheet_name` (SANTENY JVVA ↔ SANTENY) est rattaché par nom normalisé (`readTab`).

**Fiche SDR.** Le classeur RH (`ROSTERS` : Licall `SDR LC 26`, Kall Kall `SDR KK 26`) est lu avec ses onglets `SDR` (en poste) et `ARCHIVE SDR` (partis) : nom, prénom, mail, rôle (SDR / TL / RH / support), actif (`✅ En prod`, `⚠️ En prod` ou `TRUE`), date d'entrée, date de sortie. Chaque ligne devient un `users` (créé ou enrichi : mail si vide, rôle si encore `sdr`, dates) rattaché par `Prénom NOM` normalisé, puis par alias, puis par mail. Les SDR rencontrés dans les onglets RDV sont ensuite rattachés à ces fiches par nom (`Prénom NOM` ou `NOM Prénom`) avant d'être créés. Événements : `pris` à `UPDATED_AT` Sheets si antérieur au RDV (sinon à l'heure du RDV), puis le résultat 1 s après l'heure du RDV, comme l'import du dashboard.

SDR : un par nom brut rencontré (`PROSPECTEUR` et `CONF_PAR`), résolu par alias `'bot'`, créé sinon, `actif` si au moins un RDV dans les 60 derniers jours. Clients : un par téléphone E.164.

### Idempotence

- `sqlUsers` : `with cand … existing … ins …` : insère le `user` seulement si aucun alias ne correspond, puis l'alias `on conflict (alias_norm, source) do nothing`.
- `sqlPersonnes` : `on conflict (telephone_e164) do update set nom = coalesce(personnes.nom, excluded.nom)`.
- `sqlRdv` : `on conflict (gcal_event_id) do update set … coalesce(…)`, sauf `type_rdv` qui est écrasé. L'`agence_id` est résolu par `agences.discord_channel_id` : l'agence doit exister en base avec son canal **avant** de rejouer.
- `sqlEvents` : `where not exists (… same rdv_id and statut)`.
- `sqlJournal` : une ligne `bot_journal action='import_historique'` par exécution (non dédupliquée, c'est voulu).
- Mode `apply` : `resolveSdr`, `ensurePersonne`, `upsertRdv`, puis `addEvent` seulement pour les statuts absents.

### Table de dépôt `bot_import_staging`

Migrations `supabase/common/20261012150000_bot_import_staging.sql` et `20261012160000_bot_import_staging_fiche.sql`, appliquées aux deux bases. Colonnes `(id, lot, kind, payload jsonb, at)`, `kind` ∈ `sdr`, `personne`, `rdv`, `fiche`. Le plan complet est déposé en jsonb (mode `sql-stage` : fichiers de 13 Ko passables dans l'éditeur SQL ou l'outil MCP Supabase ; mode `stage` : PostgREST), puis un seul `merge_<lot>.sql` (`sqlMerge`) fait, dans l'ordre : création des agences sans canal, fiche SDR → `users`, SDR des onglets → `users` + `users_alias`, `personnes`, `rdv` (agence résolue par `discord_channel_id`, sinon `sheet_onglet`, sinon `nom`), `rdv_evenements`, ligne `bot_journal`, puis `delete from bot_import_staging where lot = …`. Tout est idempotent : rejouer le merge sur un lot vide ne fait rien, rejouer un dépôt partiel complète.

### Ce qui a été fait

Le 12/10/2026, Licall, mode `sql-stage --sheets-only`, agence de test exclue, lot `licall-20261012122015` : 22 onglets (dont 5 sans canal), **2 551 RDV** (toutes les lignes Sheets avec `EVENT_ID`), 133 SDR rencontrés dans les onglets (87 actifs), 425 fiches SDR du classeur RH (40 actives), 2 392 clients, 26 RDV sans téléphone exploitable. Statuts après lecture de la colonne « Etat » : 1 145 venus, 703 pas venus, 419 annulés, 38 vendus, 73 SAV, 173 encore `pris`. Résultat en base après fusion : 386 `users` (381 SDR, 1 TL, 2 RH, 2 support ; 50 actifs selon la fiche RH, 370 avec mail), 518 alias, 22 agences (17 actives), 2 392 `personnes`, 2 551 `rdv` (0 sans agence, 0 sans SDR, 26 sans client, 882 avec télé-confirmateur, 29 à domicile), 4 929 `rdv_evenements`, 1 ligne `bot_journal` `import_historique`, RDV du 01/07/2026 au 02/11/2026. Les fichiers sont dans `supabase/imports/licall-stage2/` **en local seulement** (`supabase/imports/` est dans `.gitignore` : noms et téléphones de clients). Pour les régénérer : relancer le script en mode `sql-stage`.

Les **événements Calendar sans ligne Sheets** (≈ 2 400 sur Licall) ne sont **pas** importés : ils n'ont ni prospecteur, ni statut réel, ni client fiable. Si on les veut, relancer sans `--sheets-only` en mode `stage` avec la clé `service_role` (trop volumineux pour l'éditeur SQL).

Les autres classeurs des dossiers Drive (Finances, KPI, extractions PDF, formulaires quiz) sont des agrégats mensuels ou par SDR, pas des RDV : rien à importer, ils se recalculent depuis `rdv` / `rdv_evenements`.

### Limites connues

- Une ligne Sheets sans `EVENT_ID` (ou de moins de 10 caractères) est **rejetée** et comptée dans `rejetsSansEventId` (14 pour Licall). Elle n'est pas en base.
- Sans `--sheets-only`, un événement Calendar « RDV MANDAT » sans ligne Sheets serait importé **sans prospecteur** (`sdr_user_id = null`). Licall a été importé avec `--sheets-only` : chaque RDV en base a sa ligne Sheets.
- Un téléphone non normalisable (`normalizePhoneE164` → `null`) donne `personne_id = null` (26 sur Licall). Le nom client est alors perdu côté base (il n'est porté que par `personnes`).
- Un événement sans `start.dateTime` et sans date Sheets est ignoré (`sansDate`).
- Les 136 RDV des 5 onglets sans canal sont rattachés à leur agence inactive ; si l'une rouvre, `/rdvadmin config` dans son canal la retrouve par nom (ou par `sheet_onglet`) et la réactive sans doublon.
- Pour Kall Kall, l'import complet n'a **pas** été lancé : la base contient déjà l'historique via le cron du dashboard (`source` différent de `'bot'`), et le classeur Kall Kall (45 onglets, ≈ 13 000 lignes) est trop gros pour l'éditeur SQL : passer par `--mode stage` avec la clé `service_role`. Prévoir d'abord la passe `--enrich-only` (Etat, TC, fiche SDR `SDR KK 26`).

---

## 9. Bascule finale (étape 4)

Changements de code à prévoir, dans l'ordre. Aucun n'est commencé.

1. **Lire les agences depuis la table `agences`** au lieu de `data/agencies.json`. Fichiers : `src/utils/rdv-helpers.js` (`loadAgencies`, `saveAgencies`, `getAgencyByChannel`, `requireAgency`), `src/services/scheduler.js` (son propre `loadAgencies`), `src/commands/rdv.js`, `src/commands/rdvadmin.js`, `src/commands/agenda.js`, `scripts/import-history.js`. Lecture par `discord_channel_id` (index unique), filtre `actif = true`, dans la base de la société du serveur Discord de l'interaction (`resolveCompany` par `guildId`, puisque le classeur disparaît). Prévoir un cache mémoire court (le scheduler et chaque commande lisent la liste) et le mapping des noms de colonnes : `calendar_id` ↔ `gcal_calendar_id`, `sheet_name` ↔ `sheet_onglet`, `channel_id` ↔ `discord_channel_id`, `granularite` ↔ `granularite_minutes`, `max_rdv_heure`, `opening_hours`, `paused`, `dom_rdv_enabled`, `timezone`. `src/config/paths.js` : retirer `AGENCIES_PATH`, `SEED_AGENCIES_PATH` et la copie initiale dans `ensureDataDir` ; garder `TOKEN_PATH`.
2. **Lire les SDR depuis `users`** : déjà le cas pour l'écriture (`resolveSdr`). À la bascule, décider si un SDR inconnu peut encore être créé automatiquement ou si `/rdv add` doit être refusé tant que `/rdvadmin sdr` n'a pas été fait (option `createIfMissing`).
3. **Arrêter les écritures Sheets par agence** avec `agences.sync_sheets` : dans `rdv.js`, entourer chaque appel `sheets.appendRowVerified`, `sheets.updateRow`, `sheets.deleteRow`, `sheets.getAllRows` d'un test `agency.sync_sheets`. Le journal `bot_journal` garde `sheets_ok = null` quand Sheets est désactivé. Passer `sync_sheets = false` agence par agence (dashboard ou éditeur), puis globalement.
4. **Supprimer `verifySheetTab`** (`src/services/agency-check.js`) et ses appels dans `rdv.js` (`handleAdd`, `handleDom`) et `rdvadmin.js` (`handleConfig`, `handleVerifier`) ; retirer les options `spreadsheet_id` / `sheet_name` de `/rdvadmin config` ; `findAgencyConflicts` ne compare plus que calendrier et canal.
5. **Rapport de cohérence** : `coherence.js` n'a plus de sens sans Sheets ; le retirer avec `maybeRunCoherence`, ou le réorienter vers Calendar ↔ base.
6. **Export** : si des utilisateurs lisent encore l'onglet, remplacer par la vue `v_export_sheet` (export CSV depuis Supabase ou écran du dashboard). Vider ensuite `agences.spreadsheet_id` et `agences.sheet_onglet`.
7. **Dashboard Kall Kall** : désactiver le cron `import-sheets-rdv` (il relit le classeur Kall Kall tous les jours à 18 h et ferait des `upsert` concurrents sur `gcal_event_id`). Dépôt `AlfredoKK/kallkall-dashboard`, hors de ce dépôt.
8. **Nettoyage** : supprimer `data/agencies.json` du dépôt et du volume Railway, retirer `DB_WRITE_ENABLED` (toujours allumé) et les variables `*_SPREADSHEET_ID`, mettre à jour `.env.example`, `docs/supabase.md` et les tests qui simulent `agencies.json` (`test/agency-check.test.js`, `test/coherence.test.js`).

---

## 10. Règles à ne jamais enfreindre

1. **Séparation des bases.** Une agence est routée vers une base ou vers aucune. Ne jamais ajouter de code qui écrirait « dans les deux », ne jamais copier des lignes d'une base à l'autre, ne jamais joindre leurs exports. Un SDR Licall n'existe pas chez Kall Kall.
2. **Migrations.** Toute évolution de structure va dans `supabase/common/<horodatage>_<nom>.sql`, idempotente (`if not exists`, `create or replace`, `drop … if exists`), et se rejoue **sur les deux bases**, dans la même session. Toute migration future du dashboard Kall Kall se rejoue sur Licall à l'identique (copie dans `supabase/licall-base/`). Ne jamais appliquer une migration à une seule base.
3. **Pas de suppression physique** d'agence, d'utilisateur, d'équipe : `actif = false`. Le trigger `interdire_delete` l'empêche ; ne pas le retirer. Les `DELETE` sur `rdv` ne concernent que `/rdv supprimer`.
4. **Clé `service_role` uniquement côté serveur**, jamais dans le code, jamais dans un embed, jamais dans un log. Pas de clé `anon` : la RLS est activée partout sans policy.
5. **Pas de données client dans les logs ni dans Discord** côté base : les `console.log` de `rdv-db.js` n'écrivent que action, ID d'événement, société et message d'erreur ; `bot_journal.details` ne contient que des booléens, compteurs et codes ; le rapport de cohérence ne cite qu'agence et ID d'événement ; l'import n'affiche que des comptes. Les fichiers de `supabase/imports/` ne se commitent pas.
6. **Idempotence sur `gcal_event_id`** pour toute écriture de RDV. Pas d'`insert` nu sur `rdv`.
7. **Le statut est un journal** (`rdv_evenements`), jamais une colonne mise à jour. L'état courant se lit dans `v_rdv_etat`.
8. **Ne jamais renommer une agence depuis le bot** (`agences.nom` est l'identité côté dashboard ; les noms Discord sont des alias).

---

## 11. Tests

### Lancer

```
npm test
```

`node --test` exécute tout `test/*.test.js`. 86 tests au 12/10/2026, tous verts, moins d'une seconde, sans réseau et sans variables d'environnement.

### Ce que couvrent les nouveaux tests

`test/supabase.test.js` (6) :

- `resolveCompany` : classeur → société, classeur prioritaire sur le serveur Discord, `societe` explicite prioritaire, `null` si rien.
- `getDbForAgency` : pas de société → pas de base ; variables absentes → raison nommant la variable.
- `isDbWriteEnabled` coupé par défaut.
- Client PostgREST : en-têtes `apikey` / `Authorization`, URL `on_conflict`, `Prefer` d'upsert, erreur lisible `Supabase 409 [23505]: …`.
- `inList` : échappement des valeurs.

`test/rdv-db.test.js` (15) :

- Correspondances `sheetStatutToDb`, `sheetConfToDb` ; `normalizePhoneE164` ; `splitDisplayName`, `normaliseLibelle`, `stripEmoji` ; `buildVehicule`.
- Interrupteur coupé : zéro appel, zéro avis.
- Société indéterminable : zéro appel, avis `Base non résolue`.
- `onRdvCreated` : création SDR + alias, client E.164, ligne `rdv` complète, événement `pris`, journal, avis `SDR inconnu créé en base`.
- `onRdvCreated` avec SDR connu par alias : rattachement de l'identifiant Discord, pas de création.
- `onRdvStatus` : RDV absent recréé puis annulé, idempotent, jamais de création de SDR.
- `onRdvConfirmation`, `onRdvModified` (rebook), `onRdvDeleted`.
- Échec base : `db_ok = false`, avis `Base non écrite`, aucune exception.
- `syncAgencyToDb` : mise à jour sans renommage ; agence connue par nom (import) jamais recréée ; création + alias.
- Conversion `opening_hours` bot ↔ base (`toDbOpeningHours`, `fromDbOpeningHours`), aller-retour sans perte.
- `linkSdr` indépendant de l'interrupteur.

`test/coherence.test.js` (4) : fenêtre de dates et mapping de `sheetRowToRecord` ; `compareAgency` (absents, écarts, `confirme` = `pris`, aucun nom de client dans les lignes) ; `formatReport` ; `getReportHour`.

`test/import-history.test.js` (8) : détection des colonnes « Etat » / « TC », lecture des onglets, priorité Etat > STATUT, TC → `confirme_par`, téléphone à 9 chiffres et `#ERROR!`, dates Sheets, rôles et lignes de la fiche SDR (onglets SDR et ARCHIVE), `stagingRows` / `sqlMerge` (agence sans canal, résolution par onglet).

### Simuler la base

Pas de Supabase local. Le point d'entrée est `setClientOverrideForTests(companyKey, client)` dans `src/services/supabase.js` : le client fourni remplace celui que `getClient` fabriquerait pour cette société, quelles que soient les variables. `resetClientCacheForTests()` retire les overrides et vide le cache. Les tests posent `process.env.DB_WRITE_ENABLED = 'true'` dans le test et le retirent dans `finally`.

Le faux client (`fakeDb` dans `test/rdv-db.test.js`) implémente `select`, `insert`, `upsert`, `update`, `remove`, `rpc` avec un état en mémoire (`users`, `personnes`, `rdv`, `events`, `journal`) et journalise chaque appel dans `calls` : les assertions portent autant sur l'état final que sur les filtres PostgREST envoyés (ex. `{ id: 'eq.u-existant', discord_user_id: 'is.null' }`). Deux surcharges : `overrides.select` et `overrides.rpc` pour simuler `resoudre_user` / `resoudre_agence`.

`src/services/alerts` et `src/services/sheets` sont remplacés dans `require.cache` (`mockModule`) avant le `require` des modules testés : les avis sont collectés dans un tableau, les lignes Sheets viennent d'une variable. Pour tester une nouvelle action, suivre ce modèle plutôt que de pointer sur une base réelle.

---

## Ce qui n'est pas fait

- **Allumage** : `DB_WRITE_ENABLED` est à `false` et les clés `service_role` ne sont pas dans Railway. Checklist en section 7.
- **Les dix jours de double écriture** (étape 3) et l'analyse des rapports de cohérence qui en sortent.
- **La bascule** (étape 4) : rien n'est commencé, liste en section 9. Le bot lit toujours `data/agencies.json` ; `agences.sync_sheets` n'est lu par aucun code.
- **Passe `--enrich-only` sur Kall Kall** (Etat, TC, fiche SDR) : à lancer en mode `stage` avec la clé `service_role` Kall Kall, une fois la double écriture validée.
- **Événements Calendar Licall sans ligne Sheets** : non importés (choix `--sheets-only`), voir section 8.
- **`onRdvDeleted` sur Kall Kall** : `/rdv supprimer` fait un `delete` physique sur `rdv` ; si une table du dashboard référence `rdv.id` sans `on delete cascade`, la suppression échouera (journalisée, non bloquante). À vérifier avant l'allumage côté Kall Kall.
- **Suppression du schéma `archive_sandbox_2026_06`** de la base Licall (ancien schéma d'essai de juin, voir `supabase/archive-2026-06/`), après validation de la bascule.
- **Référentiel Kall Kall** : `paused` et `max_rdv_heure` de la base Kall Kall n'ont pas été alignés sur le volume Railway lors du chargement du 12/10 ; ils le seront au premier `/rdvadmin pause|play| config` par agence une fois l'interrupteur allumé, ou à la bascule.
- **Format de `opening_hours`** : le bot stocke `{ "0": "fermé", "1": "09:00-19:30" }` (jour JavaScript) dans `agencies.json` ; la base attend `{ "1": ["09:00","19:30"] }` (jour ISO, absent = fermé). `agencyToDbPatch` convertit avec `toDbOpeningHours` ; à la bascule, lire la base avec `fromDbOpeningHours` (`src/services/opening-hours.js`).
- **Dashboard Licall** : inexistant ; l'édition se fait dans l'éditeur Supabase.
- **`referentiel_ecrire` côté dashboard** : la fonction SQL accepte les colonnes bot, mais l'écran « Gestion des agences » du dashboard n'a pas été modifié pour les afficher (dépôt `kallkall-dashboard`).
