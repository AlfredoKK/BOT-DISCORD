const fs = require('fs');
const { AttachmentBuilder } = require('discord.js');
const { getEventsInRange, getEventColorMap, getCalendarDefaultColor } = require('./calendar');
const { generateAgendaImage } = require('../utils/agenda-image');
const { getWeekStartSunday, getWeekDaysSunday, formatDate } = require('../utils/date-utils');
const { buildAgendaFallbackContent, buildAgendaHeader } = require('../utils/agenda-summary');
const { archiveScreenshot, isDriveArchiveConfigured } = require('./drive-archiver');
const { delay, enqueueNetworkOperation, retryNetworkOperation } = require('../utils/retry');

const { AGENCIES_PATH } = require('../config/paths');

// Send times in Europe/Paris: 08:00, 12:00, 15:00, 18:00, 21:00
const SEND_HOURS = [8, 12, 15, 18, 21];

// Seuil d'alerte « agendas-en-échec » sur un passage : au moins N agences OU au moins X % des agences
const FAILED_AGENCIES_ALERT_MIN = 3;
const FAILED_AGENCIES_ALERT_RATIO = 0.3;

let lastRunAt = null;   // dernier passage d'envoi effectif (heure d'envoi atteinte)
let lastCheckAt = null; // dernier tick du scheduler (toutes les 60 s)

// Alerte d'incident sans jamais bloquer le scheduler (require paresseux : alerts -> google-auth uniquement, pas de cycle,
// mais on garde le même style que calendar.js/sheets.js).
function alert(kind, error, context, client) {
  try {
    const { reportIncident } = require('./alerts');
    reportIncident({ kind, error, context, client }).catch(() => {});
  } catch {
    // ignore
  }
}

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
 * Send agenda images (S & S+1) for a single agency to its channel.
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function sendAgendaForAgency(client, agencyKey, agency, sharedColorMap, options = {}) {
  if (!agency.channel_id) {
    console.log(`[Scheduler] Agence ${agency.name}: pas de channel_id configuré, skip.`);
    return { ok: false, error: 'pas de channel_id configuré' };
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
    return { ok: false, error: `canal ${agency.channel_id} inaccessible (${err.message})` };
  }
  if (!channel) return { ok: false, error: `canal ${agency.channel_id} introuvable` };

  // Check bot permissions in this channel
  const perms = channel.permissionsFor?.(client.user);
  if (perms) {
    const missing = [];
    if (!perms.has('ViewChannel')) missing.push('View Channel');
    if (!perms.has('SendMessages')) missing.push('Send Messages');
    if (!perms.has('AttachFiles')) missing.push('Attach Files');
    if (missing.length > 0) {
      console.error(`[Scheduler] ${agency.name}: permissions manquantes dans <#${agency.channel_id}>: ${missing.join(', ')}`);
      return { ok: false, error: `permissions manquantes: ${missing.join(', ')}` };
    }
  }

  let firstError = null;

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
      const fileName = `agenda_${agencyKey}_${semaine.replace('+', 'plus')}.png`;

      const weekLabel = semaine === 'S' ? 'cette semaine' : 'semaine prochaine';
      const dateRange = `${formatDate(sunday)} — ${formatDate(days[6])}`;
      const content = buildAgendaHeader(agency.name, weekLabel, dateRange, events, commercials);

      try {
        await retryNetworkOperation(
          () => {
            const attachment = new AttachmentBuilder(imageBuffer, { name: fileName });
            return enqueueNetworkOperation(
              () => channel.send({
                content,
                files: [attachment],
              }),
              { priority: 'normal' }
            );
          },
          {
            attempts: 2,
            baseDelayMs: 2000,
            label: `${agency.name} ${semaine}`,
            onRetry: (sendErr, attempt, attempts, waitMs) => {
              console.log(`[Scheduler] Retry ${attempt}/${attempts - 1} for ${agency.name} ${semaine} after ${sendErr.message}; waiting ${waitMs}ms...`);
            },
          }
        );

        console.log(`[Scheduler] Agenda ${semaine} envoyé pour ${agency.name}`);
        if (options.archiveEvening && semaine === 'S' && imageBuffer.length > 0 && isDriveArchiveConfigured()) {
          try {
            const driveFileId = await archiveScreenshot(imageBuffer, channel.name || agency.name);
            if (driveFileId) {
              console.log(`[Drive] Agenda soir archivé pour ${agency.name}: ${driveFileId}`);
            }
          } catch (archiveErr) {
            console.error(`[Drive] Échec archivage ${agency.name}: ${archiveErr.message}`);
          }
        }
      } catch (sendErr) {
        console.error(`[Scheduler] Image agenda ${semaine} failed for ${agency.name}, sending text fallback: ${sendErr.message}`);
        const fallbackContent = buildAgendaFallbackContent(agency.name, weekLabel, dateRange, events, commercials);

        await retryNetworkOperation(
          () => enqueueNetworkOperation(
            () => channel.send({ content: fallbackContent }),
            { priority: 'normal' }
          ),
          {
            attempts: 2,
            baseDelayMs: 1000,
            label: `${agency.name} ${semaine} fallback`,
            onRetry: (fallbackErr, attempt, attempts, waitMs) => {
              console.log(`[Scheduler] Retry fallback ${attempt}/${attempts - 1} for ${agency.name} ${semaine} after ${fallbackErr.message}; waiting ${waitMs}ms...`);
            },
          }
        );

        console.log(`[Scheduler] Agenda ${semaine} fallback texte envoyé pour ${agency.name}`);
      }
    } catch (err) {
      console.error(`[Scheduler] Erreur envoi agenda ${semaine} pour ${agency.name}: ${err.message} (${err.name || 'Error'}${err.code ? `/${err.code}` : ''})`);
      if (!firstError) firstError = `${semaine}: ${err.message}`;
    }
    // Pause between S and S+1 to avoid network saturation
    await delay(1500);
  }

  return firstError ? { ok: false, error: firstError } : { ok: true };
}

