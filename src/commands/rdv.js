const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { generateAuthUrl, exchangeCode, isAuthenticated } = require('../services/google-auth');
const calendar = require('../services/calendar');
const sheets = require('../services/sheets');
const { COL } = sheets;
const { isSlotAvailable, reserveSlot } = require('../services/capacity');
const { parseDateTime, formatDate, formatTime, getConfType } = require('../utils/date-utils');

const AGENCIES_PATH = path.join(__dirname, '../../data/agencies.json');

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
      case 'auth': return handleAuth(interaction);
      case 'callback': return handleCallback(interaction);
      case 'add': return handleAdd(interaction);
      case 'annuler': return handleAnnuler(interaction);
      case 'vendu': return handleVendu(interaction);
      case 'conf': return handleConf(interaction);
      case 'modifier': return handleModifier(interaction);
      case 'supprimer': return handleSupprimer(interaction);
      case 'status': return handleStatus(interaction);
      case 'config': return handleConfig(interaction);
      case 'deconfig': return handleDeconfig(interaction);
      case 'agences': return handleAgences(interaction);
      case 'calendars': return handleCalendars(interaction);
      case 'pause': return handlePause(interaction);
      case 'play': return handlePlay(interaction);
      case 'horaires': return handleHoraires(interaction);
      default: return interaction.reply({ content: 'Sous-commande inconnue.', ephemeral: true });
    }
  } catch (err) {
    console.error(`Error in /rdv ${sub}:`, err);
    const msg = `Erreur: ${err.message}`;
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: msg });
    }
    return interaction.reply({ content: msg, ephemeral: true });
  }
}

// ── Helpers ──

function findSheetRowByEventId(rows, eventId) {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][COL.EVENT_ID] === eventId) {
      return { index: i, row: rows[i] };
    }
  }
  return null;
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
  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;

  if (rdvMinutes < openMinutes || rdvMinutes >= closeMinutes) {
    return { open: false, reason: `L'agence **${agency.name}** est ouverte de ${openStr} à ${closeStr} le ${JOUR_NAMES[dayOfWeek]}.` };
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
  if (liens) parts.push(liens);
  if (commentaire) parts.push(commentaire.toUpperCase());
  return parts.join(' - ');
}

