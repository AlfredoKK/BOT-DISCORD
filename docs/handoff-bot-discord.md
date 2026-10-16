# Handoff — bot Discord « RDV MANDAT » (Licall / Kall Kall)

Rédigé le 16 octobre 2026 pour le développeur qui reprend le bot. Sources : le code du dépôt `AlfredoKK/BOT-DISCORD` (chaque affirmation technique cite `fichier:ligne`, lus le 16/10), les sessions de travail du 22/09 au 16/10/2026, les logs Railway, l'API Discord et les deux bases Supabase vérifiés le 16/10. Ce qui n'a pas pu être vérifié est marqué **(à confirmer)**.

Ce document est la porte d'entrée. Deux documents le complètent : [passation-supabase.md](passation-supabase.md) (migration Sheets → Supabase, en détail) et [rapport-devs-2026-10-12.md](rapport-devs-2026-10-12.md) (état de cette migration au 12/10).

---

## 0. En une page

**Ce que fait le bot.** Un bot Discord unique (« KallKall Support ») sert deux sociétés, Licall et Kall Kall (Vroom Market), chacune sur son propre serveur Discord. Les prospecteurs (SDR) y posent des rendez-vous de mandat de vente de véhicule (« RDV MANDAT ») avec `/rdv add`, par agence automobile. Chaque RDV devient un événement Google Calendar sur le calendrier de l'agence et une ligne dans l'onglet Google Sheets de l'agence. Le bot envoie cinq fois par jour l'image de l'agenda de la semaine dans le canal Discord de chaque agence active. Une migration vers Supabase (une base par société) est codée, testée et **éteinte** ; les Sheets restent la référence en production.

**Chiffres au 16/10/2026.** 60 agences environ configurées sur le volume de production (53 actives, le reste en pause), 2 serveurs Discord, 2 classeurs Sheets, 1 compte Google (`contact@licall.fr`), 1 service Railway, 3 commandes slash (`/rdv`, `/rdvadmin`, `/agenda`), 86 tests. Bot en ligne sans interruption depuis le 23/09 (dernier déploiement, commit `a58b9ab`).

**Ce qui est fragile.** Le bot est en production permanente, utilisé en continu par les équipes. Un redéploiement coupe le bot 1 à 2 minutes. La configuration vivante des agences est sur le volume Railway, pas dans Git. Le compte Google est le seul accès aux calendriers des partenaires. Toute erreur de configuration d'agence se voit immédiatement (RDV orphelins, agenda non envoyé).

**Les trois règles du propriétaire (Alfredo).**
1. « Licall = Licall / Kall Kall = Kall Kall / Ne pas mélanger les deux. » Chacun son serveur, son canal, son calendrier, son onglet, sa base.
2. « Ne modifie en rien le bot qui aujourd'hui fonctionne très bien. » Tout changement passe par une PR qu'Alfredo fusionne lui-même ; le chantier Supabase reste inerte tant que `DB_WRITE_ENABLED=false`.
3. « Je te dirai quand lancer l'écriture. » L'allumage de la double écriture est une décision d'Alfredo, pas du dev.

---

## 1. Cartographie : qui, quoi, où

### 1.1 Acteurs

