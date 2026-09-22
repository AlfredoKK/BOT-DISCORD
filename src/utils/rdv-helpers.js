const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { COL } = require('../services/sheets');
const { formatDate, formatTime } = require('./date-utils');
const { buildManagedRdvDescription, parseManagedRdvEvent } = require('./rdv-title');

const AGENCIES_PATH = path.join(__dirname, '../../data/agencies.json');
const RDV_DURATION_MINUTES = 60;
const DOM_RDV_BUFFER_MINUTES = 15;  // 15min avant + 15min après
const DOM_RDV_TOTAL_MINUTES = 90;   // total créneau bloqué = 1h30

// ── Agences ──

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

// ── Divers ──

function getCalendarLink(eventId, calendarId) {
  const raw = `${eventId} ${calendarId}`;
  return `https://www.google.com/calendar/event?eid=${Buffer.from(raw).toString('base64').replace(/=+$/, '')}`;
}

function timestamp() {
  return new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
}

function normalizeMatchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

// ── Sheets ──

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

// ── Titres Calendar ──

function buildEventTitle(prefix, nomClient, telephone, marque, modele, annee, kilometrage, prix) {
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
    details.prix || ''
  );
  const description = buildManagedRdvDescription(details.liens, details.commentaire, details.adresse);
  return {
    summary: prefix ? `${prefix} - ${baseTitle}` : baseTitle,
    description: description || undefined,
  };
}

// ── Embeds ──

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

function vehicleLabel(sheetRow, details) {
  return sheetRow?.[COL.VEHICULE]
    || `${details?.marque || ''} ${details?.modele || ''} (${details?.annee || ''})`.trim()
    || '—';
}

module.exports = {
  AGENCIES_PATH,
  RDV_DURATION_MINUTES,
  DOM_RDV_BUFFER_MINUTES,
  DOM_RDV_TOTAL_MINUTES,
  loadAgencies,
  saveAgencies,
  getAgencyByChannel,
  requireAgency,
  getCalendarLink,
  timestamp,
  findSheetRowByEventId,
  buildEventTitle,
  isEventDomRdv,
  buildCanonicalManagedEventPayload,
  buildRdvEmbed,
  vehicleLabel,
};