function buildRdvEmbed(title, color, fields) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setTimestamp();

  for (const f of fields) {
    if (f.value) {
      embed.addFields({ name: f.name, value: String(f.value), inline: f.inline !== false });
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
  const slot = await isSlotAvailable(agency.calendar_id, dateTime, agency.max_rdv_heure);
  if (!slot.available) {
    return interaction.editReply(`Créneau complet ! (${slot.count}/${slot.max} RDV sur ce créneau)`);
  }

  // Reserve slot to prevent race conditions with concurrent bookings
  const release = reserveSlot(agency.calendar_id, dateTime);

  let eventId = '';
  try {
    // Build title
    const eventTitle = buildEventTitle('RDV MANDAT', nomClient, telephone, marque, modele, annee, kilometrage, prix, liens, commentaire);

    // Create calendar event
    const eventRes = await calendar.createEvent(agency.calendar_id, {
      summary: eventTitle,
      description: liens || undefined,
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
  const confType = getConfType(dateTime);
  const prospecteur = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
  // Store normalized date/time (not raw input) so sheets always show DD/MM/YYYY and HH:MM
  const sheetRow = [prospecteur, vehicule, nomClient.toUpperCase(), "'" + telephone, formatDate(dateTime), formatTime(dateTime), confType, 'PLANIFIÉ', eventId, timestamp(), ''];

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

  if (confType) {
    embed.setFooter({ text: confType });
  }

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
    const oldTitle = eventData.summary || '';
    if (!oldTitle.startsWith('ANNULÉ')) {
      const cleaned = oldTitle.replace(/^RDV MANDAT - /, '');
      await calendar.updateEvent(agency.calendar_id, eventId, {
        summary: `ANNULÉ - ${cleaned}`,
        colorId: calendar.EVENT_COLORS.orange,
      });
    } else {
      await calendar.updateEvent(agency.calendar_id, eventId, {
        colorId: calendar.EVENT_COLORS.orange,
      });
    }
    console.log(`[ANNULER] Calendar event ${eventId} updated`);
  } catch (calErr) {
    console.error(`[ANNULER] Calendar failed:`, calErr.message);
    return interaction.editReply(`Erreur calendrier: ${calErr.message}`);
  }

  // Update sheet
  let sheetRow = null;
  try {
    const rows = await sheets.getAllRows(agency.spreadsheet_id, agency.sheet_name);
    const found = findSheetRowByEventId(rows, eventId);
    if (found) {
      sheetRow = found.row;
      found.row[COL.STATUT] = 'ANNULÉ';
      found.row[COL.UPDATED_AT] = timestamp();
      await sheets.updateRow(agency.spreadsheet_id, found.index, found.row, agency.sheet_name);
    }
  } catch (e) {
    console.error(`[ANNULER] Sheet failed:`, e.message);
  }

  // Parse event title for embed details
  const titleParts = (eventData.summary || '').split(' - ');
  const startDt = eventData.start?.dateTime ? new Date(eventData.start.dateTime) : null;

  const calLink = getCalendarLink(eventId, agency.calendar_id);
  const embed = buildRdvEmbed('RDV annulé', 0xDC3545, [
    { name: 'Date', value: startDt ? formatDate(startDt) : (sheetRow?.[COL.DATE] || '—') },
    { name: 'Heure', value: startDt ? formatTime(startDt) : (sheetRow?.[COL.HEURE] || '—') },
    { name: 'Agence', value: agency.name },
    { name: 'Client', value: sheetRow?.[COL.CLIENT] || titleParts[1] || '—' },
    { name: 'Téléphone', value: sheetRow?.[COL.TELEPHONE] || titleParts[2] || '—' },
    { name: 'Véhicule', value: sheetRow?.[COL.VEHICULE] || `${titleParts[3] || ''} ${titleParts[4] || ''} (${titleParts[5] || ''})`.trim() || '—' },
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
    const oldTitle = eventData.summary || '';
    if (!oldTitle.startsWith('VENDU')) {
      const cleaned = oldTitle.replace(/^RDV MANDAT - /, '').replace(/^ANNULÉ - /, '').replace(/^PAS VENU - /, '');
      await calendar.updateEvent(agency.calendar_id, eventId, {
        summary: `VENDU - ${cleaned}`,
        colorId: calendar.EVENT_COLORS.orange,
      });
    } else {
      await calendar.updateEvent(agency.calendar_id, eventId, {
        colorId: calendar.EVENT_COLORS.orange,
      });
    }
    console.log(`[VENDU] Calendar event ${eventId} updated`);
  } catch (calErr) {
    console.error(`[VENDU] Calendar failed:`, calErr.message);
    return interaction.editReply(`Erreur calendrier: ${calErr.message}`);
  }

  // Update sheet
  let sheetRow = null;
  try {
    const rows = await sheets.getAllRows(agency.spreadsheet_id, agency.sheet_name);
    const found = findSheetRowByEventId(rows, eventId);
    if (found) {
      sheetRow = found.row;
      found.row[COL.STATUT] = 'VENDU';
      found.row[COL.UPDATED_AT] = timestamp();
      await sheets.updateRow(agency.spreadsheet_id, found.index, found.row, agency.sheet_name);
    }
  } catch (e) {
    console.error(`[VENDU] Sheet failed:`, e.message);
  }

  // Parse event title for embed details
  const titleParts = (eventData.summary || '').split(' - ');
  const startDt = eventData.start?.dateTime ? new Date(eventData.start.dateTime) : null;

  const calLink = getCalendarLink(eventId, agency.calendar_id);
  const embed = buildRdvEmbed('RDV vendu', 0xFF9800, [
    { name: 'Date', value: startDt ? formatDate(startDt) : (sheetRow?.[COL.DATE] || '—') },
    { name: 'Heure', value: startDt ? formatTime(startDt) : (sheetRow?.[COL.HEURE] || '—') },
    { name: 'Agence', value: agency.name },
    { name: 'Client', value: sheetRow?.[COL.CLIENT] || titleParts[1] || '—' },
    { name: 'Téléphone', value: sheetRow?.[COL.TELEPHONE] || titleParts[2] || '—' },
    { name: 'Véhicule', value: sheetRow?.[COL.VEHICULE] || `${titleParts[3] || ''} ${titleParts[4] || ''} (${titleParts[5] || ''})`.trim() || '—' },
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
    const found = findSheetRowByEventId(rows, eventId);
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

  const titleParts = (eventData.summary || '').split(' - ');
  const startDt = eventData.start?.dateTime ? new Date(eventData.start.dateTime) : null;
  const calLink = getCalendarLink(eventId, agency.calendar_id);
  const isConf = confStatut === 'CONF';

  const embed = buildRdvEmbed(isConf ? 'RDV confirmé' : 'RDV non confirmé', isConf ? 0x0B8043 : 0xDC3545, [
    { name: 'Date', value: startDt ? formatDate(startDt) : (sheetRow?.[COL.DATE] || '—') },
    { name: 'Heure', value: startDt ? formatTime(startDt) : (sheetRow?.[COL.HEURE] || '—') },
    { name: 'Agence', value: agency.name },
    { name: 'Client', value: sheetRow?.[COL.CLIENT] || titleParts[1] || '—' },
    { name: 'Téléphone', value: sheetRow?.[COL.TELEPHONE] || titleParts[2] || '—' },
    { name: 'Véhicule', value: sheetRow?.[COL.VEHICULE] || '—' },
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

  // Parse current title — strip status prefixes first
  let workTitle = (currentEvent.summary || '');
  // Remove status prefixes: "ANNULÉ - RDV MANDAT - ..." → "RDV MANDAT - ..."
  // Also handle: "PAS VENU - RDV MANDAT - ...", "VENDU - RDV MANDAT - ..."
  for (const statusPrefix of ['ANNULÉ - ', 'PAS VENU - ', 'VENDU - ']) {
    if (workTitle.toUpperCase().startsWith(statusPrefix)) {
      workTitle = workTitle.substring(statusPrefix.length);
      break;
    }
  }
  // Now also remove "RDV MANDAT - " prefix to get to the data parts
  const titleParts = workTitle.split(' - ');
  let prefix = 'RDV MANDAT'; // Always reset to RDV MANDAT on modifier (rebook)
  let dataStart = 0;
  if (titleParts[0] && titleParts[0].toUpperCase().includes('RDV MANDAT')) {
    dataStart = 1; // skip "RDV MANDAT" prefix
  }
  let curNom = titleParts[dataStart] || '';
  let curTel = titleParts[dataStart + 1] || '';
  let curMarque = titleParts[dataStart + 2] || '';
  let curModele = titleParts[dataStart + 3] || '';
  let curAnnee = titleParts[dataStart + 4] || '';
  let curKm = (titleParts[dataStart + 5] || '').replace(' KM', '');
  let curPrix = (titleParts[dataStart + 6] || '').replace('€', '');
  let curLiens = titleParts[dataStart + 7] || '';
  let curCommentaire = titleParts[dataStart + 8] || '';

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
  const currentStart = new Date(currentEvent.start.dateTime);
  const nouvelleDateStr = interaction.options.getString('nouvelle_date');
  const nouvelleHeureStr = interaction.options.getString('nouvelle_heure');

  let newDateTime, newEndTime, newDateStr, newHeureStr;
  if (nouvelleDateStr || nouvelleHeureStr) {
    // Date/time is changing — parse and validate (including past-date check)
    newDateStr = nouvelleDateStr || formatDate(currentStart);
    newHeureStr = nouvelleHeureStr || formatTime(currentStart);
    newDateTime = parseDateTime(newDateStr, newHeureStr);
    newEndTime = new Date(newDateTime.getTime() + 60 * 60000);

    // Check opening hours
    const hoursCheck = isWithinOpeningHours(agency, newDateTime);
    if (!hoursCheck.open) {
      return interaction.editReply(`🚫 ${hoursCheck.reason}`);
    }
  } else {
    // No date/time change — keep existing (even if in the past, for field-only edits)
    newDateTime = currentStart;
    newEndTime = new Date(currentStart.getTime() + 60 * 60000);
    newDateStr = formatDate(currentStart);
    newHeureStr = formatTime(currentStart);
  }

  // Check capacity if date/time changed
  if (nouvelleDateStr || nouvelleHeureStr) {
    const slot = await isSlotAvailable(agency.calendar_id, newDateTime, agency.max_rdv_heure);
    if (!slot.available) {
      return interaction.editReply(`Créneau complet pour le ${newDateStr} à ${newHeureStr} ! (${slot.count}/${slot.max})`);
    }
  }

  const newTitle = buildEventTitle(prefix, newNom, newTel, newMarque, newModele, newAnnee, newKm, newPrix, newLiens, newCommentaire);

  try {
    await calendar.updateEvent(agency.calendar_id, eventId, {
      summary: newTitle,
      description: newLiens || undefined,
      colorId: calendar.EVENT_COLORS.green,
      start: { dateTime: newDateTime.toISOString(), timeZone: 'Europe/Paris' },
      end: { dateTime: newEndTime.toISOString(), timeZone: 'Europe/Paris' },
    });
    console.log(`[MODIFIER] Calendar event ${eventId} updated`);
  } catch (calErr) {
    console.error(`[MODIFIER] Calendar update failed:`, calErr.message);
    throw calErr;
  }

  // Update sheet
  try {
    const rows = await sheets.getAllRows(agency.spreadsheet_id, agency.sheet_name);
    const found = findSheetRowByEventId(rows, eventId);
    if (found) {
      found.row[COL.CLIENT] = newNom;
      found.row[COL.TELEPHONE] = "'" + newTel;
      found.row[COL.VEHICULE] = newModele;
      found.row[COL.DATE] = newDateStr;
      found.row[COL.HEURE] = newHeureStr;
      found.row[COL.STATUT] = 'PLANIFIÉ';
      found.row[COL.CONFIRMATION] = getConfType(newDateTime);
      found.row[COL.UPDATED_AT] = timestamp();
      await sheets.updateRow(agency.spreadsheet_id, found.index, found.row, agency.sheet_name);
      console.log(`[MODIFIER] Sheet row ${found.index} updated`);
    }
  } catch (sheetErr) {
    console.error(`[MODIFIER] Sheet update failed:`, sheetErr.message);
  }

  const calLink = getCalendarLink(eventId, agency.calendar_id);
  const embed = buildRdvEmbed('RDV modifié', 0x2196F3, [
    { name: 'Date', value: newDateStr },
    { name: 'Heure', value: newHeureStr },
    { name: 'Agence', value: agency.name },
    { name: 'Client', value: newNom },
    { name: 'Téléphone', value: newTel },
    { name: 'Véhicule', value: `${newMarque} ${newModele} (${newAnnee})` },
    { name: 'Kilométrage', value: `${newKm} KM` },
    { name: 'Prix', value: `${newPrix}€` },
    { name: 'ID Événement', value: `\`${eventId}\``, inline: false },
    { name: 'Lien', value: newLiens || 'Aucun', inline: false },
    { name: 'Notes', value: newCommentaire || 'Aucune', inline: false },
    { name: 'Voir sur Calendar', value: `[Ouvrir](${calLink})`, inline: false },
  ]);

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
    const found = findSheetRowByEventId(rows, eventId);
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
    const found = findSheetRowByEventId(rows, eventId);
    if (found) {
      await sheets.deleteRow(agency.spreadsheet_id, found.index, agency.sheet_name);
      console.log(`[SUPPRIMER] Sheet row ${found.index} deleted`);
    }
  } catch (sheetErr) {
    console.error(`[SUPPRIMER] Sheet delete failed:`, sheetErr.message);
  }

  const titleParts = (eventData?.summary || '').split(' - ');
  const startDt = eventData?.start?.dateTime ? new Date(eventData.start.dateTime) : null;

  const embed = buildRdvEmbed('RDV supprimé', 0x6C757D, [
    { name: 'Date', value: startDt ? formatDate(startDt) : (sheetRow?.[COL.DATE] || '—') },
    { name: 'Heure', value: startDt ? formatTime(startDt) : (sheetRow?.[COL.HEURE] || '—') },
    { name: 'Agence', value: agency.name },
    { name: 'Client', value: sheetRow?.[COL.CLIENT] || titleParts[1] || '—' },
    { name: 'Téléphone', value: sheetRow?.[COL.TELEPHONE] || titleParts[2] || '—' },
    { name: 'Véhicule', value: sheetRow?.[COL.VEHICULE] || '—' },
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

async function handlePause(interaction) {
  // Admin only — prospecteurs must NOT be able to pause agencies
  if (!interaction.member.permissions.has('ManageGuild') && !interaction.member.permissions.has('Administrator')) {
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
  if (!interaction.member.permissions.has('ManageGuild') && !interaction.member.permissions.has('Administrator')) {
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
