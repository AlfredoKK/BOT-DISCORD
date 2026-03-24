const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { getEventsInRange, getEventColorMap, getCalendarDefaultColor } = require('../services/calendar');
const { generateAgendaImage } = require('../utils/agenda-image');
const { getWeekStartSunday, getWeekDaysSunday, formatDate } = require('../utils/date-utils');

const AGENCIES_PATH = path.join(__dirname, '../../data/agencies.json');

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
      return interaction.editReply('Ce canal n\'est lié à aucune agence. Utilisez `/rdv config` ici d\'abord.');
    }

    const semaine = interaction.options.getString('semaine') || 'S';

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

    const imageBuffer = generateAgendaImage(sunday, events, colorMap, calDefaultColor);
    const attachment = new AttachmentBuilder(imageBuffer, { name: 'agenda.png' });

    const weekLabel = semaine === 'S' ? 'cette semaine' : 'semaine prochaine';
    const dateRange = `${formatDate(sunday)} — ${formatDate(days[6])}`;

    await interaction.editReply({
      content: `**Agenda ${agency.name}** — ${weekLabel}\n${dateRange}\n${events.length} événement(s) | ${commercials.size} commercial(aux)`,
      files: [attachment],
    });
  } catch (err) {
    console.error('Error in /agenda:', err);
    const msg = `Erreur: ${err.message}`;
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: msg });
    }
    return interaction.reply({ content: msg, ephemeral: true });
  }
}

module.exports = { data, execute };
