const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fs = require('fs');
const { getEventsInRange, getEventColorMap, getCalendarDefaultColor } = require('../services/calendar');
const { generateAgendaImage } = require('../utils/agenda-image');
const { getWeekStartSunday, getWeekDaysSunday, formatDate } = require('../utils/date-utils');
const { buildAgendaFallbackContent, buildAgendaHeader } = require('../utils/agenda-summary');
const { enqueueNetworkOperation, retryNetworkOperation } = require('../utils/retry');

const { AGENCIES_PATH } = require('../config/paths');

function loadAgencies() {
  if (!fs.existsSync(AGENCIES_PATH)) return {};
  return JSON.parse(fs.readFileSync(AGENCIES_PATH, 'utf8'));
}

function getAgencyByChannel(channelId) {
  const agencies = loadAgencies();
  for (const [key, cfg] of Object.entries(agencies)) {
    if (cfg.channel_id === channelId) return { key, ...cfg };
  }
  return null;
}

async function safeEditReply(interaction, payload, label, timeoutMs = 3000) {
  let timeoutId;
  const editPromise = interaction.editReply(payload);
  editPromise.catch((err) => {
    console.error(`[AGENDA] Could not edit ${label}: ${err.message}`);
  });

  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(false), timeoutMs);
  });

  const edited = await Promise.race([
    editPromise.then(() => true, () => false),
    timeoutPromise,
  ]);

  clearTimeout(timeoutId);
  if (!edited) {
    console.warn(`[AGENDA] Timed out editing ${label} after ${timeoutMs}ms`);
  }
  return edited;
}

const data = new SlashCommandBuilder()
  .setName('agenda')
  .setDescription('Afficher l\'agenda hebdomadaire de cette agence')
  .addStringOption((opt) =>
    opt
      .setName('semaine')
      .setDescription('Semaine: S (courante) ou S+1 (prochaine)')
      .setRequired(false)
      .addChoices(
        { name: 'S (semaine courante)', value: 'S' },
        { name: 'S+1 (semaine prochaine)', value: 'S+1' }
      )
  );

async function execute(interaction) {
  await interaction.deferReply();

  try {
    const agency = getAgencyByChannel(interaction.channelId);
    if (!agency) {
      return interaction.editReply('Ce canal n\'est lié à aucune agence. Un administrateur doit utiliser `/rdvadmin config` ici d\'abord.');
    }

    const semaine = interaction.options.getString('semaine') || 'S';
    const channel = interaction.channel || await interaction.client.channels.fetch(interaction.channelId);

    await safeEditReply(interaction, { content: `Je prépare l'agenda ${agency.name}...` }, `/agenda status for ${agency.name}`);

    sendAgendaImage(interaction, channel, agency, semaine).catch((err) => {
      console.error(`[AGENDA] Background /agenda failed for ${agency.name} ${semaine}:`, err);
    });

    return null;
  } catch (err) {
    console.error('Error in /agenda:', err);
    const msg = `Erreur: ${err.message}`;
    if (interaction.deferred || interaction.replied) {
      try {
        return await interaction.editReply({ content: msg });
      } catch (replyErr) {
        console.error('Error sending /agenda failure reply:', replyErr);
        return null;
      }
    }
    return interaction.reply({ content: msg, ephemeral: true });
  }
}

async function sendAgendaImage(interaction, channel, agency, semaine) {
  try {
    const sunday = getWeekStartSunday(semaine);
    const days = getWeekDaysSunday(sunday);
    const weekEnd = new Date(days[6]);
    weekEnd.setHours(23, 59, 59, 999);

    // Fetch events and colors in parallel
    const [events, colorMap, calDefaultColor] = await Promise.all([
      getEventsInRange(agency.calendar_id, sunday, weekEnd),
      getEventColorMap(),
      getCalendarDefaultColor(agency.calendar_id),
    ]);

    const commercials = new Set();
    for (const event of events) {
      if (event.creator && event.creator.email) {
        commercials.add(event.creator.email);
      }
    }

    const imageBuffer = generateAgendaImage(sunday, events, colorMap, calDefaultColor, { scale: 0.6 });
    const weekLabel = semaine === 'S' ? 'cette semaine' : 'semaine prochaine';
    const dateRange = `${formatDate(sunday)} — ${formatDate(days[6])}`;
    const content = buildAgendaHeader(agency.name, weekLabel, dateRange, events, commercials);

    try {
      await retryNetworkOperation(
        () => {
          const attachment = new AttachmentBuilder(imageBuffer, { name: 'agenda.png' });
          return enqueueNetworkOperation(
            () => channel.send({
              content,
              files: [attachment],
            }),
            { priority: 'high', timeoutMs: 15_000 }
          );
        },
        {
          attempts: 2,
          baseDelayMs: 1500,
          label: `/agenda ${agency.name} ${semaine}`,
          onRetry: (sendErr, attempt, attempts, waitMs) => {
            console.log(`[AGENDA] Retry ${attempt}/${attempts - 1} for ${agency.name} ${semaine} after ${sendErr.message}; waiting ${waitMs}ms...`);
          },
        }
      );

      await safeEditReply(interaction, { content: `Agenda ${agency.name} envoyé ci-dessous.` }, `/agenda confirmation for ${agency.name}`);
    } catch (sendErr) {
      console.error(`[AGENDA] Channel image send failed for ${agency.name} ${semaine}, sending text fallback: ${sendErr.message}`);
      const fallbackContent = buildAgendaFallbackContent(agency.name, weekLabel, dateRange, events, commercials);
      await retryNetworkOperation(
        () => enqueueNetworkOperation(
          () => channel.send({ content: fallbackContent }),
          { priority: 'high' }
        ),
        {
          attempts: 3,
          baseDelayMs: 1000,
          label: `/agenda fallback ${agency.name} ${semaine}`,
          onRetry: (fallbackErr, attempt, attempts, waitMs) => {
            console.log(`[AGENDA] Retry fallback ${attempt}/${attempts - 1} for ${agency.name} ${semaine} after ${fallbackErr.message}; waiting ${waitMs}ms...`);
          },
        }
      );

      await safeEditReply(
        interaction,
        { content: `Agenda ${agency.name}: l'image n'a pas pu être envoyée, version texte envoyée ci-dessous.` },
        `/agenda fallback confirmation for ${agency.name}`
      );
    }
  } catch (err) {
    console.error('Error in /agenda:', err);
    const msg = `Erreur: ${err.message}`;
    if (interaction.deferred || interaction.replied) {
      try {
        return await interaction.editReply({ content: msg });
      } catch (replyErr) {
        console.error('Error sending /agenda failure reply:', replyErr);
        return null;
      }
    }
    await channel.send({ content: msg }).catch((replyErr) => {
      console.error(`[AGENDA] Could not send /agenda error to channel for ${agency.name}: ${replyErr.message}`);
    });
    await interaction.editReply({ content: msg }).catch((replyErr) => {
      console.error(`[AGENDA] Could not edit /agenda error for ${agency.name}: ${replyErr.message}`);
    });
  }
}

module.exports = { data, execute };
