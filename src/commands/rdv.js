const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { generateAuthUrl, exchangeCode, isAuthenticated } = require('../services/google-auth');
const calendar = require('../services/calendar');
const sheets = require('../services/sheets');
const { COL } = sheets;
const { isSlotAvailable, reserveSlot } = require('../services/capacity');
const { parseDateTime, formatDate, formatTime, getConfType } = require('../utils/date-utils');
const {
  buildManagedRdvDescription,
  getPrimaryStatusPrefix,
  parseManagedRdvEvent,
} = require('../utils/rdv-title');

const AGENCIES_PATH = path.join(__dirname, '../../data/agencies.json');
const RDV_DURATION_MINUTES = 60;
const DOM_RDV_BUFFER_MINUTES = 15;  // 15min avant + 15min après
const DOM_RDV_TOTAL_MINUTES = 90;   // total créneau bloqué = 1h30

function loadAgencies() {
  if (!fs.existsSync(AGENCIES_PATH)) return {};
  return JSON.parse(fs.readFileSync(AGENCIES_PATH, 'utf8'));
}

function saveAgencies(agencies) {
  fs.writeFileSync(AGENCIES_PATH, JSON.stringify(agencies, null, 2));
}

function getAgencyByChannel(channelId) {
  const agencies = loadAgencies();
  for (const [key, cfg] of Object.entries(agencies)) {
    if (cfg.channel_id === channelId) return { key, ...cfg };
  }
  return null;
}

function requireAgency(interaction) {
  return getAgencyByChannel(interaction.channelId);
}

function getCalendarLink(eventId, calendarId) {
  const raw = `${eventId} ${calendarId}`;
  return `https://www.google.com/calendar/event?eid=${Buffer.from(raw).toString('base64').replace(/=+$/, '')}`;
}

function timestamp() {
  return new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
}

// ── Slash command definition ──

const data = new SlashCommandBuilder()
  .setName('rdv')
  .setDescription('Gestion des rendez-vous')
  .addSubcommand((sub) =>
    sub.setName('auth').setDescription('Obtenir le lien d\'autorisation Google')
  )
  .addSubcommand((sub) =>
    sub.setName('callback').setDescription('Valider le code d\'autorisation Google')
      .addStringOption((opt) => opt.setName('code').setDescription('Code d\'autorisation').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub.setName('add').setDescription('Ajouter un rendez-vous')
      .addStringOption((opt) => opt.setName('date').setDescription('Date (JJ/MM/AAAA)').setRequired(true))
      .addStringOption((opt) => opt.setName('heure').setDescription('Heure (HH:MM)').setRequired(true))
      .addStringOption((opt) => opt.setName('nom_client').setDescription('Nom du client').setRequired(true))
      .addStringOption((opt) => opt.setName('telephone').setDescription('Téléphone du client').setRequired(true))
      .addStringOption((opt) => opt.setName('marque').setDescription('Marque du véhicule').setRequired(true))
      .addStringOption((opt) => opt.setName('modele').setDescription('Modèle du véhicule').setRequired(true))
      .addStringOption((opt) => opt.setName('annee').setDescription('Année du véhicule').setRequired(true))
      .addStringOption((opt) => opt.setName('kilometrage').setDescription('Kilométrage').setRequired(true))
      .addStringOption((opt) => opt.setName('prix').setDescription('Prix').setRequired(true))
      .addStringOption((opt) => opt.setName('liens').setDescription('Liens (optionnel)').setRequired(false))
      .addStringOption((opt) => opt.setName('commentaire').setDescription('Commentaire / Notes (optionnel)').setRequired(false))
  )
  .addSubcommand((sub) =>
    sub.setName('dom').setDescription('Ajouter un RDV à domicile (DOM) — créneau 1h30 avec ±15min buffer, couleur violette')
      .addStringOption((opt) => opt.setName('date').setDescription('Date (JJ/MM/AAAA)').setRequired(true))
      .addStringOption((opt) => opt.setName('heure').setDescription('Heure du RDV (HH:MM) — le créneau s\'affiche -15min sur l\'agenda').setRequired(true))
      .addStringOption((opt) => opt.setName('nom_client').setDescription('Nom du client').setRequired(true))
      .addStringOption((opt) => opt.setName('telephone').setDescription('Téléphone du client').setRequired(true))
      .addStringOption((opt) => opt.setName('marque').setDescription('Marque du véhicule').setRequired(true))
      .addStringOption((opt) => opt.setName('modele').setDescription('Modèle du véhicule').setRequired(true))
      .addStringOption((opt) => opt.setName('annee').setDescription('Année du véhicule').setRequired(true))
      .addStringOption((opt) => opt.setName('kilometrage').setDescription('Kilométrage').setRequired(true))
      .addStringOption((opt) => opt.setName('prix').setDescription('Prix').setRequired(true))
      .addStringOption((opt) => opt.setName('adresse').setDescription('Adresse du client (obligatoire pour DOM)').setRequired(true))
      .addStringOption((opt) => opt.setName('liens').setDescription('Liens (optionnel)').setRequired(false))
      .addStringOption((opt) => opt.setName('commentaire').setDescription('Commentaire / Notes (optionnel)').setRequired(false))
  )
  .addSubcommand((sub) =>
    sub.setName('annuler').setDescription('Annuler un rendez-vous')
      .addStringOption((opt) => opt.setName('id').setDescription('ID de l\'événement').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub.setName('vendu').setDescription('Marquer un rendez-vous comme vendu')
      .addStringOption((opt) => opt.setName('id').setDescription('ID de l\'événement').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub.setName('conf').setDescription('Confirmer un rendez-vous')
      .addStringOption((opt) => opt.setName('id').setDescription('ID de l\'événement').setRequired(true))
      .addStringOption((opt) => opt.setName('statut').setDescription('Statut de confirmation').setRequired(true)
        .addChoices(
          { name: 'CONF', value: 'CONF' },
          { name: 'NON CONF', value: 'NON CONF' },
        ))
  )
  .addSubcommand((sub) =>
    sub.setName('modifier').setDescription('Modifier un rendez-vous existant')
      .addStringOption((opt) => opt.setName('id').setDescription('ID de l\'événement').setRequired(true))
      .addStringOption((opt) => opt.setName('nouvelle_date').setDescription('Nouvelle date (JJ/MM/AAAA)').setRequired(false))
      .addStringOption((opt) => opt.setName('nouvelle_heure').setDescription('Nouvelle heure (HH:MM)').setRequired(false))
      .addStringOption((opt) => opt.setName('nom_client').setDescription('Nouveau nom client').setRequired(false))
      .addStringOption((opt) => opt.setName('telephone').setDescription('Nouveau téléphone').setRequired(false))
      .addStringOption((opt) => opt.setName('marque').setDescription('Nouvelle marque').setRequired(false))
      .addStringOption((opt) => opt.setName('modele').setDescription('Nouveau modèle').setRequired(false))
      .addStringOption((opt) => opt.setName('annee').setDescription('Nouvelle année').setRequired(false))
      .addStringOption((opt) => opt.setName('kilometrage').setDescription('Nouveau kilométrage').setRequired(false))
      .addStringOption((opt) => opt.setName('prix').setDescription('Nouveau prix').setRequired(false))
      .addStringOption((opt) => opt.setName('liens').setDescription('Nouveaux liens').setRequired(false))
      .addStringOption((opt) => opt.setName('commentaire').setDescription('Nouveau commentaire').setRequired(false))
  )
  .addSubcommand((sub) =>
    sub.setName('supprimer').setDescription('Supprimer définitivement un rendez-vous')
      .addStringOption((opt) => opt.setName('id').setDescription('ID de l\'événement').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('Afficher le statut du bot')
  )
  .addSubcommand((sub) =>
    sub.setName('config').setDescription('Configurer ce canal comme agence')
      .addStringOption((opt) => opt.setName('agence').setDescription('Nom de l\'agence').setRequired(true))
      .addStringOption((opt) => opt.setName('calendar_id').setDescription('ID du calendrier Google').setRequired(true))
      .addStringOption((opt) => opt.setName('spreadsheet_id').setDescription('ID du Google Sheets').setRequired(true))
      .addIntegerOption((opt) => opt.setName('max_rdv_heure').setDescription('Max RDV par heure').setRequired(true))
      .addStringOption((opt) => opt.setName('sheet_name').setDescription('Nom de l\'onglet dans le Sheets (ex: Feuille 1)').setRequired(false))
  )
  .addSubcommand((sub) =>
    sub.setName('deconfig').setDescription('Supprimer la configuration de ce canal')
  )
  .addSubcommand((sub) =>
    sub.setName('agences').setDescription('Lister toutes les agences configurées')
  )
  .addSubcommand((sub) =>
    sub.setName('calendars').setDescription('Lister les calendriers Google disponibles')
  )
  .addSubcommand((sub) =>
    sub.setName('pause').setDescription('Mettre en pause les RDV pour cette agence')
  )
  .addSubcommand((sub) =>
    sub.setName('play').setDescription('Reprendre les RDV pour cette agence')
  )
  .addSubcommand((sub) =>
    sub.setName('horaires').setDescription('Configurer les horaires d\'ouverture de l\'agence')
      .addStringOption((opt) => opt.setName('lundi').setDescription('ex: 09:00-19:00 ou fermé').setRequired(false))
      .addStringOption((opt) => opt.setName('mardi').setDescription('ex: 09:00-19:00 ou fermé').setRequired(false))
      .addStringOption((opt) => opt.setName('mercredi').setDescription('ex: 09:00-19:00 ou fermé').setRequired(false))
      .addStringOption((opt) => opt.setName('jeudi').setDescription('ex: 09:00-19:00 ou fermé').setRequired(false))
      .addStringOption((opt) => opt.setName('vendredi').setDescription('ex: 09:00-19:00 ou fermé').setRequired(false))
      .addStringOption((opt) => opt.setName('samedi').setDescription('ex: 09:00-19:00 ou fermé').setRequired(false))
      .addStringOption((opt) => opt.setName('dimanche').setDescription('ex: 09:00-19:00 ou fermé').setRequired(false))
  );

// ── Main execute ──

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  try {
    switch (sub) {
      case 'auth': return await handleAuth(interaction);
      case 'callback': return await handleCallback(interaction);
      case 'add': return await handleAdd(interaction);
      case 'dom': return await handleDom(interaction);
      case 'annuler': return await handleAnnuler(interaction);
      case 'vendu': return await handleVendu(interaction);
      case 'conf': return await handleConf(interaction);
      case 'modifier': return await handleModifier(interaction);
      case 'supprimer': return await handleSupprimer(interaction);
      case 'status': return await handleStatus(interaction);
      case 'config': return await handleConfig(interaction);
      case 'deconfig': return await handleDeconfig(interaction);
      case 'agences': return await handleAgences(interaction);
      case 'calendars': return await handleCalendars(interaction);
      case 'pause': return await handlePause(interaction);
      case 'play': return await handlePlay(interaction);
      case 'horaires': return await handleHoraires(interaction);
      default: return await interaction.reply({ content: 'Sous-commande inconnue.', ephemeral: true });
    }
  } catch (err) {
    console.error(`Error in /rdv ${sub}:`, err);
    const msg = `Erreur: ${err.message}`;
    try {
      if (interaction.deferred || interaction.replied) {
        return await interaction.editReply({ content: msg });
      }
      return await interaction.reply({ content: msg, ephemeral: true });
    } catch (replyErr) {
      console.error(`Error replying for /rdv ${sub}:`, replyErr);
    }
  }
}

// ── Helpers ──

function normalizeMatchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function scoreSheetRowForEvent(row, eventData) {
  if (!eventData) return 0;

  const details = parseManagedRdvEvent(eventData);
  const startDt = eventData.start?.dateTime ? new Date(eventData.start.dateTime) : null;
  let score = 0;

  if (details.nomClient && normalizeMatchText(row[COL.CLIENT]) === normalizeMatchText(details.nomClient)) {
    score += 5;
  }

  if (details.telephone && normalizePhone(row[COL.TELEPHONE]) === normalizePhone(details.telephone)) {
    score += 4;
  }

  if (startDt && row[COL.DATE] === formatDate(startDt)) {
    score += 3;
  }

  if (startDt && row[COL.HEURE] === formatTime(startDt)) {
    score += 2;
  }

  const rowStatus = normalizeMatchText(row[COL.STATUT]);
  if (rowStatus === 'PLANIFIE' || rowStatus === 'PLANIFIÉ') {
    score += 1;
  }

  return score;
}

function findSheetRowByEventId(rows, eventId, eventData = null) {
  const matches = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][COL.EVENT_ID] === eventId) {
      matches.push({ index: i, row: rows[i] });
    }
  }

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  const ranked = matches
    .map((match) => ({ ...match, score: scoreSheetRowForEvent(match.row, eventData) }))
    .sort((a, b) => b.score - a.score || b.index - a.index);

  const best = ranked[0];
  console.warn(
    `[SHEETS] Duplicate event ID ${eventId} found on rows ${matches.map((m) => m.index + 1).join(', ')}. Chosen row ${best.index + 1} (score ${best.score}).`
  );
  return { index: best.index, row: best.row };
}

