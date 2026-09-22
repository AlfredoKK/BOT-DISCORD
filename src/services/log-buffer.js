const util = require('util');

// Tampon circulaire des dernières lignes de console, joint aux rapports d'incident
// pour que le développeur voie ce qui s'est passé juste avant l'erreur.
const MAX_LINES = 80;
const MAX_LINE_LENGTH = 2000;
const LEVELS = ['log', 'info', 'warn', 'error'];

const buffer = [];
let installed = false;

function formatParisTimestamp(date = new Date()) {
  return date.toLocaleString('fr-FR', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function pushLine(level, args) {
  let text;
  try {
    text = util.format(...args);
  } catch {
    text = args.map((a) => String(a)).join(' ');
  }
  if (text.length > MAX_LINE_LENGTH) text = `${text.slice(0, MAX_LINE_LENGTH)}… [tronqué]`;

  buffer.push(`${formatParisTimestamp()} [${level.toUpperCase()}] ${text}`);
  while (buffer.length > MAX_LINES) buffer.shift();
}

/**
 * Patch console.log/info/warn/error pour copier chaque ligne dans le tampon,
 * sans modifier la sortie. Idempotent.
 */
function installLogBuffer() {
  if (installed) return;
  installed = true;

  for (const level of LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      try {
        pushLine(level, args);
      } catch {
        // Le tampon ne doit jamais casser la sortie console.
      }
      return original(...args);
    };
  }
}

/** Retourne une copie des dernières lignes (la plus ancienne en premier). */
function getRecentLogs() {
  return buffer.slice();
}

function clearRecentLogs() {
  buffer.length = 0;
}

module.exports = { installLogBuffer, getRecentLogs, clearRecentLogs, formatParisTimestamp, MAX_LINES };
