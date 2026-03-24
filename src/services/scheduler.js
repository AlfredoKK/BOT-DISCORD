const fs = require('fs');
const path = require('path');
const { AttachmentBuilder } = require('discord.js');
const { getEventsInRange, getEventColorMap, getCalendarDefaultColor } = require('./calendar');
const { generateAgendaImage } = require('../utils/agenda-image');
const { getWeekStartSunday, getWeekDaysSunday, formatDate } = require('../utils/date-utils');

const AGENCIES_PATH = path.join(__dirname, '../../data/agencies.json');

// Send times in Europe/Paris: 08:00, 12:00, 15:00, 18:00, 21:00
const SEND_HOURS = [8, 12, 15, 18, 21];

function loadAgencies() {
  if (!fs.existsSync(AGENCIES_PATH)) return {};
  return JSON.parse(fs.readFileSync(AGENCIES_PATH, 'utf8'));
}

/**
 * Get current hour in Europe/Paris timezone
 */
function getParisTime() {
  const now = new Date();
  const parisStr = now.toLocaleString('en-US', { timeZone: 'Europe/Paris' });
  const paris = new Date(parisStr);
  return { hours: paris.getHours(), minutes: paris.getMinutes() };
}

/**
 * Send agenda images (S & S+1) for a single agency to its channel
 */
async function sendAgendaForAgency(client, agencyKey, agency, sharedColorMap) {
  if (!agency.channel_id) {
    console.log(`[Scheduler] Agence ${agency.name}: pas de channel_id configuré, skip.`);
    return;
  }

  let channel;
  try {
    channel = await client.channels.fetch(agency.channel_id);
  } catch (err) {
    // Missing Access = bot can't see the channel. Only log once per agency to avoid spam.
    if (!sendAgendaForAgency._warned) sendAgendaForAgency._warned = new Set();
    if (!sendAgendaForAgency._warned.has(agency.name)) {
      console.error(`[Scheduler] ${agency.name}: impossible d'accéder au canal ${agency.channel_id} (${err.message}). Le bot a besoin de la permission "View Channel" + "Send Messages" + "Attach Files" dans ce canal.`);
      sendAgendaForAgency._warned.add(agency.name);
    }
    return;
  }
  if (!channel) return;

  // Check bot permissions in this channel
  const perms = channel.permissionsFor?.(client.user);
  if (perms) {
    const missing = [];
    if (!perms.has('ViewChannel')) missing.push('View Channel');
    if (!perms.has('SendMessages')) missing.push('Send Messages');
    if (!perms.has('AttachFiles')) missing.push('Attach Files');
    if (missing.length > 0) {
      console.error(`[Scheduler] ${agency.name}: permissions manquantes dans <#${agency.channel_id}>: ${missing.join(', ')}`);
      return;
    }
  }

  for (const semaine of ['S', 'S+1']) {
    try {
      const sunday = getWeekStartSunday(semaine);
      const days = getWeekDaysSunday(sunday);
      const weekEnd = new Date(days[6]);
      weekEnd.setHours(23, 59, 59, 999);

      const [events, calDefaultColor] = await Promise.all([
        getEventsInRange(agency.calendar_id, sunday, weekEnd),
        getCalendarDefaultColor(agency.calendar_id),
      ]);
      const colorMap = sharedColorMap || await getEventColorMap();

      const commercials = new Set();
      for (const event of events) {
        if (event.creator && event.creator.email) {
          commercials.add(event.creator.email);
        }
      }

      const imageBuffer = generateAgendaImage(sunday, events, colorMap, calDefaultColor);
      const attachment = new AttachmentBuilder(imageBuffer, {
        name: `agenda_${agencyKey}_${semaine.replace('+', 'plus')}.png`,
      });

      const weekLabel = semaine === 'S' ? 'cette semaine' : 'semaine prochaine';
      const dateRange = `${formatDate(sunday)} — ${formatDate(days[6])}`;

      // Retry Discord send up to 2 times on timeout/abort
      let sent = false;
      for (let attempt = 0; attempt < 2 && !sent; attempt++) {
        try {
          await channel.send({
            content: `**Agenda ${agency.name}** — ${weekLabel}\n${dateRange}\n${events.length} événement(s) | ${commercials.size} commercial(aux)`,
            files: [attachment],
          });
          sent = true;
        } catch (sendErr) {
          if (attempt === 0 && (sendErr.name === 'AbortError' || sendErr.code === 'UND_ERR_CONNECT_TIMEOUT')) {
            console.log(`[Scheduler] Retry send for ${agency.name} ${semaine} after timeout...`);
            await delay(3000);
          } else {
            throw sendErr;
          }
        }
      }

      console.log(`[Scheduler] Agenda ${semaine} envoyé pour ${agency.name}`);
    } catch (err) {
      console.error(`[Scheduler] Erreur envoi agenda ${semaine} pour ${agency.name}:`, err.message);
    }
    // Pause between S and S+1 to avoid network saturation
    await delay(1500);
  }
}

/**
 * Small delay helper to avoid overwhelming Google/Discord APIs
 */
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Check if it's time to send and send for all agencies
 */
async function checkAndSend(client) {
  const { hours, minutes } = getParisTime();

  // Only trigger at :00 (first minute of the target hour)
  if (minutes !== 0 || !SEND_HOURS.includes(hours)) return;

  console.log(`[Scheduler] Envoi automatique déclenché à ${hours}:00 (Paris)`);

  const agencies = loadAgencies();
  const entries = Object.entries(agencies).filter(([, a]) => !a.paused); // skip paused agencies

  // Pre-fetch color map once (same for all agencies)
  let sharedColorMap = null;
  try {
    sharedColorMap = await getEventColorMap();
  } catch (e) {
    console.error('[Scheduler] Could not fetch color map:', e.message);
  }

  console.log(`[Scheduler] ${entries.length} agences actives à envoyer`);
  for (const [key, agency] of entries) {
    await sendAgendaForAgency(client, key, agency, sharedColorMap);
    // 5 second pause between agencies to avoid saturating network and blocking user commands
    await delay(5000);
  }
  console.log(`[Scheduler] Envoi terminé pour toutes les agences`);
}

let schedulerInterval = null;

/**
 * Start the scheduler — checks every 60 seconds
 */
function startScheduler(client) {
  if (schedulerInterval) return;

  console.log('[Scheduler] Démarré — envoi auto à', SEND_HOURS.map((h) => `${h}:00`).join(', '), '(Europe/Paris)');

  // Check every 60 seconds
  schedulerInterval = setInterval(() => {
    checkAndSend(client).catch((err) => {
      console.error('[Scheduler] Erreur:', err.message);
    });
  }, 60 * 1000);

  // Also check immediately on startup
  checkAndSend(client).catch((err) => {
    console.error('[Scheduler] Erreur au démarrage:', err.message);
  });
}

function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[Scheduler] Arrêté');
  }
}

module.exports = { startScheduler, stopScheduler, sendAgendaForAgency };