/**
 * Check if it's time to send and send for all agencies
 */
async function checkAndSend(client) {
  const { hours, minutes } = getParisTime();
  lastCheckAt = new Date();

  // Only trigger at :00 (first minute of the target hour)
  if (minutes !== 0 || !SEND_HOURS.includes(hours)) return;

  lastRunAt = new Date();
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
  const failures = [];
  for (const [key, agency] of entries) {
    let result;
    try {
      result = await sendAgendaForAgency(client, key, agency, sharedColorMap, { archiveEvening: hours === 21 });
    } catch (err) {
      result = { ok: false, error: err.message || String(err) };
    }
    if (!result || !result.ok) {
      failures.push({ name: agency.name || key, error: result?.error || 'erreur inconnue' });
    }
    // 5 second pause between agencies to avoid saturating network and blocking user commands
    await delay(5000);
  }
  console.log(`[Scheduler] Envoi terminé pour toutes les agences (${failures.length} échec(s) sur ${entries.length})`);

  if (shouldAlertForFailures(failures.length, entries.length)) {
    const list = failures.map((f) => `- ${f.name} : ${f.error}`).join('\n');
    alert(
      'agendas-en-échec',
      new Error(`${failures.length} agence(s) sur ${entries.length} en échec lors de l'envoi de ${hours}:00`),
      { heureEnvoi: `${hours}:00 (Paris)`, agencesEnEchec: list },
      client
    );
  }
}

function shouldAlertForFailures(failedCount, totalCount) {
  if (failedCount === 0 || totalCount === 0) return false;
  return failedCount >= FAILED_AGENCIES_ALERT_MIN || failedCount / totalCount >= FAILED_AGENCIES_ALERT_RATIO;
}

function getLastRunAt() {
  return lastRunAt;
}

function getLastCheckAt() {
  return lastCheckAt;
}

let schedulerInterval = null;
let schedulerRunning = false;

/**
 * Start the scheduler — checks every 60 seconds
 */
function startScheduler(client) {
  if (schedulerInterval) return;

  console.log('[Scheduler] Démarré — envoi auto à', SEND_HOURS.map((h) => `${h}:00`).join(', '), '(Europe/Paris)');

  // Check every 60 seconds
  schedulerInterval = setInterval(() => {
    if (schedulerRunning) {
      console.log('[Scheduler] Envoi précédent encore en cours, skip.');
      return;
    }
    schedulerRunning = true;
    checkAndSend(client).catch((err) => {
      console.error('[Scheduler] Erreur:', err.message);
      alert('scheduler', err, { phase: 'tick' }, client);
    }).finally(() => {
      schedulerRunning = false;
    });
  }, 60 * 1000);

  // Also check immediately on startup
  schedulerRunning = true;
  checkAndSend(client).catch((err) => {
    console.error('[Scheduler] Erreur au démarrage:', err.message);
    alert('scheduler', err, { phase: 'démarrage' }, client);
  }).finally(() => {
    schedulerRunning = false;
  });
}

function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[Scheduler] Arrêté');
  }
}

module.exports = {
  startScheduler,
  stopScheduler,
  sendAgendaForAgency,
  getLastRunAt,
  getLastCheckAt,
  shouldAlertForFailures,
};
