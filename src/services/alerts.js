const { google } = require('googleapis');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { getOAuth2Client, isAuthenticated } = require('./google-auth');
const { getRecentLogs, formatParisTimestamp } = require('./log-buffer');

// Système d'alerte d'incident : quand quelque chose casse, un rapport de bug
// complet part par e-mail (API Gmail du compte du bot) et dans un canal Discord,
// prêt à être transmis tel quel à un développeur.

const DEFAULT_EMAIL = 'contact@licall.fr';
const DEFAULT_COOLDOWN_MINUTES = 15;
const SIGNATURE_MESSAGE_LENGTH = 120;
const SUBJECT_MESSAGE_LENGTH = 80;

const GOOGLE_AUTH_PATTERNS = [/invalid_grant/i, /Token has been expired or revoked/i];
const GOOGLE_AUTH_ADVICE =
  'Le token Google est expiré ou révoqué : relancer /rdvadmin auth puis /rdvadmin callback avec le compte contact@licall.fr.';
const GMAIL_SCOPE_WARNING =
  'Alerte e-mail impossible : le token Google n\'a pas la permission gmail.send. ' +
  'Relancer /rdvadmin auth puis /rdvadmin callback avec le compte contact@licall.fr.';

// signature -> timestamp (ms) du dernier envoi
const lastSentBySignature = new Map();
let gmailScopeWarningLogged = false;
let defaultClient = null;

// ── Configuration ──

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['false', '0', 'non', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function getConfig() {
  const cooldownRaw = Number(process.env.ALERT_COOLDOWN_MINUTES);
  return {
    enabled: parseBool(process.env.ALERTS_ENABLED, true),
    emailFrom: (process.env.ALERT_EMAIL_FROM || DEFAULT_EMAIL).trim(),
    emailTo: String(process.env.ALERT_EMAIL_TO || DEFAULT_EMAIL)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    channelId: (process.env.ALERT_CHANNEL_ID || '').trim(),
    cooldownMinutes: Number.isFinite(cooldownRaw) && cooldownRaw >= 0 ? cooldownRaw : DEFAULT_COOLDOWN_MINUTES,
  };
}

/** Client Discord par défaut utilisé quand l'appelant n'en fournit pas (ex: calendar.js). */
function setAlertClient(client) {
  defaultClient = client || null;
}

// ── Normalisation de l'erreur et du contexte ──

function normalizeError(error) {
  if (error instanceof Error) {
    return {
      message: error.message || String(error),
      stack: error.stack || '',
      name: error.name || 'Error',
      code: error.code,
      status: error.status || error.response?.status,
      details: error.response?.data,
    };
  }
  if (error && typeof error === 'object') {
    let message;
    try {
      message = error.message || JSON.stringify(error);
    } catch {
      message = String(error);
    }
    return { message: String(message), stack: error.stack || '', name: error.name || 'Objet', code: error.code };
  }
  return { message: error === undefined || error === null ? 'Erreur inconnue' : String(error), stack: '', name: 'Erreur' };
}

const CONTEXT_LABELS = {
  commande: 'Commande',
  sousCommande: 'Sous-commande',
  utilisateur: 'Utilisateur',
  channelId: 'Canal (id)',
  guildId: 'Serveur (id)',
  agence: 'Agence',
};

function formatContextValue(value) {
  if (value === undefined || value === null || value === '') return '(vide)';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatContext(context = {}) {
  const lines = [];
  const seen = new Set();
  for (const [key, label] of Object.entries(CONTEXT_LABELS)) {
    if (key in context) {
      lines.push(`- ${label} : ${formatContextValue(context[key])}`);
      seen.add(key);
    }
  }
  for (const [key, value] of Object.entries(context)) {
    if (seen.has(key)) continue;
    const formatted = formatContextValue(value);
    if (formatted.includes('\n')) {
      lines.push(`- ${key} :\n${formatted.split('\n').map((l) => `    ${l}`).join('\n')}`);
    } else {
      lines.push(`- ${key} : ${formatted}`);
    }
  }
  return lines.length ? lines.join('\n') : '(aucun)';
}

function formatUptime(seconds) {
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}j`);
  if (d || h) parts.push(`${h}h`);
  parts.push(`${m}m`, `${sec}s`);
  return `${parts.join(' ')} (${s}s)`;
}

function isGoogleAuthError(message) {
  return GOOGLE_AUTH_PATTERNS.some((re) => re.test(String(message || '')));
}

function truncate(text, max) {
  const str = String(text || '').replace(/\s+/g, ' ').trim();
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

// ── Rapport ──

/**
 * Construit le rapport d'incident.
 * @returns {{ title: string, text: string, signature: string, kind: string, message: string, context: object, googleAuthAdvice: boolean }}
 */
function buildIncidentReport({ kind = 'inconnu', error, context = {} } = {}) {
  const err = normalizeError(error);
  const now = new Date();
  const commit = process.env.RAILWAY_GIT_COMMIT_SHA || 'inconnu';
  const googleAuthAdvice = isGoogleAuthError(err.message) || isGoogleAuthError(err.stack);
  const logs = getRecentLogs();

  const title = `[BOT RDV] Incident : ${kind} — ${truncate(err.message, SUBJECT_MESSAGE_LENGTH)}`;

  const sections = [
    '=== RAPPORT D\'INCIDENT — BOT RDV DISCORD ===',
    '',
    `Date/heure (Paris) : ${formatParisTimestamp(now)}`,
    `Type d'incident    : ${kind}`,
    `Message d'erreur   : ${err.message}`,
    err.name ? `Nom de l'erreur    : ${err.name}` : null,
    err.code !== undefined ? `Code               : ${err.code}` : null,
    err.status !== undefined ? `Statut HTTP        : ${err.status}` : null,
    googleAuthAdvice ? `\nCONSEIL : ${GOOGLE_AUTH_ADVICE}` : null,
    '',
    '--- Pile d\'exécution ---',
    err.stack || '(aucune pile disponible)',
    '',
    '--- Contexte ---',
    formatContext(context),
  ];

  if (err.details !== undefined) {
    sections.push('', '--- Détails de la réponse (API) ---', formatContextValue(err.details));
  }

  sections.push(
    '',
    '--- Environnement ---',
    `Commit déployé : ${commit}`,
    `Uptime         : ${formatUptime(process.uptime())}`,
    `Version Node   : ${process.version}`,
    `Plateforme     : ${process.platform} ${process.arch}`,
    `Mémoire (RSS)  : ${Math.round(process.memoryUsage().rss / 1024 / 1024)} Mo`,
    '',
    `--- ${logs.length} dernière(s) ligne(s) de log ---`,
    logs.length ? logs.join('\n') : '(aucun log en mémoire)',
    '',
    '=== Pour corriger : transmettre ce rapport tel quel au développeur / à Claude ===',
  );

  const text = sections.filter((s) => s !== null).join('\n');
  const signature = `${kind}:${String(err.message || '').slice(0, SIGNATURE_MESSAGE_LENGTH)}`;

  return { title, text, signature, kind, message: err.message, context, googleAuthAdvice };
}