const JOUR_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const JOUR_MAP = { lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6, dimanche: 0 };

function isWithinOpeningHours(agency, dateTime) {
  if (!agency.opening_hours) return { open: true }; // No hours configured = always open

  const dayOfWeek = dateTime.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daySchedule = agency.opening_hours[String(dayOfWeek)];

  if (!daySchedule || daySchedule === 'fermé') {
    return { open: false, reason: `L'agence **${agency.name}** est fermée le ${JOUR_NAMES[dayOfWeek]}.` };
  }

  const [openStr, closeStr] = daySchedule.split('-');
  const [openH, openM] = openStr.split(':').map(Number);
  const [closeH, closeM] = closeStr.split(':').map(Number);

  const rdvMinutes = dateTime.getHours() * 60 + dateTime.getMinutes();
  const rdvEndMinutes = rdvMinutes + RDV_DURATION_MINUTES;
  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;

  if (rdvMinutes < openMinutes || rdvEndMinutes > closeMinutes) {
    return { open: false, reason: `L'agence **${agency.name}** accepte des RDV de ${openStr} à ${closeStr} le ${JOUR_NAMES[dayOfWeek]}. Un RDV d'1h doit se terminer avant la fermeture.` };
  }

  return { open: true };
}

function buildEventTitle(prefix, nomClient, telephone, marque, modele, annee, kilometrage, prix, liens, commentaire) {
  // Strip trailing KM/km/€ that users sometimes include in their input
  const cleanKm = String(kilometrage || '').replace(/\s*(km|kms)?\s*$/i, '');
  const cleanPrix = String(prix || '').replace(/\s*€?\s*$/, '');
  const parts = [
    prefix,
    nomClient.toUpperCase(),
    telephone,
    marque.toUpperCase(),
    modele.toUpperCase(),
    annee,
    `${cleanKm} KM`,
    `${cleanPrix}€`,
  ];
  return parts.join(' - ');
}

