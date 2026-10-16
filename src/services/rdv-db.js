// ══════════════════════════════════════════════════════════════
// Écriture des RDV dans Supabase (double écriture Sheets + base).
//
// Une action du bot = une écriture Sheets (historique) + une écriture base
// (nouveau), chacune journalisée dans `bot_journal` avec son résultat.
// Tout est idempotent sur `gcal_event_id` : rejouer une action ne crée
// jamais de doublon.
//
// Tables touchées : agences (lecture), users / users_alias (SDR),
// personnes (clients, clé téléphone E.164), rdv, rdv_evenements (journal
// des statuts), bot_journal (trace).
//
// Interrupteur : DB_WRITE_ENABLED (défaut false). Coupé → toutes les
// fonctions `on*` renvoient { ok:false, skipped:'désactivé' } sans rien
// faire ni rien dire. La société est résolue par src/services/supabase.js :
// pas de société → pas d'écriture (Licall = Licall, Kall Kall = Kall Kall).
// ══════════════════════════════════════════════════════════════

const { getDbForAgency, isDbWriteEnabled, inList } = require('./supabase');
const { toDbOpeningHours } = require('./opening-hours');

// ── Correspondances Sheets ↔ base ──────────────────────────────

/** STATUT Sheets (ou préfixe de titre Calendar) → statut rdv_evenements. */
const STATUT_SHEET_TO_DB = {
  'PLANIFIE': 'pris',
  'A VENIR': 'pris',
  'EN ATTENTE': 'pris',
  'ANNULE': 'annule',
  'VENDU': 'vendu',
  'PAS VENU': 'pas_venu',
  'NO SHOW': 'pas_venu',
  'ABSENT': 'pas_venu',
  'VENU': 'venu',
  'SAV': 'sav',
};

/** CONFIRMATION Sheets → rdv.confirmation. */
const CONF_SHEET_TO_DB = { 'J/J': 'jj', 'J+1': 'j1', 'CONF': 'conf', 'NON CONF': 'non_conf' };
const CONF_DB_TO_SHEET = { jj: 'J/J', j1: 'J+1', conf: 'CONF', non_conf: 'NON CONF' };

function normalizeLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[✓✗✅⏳]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** Statut Sheets brut → code base ('pris', 'annule', …) ou null si inconnu. */
function sheetStatutToDb(raw) {
  const n = normalizeLabel(raw);
  if (!n) return null;
  if (STATUT_SHEET_TO_DB[n]) return STATUT_SHEET_TO_DB[n];
  if (n.startsWith('VENDU')) return 'vendu';
  if (n.startsWith('VENU') || n === 'VENUE' || n === 'V') return 'venu';
  if (n.includes('PAS VENU') || n === 'PV' || n === 'NO-SHOW' || n === 'NOSHOW' || n === 'ABSENTE') return 'pas_venu';
  if (n.startsWith('ANNUL')) return 'annule';
  if (n.replace(/\./g, '') === 'SAV') return 'sav';
  if (n.startsWith('PLANIFI')) return 'pris';
  return null;
}

/** CONFIRMATION Sheets brute → 'jj' | 'j1' | 'conf' | 'non_conf' | null. */
function sheetConfToDb(raw) {
  const n = normalizeLabel(raw);
  if (!n) return null;
  if (n === 'NON CONF' || n === 'NONCONF' || n === 'NON CONFIRME') return 'non_conf';
  if (n === 'CONF' || n === 'CONFIRME') return 'conf';
  if (n === 'J/J' || n === 'JJ') return 'jj';
  if (n === 'J+1' || n === 'J1') return 'j1';
  return CONF_SHEET_TO_DB[n] || null;
}