// ── Envoi Discord ──

function safeFileName(kind) {
  return String(kind).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase() || 'incident';
}

async function sendDiscordAlert(client, report, config) {
  if (!config.channelId) return { ok: false, error: 'ALERT_CHANNEL_ID non défini' };
  if (!client) return { ok: false, error: 'client Discord indisponible' };

  const channel = await client.channels.fetch(config.channelId);
  if (!channel || typeof channel.send !== 'function') {
    return { ok: false, error: `canal ${config.channelId} introuvable ou non textuel` };
  }

  const ctx = report.context || {};
  const commandLabel = ctx.commande
    ? `/${ctx.commande}${ctx.sousCommande ? ` ${ctx.sousCommande}` : ''}`
    : '—';

  const embed = new EmbedBuilder()
    .setTitle(`🚨 Incident : ${truncate(report.kind, 200)}`)
    .setColor(0xDC3545)
    .setDescription(truncate(report.message, 1000) || '(sans message)')
    .addFields(
      { name: 'Type', value: truncate(report.kind, 100), inline: true },
      { name: 'Commande', value: truncate(commandLabel, 100), inline: true },
      { name: 'Agence', value: truncate(ctx.agence || '—', 100), inline: true },
      { name: 'Commit', value: truncate(process.env.RAILWAY_GIT_COMMIT_SHA || 'inconnu', 40), inline: true },
      { name: 'Utilisateur', value: truncate(ctx.utilisateur || '—', 100), inline: true },
    )
    .setFooter({ text: 'Rapport complet en pièce jointe — à transmettre tel quel au développeur' })
    .setTimestamp();

  if (report.googleAuthAdvice) {
    embed.addFields({ name: 'Conseil', value: truncate(GOOGLE_AUTH_ADVICE, 1000), inline: false });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const attachment = new AttachmentBuilder(Buffer.from(report.text, 'utf8'), {
    name: `incident-${safeFileName(report.kind)}-${stamp}.txt`,
  });

  await channel.send({
    embeds: [embed],
    files: [attachment],
    allowedMentions: { parse: [] },
  });
  return { ok: true };
}

// ── Envoi e-mail (API Gmail) ──

function encodeHeaderUtf8(value) {
  // RFC 2047 : encode les caractères non ASCII dans les en-têtes
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function buildRawEmail({ from, to, subject, text }) {
  const body = Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const message = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeHeaderUtf8(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
  return Buffer.from(message, 'utf8').toString('base64url');
}

function isScopeError(err) {
  const message = String(err?.message || '');
  const status = err?.code || err?.status || err?.response?.status;
  const reason = JSON.stringify(err?.response?.data || err?.errors || '');
  return (
    status === 403 ||
    /insufficient/i.test(message) ||
    /ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(message) ||
    /insufficient|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(reason)
  );
}

async function sendEmailAlert(report, config) {
  if (!config.emailTo.length) return { ok: false, error: 'ALERT_EMAIL_TO vide' };
  if (!isAuthenticated()) return { ok: false, error: 'Google non authentifié (lancer /rdvadmin auth)' };

  try {
    const gmail = google.gmail({ version: 'v1', auth: getOAuth2Client() });
    const raw = buildRawEmail({
      from: config.emailFrom,
      to: config.emailTo,
      subject: report.title,
      text: report.text,
    });
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    return { ok: true };
  } catch (err) {
    if (isScopeError(err)) {
      if (!gmailScopeWarningLogged) {
        gmailScopeWarningLogged = true;
        console.warn(`[ALERT] ${GMAIL_SCOPE_WARNING}`);
      }
      return { ok: false, error: `permission gmail.send manquante (${err.message})`, scopeMissing: true };
    }
    return { ok: false, error: err.message || String(err) };
  }
}

// ── Point d'entrée ──

/**
 * Signale un incident : log console, e-mail et Discord (chaque canal isolé,
 * ne lève jamais d'exception). Une même signature n'est renvoyée qu'après le
 * délai ALERT_COOLDOWN_MINUTES, sauf `force: true`.
 * @returns {Promise<{ sent: boolean, skipped?: string, signature: string, discord: {ok:boolean,error?:string}, email: {ok:boolean,error?:string} }>}
 */
async function reportIncident({ kind = 'inconnu', error, context = {}, client, force = false } = {}) {
  const result = {
    sent: false,
    signature: '',
    discord: { ok: false, error: 'non tenté' },
    email: { ok: false, error: 'non tenté' },
  };

  try {
    const config = getConfig();
    const report = buildIncidentReport({ kind, error, context });
    result.signature = report.signature;

    console.error(`[ALERT] ${kind}: ${report.message}`);

    if (!config.enabled) {
      result.skipped = 'désactivé (ALERTS_ENABLED=false)';
      result.discord = { ok: false, error: result.skipped };
      result.email = { ok: false, error: result.skipped };
      return result;
    }

    const now = Date.now();
    const lastSent = lastSentBySignature.get(report.signature);
    if (!force && lastSent && now - lastSent < config.cooldownMinutes * 60 * 1000) {
      const remaining = Math.ceil((config.cooldownMinutes * 60 * 1000 - (now - lastSent)) / 60000);
      result.skipped = `cooldown (même incident envoyé il y a moins de ${config.cooldownMinutes} min, prochain envoi possible dans ~${remaining} min)`;
      result.discord = { ok: false, error: result.skipped };
      result.email = { ok: false, error: result.skipped };
      return result;
    }
    lastSentBySignature.set(report.signature, now);
    if (lastSentBySignature.size > 200) {
      // Évite une croissance infinie : on retire les entrées les plus anciennes.
      const oldest = [...lastSentBySignature.entries()].sort((a, b) => a[1] - b[1]).slice(0, 100);
      for (const [sig] of oldest) lastSentBySignature.delete(sig);
    }

    const discordClient = client || defaultClient;
    const [discord, email] = await Promise.all([
      sendDiscordAlert(discordClient, report, config).catch((err) => ({ ok: false, error: err.message || String(err) })),
      sendEmailAlert(report, config).catch((err) => ({ ok: false, error: err.message || String(err) })),
    ]);

    result.discord = discord;
    result.email = email;
    result.sent = true;

    if (!discord.ok) console.warn(`[ALERT] Envoi Discord échoué (${kind}): ${discord.error}`);
    if (!email.ok) console.warn(`[ALERT] Envoi e-mail échoué (${kind}): ${email.error}`);
  } catch (err) {
    // Le système d'alerte ne doit jamais faire tomber le bot.
    try {
      console.error(`[ALERT] Échec interne du système d'alerte: ${err?.message || err}`);
    } catch {
      // ignore
    }
    result.discord = result.discord.ok ? result.discord : { ok: false, error: `échec interne: ${err?.message || err}` };
    result.email = result.email.ok ? result.email : { ok: false, error: `échec interne: ${err?.message || err}` };
  }

  return result;
}

/** Configuration courante pour l'affichage (/rdvadmin alertes). */
function getAlertStatus() {
  const config = getConfig();
  const lastSent = {};
  for (const [sig, ts] of lastSentBySignature.entries()) lastSent[sig] = new Date(ts).toISOString();
  return {
    emailTo: config.emailTo,
    emailFrom: config.emailFrom,
    channelId: config.channelId,
    cooldownMinutes: config.cooldownMinutes,
    enabled: config.enabled,
    gmailScopeWarningLogged,
    lastSentBySignature: lastSent,
  };
}

function resetAlertStateForTests() {
  lastSentBySignature.clear();
  gmailScopeWarningLogged = false;
  defaultClient = null;
}

module.exports = {
  buildIncidentReport,
  reportIncident,
  getAlertStatus,
  setAlertClient,
  isGoogleAuthError,
  buildRawEmail,
  GOOGLE_AUTH_ADVICE,
  GMAIL_SCOPE_WARNING,
  resetAlertStateForTests,
};