function getPreservedCalendarPrefix(sheetRow, fallbackTitle) {
  const sheetStatus = String(sheetRow?.[COL.STATUT] || '').trim().toUpperCase();
  const sheetConfirmation = String(sheetRow?.[COL.CONFIRMATION] || '').trim().toUpperCase();

  if (sheetStatus === 'ANNULÉ' || sheetStatus === 'ANNULE') return 'ANNULÉ';
  if (sheetStatus === 'VENDU') return 'VENDU';
  if (sheetStatus === 'PAS VENU' || sheetStatus === 'NO SHOW') return 'PAS VENU';

  if (sheetConfirmation === 'NON CONF') return 'NON CONF';
  if (sheetConfirmation === 'CONF') return 'CONF';
  if (sheetConfirmation === 'J/J') return 'J/J';

  return getPrimaryStatusPrefix(fallbackTitle);
}

function isEventDomRdv(eventData) {
  return /\bRDV MANDAT DOM\b/i.test(String(eventData?.summary || ''));
}

function buildCanonicalManagedEventPayload(details, prefix, isDom = false) {
  const rdvType = isDom ? 'RDV MANDAT DOM' : 'RDV MANDAT';
  const baseTitle = buildEventTitle(
    rdvType,
    details.nomClient || '',
    details.telephone || '',
    details.marque || '',
    details.modele || '',
    details.annee || '',
    details.kilometrage || '',
    details.prix || '',
    details.liens || '',
    details.commentaire || ''
  );
  const description = buildManagedRdvDescription(details.liens, details.commentaire, details.adresse);
  return {
    summary: prefix ? `${prefix} - ${baseTitle}` : baseTitle,
    description: description || undefined,
  };
}