/** Même règle que la fonction SQL normalise_telephone (E.164 ou null). */
function normalizePhoneE164(raw) {
  if (!raw) return null;
  const d = String(raw).trim().replace(/[^0-9+]/g, '');
  if (/^\+[1-9][0-9]{6,14}$/.test(d)) return d;
  if (/^00[1-9][0-9]{6,14}$/.test(d)) return `+${d.slice(2)}`;
  if (/^0[1-9][0-9]{8}$/.test(d)) return `+33${d.slice(1)}`;
  if (/^33[1-9][0-9]{8}$/.test(d)) return `+${d}`;
  // 9 chiffres : zéro initial perdu par un format numérique Sheets (612345678 → +33612345678)
  if (/^[1-9][0-9]{8}$/.test(d)) return `+33${d}`;
  return null;
}

/** Même règle que la fonction SQL normalise_libelle. */
function normaliseLibelle(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Retire emojis et décorations en tête/queue d'un pseudo Discord. */
function stripEmoji(value) {
  return String(value || '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** « Prénom NOM » Discord → { prenom, nom } (mots en capitales = nom). */
function splitDisplayName(full) {
  const clean = stripEmoji(full).replace(/^[^\p{L}]+/u, '').trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { prenom: '', nom: '' };
  const nomParts = parts.filter((p) => p.length > 1 && p === p.toUpperCase() && /\p{L}/u.test(p));
  const prenomParts = parts.filter((p) => !nomParts.includes(p));
  if (nomParts.length > 0 && prenomParts.length > 0) {
    return { prenom: prenomParts.join(' '), nom: nomParts.join(' ') };
  }
  if (parts.length === 1) return { prenom: parts[0], nom: parts[0] };
  return { prenom: parts[0], nom: parts.slice(1).join(' ') };
}

function toInt(value) {
  const digits = String(value ?? '').replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/** Instantané véhicule saisi par le SDR → jsonb { marque, modele, annee, km, prix }. */
function buildVehicule({ marque, modele, annee, kilometrage, prix } = {}) {
  const out = {
    marque: String(marque || '').trim().toUpperCase() || null,
    modele: String(modele || '').trim().toUpperCase() || null,
    annee: toInt(annee),
    km: toInt(kilometrage),
    prix: toInt(prix),
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
}

// ── Accès bas niveau (réutilisés par l'import d'historique) ─────

async function resolveAgencyId(db, agency) {
  if (agency.channel_id) {
    const rows = await db.select('agences', { select: 'id', discord_channel_id: `eq.${agency.channel_id}`, limit: 1 });
    if (rows?.[0]?.id) return rows[0].id;
  }
  const byAlias = await db.rpc('resoudre_agence', { brut: agency.name || agency.key || '', src: 'bot' });
  if (byAlias) return byAlias;
  if (agency.sheet_name) {
    const rows = await db.select('agences', { select: 'id', sheet_onglet: `eq.${agency.sheet_name}`, limit: 1 });
    if (rows?.[0]?.id) return rows[0].id;
  }
  return null;
}

/**
 * Résout un SDR : par identifiant Discord, puis par alias « bot » du pseudo.
 * Rattache automatiquement l'identifiant Discord au premier RDV, crée le
 * compte s'il est inconnu (role sdr). Retourne { id, created, linked }.
 */
async function resolveSdr(db, actor = {}, { createIfMissing = true, actif = true } = {}) {
  const discordUserId = actor.discordUserId ? String(actor.discordUserId) : null;
  const displayName = stripEmoji(actor.displayName || '');

  if (discordUserId) {
    const rows = await db.select('users', { select: 'id,discord_display_name', discord_user_id: `eq.${discordUserId}`, limit: 1 });
    if (rows?.[0]?.id) {
      if (displayName && rows[0].discord_display_name !== displayName) {
        await db.update('users', { id: `eq.${rows[0].id}` }, { discord_display_name: displayName }).catch(() => {});
      }
      return { id: rows[0].id, created: false, linked: false };
    }
  }

  if (displayName) {
    const byAlias = await db.rpc('resoudre_user', { brut: displayName, src: 'bot' });
    if (byAlias) {
      let linked = false;
      if (discordUserId) {
        try {
          await db.update('users', { id: `eq.${byAlias}`, discord_user_id: 'is.null' }, { discord_user_id: discordUserId, discord_display_name: displayName });
          linked = true;
        } catch {
          linked = false;
        }
      }
      return { id: byAlias, created: false, linked };
    }
  }

  if (!createIfMissing || !displayName || displayName.length < 2) return { id: null, created: false, linked: false };

  const { prenom, nom } = splitDisplayName(displayName);
  const created = await db.insert('users', [{
    nom: nom || displayName,
    prenom: prenom || '',
    role: 'sdr',
    actif,
    discord_user_id: discordUserId,
    discord_display_name: displayName,
  }]);
  const id = created?.[0]?.id;
  if (!id) throw new Error('création du SDR : aucun id renvoyé');
  await db.upsert('users_alias', [{ user_id: id, alias: displayName, alias_norm: normaliseLibelle(displayName), source: 'bot' }],
    { onConflict: 'alias_norm,source', ignoreDuplicates: true, returning: false }).catch(() => {});
  return { id, created: true, linked: Boolean(discordUserId) };
}

/** Client par téléphone E.164 (créé si absent). Null si téléphone inexploitable. */
async function ensurePersonne(db, { nom, telephone } = {}) {
  const tel = normalizePhoneE164(telephone);
  if (!tel) return null;
  const cleanNom = String(nom || '').trim().toUpperCase() || null;
  await db.upsert('personnes', [{ telephone_e164: tel, nom: cleanNom }], { onConflict: 'telephone_e164', ignoreDuplicates: true, returning: false });
  const rows = await db.select('personnes', { select: 'id,nom', telephone_e164: `eq.${tel}`, limit: 1 });
  const row = rows?.[0];
  if (!row) return null;
  if (cleanNom && !row.nom) await db.update('personnes', { id: `eq.${row.id}` }, { nom: cleanNom }).catch(() => {});
  return row.id;
}

async function upsertRdv(db, row) {
  const rows = await db.upsert('rdv', [row], { onConflict: 'gcal_event_id' });
  const id = rows?.[0]?.id;
  if (!id) throw new Error('upsert rdv : aucun id renvoyé');
  return id;
}

async function getRdvByEventId(db, eventId) {
  const rows = await db.select('rdv', { select: 'id,agence_id,sdr_user_id,personne_id,debut_at,confirmation', gcal_event_id: `eq.${eventId}`, limit: 1 });
  return rows?.[0] || null;
}

async function currentStatut(db, rdvId) {
  const rows = await db.select('v_rdv_etat', { select: 'statut,at', rdv_id: `eq.${rdvId}`, limit: 1 });
  return rows?.[0]?.statut || null;
}

async function addEvent(db, { rdvId, statut, auteurUserId = null, at = null, origine = 'bot' }) {
  await db.insert('rdv_evenements', [{
    rdv_id: rdvId,
    statut,
    origine,
    auteur_user_id: auteurUserId,
    at: at || new Date().toISOString(),
  }], { returning: false });
}

/** Insère l'événement seulement s'il n'est pas déjà l'état courant. */
async function addEventIfNeeded(db, params) {
  const current = await currentStatut(db, params.rdvId);
  if (current === params.statut) return false;
  await addEvent(db, params);
  return true;
}

async function writeJournal(db, entry) {
  try {
    await db.insert('bot_journal', [{
      action: entry.action,
      agence_id: entry.agenceId || null,
      rdv_id: entry.rdvId || null,
      gcal_event_id: entry.eventId || null,
      discord_user_id: entry.discordUserId ? String(entry.discordUserId) : null,
      discord_channel_id: entry.channelId ? String(entry.channelId) : null,
      sheets_ok: entry.sheetsOk ?? null,
      sheets_erreur: entry.sheetsError ? String(entry.sheetsError).slice(0, 500) : null,
      db_ok: entry.dbOk ?? null,
      db_erreur: entry.dbError ? String(entry.dbError).slice(0, 500) : null,
      details: entry.details || {},
    }], { returning: false });
  } catch (err) {
    console.warn(`[DB] bot_journal non écrit (${entry.action}): ${err.message}`);
  }
}

// ── Construction d'une ligne rdv ───────────────────────────────

function buildRdvRow({
  eventId, agenceId, sdrUserId, personneId, start, end, typeRdv = 'mandat',
  confirmation = null, liens, commentaire, adresse, vehicule, prospecteurNom, discordUserId,
}) {
  const row = {
    gcal_event_id: eventId,
    agence_id: agenceId,
    source: 'bot',
    type_rdv: typeRdv === 'mandat_dom' ? 'mandat_dom' : 'mandat',
  };
  if (sdrUserId !== undefined) row.sdr_user_id = sdrUserId;
  if (personneId !== undefined) row.personne_id = personneId;
  if (start) row.debut_at = new Date(start).toISOString();
  if (end) row.fin_at = new Date(end).toISOString();
  if (confirmation !== undefined) row.confirmation = confirmation;
  if (liens !== undefined) row.liens = String(liens || '').trim() || null;
  if (commentaire !== undefined) row.commentaire = String(commentaire || '').trim() || null;
  if (adresse !== undefined) row.adresse_dom = String(adresse || '').trim() || null;
  if (vehicule !== undefined) row.vehicule = vehicule;
  if (prospecteurNom !== undefined) row.prospecteur_nom_brut = stripEmoji(prospecteurNom) || null;
  if (discordUserId !== undefined) row.booked_by_discord_user_id = discordUserId ? String(discordUserId) : null;
  return row;
}

// ── Contexte commun aux actions ────────────────────────────────

function notify(ctx, kind, message, level = 'error') {
  try {
    const { notifyOps } = require('./alerts');
    notifyOps({
      kind,
      message,
      level,
      context: {
        commande: ctx.commande || 'rdv',
        sousCommande: ctx.action || '',
        utilisateur: ctx.actor?.displayName || '',
        channelId: ctx.agency?.channel_id || ctx.channelId || '',
        agence: ctx.agency?.name || '',
        eventId: ctx.eventId || '',
        conseil: ctx.conseil || 'Vérifier les variables SUPABASE_* dans Railway et /rdvadmin db. La ligne sera rattrapée par le rapport de cohérence.',
      },
      client: ctx.client,
    }).catch(() => {});
  } catch {
    // jamais bloquant
  }
}

/**
 * Enveloppe commune : interrupteur, routage, exécution, journal, avis.
 * `fn(db, { agenceId, sdr })` fait l'écriture et renvoie { rdvId, details }.
 */
async function runAction(ctx, fn, { requireAgency = true } = {}) {
  if (!isDbWriteEnabled()) return { ok: false, skipped: 'désactivé' };

  const route = getDbForAgency(ctx.agency, ctx.guildId);
  if (!route.db) {
    console.error(`[DB] ${ctx.action}: ${route.reason}`);
    notify({ ...ctx, conseil: 'Aucune écriture en base pour cette agence. Vérifier le classeur Sheets de l\'agence ou le serveur Discord, puis les variables SUPABASE_*.' }, 'Base non résolue', route.reason);
    return { ok: false, error: route.reason, company: route.company };
  }

  const db = route.db;
  let agenceId = null;
  try {
    agenceId = await resolveAgencyId(db, ctx.agency);
    if (!agenceId && requireAgency) throw new Error(`agence « ${ctx.agency?.name} » introuvable dans la base ${route.label} (canal ${ctx.agency?.channel_id})`);

    const result = await fn(db, { agenceId, company: route.company, label: route.label });
    if (!agenceId && result?.details?.agence_id) agenceId = result.details.agence_id;

    await writeJournal(db, {
      action: ctx.action,
      agenceId,
      rdvId: result?.rdvId || null,
      eventId: ctx.eventId,
      discordUserId: ctx.actor?.discordUserId,
      channelId: ctx.agency?.channel_id,
      sheetsOk: ctx.sheetsOk ?? null,
      sheetsError: ctx.sheetsError || null,
      dbOk: true,
      details: { societe: route.company, ...(result?.details || {}) },
    });

    if (result?.sdr?.created) {
      notify(ctx, 'SDR inconnu créé en base', `« ${stripEmoji(ctx.actor?.displayName || '')} » n'existait pas dans la base ${route.label} : compte SDR créé et rattaché à son Discord. Un Team Lead peut le corriger avec /rdvadmin sdr.`, 'info');
    }

    console.log(`[DB] ${ctx.action} ${ctx.eventId || ''} → ${route.label} ok`);
    return { ok: true, company: route.company, label: route.label, rdvId: result?.rdvId || null, sdr: result?.sdr || null };
  } catch (err) {
    console.error(`[DB] ${ctx.action} ${ctx.eventId || ''} → ${route.label} ÉCHEC: ${err.message}`);
    await writeJournal(db, {
      action: ctx.action,
      agenceId,
      eventId: ctx.eventId,
      discordUserId: ctx.actor?.discordUserId,
      channelId: ctx.agency?.channel_id,
      sheetsOk: ctx.sheetsOk ?? null,
      sheetsError: ctx.sheetsError || null,
      dbOk: false,
      dbError: err.message,
      details: { societe: route.company },
    });
    notify(ctx, 'Base non écrite', `${ctx.action} ${ctx.eventId ? `(${ctx.eventId}) ` : ''}: ${err.message}`);
    return { ok: false, error: err.message, company: route.company, label: route.label };
  }
}

// ── Actions du bot ─────────────────────────────────────────────

/**
 * /rdv add, /rdv dom : création.
 * ctx: { agency, guildId, actor:{discordUserId, displayName}, client, eventId,
 *        start, end, typeRdv, nomClient, telephone, vehicule:{marque,modele,annee,kilometrage,prix},
 *        liens, commentaire, adresse, confirmation ('jj'|'j1'|'conf'|null), sheetsOk, sheetsError }
 */
async function onRdvCreated(ctx) {
  return runAction({ ...ctx, action: ctx.typeRdv === 'mandat_dom' ? 'dom' : 'add' }, async (db, { agenceId }) => {
    const sdr = await resolveSdr(db, ctx.actor);
    const personneId = await ensurePersonne(db, { nom: ctx.nomClient, telephone: ctx.telephone });
    const rdvId = await upsertRdv(db, buildRdvRow({
      eventId: ctx.eventId,
      agenceId,
      sdrUserId: sdr.id,
      personneId,
      start: ctx.start,
      end: ctx.end,
      typeRdv: ctx.typeRdv,
      confirmation: ctx.confirmation || null,
      liens: ctx.liens,
      commentaire: ctx.commentaire,
      adresse: ctx.adresse,
      vehicule: buildVehicule(ctx.vehicule),
      prospecteurNom: ctx.actor?.displayName,
      discordUserId: ctx.actor?.discordUserId,
    }));
    await addEventIfNeeded(db, { rdvId, statut: 'pris', auteurUserId: sdr.id });
    return { rdvId, sdr, details: { personne: Boolean(personneId), sdr_cree: sdr.created } };
  });
}

/**
 * /rdv annuler, /rdv vendu : changement de statut.
 * ctx: { ..., eventId, statut:'annule'|'vendu', eventData (Calendar), start, end }
 * Si le RDV n'existe pas encore en base (créé avant la double écriture),
 * il est créé à la volée depuis l'événement Calendar.
 */
async function onRdvStatus(ctx) {
  return runAction({ ...ctx, action: ctx.statut === 'vendu' ? 'vendu' : 'annuler' }, async (db, { agenceId }) => {
    const sdr = await resolveSdr(db, ctx.actor, { createIfMissing: false });
    let rdv = await getRdvByEventId(db, ctx.eventId);
    let rdvId = rdv?.id;
    if (!rdvId) {
      rdvId = await upsertRdv(db, buildRdvRow({
        eventId: ctx.eventId,
        agenceId,
        personneId: await ensurePersonne(db, { nom: ctx.nomClient, telephone: ctx.telephone }),
        start: ctx.start,
        end: ctx.end,
        typeRdv: ctx.typeRdv,
        vehicule: buildVehicule(ctx.vehicule),
        liens: ctx.liens,
        commentaire: ctx.commentaire,
        adresse: ctx.adresse,
      }));
      await addEventIfNeeded(db, { rdvId, statut: 'pris', at: ctx.start ? new Date(ctx.start).toISOString() : null });
    }
    await addEventIfNeeded(db, { rdvId, statut: ctx.statut, auteurUserId: sdr.id });
    return { rdvId, details: { statut: ctx.statut, rattrape: !rdv } };
  });
}

/**
 * /rdv conf : confirmation ('conf' | 'non_conf').
 */
async function onRdvConfirmation(ctx) {
  return runAction({ ...ctx, action: 'conf' }, async (db, { agenceId }) => {
    const sdr = await resolveSdr(db, ctx.actor);
    let rdv = await getRdvByEventId(db, ctx.eventId);
    let rdvId = rdv?.id;
    if (!rdvId) {
      rdvId = await upsertRdv(db, buildRdvRow({
        eventId: ctx.eventId,
        agenceId,
        personneId: await ensurePersonne(db, { nom: ctx.nomClient, telephone: ctx.telephone }),
        start: ctx.start,
        end: ctx.end,
        typeRdv: ctx.typeRdv,
        vehicule: buildVehicule(ctx.vehicule),
        liens: ctx.liens,
        commentaire: ctx.commentaire,
        adresse: ctx.adresse,
      }));
      await addEventIfNeeded(db, { rdvId, statut: 'pris', at: ctx.start ? new Date(ctx.start).toISOString() : null });
    }
    await db.update('rdv', { id: `eq.${rdvId}` }, {
      confirmation: ctx.confirmation,
      confirme_par_user_id: sdr.id,
      confirme_at: new Date().toISOString(),
    });
    if (ctx.confirmation === 'conf') {
      await addEventIfNeeded(db, { rdvId, statut: 'confirme', auteurUserId: sdr.id });
    }
    return { rdvId, sdr, details: { confirmation: ctx.confirmation, rattrape: !rdv } };
  });
}

/**
 * /rdv modifier : mise à jour des données ; `rebook` = date/heure changée
 * (le statut repasse à « pris » et la confirmation est recalculée).
 */
async function onRdvModified(ctx) {
  return runAction({ ...ctx, action: 'modifier' }, async (db, { agenceId }) => {
    const sdr = await resolveSdr(db, ctx.actor, { createIfMissing: false });
    const existing = await getRdvByEventId(db, ctx.eventId);
    const personneId = await ensurePersonne(db, { nom: ctx.nomClient, telephone: ctx.telephone });
    const row = buildRdvRow({
      eventId: ctx.eventId,
      agenceId,
      personneId,
      start: ctx.start,
      end: ctx.end,
      typeRdv: ctx.typeRdv,
      liens: ctx.liens,
      commentaire: ctx.commentaire,
      adresse: ctx.adresse,
      vehicule: buildVehicule(ctx.vehicule),
    });
    if (ctx.rebook) {
      row.confirmation = ctx.confirmation || null;
      row.confirme_par_user_id = null;
      row.confirme_at = null;
    } else if (ctx.confirmation !== undefined) {
      row.confirmation = ctx.confirmation || null;
    }
    const rdvId = await upsertRdv(db, row);
    if (!existing) {
      await addEventIfNeeded(db, { rdvId, statut: 'pris', auteurUserId: sdr.id });
    } else if (ctx.rebook) {
      await addEvent(db, { rdvId, statut: 'pris', auteurUserId: sdr.id });
    }
    return { rdvId, details: { rebook: Boolean(ctx.rebook), rattrape: !existing } };
  });
}

/**
 * /rdv supprimer : suppression définitive (journal des statuts + rdv).
 * Le journal bot_journal garde la trace par gcal_event_id.
 */
async function onRdvDeleted(ctx) {
  return runAction({ ...ctx, action: 'supprimer' }, async (db) => {
    const rdv = await getRdvByEventId(db, ctx.eventId);
    if (!rdv) return { rdvId: null, details: { absent: true } };
    await db.update('bot_journal', { rdv_id: `eq.${rdv.id}` }, { rdv_id: null }).catch(() => {});
    await db.remove('rdv_evenements', { rdv_id: `eq.${rdv.id}` });
    await db.remove('rdv', { id: `eq.${rdv.id}` });
    return { rdvId: null, details: { supprime: true } };
  });
}

// ── Référentiel agences : miroir de agencies.json ──────────────

function agencyToDbPatch(agency, guildId) {
  const patch = {
    gcal_calendar_id: agency.calendar_id || null,
    spreadsheet_id: agency.spreadsheet_id || null,
    sheet_onglet: agency.sheet_name || null,
    discord_channel_id: agency.channel_id || null,
    granularite_minutes: Number(agency.granularite) || 30,
    timezone: agency.timezone || 'Europe/Paris',
    dom_rdv_enabled: Boolean(agency.dom_rdv_enabled),
    paused: Boolean(agency.paused),
    opening_hours: toDbOpeningHours(agency.opening_hours), // format base : jour ISO, [ouverture, fermeture]
  };
  const max = Number(agency.max_rdv_heure);
  if (Number.isFinite(max) && max > 0) patch.max_rdv_heure = Math.floor(max);
  if (guildId) patch.discord_guild_id = String(guildId);
  return patch;
}

async function findAgencyByName(db, name) {
  if (!name) return null;
  const rows = await db.select('agences', { select: 'id', nom: `ilike.${String(name).replace(/[%*]/g, '')}`, limit: 1 });
  return rows?.[0]?.id || null;
}

/**
 * /rdvadmin config | pause | play | horaires : l'agence est mise à jour (ou
 * créée) dans SA base. Ne renomme jamais une agence existante.
 */
async function syncAgencyToDb(ctx) {
  return runAction({ ...ctx, commande: 'rdvadmin', action: ctx.action || 'config' }, async (db) => {
    const agency = ctx.agency;
    const patch = agencyToDbPatch(agency, ctx.guildId);
    let id = null;
    const byChannel = agency.channel_id
      ? await db.select('agences', { select: 'id', discord_channel_id: `eq.${agency.channel_id}`, limit: 1 })
      : [];
    if (byChannel?.[0]?.id) id = byChannel[0].id;
    if (!id) id = await db.rpc('resoudre_agence', { brut: agency.name, src: 'bot' });
    // Agence connue de la base sans alias bot (import d'historique, dashboard) : par nom, puis par onglet Sheets.
    if (!id) id = await findAgencyByName(db, agency.name);
    if (!id && agency.sheet_name) {
      const bySheet = await db.select('agences', { select: 'id', sheet_onglet: `ilike.${agency.sheet_name}`, limit: 1 });
      if (bySheet?.[0]?.id) id = bySheet[0].id;
    }
    if (id) {
      await db.update('agences', { id: `eq.${id}` }, { ...patch, actif: true });
      return { rdvId: null, details: { agence_id: id, cree: false } };
    }
    const created = await db.insert('agences', [{ nom: agency.name, actif: true, ...patch }]);
    id = created?.[0]?.id;
    if (!id) throw new Error('création agence : aucun id renvoyé');
    await db.upsert('agences_alias', [{ agence_id: id, alias: agency.name, alias_norm: normaliseLibelle(agency.name), source: 'bot' }],
      { onConflict: 'alias_norm,source', ignoreDuplicates: true, returning: false }).catch(() => {});
    return { rdvId: null, details: { agence_id: id, cree: true } };
  }, { requireAgency: false });
}

/** /rdvadmin deconfig : l'agence perd son canal et passe inactive (jamais supprimée). */
async function unlinkAgencyInDb(ctx) {
  return runAction({ ...ctx, commande: 'rdvadmin', action: 'deconfig' }, async (db) => {
    if (!ctx.agency?.channel_id) return { rdvId: null, details: { absent: true } };
    const rows = await db.update('agences', { discord_channel_id: `eq.${ctx.agency.channel_id}` }, { discord_channel_id: null, actif: false });
    return { rdvId: null, details: { modifiees: rows?.length || 0 } };
  }, { requireAgency: false });
}

/**
 * /rdvadmin sdr : rattache un membre Discord à un utilisateur de la base
 * (par nom « Prénom NOM » ou alias), ou crée le compte. Ne dépend pas de
 * DB_WRITE_ENABLED : c'est une action d'administration explicite.
 */
async function linkSdr({ agency, guildId, discordUserId, displayName, nom }) {
  const route = getDbForAgency(agency, guildId);
  if (!route.db) return { ok: false, error: route.reason };
  const db = route.db;
  try {
    const target = stripEmoji(nom || displayName);
    let userId = await db.rpc('resoudre_user', { brut: target, src: 'bot' });
    if (!userId) userId = await db.rpc('resoudre_user', { brut: target, src: 'manuel' });
    let created = false;
    if (!userId) {
      const { prenom, nom: n } = splitDisplayName(target);
      const rows = await db.insert('users', [{ nom: n || target, prenom: prenom || '', role: 'sdr', actif: true }]);
      userId = rows?.[0]?.id;
      created = true;
    }
    // Un seul compte par identifiant Discord : on détache l'ancien éventuel.
    await db.update('users', { discord_user_id: `eq.${discordUserId}`, id: `neq.${userId}` }, { discord_user_id: null }).catch(() => {});
    await db.update('users', { id: `eq.${userId}` }, { discord_user_id: String(discordUserId), discord_display_name: stripEmoji(displayName) });
    await db.upsert('users_alias', [{ user_id: userId, alias: stripEmoji(displayName), alias_norm: normaliseLibelle(displayName), source: 'bot' }],
      { onConflict: 'alias_norm,source', ignoreDuplicates: true, returning: false }).catch(() => {});
    const rows = await db.select('users', { select: 'id,prenom,nom,role,actif', id: `eq.${userId}`, limit: 1 });
    return { ok: true, company: route.company, label: route.label, created, user: rows?.[0] || { id: userId } };
  } catch (err) {
    return { ok: false, error: err.message, company: route.company, label: route.label };
  }
}

module.exports = {
  STATUT_SHEET_TO_DB,
  CONF_SHEET_TO_DB,
  CONF_DB_TO_SHEET,
  sheetStatutToDb,
  sheetConfToDb,
  normalizePhoneE164,
  normaliseLibelle,
  stripEmoji,
  splitDisplayName,
  buildVehicule,
  buildRdvRow,
  agencyToDbPatch,
  // bas niveau (import d'historique, rapport de cohérence)
  resolveAgencyId,
  resolveSdr,
  ensurePersonne,
  upsertRdv,
  getRdvByEventId,
  currentStatut,
  addEvent,
  addEventIfNeeded,
  writeJournal,
  inList,
  // actions du bot
  onRdvCreated,
  onRdvStatus,
  onRdvConfirmation,
  onRdvModified,
  onRdvDeleted,
  syncAgencyToDb,
  unlinkAgencyInDb,
  linkSdr,
};
