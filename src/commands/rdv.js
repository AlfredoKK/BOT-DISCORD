const { SlashCommandBuilder } = require('discord.js');
const calendar = require('../services/calendar');
const sheets = require('../services/sheets');
const { COL } = sheets;
const { isSlotAvailable, reserveSlot } = require('../services/capacity');
const { isWithinOpeningHours } = require('../services/opening-hours');
const { parseDateTime, formatDate, formatTime, getConfType } = require('../utils/date-utils');
const {
  buildManagedRdvDescription,
  getPrimaryStatusPrefix,
  parseManagedRdvEvent,
} = require('../utils/rdv-title');
const {
  DOM_RDV_BUFFER_MINUTES,
  DOM_RDV_TOTAL_MINUTES,
  requireAgency,
  getCalendarLink,
  timestamp,
  findSheetRowByEventId,
  buildEventTitle,
  isEventDomRdv,
  buildCanonicalManagedEventPayload,
  buildRdvEmbed,
  vehicleLabel,
} = require('../utils/rdv-helpers');
const { verifySheetTab, brokenSheetConfigMessage } = require('../services/agency-check');

// ── Slash command definition ──
// Commande ouverte aux prospecteurs : créer, modifier, annuler, confirmer un RDV.
// Les commandes d'administration sont dans /rdvadmin.

const data = new SlashCommandBuilder()
  .setName('rdv')
  .setDescription('Gestion des rendez-vous')
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
    sub.setName('supprimer').setDescription('Supprimer définitivement un rendez-vous')
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
  );

// ── Main execute ──

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  try {
    switch (sub) {
      case 'add': return await handleAdd(interaction);
      case 'dom': return await handleDom(interaction);
      case 'annuler': return await handleAnnuler(interaction);
      case 'vendu': return await handleVendu(interaction);
      case 'supprimer': return await handleSupprimer(interaction);
      case 'conf': return await handleConf(interaction);
      case 'modifier': return await handleModifier(interaction);
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

// ── Add ──

async function handleAdd(interaction) {
  await interaction.deferReply();
  const agency = requireAgency(interaction);
  if (!agency) return interaction.editReply('Ce canal n\'est lié à aucune agence. Un administrateur doit utiliser `/rdvadmin config` ici d\'abord.');

  if (agency.paused) {
    return interaction.editReply(`⏸️ L'agence **${agency.name}** est actuellement en pause. Aucun RDV ne peut être ajouté. Un administrateur doit utiliser \`/rdvadmin play\` ici pour reprendre.`);
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

  // Check Sheets config before touching Calendar, so a broken config never creates orphan events
  const sheetCheck = await verifySheetTab(agency.spreadsheet_id, agency.sheet_name);
  if (!sheetCheck.ok) {
    console.error(`[ADD] Sheets config invalide pour ${agency.name}: ${sheetCheck.reason}`);
    return interaction.editReply(brokenSheetConfigMessage(agency, sheetCheck));
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
    console.log(`[ADD] Sheet row prepared for event ${eventId} (${sheetRow.length} colonnes)`);
    const result = await sheets.appendRowVerified(agency.spreadsheet_id, sheetRow, agency.sheet_name, eventId);
    console.log(`[ADD] Sheet row appended and verified at row ${result.found.index + 1}`);
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
  if (!agency) return interaction.editReply('Ce canal n\'est lié à aucune agence. Un administrateur doit utiliser `/rdvadmin config` ici d\'abord.');

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

  const sheetCheck = await verifySheetTab(agency.spreadsheet_id, agency.sheet_name);
  if (!sheetCheck.ok) {
    console.error(`[DOM] Sheets config invalide pour ${agency.name}: ${sheetCheck.reason}`);
    return interaction.editReply(brokenSheetConfigMessage(agency, sheetCheck));
  }

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
  const sheetRow = [prospecteur, vehicule, nomClient.toUpperCase(), "'" + telephone, formatDate(rdvTime), formatTime(rdvTime), sheetConfType, 'PLANIFIÉ', eventId, timestamp(), ''];

  let sheetStatus = 'Synchronisé';
  try {
    const result = await sheets.appendRowVerified(agency.spreadsheet_id, sheetRow, agency.sheet_name, eventId);
    console.log(`[DOM] Sheet row appended and verified at row ${result.found.index + 1}`);
  } catch (sheetErr) {
    console.error(`[DOM] Sheet append FAILED:`, sheetErr.message);
    sheetStatus = `Erreur: ${sheetErr.message}`;
  }

  const calLink = getCalendarLink(eventId, agency.calendar_id);

  const embed = buildRdvEmbed('RDV DOM créé', 0x8E24AA, [
    { name: 'Date', value: formatDate(rdvTime) },
    { name: 'Heure RDV', value: formatTime(rdvTime) },
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
    { name: 'Véhicule', value: vehicleLabel(sheetRow, currentDetails) },
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
    { name: 'Véhicule', value: vehicleLabel(sheetRow, currentDetails) },
    { name: 'Statut', value: 'VENDU' },
    { name: 'ID Événement', value: `\`${eventId}\``, inline: false },
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
    { name: 'Véhicule', value: vehicleLabel(sheetRow, currentDetails) },
    { name: 'Statut', value: 'SUPPRIMÉ DÉFINITIVEMENT' },
    { name: 'ID Événement', value: `\`${eventId}\``, inline: false },
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
    { name: 'Véhicule', value: vehicleLabel(sheetRow, currentDetails) },
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

module.exports = { data, execute };