function truncateForEmbed(value, maxLength = 1024) {
  const text = String(value ?? '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function buildRdvEmbed(title, color, fields) {
  const embed = new EmbedBuilder()
    .setTitle(truncateForEmbed(title, 256))
    .setColor(color)
    .setTimestamp();

  for (const f of fields) {
    if (f.value) {
      embed.addFields({
        name: truncateForEmbed(f.name, 256),
        value: truncateForEmbed(f.value, 1024),
        inline: f.inline !== false,
      });
    }
  }

  return embed;
}

// ── Auth ──

async function handleAuth(interaction) {
  const url = generateAuthUrl();
  await interaction.reply({
    content:
      `**Étape 1** — Cliquez sur ce lien pour autoriser :\n${url}\n\n` +
      `**Étape 2** — Après autorisation, la page ne chargera pas (c'est normal).\n` +
      `Copiez le **code** dans la barre d'adresse :\n` +
      `\`http://localhost:3000/oauth2callback?code=4/0XXXXX...\`\n\n` +
      `**Étape 3** — Collez le code ici :\n` +
      `\`/rdv callback code:4/0XXXXX...\``,
    ephemeral: true,
  });
}

async function handleCallback(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const code = interaction.options.getString('code');
  await exchangeCode(code);
  await interaction.editReply('Google authentifié avec succès !');
}

// ── Add ──

async function handleAdd(interaction) {
  await interaction.deferReply();
  const agency = requireAgency(interaction);
  if (!agency) return interaction.editReply('Ce canal n\'est lié à aucune agence. Utilisez `/rdv config` ici d\'abord.');

  if (agency.paused) {
    return interaction.editReply(`⏸️ L'agence **${agency.name}** est actuellement en pause. Aucun RDV ne peut être ajouté. Utilisez \`/rdv play\` pour reprendre.`);
  }

  const dateStr = interaction.options.getString('date');
  const heureStr = interaction.options.getString('heure');
  const nomClient = interaction.options.getString('nom_client');
  const telephone = interaction.options.getString('telephone');
  const marque = interaction.options.getString('marque');
  const modele = interaction.options.getString('modele');
  const annee = interaction.options.getString('annee');
  const kilometrage = interaction.options.getString('kilometrage');
  const prix = interaction.options.getString('prix');
  const liens = interaction.options.getString('liens') || '';
  const commentaire = interaction.options.getString('commentaire') || '';

  const dateTime = parseDateTime(dateStr, heureStr);
  const endTime = new Date(dateTime.getTime() + 60 * 60000);

  // Check opening hours
  const hoursCheck = isWithinOpeningHours(agency, dateTime);
  if (!hoursCheck.open) {
    return interaction.editReply(`🚫 ${hoursCheck.reason}`);
  }

  // Check capacity
  const slot = await isSlotAvailable(agency, dateTime);
  if (!slot.available) {
    return interaction.editReply(slot.reason || `Créneau complet ! (${slot.count}/${slot.max} RDV sur ce créneau)`);
  }

  const confType = getConfType(dateTime);
  const isJ1MorningAutoConf = confType === 'J+1' && dateTime.getHours() < 12;
  const sheetConfType = isJ1MorningAutoConf ? 'CONF' : confType;

  // Reserve slot to prevent race conditions with concurrent bookings
  const release = reserveSlot(agency.calendar_id, dateTime);

  let eventId = '';
  try {
    // Build title — add J/J or CONF prefix when applicable
    const baseTitle = buildEventTitle('RDV MANDAT', nomClient, telephone, marque, modele, annee, kilometrage, prix, liens, commentaire);
    const description = buildManagedRdvDescription(liens, commentaire);
    let calendarPrefix = null;
    if (confType === 'J/J') calendarPrefix = 'J/J';
    else if (isJ1MorningAutoConf) calendarPrefix = 'CONF';
    const calTitle = calendarPrefix ? `${calendarPrefix} - ${baseTitle}` : baseTitle;

    // Create calendar event
    const eventRes = await calendar.createEvent(agency.calendar_id, {
      summary: calTitle,
      description: description || undefined,
      start: dateTime,
      end: endTime,
      colorId: calendar.EVENT_COLORS.green,
    });
    eventId = eventRes.data.id || '';
    console.log(`[ADD] Calendar event created: ${eventId}`);
  } finally {
    release();
  }

  // Add to sheet
  const vehicule = modele.toUpperCase();
  const prospecteur = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
  // Store normalized date/time (not raw input) so sheets always show DD/MM/YYYY and HH:MM
  const sheetRow = [prospecteur, vehicule, nomClient.toUpperCase(), "'" + telephone, formatDate(dateTime), formatTime(dateTime), sheetConfType, 'PLANIFIÉ', eventId, timestamp(), ''];

  let sheetStatus = 'Synchronisé';
  try {
    console.log(`[ADD] Sheet row values:`, JSON.stringify(sheetRow));
    await sheets.appendRow(agency.spreadsheet_id, sheetRow, agency.sheet_name);
    console.log(`[ADD] Sheet row appended`);
  } catch (sheetErr) {
    console.error(`[ADD] Sheet append FAILED:`, sheetErr.message);
    sheetStatus = `Erreur: ${sheetErr.message}`;
  }

  const calLink = getCalendarLink(eventId, agency.calendar_id);

  const embed = buildRdvEmbed('RDV créé', 0x0B8043, [
    { name: 'Date', value: dateStr },
    { name: 'Heure', value: heureStr },
    { name: 'Agence', value: agency.name },
    { name: 'Client', value: nomClient.toUpperCase() },
    { name: 'Téléphone', value: telephone },
    { name: 'Véhicule', value: `${marque.toUpperCase()} ${modele.toUpperCase()} (${annee})` },
    { name: 'Kilométrage', value: `${kilometrage} KM` },
    { name: 'Prix', value: `${prix}€` },
    { name: 'ID Événement', value: `\`${eventId}\``, inline: false },
    { name: 'Lien', value: liens || 'Aucun', inline: false },
    { name: 'Notes', value: commentaire || 'Aucune', inline: false },
    { name: 'Voir sur Calendar', value: `[Ouvrir](${calLink})`, inline: false },
    { name: 'Sheets', value: sheetStatus, inline: false },
  ]);

  if (sheetConfType) {
    embed.setFooter({ text: sheetConfType });
  }

  await interaction.editReply({ embeds: [embed] });
}

// ── Dom ──

async function handleDom(interaction) {
  await interaction.deferReply();
  const agency = requireAgency(interaction);
  if (!agency) return interaction.editReply('Ce canal n\'est lié à aucune agence. Utilisez `/rdv config` ici d\'abord.');

  if (!agency.dom_rdv_enabled) {
    return interaction.editReply('🚫 La fonctionnalité RDV à domicile n\'est pas activée pour cette agence.');
  }

  if (agency.paused) {
    return interaction.editReply(`⏸️ L'agence **${agency.name}** est actuellement en pause. Aucun RDV ne peut être ajouté.`);
  }

  const dateStr = interaction.options.getString('date');
  const heureStr = interaction.options.getString('heure');
  const nomClient = interaction.options.getString('nom_client');
  const telephone = interaction.options.getString('telephone');
  const marque = interaction.options.getString('marque');
  const modele = interaction.options.getString('modele');
  const annee = interaction.options.getString('annee');
  const kilometrage = interaction.options.getString('kilometrage');
  const prix = interaction.options.getString('prix');
  const adresse = interaction.options.getString('adresse');
  const liens = interaction.options.getString('liens') || '';
  const commentaire = interaction.options.getString('commentaire') || '';

  // rdvTime = heure saisie par l'utilisateur (ex: 15h00)
  // startTime = rdvTime - 15min (ex: 14h45) → affiché sur l'agenda
  // endTime   = rdvTime + 75min (ex: 16h15) → total créneau = 1h30
  const rdvTime = parseDateTime(dateStr, heureStr);
  const startTime = new Date(rdvTime.getTime() - DOM_RDV_BUFFER_MINUTES * 60000);
  const endTime = new Date(rdvTime.getTime() + (DOM_RDV_TOTAL_MINUTES - DOM_RDV_BUFFER_MINUTES) * 60000);

  const confType = getConfType(rdvTime);
  const isJ1MorningAutoConf = confType === 'J+1' && rdvTime.getHours() < 12;
  const sheetConfType = isJ1MorningAutoConf ? 'CONF' : confType;

  const baseTitle = buildEventTitle('RDV MANDAT DOM', nomClient, telephone, marque, modele, annee, kilometrage, prix, liens, commentaire);
  const description = buildManagedRdvDescription(liens, commentaire, adresse);

  let calendarPrefix = null;
  if (confType === 'J/J') calendarPrefix = 'J/J';
  else if (isJ1MorningAutoConf) calendarPrefix = 'CONF';
  const calTitle = calendarPrefix ? `${calendarPrefix} - ${baseTitle}` : baseTitle;

  let eventId = '';
  try {
    const eventRes = await calendar.createEvent(agency.calendar_id, {
      summary: calTitle,
      description: description || undefined,
      start: startTime,
      end: endTime,
      colorId: calendar.EVENT_COLORS.grape,
    });
    eventId = eventRes.data.id || '';
    console.log(`[DOM] Calendar event created: ${eventId}`);
  } catch (calErr) {
    console.error(`[DOM] Calendar create failed:`, calErr.message);
    throw calErr;
  }

  const vehicule = modele.toUpperCase();
  const prospecteur = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
  const sheetRow = [prospecteur, vehicule, nomClient.toUpperCase(), "'" + telephone, formatDate(rdvTime), heureStr, sheetConfType, 'PLANIFIÉ', eventId, timestamp(), ''];

  let sheetStatus = 'Synchronisé';
  try {
    await sheets.appendRow(agency.spreadsheet_id, sheetRow, agency.sheet_name);
    console.log(`[DOM] Sheet row appended`);
  } catch (sheetErr) {
    console.error(`[DOM] Sheet append FAILED:`, sheetErr.message);
    sheetStatus = `Erreur: ${sheetErr.message}`;
  }

  const calLink = getCalendarLink(eventId, agency.calendar_id);

  const embed = buildRdvEmbed('RDV DOM créé', 0x8E24AA, [
    { name: 'Date', value: dateStr },
    { name: 'Heure RDV', value: heureStr },
    { name: 'Créneau agenda', value: `${formatTime(startTime)} → ${formatTime(endTime)}`, inline: false },
    { name: 'Agence', value: agency.name },
    { name: 'Client', value: nomClient.toUpperCase() },
    { name: 'Téléphone', value: telephone },
    { name: 'Adresse', value: adresse, inline: false },
    { name: 'Véhicule', value: `${marque.toUpperCase()} ${modele.toUpperCase()} (${annee})` },
    { name: 'Kilométrage', value: `${kilometrage} KM` },
    { name: 'Prix', value: `${prix}€` },
    { name: 'ID Événement', value: `\`${eventId}\``, inline: false },
    { name: 'Lien', value: liens || 'Aucun', inline: false },
    { name: 'Notes', value: commentaire || 'Aucune', inline: false },
    { name: 'Voir sur Calendar', value: `[Ouvrir](${calLink})`, inline: false },
    { name: 'Sheets', value: sheetStatus, inline: false },
  ]);

  if (sheetConfType) embed.setFooter({ text: sheetConfType });

  await interaction.editReply({ embeds: [embed] });
}

// ── Annuler ──

async function handleAnnuler(interaction) {
  await interaction.deferReply();
  const agency = requireAgency(interaction);
  if (!agency) return interaction.editReply('Ce canal n\'est lié à aucune agence.');

  const eventId = interaction.options.getString('id');

  // Get event details first
  let eventData;
  try {
    const cal = await calendar.getCalendarApi();
    const ev = await cal.events.get({ calendarId: agency.calendar_id, eventId });
    eventData = ev.data;
  } catch (calErr) {
    console.error(`[ANNULER] Event fetch failed:`, calErr.message);
    return interaction.editReply(`Événement introuvable: \`${eventId}\``);
  }

  // Block annulation if the RDV time has already passed
  if (eventData.start?.dateTime) {
    const rdvTime = new Date(eventData.start.dateTime);
    if (rdvTime < new Date()) {
      return interaction.editReply(`Impossible d'annuler : le RDV du ${formatDate(rdvTime)} à ${formatTime(rdvTime)} est déjà passé.`);
    }
  }

  // Update calendar title + color
  try {
    const currentDetails = parseManagedRdvEvent(eventData);
    const isDom = isEventDomRdv(eventData);
    const payload = buildCanonicalManagedEventPayload(currentDetails, 'ANNULÉ', isDom);
    await calendar.updateEvent(agency.calendar_id, eventId, {
      summary: payload.summary,
      description: payload.description,
      colorId: calendar.EVENT_COLORS.red,
    });
    console.log(`[ANNULER] Calendar event ${eventId} updated`);
  } catch (calErr) {
    console.error(`[ANNULER] Calendar failed:`, calErr.message);
    return interaction.editReply(`Erreur calendrier: ${calErr.message}`);
  }

  // Update sheet
  let sheetRow = null;
  try {
    const rows = await sheets.getAllRows(agency.spreadsheet_id, agency.sheet_name);
    const found = findSheetRowByEventId(rows, eventId, eventData);
    if (found) {
      sheetRow = found.row;
      found.row[COL.STATUT] = 'ANNULÉ';
      found.row[COL.UPDATED_AT] = timestamp();
      await sheets.updateRow(agency.spreadsheet_id, found.index, found.row, agency.sheet_name);
    }
  } catch (e) {
    console.error(`[ANNULER] Sheet failed:`, e.message);
  }

  const currentDetails = parseManagedRdvEvent(eventData);
  const startDt = eventData.start?.dateTime ? new Date(eventData.start.dateTime) : null;

  const calLink = getCalendarLink(eventId, agency.calendar_id);
  const embed = buildRdvEmbed('RDV annulé', 0xDC3545, [
    { name: 'Date', value: startDt ? formatDate(startDt) : (sheetRow?.[COL.DATE] || '—') },
    { name: 'Heure', value: startDt ? formatTime(startDt) : (sheetRow?.[COL.HEURE] || '—') },
    { name: 'Agence', value: agency.name },
    { name: 'Client', value: sheetRow?.[COL.CLIENT] || currentDetails.nomClient || '—' },
    { name: 'Téléphone', value: sheetRow?.[COL.TELEPHONE] || currentDetails.telephone || '—' },
    { name: 'Véhicule', value: sheetRow?.[COL.VEHICULE] || `${currentDetails.marque || ''} ${currentDetails.modele || ''} (${currentDetails.annee || ''})`.trim() || '—' },
    { name: 'Statut', value: 'ANNULÉ' },
    { name: 'ID Événement', value: `\`${eventId}\``, inline: false },
    { name: 'Voir sur Calendar', value: `[Ouvrir](${calLink})`, inline: false },
  ]);

  await interaction.editReply({ embeds: [embed] });
}

// ── Vendu ──

async function handleVendu(interaction) {
  await interaction.deferReply();
  const agency = requireAgency(interaction);
  if (!agency) return interaction.editReply('Ce canal n\'est lié à aucune agence.');

  const eventId = interaction.options.getString('id');

  // Get event details first
  let eventData;
  try {
    const cal = await calendar.getCalendarApi();
    const ev = await cal.events.get({ calendarId: agency.calendar_id, eventId });
    eventData = ev.data;
  } catch (calErr) {
    console.error(`[VENDU] Event fetch failed:`, calErr.message);
    return interaction.editReply(`Événement introuvable: \`${eventId}\``);
  }

  // Update calendar title + color
  try {
    const currentDetails = parseManagedRdvEvent(eventData);
    const isDom = isEventDomRdv(eventData);
    const payload = buildCanonicalManagedEventPayload(currentDetails, 'VENDU', isDom);
    await calendar.updateEvent(agency.calendar_id, eventId, {
      summary: payload.summary,
      description: payload.description,
      colorId: calendar.EVENT_COLORS.orange,
    });
    console.log(`[VENDU] Calendar event ${eventId} updated`);
  } catch (calErr) {
    console.error(`[VENDU] Calendar failed:`, calErr.message);
    return interaction.editReply(`Erreur calendrier: ${calErr.message}`);
  }

  // Update sheet
  let sheetRow = null;
  try {
    const rows = await sheets.getAllRows(agency.spreadsheet_id, agency.sheet_name);
    const found = findSheetRowByEventId(rows, eventId, eventData);
    if (found) {
      sheetRow = found.row;
      found.row[COL.STATUT] = 'VENDU';
      found.row[COL.UPDATED_AT] = timestamp();
      await sheets.updateRow(agency.spreadsheet_id, found.index, found.row, agency.sheet_name);
    }
  } catch (e) {
    console.error(`[VENDU] Sheet failed:`, e.message);
  }

  const currentDetails = parseManagedRdvEvent(eventData);
  const startDt = eventData.start?.dateTime ? new Date(eventData.start.dateTime) : null;

  const calLink = getCalendarLink(eventId, agency.calendar_id);
  const embed = buildRdvEmbed('RDV vendu', 0xFF9800, [
    { name: 'Date', value: startDt ? formatDate(startDt) : (sheetRow?.[COL.DATE] || '—') },
    { name: 'Heure', value: startDt ? formatTime(startDt) : (sheetRow?.[COL.HEURE] || '—') },
    { name: 'Agence', value: agency.name },
    { name: 'Client', value: sheetRow?.[COL.CLIENT] || currentDetails.nomClient || '—' },
    { name: 'Téléphone', value: sheetRow?.[COL.TELEPHONE] || currentDetails.telephone || '—' },
    { name: 'Véhicule', value: sheetRow?.[COL.VEHICULE] || `${currentDetails.marque || ''} ${currentDetails.modele || ''} (${currentDetails.annee || ''})`.trim() || '—' },
    { name: 'Statut', value: 'VENDU' },
    { name: 'ID Événement', value: `\`${eventId}\``, inline: false },
    { name: 'Voir sur Calendar', value: `[Ouvrir](${calLink})`, inline: false },
  ]);

  await interaction.editReply({ embeds: [embed] });
}

// ── Conf ──

async function handleConf(interaction) {
  await interaction.deferReply();
  const agency = requireAgency(interaction);
  if (!agency) return interaction.editReply('Ce canal n\'est lié à aucune agence.');

  const eventId = interaction.options.getString('id');
  const confStatut = interaction.options.getString('statut'); // 'CONF' or 'NON CONF'

  // Get event details from calendar
  let eventData;
  try {
    const cal = await calendar.getCalendarApi();
    const ev = await cal.events.get({ calendarId: agency.calendar_id, eventId });
    eventData = ev.data;
  } catch (calErr) {
    console.error(`[CONF] Event fetch failed:`, calErr.message);
    return interaction.editReply(`Événement introuvable: \`${eventId}\``);
  }

  // Update sheet
  let sheetRow = null;
  try {
    const rows = await sheets.getAllRows(agency.spreadsheet_id, agency.sheet_name);
    const found = findSheetRowByEventId(rows, eventId, eventData);
    if (!found) {
      return interaction.editReply(`Aucun RDV trouvé avec l'ID \`${eventId}\` dans le Sheets.`);
    }
    sheetRow = found.row;
    found.row[COL.CONFIRMATION] = confStatut;
    found.row[COL.CONF_PAR] = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
    found.row[COL.UPDATED_AT] = timestamp();
    await sheets.updateRow(agency.spreadsheet_id, found.index, found.row, agency.sheet_name);
    console.log(`[CONF] Sheet row ${found.index} updated to ${confStatut}`);
  } catch (e) {
    console.error(`[CONF] Failed:`, e.message);
    return interaction.editReply(`Erreur: ${e.message}`);
  }

  // Update calendar title only — no color change
  try {
    const currentDetails = parseManagedRdvEvent(eventData);
    const isDom = isEventDomRdv(eventData);
    const payload = buildCanonicalManagedEventPayload(currentDetails, confStatut, isDom);
    await calendar.updateEvent(agency.calendar_id, eventId, {
      summary: payload.summary,
      description: payload.description,
    });
    console.log(`[CONF] Calendar event ${eventId} updated to ${confStatut}`);
  } catch (calErr) {
    console.error(`[CONF] Calendar update failed:`, calErr.message);
    // Non-fatal: sheet already updated, just warn in reply
  }

  const currentDetails = parseManagedRdvEvent(eventData);
  const startDt = eventData.start?.dateTime ? new Date(eventData.start.dateTime) : null;
  const calLink = getCalendarLink(eventId, agency.calendar_id);
  const isConf = confStatut === 'CONF';

  const embed = buildRdvEmbed(isConf ? 'RDV confirmé' : 'RDV non confirmé', isConf ? 0x0B8043 : 0xDC3545, [
    { name: 'Date', value: startDt ? formatDate(startDt) : (sheetRow?.[COL.DATE] || '—') },
    { name: 'Heure', value: startDt ? formatTime(startDt) : (sheetRow?.[COL.HEURE] || '—') },
    { name: 'Agence', value: agency.name },
    { name: 'Client', value: sheetRow?.[COL.CLIENT] || currentDetails.nomClient || '—' },
    { name: 'Téléphone', value: sheetRow?.[COL.TELEPHONE] || currentDetails.telephone || '—' },
    { name: 'Véhicule', value: sheetRow?.[COL.VEHICULE] || `${currentDetails.marque || ''} ${currentDetails.modele || ''} (${currentDetails.annee || ''})`.trim() || '—' },
    { name: 'Confirmation', value: confStatut },
    { name: 'ID Événement', value: `\`${eventId}\``, inline: false },
    { name: 'Voir sur Calendar', value: `[Ouvrir](${calLink})`, inline: false },
  ]);

  await interaction.editReply({ embeds: [embed] });
}

// ── Modifier ──

async function handleModifier(interaction) {
  await interaction.deferReply();
  const agency = requireAgency(interaction);
  if (!agency) return interaction.editReply('Ce canal n\'est lié à aucune agence.');

  const eventId = interaction.options.getString('id');

  // Get current event from calendar
  let currentEvent;
  try {
    const cal = await calendar.getCalendarApi();
    const ev = await cal.events.get({ calendarId: agency.calendar_id, eventId });
    currentEvent = ev.data;
  } catch (calErr) {
    console.error(`[MODIFIER] Event fetch failed:`, calErr.message);
    return interaction.editReply(`Événement introuvable: \`${eventId}\``);
  }

  let currentSheetRow = null;
  try {
    const rows = await sheets.getAllRows(agency.spreadsheet_id, agency.sheet_name);
    currentSheetRow = findSheetRowByEventId(rows, eventId, currentEvent);
  } catch (sheetErr) {
    console.error(`[MODIFIER] Sheet prefetch failed:`, sheetErr.message);
  }

  if (!currentSheetRow) {
    return interaction.editReply(`Aucun RDV trouvé avec l'ID \`${eventId}\` dans le Sheets. Modification bloquée pour éviter un décalage Calendar/Sheets.`);
  }

  const isDom = isEventDomRdv(currentEvent);
  const currentDetails = parseManagedRdvEvent(currentEvent);
  const curNom = currentDetails.nomClient;
  const curTel = currentDetails.telephone;
  const curMarque = currentDetails.marque;
  const curModele = currentDetails.modele;
  const curAnnee = currentDetails.annee;
  const curKm = currentDetails.kilometrage;
  const curPrix = currentDetails.prix;
  const curLiens = currentDetails.liens;
  const curCommentaire = currentDetails.commentaire;

  // Get optional new values
  const newNom = interaction.options.getString('nom_client') ? interaction.options.getString('nom_client').toUpperCase() : curNom;
  const newTel = interaction.options.getString('telephone') || curTel;
  const newMarque = interaction.options.getString('marque') ? interaction.options.getString('marque').toUpperCase() : curMarque;
  const newModele = interaction.options.getString('modele') ? interaction.options.getString('modele').toUpperCase() : curModele;
  const newAnnee = interaction.options.getString('annee') || curAnnee;
  const newKm = interaction.options.getString('kilometrage') || curKm;
  const newPrix = interaction.options.getString('prix') || curPrix;
  const newLiens = interaction.options.getString('liens') !== null ? (interaction.options.getString('liens') || '') : curLiens;
  const newCommentaire = interaction.options.getString('commentaire') !== null ? (interaction.options.getString('commentaire') || '').toUpperCase() : curCommentaire;

  // Determine date/time
  const currentStartRaw = currentEvent.start?.dateTime;
  if (!currentStartRaw) {
    return interaction.editReply('Impossible de modifier cet événement: heure de début introuvable dans Google Calendar.');
  }

  const currentStart = new Date(currentStartRaw);
  const nouvelleDateStr = interaction.options.getString('nouvelle_date');
  const nouvelleHeureStr = interaction.options.getString('nouvelle_heure');
  const isRebook = Boolean(nouvelleDateStr || nouvelleHeureStr);

  // Pour les RDV DOM, le calendrier démarre 15min AVANT l'heure RDV.
  // rdvUserTime = l'heure affichée à l'utilisateur (ex: 15h00).
  const rdvUserTime = isDom
    ? new Date(currentStart.getTime() + DOM_RDV_BUFFER_MINUTES * 60000)
    : currentStart;

  let newDateTime, newEndTime, newDateStr, newHeureStr;
  if (isRebook) {
    newDateStr = nouvelleDateStr || formatDate(rdvUserTime);
    newHeureStr = nouvelleHeureStr || formatTime(rdvUserTime);
    newDateTime = parseDateTime(newDateStr, newHeureStr);
    newEndTime = new Date(newDateTime.getTime() + 60 * 60000);

    // Vérification horaires uniquement pour les RDV classiques
    if (!isDom) {
      const hoursCheck = isWithinOpeningHours(agency, newDateTime);
      if (!hoursCheck.open) {
        return interaction.editReply(`🚫 ${hoursCheck.reason}`);
      }
    }
  } else {
    // Pas de changement de date/heure — conserver l'heure RDV existante
    newDateTime = rdvUserTime;
    newEndTime = new Date(rdvUserTime.getTime() + 60 * 60000);
    newDateStr = formatDate(rdvUserTime);
    newHeureStr = formatTime(rdvUserTime);
  }

  // Vérification capacité uniquement pour les RDV classiques (DOM = hors agence)
  if (isRebook && !isDom) {
    const slot = await isSlotAvailable(agency, newDateTime, { excludeEventId: eventId });
    if (!slot.available) {
      return interaction.editReply(slot.reason || `Créneau complet pour le ${newDateStr} à ${newHeureStr} ! (${slot.count}/${slot.max})`);
    }
  }

  const rdvType = isDom ? 'RDV MANDAT DOM' : 'RDV MANDAT';
  const baseTitle = buildEventTitle(rdvType, newNom, newTel, newMarque, newModele, newAnnee, newKm, newPrix, newLiens, newCommentaire);
  const description = buildManagedRdvDescription(newLiens, newCommentaire, currentDetails.adresse);

  let sheetConfType = currentSheetRow.row[COL.CONFIRMATION] || '';
  let sheetStatus = currentSheetRow.row[COL.STATUT] || 'PLANIFIÉ';
  let confPar = currentSheetRow.row[COL.CONF_PAR] || '';
  let calendarPrefix = getPreservedCalendarPrefix(currentSheetRow.row, currentEvent.summary || '');
  let colorId = currentEvent.colorId || calendar.EVENT_COLORS.green;

  if (isRebook) {
    const confType = getConfType(newDateTime);
    const isJ1MorningAutoConf = confType === 'J+1' && newDateTime.getHours() < 12;

    sheetConfType = isJ1MorningAutoConf ? 'CONF' : confType;
    sheetStatus = 'PLANIFIÉ';
    confPar = '';
    calendarPrefix = confType === 'J/J' ? 'J/J' : (isJ1MorningAutoConf ? 'CONF' : null);
    colorId = isDom ? calendar.EVENT_COLORS.grape : calendar.EVENT_COLORS.green;
  }

  const newTitle = calendarPrefix ? `${calendarPrefix} - ${baseTitle}` : baseTitle;

  // Calcul des temps réels sur le calendrier
  const calStart = isDom
    ? new Date(newDateTime.getTime() - DOM_RDV_BUFFER_MINUTES * 60000)
    : newDateTime;
  const calEnd = isDom
    ? new Date(newDateTime.getTime() + (DOM_RDV_TOTAL_MINUTES - DOM_RDV_BUFFER_MINUTES) * 60000)
    : newEndTime;

  try {
    await calendar.updateEvent(agency.calendar_id, eventId, {
      summary: newTitle,
      description: description || undefined,
      colorId,
      start: { dateTime: calStart.toISOString(), timeZone: 'Europe/Paris' },
      end: { dateTime: calEnd.toISOString(), timeZone: 'Europe/Paris' },
    });
    console.log(`[MODIFIER] Calendar event ${eventId} updated${isRebook ? ' with reset state' : ''}`);
  } catch (calErr) {
    console.error(`[MODIFIER] Calendar update failed:`, calErr.message);
    throw calErr;
  }

  try {
    currentSheetRow.row[COL.CLIENT] = newNom;
    currentSheetRow.row[COL.TELEPHONE] = "'" + newTel;
    currentSheetRow.row[COL.VEHICULE] = newModele;
    currentSheetRow.row[COL.DATE] = newDateStr;
    currentSheetRow.row[COL.HEURE] = newHeureStr;
    currentSheetRow.row[COL.STATUT] = sheetStatus;
    currentSheetRow.row[COL.CONFIRMATION] = sheetConfType;
    currentSheetRow.row[COL.CONF_PAR] = confPar;
    currentSheetRow.row[COL.UPDATED_AT] = timestamp();
    await sheets.updateRow(agency.spreadsheet_id, currentSheetRow.index, currentSheetRow.row, agency.sheet_name);
    console.log(`[MODIFIER] Sheet row ${currentSheetRow.index} updated${isRebook ? ' with reset state' : ''}`);
  } catch (sheetErr) {
    console.error(`[MODIFIER] Sheet update failed:`, sheetErr.message);
    return interaction.editReply(`Le calendrier a été mis à jour mais le Sheets a échoué sur l'ID \`${eventId}\`. Vérifie la ligne avant de refaire une modification.`);
  }

  const calLink = getCalendarLink(eventId, agency.calendar_id);
  const embed = buildRdvEmbed(
    isDom ? 'RDV DOM modifié' : 'RDV modifié',
    isDom ? 0x8E24AA : 0x2196F3,
    [
      { name: 'Date', value: newDateStr },
      { name: 'Heure RDV', value: newHeureStr },
      { name: 'Créneau agenda', value: isDom ? `${formatTime(calStart)} → ${formatTime(calEnd)}` : '' },
      { name: 'Agence', value: agency.name },
      { name: 'Client', value: newNom },
      { name: 'Téléphone', value: newTel },
      { name: 'Adresse', value: currentDetails.adresse || '' },
      { name: 'Véhicule', value: `${newMarque} ${newModele} (${newAnnee})` },
      { name: 'Kilométrage', value: `${newKm} KM` },
      { name: 'Prix', value: `${newPrix}€` },
      { name: 'ID Événement', value: `\`${eventId}\``, inline: false },
      { name: 'Lien', value: newLiens || 'Aucun', inline: false },
      { name: 'Notes', value: newCommentaire || 'Aucune', inline: false },
      { name: 'Voir sur Calendar', value: `[Ouvrir](${calLink})`, inline: false },
    ]
  );

  await interaction.editReply({ embeds: [embed] });
}

// ── Supprimer ──

async function handleSupprimer(interaction) {
  await interaction.deferReply();
  const agency = requireAgency(interaction);
  if (!agency) return interaction.editReply('Ce canal n\'est lié à aucune agence.');

  const eventId = interaction.options.getString('id');

  // Get event details before deleting
  let eventData = null;
  try {
    const cal = await calendar.getCalendarApi();
    const ev = await cal.events.get({ calendarId: agency.calendar_id, eventId });
    eventData = ev.data;
  } catch (e) {
    // Event might not exist, continue
  }

  // Get sheet row before deleting
  let sheetRow = null;
  try {
    const rows = await sheets.getAllRows(agency.spreadsheet_id, agency.sheet_name);
    const found = findSheetRowByEventId(rows, eventId, eventData);
    if (found) {
      sheetRow = found.row;
    }
  } catch (e) {
    // Continue even if sheet read fails
  }

  try {
    await calendar.deleteEvent(agency.calendar_id, eventId);
    console.log(`[SUPPRIMER] Calendar event ${eventId} deleted`);
  } catch (calErr) {
    console.error(`[SUPPRIMER] Calendar delete failed:`, calErr.message);
    return interaction.editReply(`Erreur suppression calendrier: ${calErr.message}`);
  }

  try {
    const rows = await sheets.getAllRows(agency.spreadsheet_id, agency.sheet_name);
    const found = findSheetRowByEventId(rows, eventId, eventData);
    if (found) {
      await sheets.deleteRow(agency.spreadsheet_id, found.index, agency.sheet_name);
      console.log(`[SUPPRIMER] Sheet row ${found.index} deleted`);
    }
  } catch (sheetErr) {
    console.error(`[SUPPRIMER] Sheet delete failed:`, sheetErr.message);
  }

  const currentDetails = eventData ? parseManagedRdvEvent(eventData) : null;
  const startDt = eventData?.start?.dateTime ? new Date(eventData.start.dateTime) : null;

  const embed = buildRdvEmbed('RDV supprimé', 0x6C757D, [
    { name: 'Date', value: startDt ? formatDate(startDt) : (sheetRow?.[COL.DATE] || '—') },
    { name: 'Heure', value: startDt ? formatTime(startDt) : (sheetRow?.[COL.HEURE] || '—') },
    { name: 'Agence', value: agency.name },
    { name: 'Client', value: sheetRow?.[COL.CLIENT] || currentDetails?.nomClient || '—' },
    { name: 'Téléphone', value: sheetRow?.[COL.TELEPHONE] || currentDetails?.telephone || '—' },
    { name: 'Véhicule', value: sheetRow?.[COL.VEHICULE] || `${currentDetails?.marque || ''} ${currentDetails?.modele || ''} (${currentDetails?.annee || ''})`.trim() || '—' },
    { name: 'Statut', value: 'SUPPRIMÉ DÉFINITIVEMENT' },
    { name: 'ID Événement', value: `\`${eventId}\``, inline: false },
  ]);

  await interaction.editReply({ embeds: [embed] });
}

// ── Status ──

async function handleStatus(interaction) {
  const agencies = loadAgencies();
  const agencyCount = Object.keys(agencies).length;
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  const authValid = isAuthenticated();

  const embed = new EmbedBuilder()
    .setTitle('Statut du bot')
    .setColor(authValid ? 0x34A853 : 0xDC3545)
    .addFields(
      { name: 'Uptime', value: `${hours}h ${minutes}m ${seconds}s`, inline: true },
      { name: 'Google Auth', value: authValid ? 'Valide' : 'Non configuré', inline: true },
      { name: 'Agences', value: String(agencyCount), inline: true },
    )
    .setTimestamp();

  if (agencyCount > 0) {
    const agencyList = Object.values(agencies).map((cfg) =>
      `**${cfg.name}** (max ${cfg.max_rdv_heure}/h) → <#${cfg.channel_id}>`
    ).join('\n');
    embed.addFields({ name: 'Agences configurées', value: agencyList, inline: false });
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ── Config ──

async function handleConfig(interaction) {
  await interaction.deferReply();
  const agenceName = interaction.options.getString('agence');
  const calendarId = interaction.options.getString('calendar_id');
  const spreadsheetId = interaction.options.getString('spreadsheet_id');
  const maxRdvHeure = interaction.options.getInteger('max_rdv_heure');
  const channelId = interaction.channelId;

  const sheetName = interaction.options.getString('sheet_name') || '';

  // If no sheet_name given, auto-detect by listing tabs
  let resolvedSheetName = sheetName;
  if (!resolvedSheetName) {
    try {
      const tabs = await sheets.listSheetTabs(spreadsheetId);
      console.log(`[CONFIG] Sheet tabs:`, tabs);
      // Use the first tab that isn't "TOTAUX" or similar summary tabs
      resolvedSheetName = tabs.find((t) => !t.toLowerCase().includes('totaux') && !t.toLowerCase().includes('résumé')) || tabs[0] || '';
    } catch (e) {
      console.error(`[CONFIG] Could not list tabs:`, e.message);
    }
  }

  const agencies = loadAgencies();
  agencies[agenceName.toLowerCase()] = {
    name: agenceName,
    calendar_id: calendarId,
    spreadsheet_id: spreadsheetId,
    max_rdv_heure: maxRdvHeure,
    granularite: 30,
    timezone: 'Europe/Paris',
    channel_id: channelId,
    sheet_name: resolvedSheetName,
  };
  saveAgencies(agencies);

  const embed = new EmbedBuilder()
    .setTitle(`Agence ${agenceName} configurée`)
    .setColor(0x34A853)
    .addFields(
      { name: 'Canal', value: `<#${channelId}>`, inline: true },
      { name: 'Max RDV/heure', value: String(maxRdvHeure), inline: true },
      { name: 'Calendrier', value: `\`${calendarId}\``, inline: false },
      { name: 'Spreadsheet', value: `\`${spreadsheetId}\``, inline: false },
      { name: 'Onglet', value: resolvedSheetName || '(premier onglet)', inline: false },
    )
    .setFooter({ text: 'Envoi auto agendas S & S+1 : 08h, 12h, 15h, 18h, 21h' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ── Deconfig ──

async function handleDeconfig(interaction) {
  const agency = getAgencyByChannel(interaction.channelId);
  if (!agency) return interaction.reply({ content: 'Ce canal n\'est lié à aucune agence.', ephemeral: true });

  const agencies = loadAgencies();
  delete agencies[agency.key];
  saveAgencies(agencies);
  await interaction.reply(`Agence **${agency.name}** supprimée de ce canal.`);
}

// ── Agences ──

async function handleAgences(interaction) {
  const agencies = loadAgencies();
  const entries = Object.entries(agencies);

  if (entries.length === 0) return interaction.reply({ content: 'Aucune agence configurée.', ephemeral: true });

  // Discord embed max 25 fields — use plain text list for 33+ agencies
  const lines = entries.map(([, cfg]) => {
    const status = cfg.paused ? '⏸️' : '▶️';
    return `${status} **${cfg.name}** — ${cfg.max_rdv_heure} RDV/h — <#${cfg.channel_id}>`;
  });

  // Split into chunks of 2000 chars (Discord message limit)
  const chunks = [];
  let current = '**Agences configurées :**\n\n';
  for (const line of lines) {
    if (current.length + line.length + 1 > 1900) {
      chunks.push(current);
      current = '';
    }
    current += line + '\n';
  }
  if (current) chunks.push(current);

  await interaction.reply(chunks[0]);
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp(chunks[i]);
  }
}

// ── Calendars ──

async function handleCalendars(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const calendars = await calendar.listCalendars();

  if (calendars.length === 0) return interaction.editReply('Aucun calendrier trouvé.');

  const lines = calendars.map((cal) => `**${cal.name}** → \`${cal.id}\``).join('\n');
  await interaction.editReply(`**Calendriers disponibles :**\n${lines}`);
}

// ── Pause / Play ──

const ALLOWED_PLAY_PAUSE_USERS = ['1446485383729778749'];

async function handlePause(interaction) {
  // Admin only — prospecteurs must NOT be able to pause agencies
  const isAllowed = interaction.member.permissions.has('ManageGuild') || interaction.member.permissions.has('Administrator') || ALLOWED_PLAY_PAUSE_USERS.includes(interaction.user.id);
  if (!isAllowed) {
    return interaction.reply({ content: 'Seuls les administrateurs peuvent mettre en pause une agence.', ephemeral: true });
  }
  await interaction.deferReply();
  const agency = requireAgency(interaction);
  if (!agency) return interaction.editReply('Ce canal n\'est lié à aucune agence.');

  const agencies = loadAgencies();
  if (!agencies[agency.key]) return interaction.editReply('Agence introuvable.');

  agencies[agency.key].paused = true;
  saveAgencies(agencies);

  await interaction.editReply(`⏸️ L'agence **${agency.name}** est maintenant **en pause**. Plus aucun RDV ne sera accepté jusqu'à \`/rdv play\`.`);
}

async function handlePlay(interaction) {
  // Admin only — prospecteurs must NOT be able to resume agencies
  const isAllowed = interaction.member.permissions.has('ManageGuild') || interaction.member.permissions.has('Administrator') || ALLOWED_PLAY_PAUSE_USERS.includes(interaction.user.id);
  if (!isAllowed) {
    return interaction.reply({ content: 'Seuls les administrateurs peuvent réactiver une agence.', ephemeral: true });
  }
  await interaction.deferReply();
  const agency = requireAgency(interaction);
  if (!agency) return interaction.editReply('Ce canal n\'est lié à aucune agence.');

  const agencies = loadAgencies();
  if (!agencies[agency.key]) return interaction.editReply('Agence introuvable.');

  delete agencies[agency.key].paused;
  saveAgencies(agencies);

  await interaction.editReply(`▶️ L'agence **${agency.name}** est maintenant **active**. Les RDV sont de nouveau acceptés.`);
}

// ── Horaires ──

async function handleHoraires(interaction) {
  // Admin only
  if (!interaction.member.permissions.has('ManageGuild') && !interaction.member.permissions.has('Administrator')) {
    return interaction.reply({ content: 'Seuls les administrateurs peuvent configurer les horaires.', ephemeral: true });
  }

  await interaction.deferReply();
  const agency = requireAgency(interaction);
  if (!agency) return interaction.editReply('Ce canal n\'est lié à aucune agence.');

  const agencies = loadAgencies();
  const cfg = agencies[agency.key];
  if (!cfg) return interaction.editReply('Agence introuvable.');

  // Initialize opening_hours if not set
  if (!cfg.opening_hours) cfg.opening_hours = {};

  const days = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
  let updated = false;

  for (const day of days) {
    const value = interaction.options.getString(day);
    if (value === null || value === undefined) continue;

    const jsDay = JOUR_MAP[day];
    const clean = value.trim().toLowerCase();

    if (clean === 'fermé' || clean === 'ferme' || clean === 'fermé' || clean === 'closed' || clean === 'off') {
      cfg.opening_hours[String(jsDay)] = 'fermé';
      updated = true;
    } else if (/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(clean)) {
      cfg.opening_hours[String(jsDay)] = clean;
      updated = true;
    } else {
      return interaction.editReply(`Format invalide pour **${day}**: "${value}". Utilisez HH:MM-HH:MM (ex: 09:00-19:00) ou "fermé".`);
    }
  }

  if (!updated) {
    // No options provided — show current schedule
    const lines = days.map((day) => {
      const jsDay = JOUR_MAP[day];
      const schedule = cfg.opening_hours[String(jsDay)];
      if (!schedule || schedule === 'fermé') return `**${day.charAt(0).toUpperCase() + day.slice(1)}** : Fermé`;
      return `**${day.charAt(0).toUpperCase() + day.slice(1)}** : ${schedule}`;
    });

    return interaction.editReply(`**Horaires de ${agency.name} :**\n${lines.join('\n')}\n\nPour modifier: \`/rdv horaires samedi:fermé dimanche:fermé lundi:09:00-19:00\``);
  }

  saveAgencies(agencies);

  const lines = days.map((day) => {
    const jsDay = JOUR_MAP[day];
    const schedule = cfg.opening_hours[String(jsDay)];
    if (!schedule || schedule === 'fermé') return `**${day.charAt(0).toUpperCase() + day.slice(1)}** : Fermé`;
    return `**${day.charAt(0).toUpperCase() + day.slice(1)}** : ${schedule}`;
  });

  await interaction.editReply(`**Horaires mis à jour pour ${agency.name} :**\n${lines.join('\n')}`);
}

module.exports = { data, execute };