| Qui | Rôle |
|---|---|
| Alfredo (`alfredo@vroommarket.fr`, GitHub `AlfredoKK`) | Propriétaire. Fusionne les PR, colle les variables Railway, décide des bascules. |
| Jeremy Scatigna | Auteur du code d'origine (dépôt `jeremyscatigna/discord-support`). Le bot a tourné sur son Railway jusqu'au 22/09/2026 ; il ne l'héberge plus. |
| Team Leads et admins Discord (comptes vus dans les logs : `fanny_licall_19827`, `anais_licall`, `bitterlinlaura`) | Utilisent `/rdvadmin pause`, `play`, `config`, `horaires` au quotidien. |
| SDR / prospecteurs | `/rdv` et `/agenda` uniquement. |
| Claude Code | A fait les évolutions du 22/09 au 16/10 (PR #1 à #14). |

### 1.2 Dépôts GitHub

| Dépôt | Contenu |
|---|---|
| `AlfredoKK/BOT-DISCORD` | **Ce bot.** Branche `main` = production (auto-déploiement Railway). PR #1 à #13 fusionnées les 22–23/09. PR #14 `feat/supabase-schema` **ouverte, non fusionnée** (couche Supabase + import + ce handoff). |
| `AlfredoKK/kallkall-dashboard` | Dashboard Kall Kall. Sa base Supabase est partagée avec le bot ; ses 42 migrations sont la structure de référence. |
| `AlfredoKK/kallkall-bot` | **Un autre bot**, en Python, qui répond aux mentions dans les canaux `questions-*` (FAQ). Même nom affiché « KallKall Support ». Projet Railway `radiant-inspiration`. Ne pas confondre. |

### 1.3 Hébergement Railway (compte Alfredo, workspace « alfredokk's Projects »)

| Élément | Valeur |
|---|---|
| Projet | `bot-discord-rdv` (`b559b183-2e91-496e-8779-e3bd9878fb81`) |
| Service | `rdv-bot` (`b556180c-6a03-4088-9310-8893f69684c2`), environnement `production` (`2eac674c-5440-4e8a-a68a-07f83e5afc7b`) |
| Source | GitHub `AlfredoKK/BOT-DISCORD`, branche `main`, auto-déploiement à chaque fusion (≈ 2 min) |
| Build / start | Railpack, `node src/index.js` ; pas de Dockerfile ni `railway.json` dans le dépôt |
| Région | `us-east4-eqdc4a`, 1 réplica |
| Volume | `rdv-bot-data` (`a093af64-…`), 50 Go, monté sur `/data` : contient `agencies.json` (config vivante) et `google_token.json` |
| URL publique | `https://rdv-bot-production.up.railway.app` ; `GET /health` |
| Variables posées (noms) | `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_JSON`, `DATA_DIR`, `TZ`, `NODE_ENV`, `REGISTER_COMMANDS_ON_START`, `ADMIN_ROLE_NAME`, `ALERT_CHANNEL_ID`, `PUBLIC_URL` |
| Variables **absentes** | Tout ce qui concerne Supabase (`SUPABASE_*`, `DB_WRITE_ENABLED`) et l'archive Drive (`GOOGLE_DRIVE_*`) |
| Dernier déploiement | 23/09/2026 12:47Z, commit `a58b9ab` (PR #13), statut SUCCESS |

Les valeurs des variables ne sont lisibles que dans le dashboard Railway. Le bot Python FAQ est dans le projet `radiant-inspiration`, service `kallkall-bot`, région `europe-west4` depuis le 12/10 (après un bannissement de l'IP US-East par Cloudflare).

### 1.4 Discord

| Élément | Valeur |
|---|---|
| Application / bot | « KallKall Support », client ID `1450027085434458225` |
| Serveur Licall | guild `1443725425904848959` |
| Serveur Kall Kall | guild `1445676914667946085` |
| Canal d'alertes | `#alertes-bot` (serveur Kall Kall) `1551961930875404408` |
| Convention de canaux | Une catégorie par agence (`☎️ Nom - Partenaire`) avec `rdv-<ville>`, `infos-<ville>`, `questions-<ville>`, `consentement-<ville>`. Le bot n'agit que dans `rdv-<ville>` (canal lié par `/rdvadmin config`). Un préfixe `🚫` sur le nom du canal est une convention humaine « agence en pause », sans effet technique. |
| Commandes enregistrées (globales, vérifié 16/10) | `/agenda semaine`, `/rdv add dom annuler vendu supprimer conf modifier`, `/rdvadmin auth callback status config deconfig verifier agences calendars pause play horaires testalerte alertes` |
| Intents | `Guilds`, `GuildMessages` (`src/index.js:36-37`) |
| Permissions nécessaires au bot par canal `rdv-*` | Voir le salon, Envoyer des messages, Joindre des fichiers (`src/services/scheduler.js:73-84`) |

### 1.5 Google (compte du bot : `contact@licall.fr`, projet OAuth n° 214366939500)

| Élément | Valeur |
|---|---|
| Classeur KALLKALL (agences Vroom) | `1dshz0ZhA44VziYOirOwQj_AQFRJxehsV7yZnZ5LJ0BU` |
| Classeur LICALL (agences partenaires) | `16H-aZ8eV9M5Qd5ZToWFSluZFbtHKdP0wcS3mtBK_mzI` |
| Fiches RH SDR | `SDR LC 26` `1TDii7089ebh0XG9xcy8FyC43cfGfqpXzIeJRrIwytbU` ; `SDR KK 26` `14Ab0jU1JL2IXCn-7covj24G2DPpjpVAQ-dGIDOjihuo` |
| Dossiers Drive de données | Licall `0AEPC9y4khfbXUk9PVA` ; Kall Kall `0ABxf3OcEQDceUk9PVA` |
| Calendriers | Un par agence. Vroom : `<ville>@vroommarket.fr` (le compte du bot en est propriétaire). Partenaires Licall : calendriers tiers (gmail, weecars.fr, `…@group.calendar.google.com`) partagés en écriture avec `contact@licall.fr`. |
| Token OAuth | Fichier `/data/google_token.json` sur le volume. Scopes actuels : `calendar`, `spreadsheets`. **Le scope `gmail.send` manque** (alerte du 28/09 dans les logs) : les alertes par e-mail ne partent pas, seul Discord fonctionne. |
| Compte de service Drive | Non configuré sur Railway → l'archivage des agendas de 21 h sur Drive est **inactif**. |

### 1.6 Supabase (migration en cours, éteinte en prod)

| Société | Projet | Rôle |
|---|---|---|
| Licall | `zvfhhcxsdzyubufmexng` | Nouvelle base. Historique chargé le 12/10 (2 551 RDV). Ancien schéma d'essai conservé dans `archive_sandbox_2026_06`. |
| Kall Kall | `cegswxmdpsvzqrjplcvy` | **Base de production du dashboard Kall Kall**. 33 756 RDV, alimentée chaque jour à 18 h par le cron `import-sheets-rdv` du dashboard. |

Clés `service_role` : à prendre dans Supabase → Project Settings → API ; elles ne sont ni dans Railway ni dans le `.env` local au 16/10. Le 16/10, l'accès MCP à la base Licall renvoyait « permission refusée » alors qu'il fonctionnait le 12/10 **(à confirmer côté organisation Supabase)**.

### 1.7 Machine locale d'Alfredo

Dépôt cloné dans `/Users/alfredotransakauto/BOT DISCORD`, branche `feat/supabase-schema`. `.env` présent (token Discord, identifiants Google) et `data/google_token.json` présent, tous deux gitignorés. Node v25.8.1. `gh` authentifié. Les fichiers d'import générés (`supabase/imports/`) sont gitignorés car ils contiennent des noms et téléphones de clients.

---

## 2. Architecture du code

### 2.1 Arborescence

```
src/index.js                 démarrage, routage des interactions, erreurs globales
src/deploy-commands.js       enregistrement des commandes slash (rest.put)
src/health.js                GET /health
src/config/paths.js          DATA_DIR, agencies.json, google_token.json, amorçage du volume
src/commands/rdv.js          /rdv (7 sous-commandes) — cœur métier
src/commands/rdvadmin.js     /rdvadmin (16 sous-commandes, dont 3 Supabase non déployées)
src/commands/agenda.js       /agenda (image de la semaine à la demande)
src/services/calendar.js     Google Calendar (création, patch, suppression, couleurs)
src/services/sheets.js       Google Sheets (append vérifié, update, delete, onglets)
src/services/google-auth.js  OAuth2 utilisateur, token, scopes
src/services/capacity.js     plafond de RDV par heure/jour, marqueurs calendrier, retenues
src/services/opening-hours.js horaires d'ouverture + conversion vers le format base
src/services/scheduler.js    envoi automatique des agendas, archive Drive, rapport cohérence
src/services/alerts.js       incidents (Discord + e-mail) et avis d'exploitation
src/services/log-buffer.js   80 dernières lignes de log pour les rapports d'incident
src/services/agency-check.js vérification onglet/calendrier, conflits entre agences
src/services/drive-archiver.js archive PNG sur Drive via compte de service
src/services/supabase.js     client PostgREST, routage société, interrupteur DB_WRITE_ENABLED
src/services/rdv-db.js       double écriture en base (idempotente)
src/services/coherence.js    rapport Sheets ↔ base
src/utils/rdv-helpers.js     agences (load/save/getByChannel), titre d'événement, lignes Sheets
src/utils/rdv-title.js       parsing/formatage des titres et descriptions Calendar
src/utils/date-utils.js      parseDateTime, semaines, formats
src/utils/capacity / permissions / agenda-image / agenda-summary / retry
scripts/import-history.js    import d'historique vers Supabase
scripts/check-agenda-colors.js diagnostic couleurs d'un calendrier
data/agencies.json           SEED de configuration (copié une seule fois sur le volume)
assets/fonts/DejaVuSans*.ttf police embarquée pour les images
supabase/common/             migrations du bot (à appliquer aux DEUX bases)
supabase/licall-base/        copie des 42 migrations du dashboard rejouées sur Licall
test/*.test.js               86 tests, node --test
```

### 2.2 Séquence de démarrage (`src/index.js`)

1. `dotenv` (`:1`), puis `installLogBuffer()` en premier pour capter les logs de boot (`:5`).
2. `ensureDataDir()` (`src/config/paths.js:21-40`) : crée `DATA_DIR` ; **copie `data/agencies.json` du dépôt vers le volume uniquement s'il n'y est pas encore** (`:24-27`) ; écrit `google_token.json` depuis `GOOGLE_TOKEN_JSON` uniquement si le fichier est absent (`:29-37`).
3. Client Discord avec agent HTTP `undici` dédié (`:26-43`).
4. Chargement de `src/commands/*.js` (`:46-55`).
5. Serveur `/health` démarré **avant** le login (`:144`) : il répond 503 tant que Discord n'est pas prêt.
6. `client.login(DISCORD_TOKEN)` (`:154`).
7. Au `clientReady` : enregistrement des commandes slash par `rest.put` (sauf `REGISTER_COMMANDS_ON_START=false`, `:118-125`), puis `startScheduler` (`:128-129`), qui fait un passage immédiat.
8. `unhandledRejection` / `uncaughtException` : log + alerte, **le process ne quitte pas** (`:133-141`).

### 2.3 Routage d'une commande

`interactionCreate` → `client.commands.get(name).execute(interaction)` (`src/index.js:59-65`). Chaque commande fait son `switch` sur la sous-commande et a son propre `try/catch` qui répond `Erreur: <message>` (`rdv.js:193-204`, `rdvadmin.js:141-152`). Le handler global ne voit donc que les erreurs de la réponse elle-même ; les erreurs métier remontent par les avis d'exploitation (`notifyOps`), pas par les alertes d'incident.

### 2.4 Flux complet d'un `/rdv add` (`src/commands/rdv.js:226-359`)

1. Agence du canal (`requireAgency`) ; sinon avis « Canal sans agence » et refus.
2. Agence en pause → refus ⏸️.
3. `parseDateTime(date, heure)` : `JJ/MM/AAAA` (ou `JJ/MM/AA`, `JJ/MM`), heure `H:MM` strict ; refuse le passé.
4. Horaires d'ouverture (`isWithinOpeningHours`) : le RDV d'1 h doit finir avant la fermeture.
5. Capacité (`isSlotAvailable`) : plafond horaire/journalier + marqueurs du calendrier.
6. **Vérification de l'onglet Sheets avant toute écriture** (`verifySheetTab`) pour ne jamais créer d'événement orphelin.
7. Type de confirmation : `J/J` si le jour même, `J+1` si lendemain (auto-`CONF` si posé avant 12 h), sinon vide.
8. Retenue mémoire du créneau (`reserveSlot`, 30 s) → **Calendar `createEvent`** (titre canonique, couleur verte, 1 h).
9. **Sheets `appendRowVerified`** (append puis relecture de l'EVENT_ID jusqu'à 3 fois). Échec → avis « Sheets non écrit » avec l'ID d'événement ; la commande continue.
10. **Base** `rdvDb.onRdvCreated` : renvoie `skipped` tant que `DB_WRITE_ENABLED=false`.
11. Embed public « RDV créé » avec date, heure, agence, client, téléphone, véhicule, ID d'événement, lien Calendar, état Sheets (et état Base si allumé).

Ordre pour `dom`, `annuler`, `vendu`, `supprimer`, `modifier` : Calendar → Sheets → base. **Exception `conf`** : Sheets d'abord, puis Calendar, et un échec Calendar est seulement loggué (`rdv.js:785-788`).

---

## 3. Configuration

### 3.1 Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `DISCORD_TOKEN` | — | **Seule variable obligatoire au boot** (`index.js:154`). |
| `DISCORD_CLIENT_ID` | id du bot au runtime | Enregistrement des commandes. Obligatoire pour `npm run deploy`. |
| `DISCORD_GUILD_ID` | vide → commandes globales | Si posée : enregistrement sur un seul serveur (instantané). Non posée en prod : propagation globale jusqu'à 1 h. |
| `REGISTER_COMMANDS_ON_START` | activé | `false` désactive l'enregistrement au démarrage. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | — | Client OAuth2 Google. |
| `GOOGLE_TOKEN_JSON` | vide | Amorce `google_token.json` **seulement si le fichier est absent** du volume. |
| `DATA_DIR` | `./data` | `/data` en prod (volume). |
| `TZ` | — | `Europe/Paris` **indispensable** : `parseDateTime`, horaires, lignes Sheets utilisent l'heure locale du serveur (`date-utils.js:53`, `opening-hours.js:24`). |
| `PORT` | 3000 | Port de `/health`. |
| `PUBLIC_URL` | vide | Affichage dans `/rdvadmin alertes`. |
| `ADMIN_ROLE_IDS` | vide | IDs de rôles autorisés sur `/rdvadmin`. |
| `ADMIN_ROLE_NAME` | vide | Noms de rôles **ajoutés** aux défauts `admin`, `team lead`. |
| `ALERTS_ENABLED` | true | `false` coupe incidents et avis. |
| `ALERT_CHANNEL_ID` | vide | Canal Discord des incidents et avis. |
| `ALERT_EMAIL_FROM` / `ALERT_EMAIL_TO` | `contact@licall.fr` | E-mail d'alerte (inactif sans scope `gmail.send`). |
| `ALERT_COOLDOWN_MINUTES` | 15 | Anti-spam incidents par signature. |
| `OPS_NOTICES_ENABLED` / `NOTICE_COOLDOWN_MINUTES` | true / 30 | Avis d'exploitation. |
| `GOOGLE_DRIVE_ARCHIVE_ROOT_FOLDER_ID`, `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` ou `_FILE` | vide | Archive Drive de 21 h (inactive). |
| `DB_WRITE_ENABLED` | **false** | Interrupteur de la double écriture Supabase. |
| `SUPABASE_LICALL_URL`, `SUPABASE_LICALL_SERVICE_ROLE_KEY`, `SUPABASE_KALLKALL_URL`, `SUPABASE_KALLKALL_SERVICE_ROLE_KEY` | vide | Bases. |
| `COHERENCE_REPORT_HOUR` | 22 | Heure du rapport Sheets ↔ base (si allumé). |
| `LICALL_GUILD_ID`, `KALLKALL_GUILD_ID`, `LICALL_SPREADSHEET_ID`, `KALLKALL_SPREADSHEET_ID` | codés en dur (`supabase.js:23-35`) | Routage société. |

`.env.example` documente chacune.

### 3.2 `agencies.json` : le fichier qui pilote tout

Objet `{ "<clé>": { … } }`, clé = nom d'agence en minuscules saisi dans `/rdvadmin config` (`rdvadmin.js:270`). Lu intégralement à **chaque** commande, sans cache (`rdv-helpers.js:14-21`), donc une modification du fichier est prise en compte immédiatement, sans redémarrage.

| Clé | Écrite par | Effet |
|---|---|---|
| `name` | config | Libellé, et clé de résolution en base. |
| `calendar_id`, `spreadsheet_id`, `sheet_name` | config | Calendrier et onglet de l'agence. |
| `channel_id` | config | Lien canal Discord ↔ agence (`getAgencyByChannel`, première entrée qui correspond). |
| `guild_id` | config (depuis le 12/10) | Routage société de secours. Absent pour toutes les agences configurées avant. |
| `max_rdv_heure` | config | Plafond horaire. Texte numérique toléré (`parseCapacityValue`). |
| `max_rdv_jour` | **aucune commande** | Plafond journalier (édition manuelle seulement). |
| `opening_hours` | horaires | `{ "0".."6": "HH:MM-HH:MM" | "fermé" }`, 0 = dimanche. Absent → lun-sam 09:00-19:30. |
| `paused` | pause / play | Bloque `/rdv add`, `/rdv dom` et l'agenda automatique. |
| `dom_rdv_enabled` | **aucune commande** | Autorise `/rdv dom` (une seule agence : Saint-Cannat). |
| `granularite`, `timezone` | config (constantes) | Non utilisés par la logique. |
| `societe` | **aucune commande** | Routage société explicite (prioritaire). |

**Seed vs volume.** `data/agencies.json` du dépôt (55 agences : 18 Licall, 37 Kall Kall) n'est copié sur `/data` qu'au premier démarrage d'un volume vide (`paths.js:24-27`). Depuis le 22/09, **le fichier du volume fait foi** ; les commits sur le seed n'ont aucun effet en production. Au 16/10, le volume contient au moins 60 agences : les 55 du seed, plus TRÉGUNC, TOULOUSE - AGORA CARS, TOULOUSE SUD - SIMPLICICAR, VELAUX et une entrée « SANTENY » configurées depuis via `/rdvadmin config`. L'entrée « SANTENY » du volume envoie ses agendas dans un canal qui n'est pas celui du seed (`#rdv-santeny` Licall, sans message le 16/10) **(à confirmer : probablement le Santeny Vroom, côté Kall Kall)**.

**Pour connaître l'état réel** : `/rdvadmin agences` (liste publique ⏸️/▶️ avec plafond et canal) et `/rdvadmin verifier` (contrôle calendrier/onglet/conflits). Il n'existe pas de commande d'export du fichier du volume.

**`/rdvadmin config` réécrit l'entrée entière** (`rdvadmin.js:270-280`) : reconfigurer une agence existante remet `paused`, `opening_hours`, `dom_rdv_enabled`, `max_rdv_jour` à zéro. Relancer `/rdvadmin horaires` ensuite si besoin.

### 3.3 État des agences au 16/10/2026 (d'après l'envoi de 8 h et les logs)

Actives (53) : VILLEBON, TOURS, ROUEN, REIMS, PAU, PARIS, ORLÉANS, NICE, MULHOUSE, MERIGNAC, MARSEILLE, LILLE, LA ROCHELLE, LA CIOTAT, HERBLAY, ETAMPES, COLOMBES, CHARTRES, CHAMBERY, CAEN, BLOIS, COIGNIÈRES - LG PRESTIGE, COLMAR, MAUBEUGE, TOULOUSE NORD, ROANNE, SANTENY, VALENCE, RENNES, LIMOGES, LICALL TEST, VILLENAVE, ST CANNAT, LIMAS LUXE, LIMAS CLASSIQUE, LOGNES, CHANTILLY, LYON NORD, BOURGOIN JAILLEUX, LIMOGES - WEECARS, POITIERS - WEECARS, POITIERS, TOULOUSE - AGORA CARS, GARIDECH, BUCHELAY, BESANÇON, TRÉGUNC, CHOLET, TOULOUSE SUD - SIMPLICICAR, DIJON, LA QUEUE EN BRIE, NANTES, VELAUX.

En pause (commandes `/rdvadmin pause` tracées dans les logs) : DOUAI (05/10), BÉZIERS (06/10), ST ANDRE DLM (12/10), MONTPELLIER (15/10), STRASBOURG (15/10), MONTAUBAN (16/10), EVREUX (avant octobre). Probablement en pause aussi, d'après le seed : ALBI, PERPIGNAN, TOULOUSE ST ORENS, PIERRELAYE, ANNEMASSE, SANTENY - JVVA **(à confirmer avec `/rdvadmin agences`)**. Albi et Toulouse St Orens ont en plus un onglet manquant / un calendrier non partagé (contrôle du 22/09) : ne pas les réactiver sans corriger.

Cas particuliers à connaître :
- Deux Poitiers : Weecars (Licall, canal `1542200508188598412`, onglet LICALL `POITIERS - WEECARS`) et Vroom (Kall Kall, canal `1549341286501318656`, onglet KALLKALL `POITIERS`). Deux Limoges, deux Toulouse Licall (Agora Cars, Simplicicar) et un Toulouse Nord Kall Kall.
- Paris : canal `rdv-paris-15`, calendrier `paris15@vroommarket.fr`, onglet KALLKALL `PARIS 15` (pas `PARIS`), 4 RDV/h.
- Santeny : « Vroom Santeny est chez KK et JVVA Santeny est chez Licall mais plus actif » (Alfredo, 12/10).
- ST ANDRE DLM = « RM TOP MARQUES » dans le langage des équipes (nom du partenaire).

---

## 4. Commandes

### 4.1 `/rdv` (prospecteurs, aucun contrôle de rôle)

| Sous-commande | Options | Effets |
|---|---|---|
| `add` | `date`, `heure`, `nom_client`, `telephone`, `marque`, `modele`, `annee`, `kilometrage`, `prix` (requis), `liens`, `commentaire` | Flux §2.4. |
| `dom` | idem + `adresse` (requis) | RDV à domicile : agence avec `dom_rdv_enabled` seulement ; **ni horaires, ni capacité, ni retenue** (`rdv.js:395-432`) ; événement Calendar de 1 h 30 commençant 15 min avant l'heure saisie, couleur violette ; la ligne Sheets porte l'heure saisie. |
| `annuler` | `id` | Refuse si le RDV est passé. Calendar : préfixe `ANNULÉ`, couleur rouge ; puis Sheets `STATUT=ANNULÉ`. Échec Calendar → arrêt, Sheets non touché. |
| `vendu` | `id` | Préfixe `VENDU`, couleur orange, `STATUT=VENDU`. |
| `supprimer` | `id` | Suppression **physique** de l'événement Calendar et de la ligne Sheets. Irréversible. |
| `conf` | `id`, `statut` (`CONF` / `NON CONF`) | Sheets d'abord (`CONFIRMATION`, `CONF_PAR` = pseudo, `UPDATED_AT`), puis préfixe Calendar sans changer la couleur ; échec Calendar silencieux. |
| `modifier` | `id` + options facultatives (`nouvelle_date`, `nouvelle_heure`, client, téléphone, véhicule, `liens`, `commentaire`) | Ligne Sheets **obligatoire** (sinon « Modification bloquée »). Valeurs courantes relues depuis le titre Calendar. Déplacement → horaires + capacité revérifiés (hors DOM), confirmation recalculée, `STATUT=PLANIFIÉ`, `CONF_PAR` vidé. `commentaire` mis en majuscules (pas dans `add`). |

Toutes répondent en public dans le canal (`deferReply()`), avec un embed coloré (vert créé, violet DOM, rouge annulé, orange vendu, gris supprimé, bleu modifié).

### 4.2 `/rdvadmin` (rôle Admin / Team Lead / permission Administrateur)

| Sous-commande | Effet | Réponse |
|---|---|---|
| `auth` | Lien de consentement Google (`prompt=consent`, offline). | éphémère |
| `callback code:` | Échange le code, écrit `google_token.json`. | éphémère |
| `status` | Uptime, Google auth, nombre et liste des agences. | éphémère |
| `config agence: calendar_id: spreadsheet_id: max_rdv_heure: [sheet_name:]` | Vérifie l'onglet (refus si absent), refuse un calendrier ou un onglet déjà utilisé par une autre agence, remplace l'entrée liée au canal, **réécrit** l'agence, miroir base si allumé. Sans `sheet_name` : premier onglet ne contenant pas « totaux »/« résumé ». | public |
| `deconfig` | Retire l'agence du canal (fichier), puis la passe inactive en base si allumé. | public |
| `verifier` | Pour chaque agence : conflits, accès calendrier, présence de l'onglet. | éphémère |
| `agences` | Liste ⏸️/▶️ — plafond — canal. | **public** |
| `calendars` | Calendriers visibles par le compte du bot. | éphémère |
| `pause` / `play` | `paused=true` / supprimé. Tracé dans les logs `[PAUSE]`/`[PLAY]` avec le pseudo. | public |
| `horaires [lundi: … dimanche:]` | `HH:MM-HH:MM` ou `fermé`. Sans option : affiche. | public |
| `testalerte` | Force un incident de test (Discord + e-mail). | éphémère |
| `alertes` | État des alertes, scope Gmail, commit, sonde. | éphémère |
| `db`, `coherence`, `sdr` | Supabase (PR #14, **pas encore en production**). `sdr` et `db` fonctionnent même interrupteur coupé. | éphémère |

### 4.3 `/agenda [semaine: S | S+1]` (ouverte à tous)

Image PNG de la semaine (dimanche → samedi) de l'agence du canal, envoyée en arrière-plan après un message d'attente ; repli en texte si l'image échoue ; avis « Agenda non envoyé » en cas d'échec total (`agenda.js:61-93`).

---

## 5. Règles métier

### 5.1 Titre d'événement Calendar (`rdv-helpers.js:116-131`, `rdv-title.js`)

```
[STATUT - ]RDV MANDAT[ DOM] - NOM CLIENT - TÉLÉPHONE - MARQUE - MODÈLE - ANNÉE - <km> KM - <prix>€
```
Préfixes reconnus : `CONF`, `NON CONF`, `J/J`, `ANNULÉ`, `PAS VENU`, `NO SHOW`, `VENDU`. Description : sections `Adresse:`, `Liens:`, `Commentaire:`. Le titre est **re-parsé** par `/rdv modifier` : un titre édité à la main dans Calendar peut être mal découpé. Couleurs : 10 vert (RDV), 3 violet (DOM), 11 rouge (annulé), 6 orange (vendu).

### 5.2 Ligne Sheets (`sheets.js:81-82`, plage `A:K`)

A `PROSPECTEUR` (pseudo Discord) · B `VEHICULE` (modèle seul) · C `CLIENT` · D `TELEPHONE` (préfixé d'une apostrophe) · E `DATE` `JJ/MM/AAAA` · F `HEURE` · G `CONFIRMATION` (`J/J`, `J+1`, `CONF`, `NON CONF`, vide) · H `STATUT` (`PLANIFIÉ`, `ANNULÉ`, `VENDU`) · I `EVENT_ID` · J `UPDATED_AT` · K `CONF_PAR`.

Les équipes ajoutent à droite deux colonnes hors bot, en position variable : **« Etat »** (résultat réel : VENU / PAS VENU / ANNULÉ / VENDU / SAV) et **« TC »** (télé-confirmateur). Le bot ne les lit pas ; l'import Supabase et le cron du dashboard, si.

### 5.3 Capacité (`capacity.js`)

- Plafond horaire = `max_rdv_heure` ; **défaut 1** si absent ou invalide (`:13`, `:294-297`).
- Marqueurs posés par l'équipe dans le **titre** d'événements du calendrier : `N RDV/H` (plafond horaire, le minimum avec la config gagne), `N RDV/J`, `PAS DE RDV` (bloque le créneau), `STOP RDV` (bloque la journée), `AGENCE FERMÉE`. Un plafond « inexpliqué » vient presque toujours d'un marqueur : vérifier le calendrier avant le code (cas Tours et Paris le 22/09).
- Comptent comme RDV : titres `RDV MANDAT` sans préfixe d'annulation, durée ≤ 3 h.
- Retenue mémoire de 30 s par créneau pendant la création ; perdue au redémarrage ; fenêtre de concurrence entre le contrôle et la retenue (`rdv.js:260-278`).

### 5.4 Horaires, dates, fuseau

- Horaires : jour fermé ou RDV finissant après la fermeture → refus. Format strict `H:MM-H:MM`.
- `parseDateTime` : `JJ/MM/AAAA`, `JJ/MM/AA`, `JJ/MM` ; heure `H:MM` (« 9h30 » refusé) ; refuse tout instant passé.
- Tout est en heure locale du serveur, d'où `TZ=Europe/Paris` obligatoire ; Calendar reçoit explicitement `Europe/Paris`.

### 5.5 Statuts et confirmation

`J/J` même jour, `J+1` lendemain (auto-`CONF` si posé avant midi), `CONF` / `NON CONF` par `/rdv conf`. Statut Sheets : `PLANIFIÉ` → `ANNULÉ` | `VENDU` ; `PAS VENU` n'est posé par aucune commande (seulement reconnu).

---

## 6. Agendas automatiques (`scheduler.js`)

- Un `setInterval` de 60 s ; passage à **08:00, 12:00, 15:00, 18:00, 21:00 heure de Paris** (`SEND_HOURS` `:13`), uniquement à la minute 00.
- Pour chaque agence **non en pause** : vérification du canal et des 3 permissions, puis deux images (semaine S et S+1) ; 1,5 s entre les deux, **5 s entre agences** → un passage dure ≈ 10 min pour 53 agences.
- Échec d'une agence → avis « Agenda automatique non envoyé » ; ≥ 3 agences ou ≥ 30 % → incident `agendas-en-échec`.
- Passage de 21 h : archive Drive de l'image S si configurée (inactif aujourd'hui).
- **Aucune variable ne coupe les agendas** : mettre l'agence en pause, ou modifier `SEND_HOURS`.
- Un passage est relancé au démarrage : un redéploiement à hh:00 pile peut envoyer deux fois.
- Les 5 passages du 12/10 au 16/10 ont tous fini avec 0 échec (logs `Envoi terminé pour toutes les agences`).

**Diagnostic type « l'agence X ne reçoit plus ses agendas » (fait le 16/10).** Dans 100 % des cas remontés ce jour-là, l'agence était en pause (`/rdvadmin pause` par un Team Lead) ou l'image était bien dans le canal. Méthode : logs Railway filtre `agences actives à envoyer` et `Agenda S envoyé pour <NOM>` à l'heure du passage ; filtre `mise en pause` / `réactivée` pour l'historique des pauses ; puis les 5 permissions du bot dans le canal. Réactivation : `/rdvadmin play` dans le canal.

---

## 7. Google : authentification et accès

- OAuth2 **utilisateur** (pas de compte de service pour Calendar/Sheets) : `GOOGLE_CLIENT_ID/SECRET`, redirect `http://localhost:3000/oauth2callback` codé en dur (`google-auth.js:5`), scopes `calendar`, `spreadsheets`, `gmail.send` (`:7-13`). Token dans `/data/google_token.json`, rafraîchi et réécrit automatiquement (`:22-36`). `isAuthenticated()` = `access_token` et `refresh_token` présents.
- **Procédure de réautorisation** (token révoqué, expiré, ou pour ajouter `gmail.send`) :
  1. Dans un canal, avec un compte Admin/Team Lead : `/rdvadmin auth` → ouvrir le lien **connecté avec `contact@licall.fr`** (sinon les calendriers partenaires deviennent inaccessibles), accepter.
  2. La page `localhost:3000/oauth2callback?code=…` ne charge pas (il n'y a pas de serveur OAuth) : copier le paramètre `code` de l'URL.
  3. `/rdvadmin callback code:<code>`.
  4. `/rdvadmin testalerte` et `/rdvadmin alertes` pour vérifier (scope Gmail affiché).
  5. Mettre à jour la variable `GOOGLE_TOKEN_JSON` dans Railway avec le nouveau token si l'on veut qu'un volume recréé soit amorçable **(à confirmer : jamais fait)**.
- Symptômes d'un token mort : `invalid_grant`, « Token has been expired or revoked » dans les logs, incident `google-auth` dans `#alertes-bot` avec ce conseil, `/health` → `googleAuth:false`.
- Calendar : `withRetry` 3 tentatives (1 s, 2 s) sur toute erreur ; `getEventsInRange` sans pagination (2 500 événements max par semaine). Sheets : même retry ; `appendRowVerified` relit l'EVENT_ID.
- Quota Sheets : 60 lectures / minute / utilisateur. Un script qui lit tous les onglets en rafale est bloqué (vécu le 12/10).
- Drive (archive) : compte de service séparé, non configuré.

---

## 8. Alertes, santé, logs

### 8.1 Canal `#alertes-bot` (serveur Kall Kall)

- **Incidents** (`reportIncident`, `alerts.js:320-382`) : embed rouge + fichier `.txt` (pile, contexte, commit, uptime, 80 dernières lignes de log). Déclencheurs : erreur de commande non rattrapée, déconnexion Discord, rejet non géré, scheduler en échec, token Google invalide. Cooldown 15 min par signature. Copie par e-mail prévue mais inactive (scope manquant).
- **Avis d'exploitation** (`notifyOps`, `:402-463`) : embed court, sans e-mail. Cas : refus de permission (pseudo + rôles), RDV créé dans Calendar mais pas dans Sheets (avec l'ID), Sheets non mis à jour, erreur Calendar, configuration refusée, commande hors canal d'agence, agenda non envoyé, base non écrite. Cooldown 30 min par cause.
- Depuis le 23/09, un seul incident réel (28/09, « Unknown interaction ») ; les avis sont surtout des SDR qui tentent `/rdvadmin calendars` ou `agences`, des configs refusées pour onglet introuvable (Toulouse Agora Cars le 24/09, Toulouse Sud le 12/10, Besançon « classeur inaccessible » le 01/10) et des commandes hors canal.

### 8.2 `GET /health`

```json
{"status":"ok","discordReady":true,"uptimeSeconds":1976638,"lastSchedulerRunAt":"2026-10-16T06:00:11Z","lastSchedulerCheckAt":"…","googleAuth":true,"commit":"a58b9ab…"}
```
200 si Discord prêt, sinon 503. Aucune surveillance externe n'est en place (uptimerobot proposé le 22/09, jamais créé **(à confirmer)**).

### 8.3 Logs Railway : étiquettes utiles

`[Scheduler]` (passages, `Agenda S envoyé pour`, `Envoi terminé`), `[PAUSE]` / `[PLAY]` (qui a mis en pause quoi), `[CONFIG]`, `[Permissions]` et `[NOTICE] Refus de permission`, `[ALERT]`, `[Data]` (amorçage du volume au boot), `[Drive]`. Le filtre de l'outil de logs traite les crochets comme des caractères spéciaux : filtrer sur `mise en pause`, `réactivée`, `Envoi terminé`, `Refus de permission` plutôt que sur `[PAUSE]`.

---

## 9. Permissions (`src/utils/permissions.js`)

`/rdvadmin` est accepté si : permission Discord **Administrateur**, ou un rôle dont l'ID est dans `ADMIN_ROLE_IDS`, ou un rôle nommé `admin` / `team lead` (plus `ADMIN_ROLE_NAME`). Correspondance de nom : égalité insensible à la casse, ou nom suivi uniquement de lettres (« Admins », « Administrateur », « Team Leader » passent ; « Team Laura », « admin-stagiaire » non). Tout refus est loggué avec le pseudo et les rôles, et génère un avis. `/rdv` et `/agenda` sont ouverts à tout membre du canal. La commande n'est pas masquée dans Discord (`setDefaultMemberPermissions` volontairement absent) : c'est le bot qui refuse.

---

## 10. Procédures

### 10.1 Déployer une modification

1. Branche depuis `main`, commits, `npm test` (86 verts attendus), push, `gh pr create`.
2. **Alfredo fusionne** la PR sur GitHub. Ne jamais pousser directement sur `main`.
3. Railway redéploie en ≈ 2 min ; coupure de 1 à 2 min (« L'application ne répond plus » côté SDR → réessayer). Choisir un creux, **hors 08:00 / 12:00 / 15:00 / 18:00 / 21:00** (passage d'agendas).
4. Vérifier : logs (`connecté`, `[Data] Dossier de données: /data | agences: ok | token Google: ok`), `/health` (commit déployé, `googleAuth:true`), `/rdvadmin status`. Si une définition de commande a changé : « Cette commande est obsolète » s'affiche une fois par utilisateur (cache Discord, Ctrl+R) ; propagation globale jusqu'à 1 h.
5. Retour arrière : Railway → déploiement précédent → « Rollback » (le dernier bon est `611ac1db…`, commit `a58b9ab`).

### 10.2 Ajouter ou corriger une agence

1. Préparer : calendrier Google partagé **en écriture** avec `contact@licall.fr` ; onglet créé dans le bon classeur (KALLKALL pour Vroom, LICALL pour les partenaires) avec la ligne d'en-tête ; canal `rdv-<ville>` sur le bon serveur, avec les 3 permissions pour le bot.
2. Dans le canal : `/rdvadmin config agence:<NOM> calendar_id:<id> spreadsheet_id:<id> max_rdv_heure:<n> sheet_name:<onglet exact>` (casse, espaces, accents exacts).
3. `/rdvadmin verifier`, puis `/rdvadmin horaires` si l'agence ne suit pas lun-sam 09:00-19:30.
4. Test : `/rdv add` avec des données fictives puis `/rdv supprimer` avec l'ID renvoyé.
5. Ne pas éditer le seed du dépôt pour la prod. Pour `dom_rdv_enabled` ou `max_rdv_jour`, édition manuelle du fichier sur le volume (shell Railway) **(aucune commande ne les écrit)**.

### 10.3 Pause, reprise, horaires

`/rdvadmin pause` / `play` / `horaires` dans le canal, par un Admin ou Team Lead. Effet immédiat et persistant. La pause coupe les RDV **et** les agendas automatiques. Pour limiter ponctuellement sans couper : poser un événement `N RDV/H`, `PAS DE RDV` ou `STOP RDV` sur le calendrier.

### 10.4 Diagnostics courants

| Symptôme | Où regarder | Cause habituelle |
|---|---|---|
| « L'agence ne reçoit plus ses agendas » | Logs `agences actives à envoyer`, `Agenda S envoyé pour`, `mise en pause` | Agence en pause (16/10 : 7 cas sur 10), ou image bien présente mais non vue. Sinon permissions du canal. |
| « Le bot refuse : créneau complet 1/1 » alors que config > 1 | Calendrier de l'agence | Marqueur `1 RDV/H` posé par l'équipe ; ou `max_rdv_heure` absent/invalide → défaut 1. |
| « Requested entity was not found » / RDV dans Calendar mais pas dans Sheets | Avis dans `#alertes-bot`, `/rdvadmin verifier` | Onglet `sheet_name` inexistant ou classeur non partagé. Depuis la PR #6, `/rdv add` vérifie l'onglet avant Calendar. |
| « Commande réservée aux administrateurs » | Logs `Refus de permission` (rôles listés) | Rôle non reconnu ; ajouter via `ADMIN_ROLE_NAME` ou renommer. |
| « Cette commande est obsolète » / « L'application ne répond plus » | Déploiements Railway | Redéploiement en cours ou cache Discord. Jamais vu par le bot. |
| `googleAuth:false`, `invalid_grant` | `/health`, `#alertes-bot` | Token révoqué → §7. |
| Deux agendas, deux réponses par commande | Railway, autres hébergements | Deux instances avec le même `DISCORD_TOKEN` (vécu le 22/09 pendant la bascule). |
| Images d'agenda sans texte | — | Polices : résolu par PR #10 (DejaVu embarquée). Si ça revient, vérifier `assets/fonts`. |

### 10.5 Recréer l'hébergement (fait le 22/09)

1. Projet/service Railway lié au dépôt, volume monté sur `/data`.
2. Variables (Raw Editor) : `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_JSON` (token valide), `DATA_DIR=/data`, `TZ=Europe/Paris`, `ADMIN_ROLE_NAME=admin`, `NODE_ENV=production`, `REGISTER_COMMANDS_ON_START=true`, `ALERT_CHANNEL_ID`, `PUBLIC_URL`.
3. Un volume vide est amorcé avec le seed du dépôt (55 agences, **pas** celles ajoutées depuis) : récupérer d'abord `agencies.json` de l'ancien volume.
4. Attendre `connecté` dans les logs **avant** de couper l'ancienne instance.

### 10.6 Travailler en local

`npm install`, `.env` (voir `.env.example`), `data/google_token.json` valide, puis `npm start`. Attention : un bot local avec le token de production **est une seconde instance** (doublons). Pour développer, utiliser une application Discord de test et `DISCORD_GUILD_ID` (commandes instantanées).

---

## 11. Chantier Supabase (PR #14, éteint)

Résumé ; le détail est dans [passation-supabase.md](passation-supabase.md).

- Deux bases à structure identique, aucun lien entre elles. Migrations du bot dans `supabase/common/` (3 appliquées : `bot_integration`, `bot_import_staging`, `bot_import_staging_fiche`), **toujours sur les deux bases**. Pas de `DROP` : déplacer dans un schéma `archive_*`.
- Code : `supabase.js` (client, routage société par classeur puis serveur), `rdv-db.js` (double écriture idempotente sur `gcal_event_id`, jamais bloquante), `coherence.js` (rapport quotidien), sous-commandes `/rdvadmin db | coherence | sdr`. Tout derrière `DB_WRITE_ENABLED` (`supabase.js:47-49`, `rdv-db.js:331`).
- Historique Licall importé le 12/10 (2 551 RDV, 386 users, 2 392 clients, statuts réels depuis la colonne Etat). Kall Kall : historique déjà présent via le dashboard, enrichissement (confirmation, véhicule, TC, fiche RH) à faire avec la clé `service_role` KK.
- Étapes restantes, dans l'ordre : fusionner la PR #14 → clés dans Railway → enrichir KK → `DB_WRITE_ENABLED=true` + tests sur `LICALL TEST` → 10 jours d'observation → bascule (lire agences/SDR depuis la base, couper Sheets, désactiver le cron du dashboard).
- Points de vigilance : `/rdv supprimer` fait un delete physique sur `rdv` (FK côté dashboard à vérifier) ; `opening_hours` converti par `toDbOpeningHours` ; un RDV daté 2036 dans un onglet KK.

---

## 12. Historique des changements (22/09 → 16/10/2026)

| Date | PR | Changement |
|---|---|---|
| 22/09 | #1 | `/rdv` (prospecteurs) séparé de `/rdvadmin` (rôle Admin). |
| 22/09 | #2 | Enregistrement automatique des commandes au démarrage. |
| 22/09 | #3, #6, #7 | Poitiers : deux agences distinctes ; garde-fous contre le partage de calendrier/onglet ; `/rdvadmin verifier` ; Paris aligné (`PARIS 15`, 4/h). |
| 22/09 | #4, #5 | `max_rdv_heure` en texte toléré ; `/rdvadmin config` remplace l'entrée du canal. |
| 22/09 | #8 | `DATA_DIR` + volume, amorçage du token ; bascule du Railway de Jeremy vers celui d'Alfredo (bot en ligne 15:59 Paris). |
| 22/09 | #9 | Alertes d'incident (Discord + e-mail), `/health`, tampon de logs. |
| 22/09 | #10 | Police DejaVu embarquée (images sans texte sur Linux). |
| 22/09 | #11, #12 | Rôles « Administrateur »/« Admins » acceptés, refus tracés ; Team Lead autorisé. |
| 23/09 | #13 | Avis d'exploitation courts dans `#alertes-bot`. **Dernier déploiement en production.** |
| 12/10 | #14 (ouverte) | Schéma Supabase, double écriture éteinte, import Licall, docs. |
| 12/10 | — | Bot FAQ Python : IP bannie par Cloudflare, déplacé en région EU (autre projet Railway). |
| 16/10 | — | Diagnostic agendas (agences en pause) ; ce handoff. |

---

## 13. Pièges et dettes connues

Classés par risque pour la production.

**Risque fort**
1. **Deux instances = doublons** : ne jamais lancer le bot ailleurs avec le token de prod.
2. **Le volume est la vérité** : toute recréation de volume repart du seed (55 agences) et perd les agences ajoutées, les pauses, les horaires, le token.
3. **`/rdvadmin config` écrase pause/horaires/DOM** de l'agence reconfigurée (`rdvadmin.js:270-280`).
4. **Token Google unique** : s'authentifier avec un autre compte que `contact@licall.fr` casse l'accès aux calendriers partenaires.
5. **Pas de surveillance externe** ; si Railway tombe, personne n'est prévenu (les alertes partent du bot lui-même).

**Risque moyen**
6. `/rdv dom` sans contrôle d'horaires ni de capacité (`rdv.js:395-432`), volontaire.
7. `/rdv conf` : échec Calendar silencieux (`rdv.js:785-788`).
8. Fenêtre de concurrence dans `/rdv add` entre le contrôle de capacité et la retenue (`rdv.js:260-278`) ; retenue en mémoire seulement.
9. `getEventsInRange` tronque à 2 500 événements sans erreur (`calendar.js:52-65`).
10. Redéploiement à hh:00 → agendas envoyés deux fois.
11. Dépendance au fuseau du serveur (`TZ`).
12. Routage société par classeur : une agence sur un troisième classeur n'irait dans aucune base.

**Dette**
13. `loadAgencies` / `getAgencyByChannel` dupliqués dans `agenda.js` et `scheduler.js`.
14. IDs codés en dur : guilds et classeurs (`supabase.js:23-35`), classeurs RH (`import-history.js:187-190`), e-mail `contact@licall.fr`, redirect OAuth.
15. `undici` importé mais non déclaré dans `package.json` ; pas de champ `engines` (Node ≥ 18 requis pour `fetch`).
16. `check-agenda-colors.js` lit le seed du dépôt, pas `DATA_DIR`.
17. Exports morts (`findEventByClient`, `findRow`, `stopScheduler`, etc.) : ne pas les prendre pour des chemins actifs.
18. `src/commands/*`, `scheduler.js`, `calendar.js`, `sheets.js` n'ont pas de tests unitaires.

---

## 14. Backlog et questions ouvertes

1. Fusionner la PR #14 (Alfredo) ; aucun effet tant que l'interrupteur est éteint.
2. Clés `service_role` dans Railway, enrichissement Kall Kall, allumage, observation, bascule (§11).
3. Réautoriser Google avec le scope `gmail.send` pour activer l'e-mail d'alerte (optionnel : Discord suffit selon Alfredo).
4. Surveillance externe de `/health` (uptimerobot ou équivalent).
5. Archive Drive de 21 h : fournir le compte de service si souhaité.
6. Agendas pendant la pause : les Team Leads utilisent la pause pour « pas de RDV » et perdent les agendas ; décision produit à prendre (une ligne dans `scheduler.js:194`).
7. Buchelay : les RDV du bot ne restent pas verts dans Calendar (cause côté Google/équipe, non traité).
8. Albi, Toulouse St Orens : onglet manquant / calendrier non partagé, à corriger avant réactivation.
9. `/rdvadmin export` (sauvegarde du `agencies.json` du volume) : proposé, jamais fait. Utile avant toute opération sur le volume.
10. Supprimer le schéma `archive_sandbox_2026_06` sur Licall après validation.
11. RDV daté 2036 dans un onglet Kall Kall (faute de frappe).

---

## 15. Index des documents

| Document | Contenu |
|---|---|
| `docs/handoff-bot-discord.md` | Ce document. |
| `docs/passation-supabase.md` | Migration Sheets → Supabase : architecture, modèle, SDR, agences, exploitation, allumage, import, bascule, règles, tests. |
| `docs/rapport-devs-2026-10-12.md` | État de la migration au 12/10 et étapes restantes. |
| `docs/supabase.md` | Principe des deux bases et rejeu des migrations. |
| `.env.example` | Toutes les variables commentées. |
| `supabase/common/*.sql` | Migrations du bot. |
| `test/*.test.js` | Spécification exécutable (`npm test`). |
