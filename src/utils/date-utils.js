/**
 * Parse a date string (DD/MM/YYYY) and time string (HH:MM) into a Date.
 * Strict validation: rejects invalid dates, wrong formats, and past dates.
 */
function parseDateTime(dateStr, timeStr) {
  let cleanDate = (dateStr || '').trim();
  let cleanTime = (timeStr || '').trim();

  // ── Auto-fix common date formats ──
  // "24/03/26" → "24/03/2026" (2-digit year)
  if (/^\d{1,2}\/\d{1,2}\/\d{2}$/.test(cleanDate)) {
    const parts = cleanDate.split('/');
    cleanDate = `${parts[0]}/${parts[1]}/20${parts[2]}`;
  }
  // "21/03" → "21/03/2026" (no year = current year)
  if (/^\d{1,2}\/\d{1,2}$/.test(cleanDate)) {
    cleanDate = `${cleanDate}/${new Date().getFullYear()}`;
  }
  // Final check: date must be DD/MM/YYYY
  if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(cleanDate)) {
    throw new Error(`Format de date invalide: "${dateStr}". Utilisez le format JJ/MM/AAAA (ex: 14/03/2026)`);
  }

  // ── Auto-fix common time formats ──
  // "16H30" → "16:30", "16h" → "16:00", "16h15" → "16:15"
  cleanTime = cleanTime.replace(/[hH]/, ':');
  // "16:" → "16:00"
  if (/^\d{1,2}:$/.test(cleanTime)) cleanTime += '00';
  // Bare number "15" → "15:00"
  if (/^\d{1,2}$/.test(cleanTime)) cleanTime += ':00';
  // Final check: time must be HH:MM (after normalization)
  if (!/^\d{1,2}:\d{2}$/.test(cleanTime)) {
    throw new Error(`Format d'heure invalide: "${timeStr}". Utilisez le format HH:MM (ex: 14:30)`);
  }

  const dateParts = cleanDate.split('/').map(Number);
  const timeParts = cleanTime.split(':').map(Number);

  const [day, month, year] = dateParts;
  const [hours, minutes] = timeParts;

  if (isNaN(day) || isNaN(month) || isNaN(year) || isNaN(hours) || isNaN(minutes)) {
    throw new Error(`Valeurs invalides: date="${dateStr}" heure="${timeStr}". Utilisez JJ/MM/AAAA et HH:MM`);
  }

  // Validate ranges
  if (month < 1 || month > 12) {
    throw new Error(`Mois invalide: ${month}. Le mois doit être entre 01 et 12.`);
  }
  if (day < 1 || day > 31) {
    throw new Error(`Jour invalide: ${day}. Le jour doit être entre 01 et 31.`);
  }
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error(`Heure invalide: ${hours}:${minutes}. L'heure doit être entre 00:00 et 23:59.`);
  }
  if (year < 2024 || year > 2100) {
    throw new Error(`Année invalide: ${year}. L'année doit être 2024 ou plus.`);
  }

  const dt = new Date(year, month - 1, day, hours, minutes, 0, 0);

  if (isNaN(dt.getTime())) {
    throw new Error(`Date invalide: ${dateStr} ${timeStr}`);
  }

  // Verify the date wasn't silently rolled over (e.g. 31/02 → 03/03)
  if (dt.getDate() !== day || dt.getMonth() !== month - 1 || dt.getFullYear() !== year) {
    throw new Error(`Le ${String(day).padStart(2,'0')}/${String(month).padStart(2,'0')}/${year} n'existe pas.`);
  }

  // Reject past dates (before today)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (dt < today) {
    throw new Error(`Date dans le passé: le ${String(day).padStart(2,'0')}/${String(month).padStart(2,'0')}/${year} est déjà passé.`);
  }

  return dt;
}

/**
 * Format a Date to DD/MM/YYYY
 */
function formatDate(date) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

/**
 * Format a Date to HH:MM
 */
function formatTime(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Determine conference type:
 * - "J/J" if RDV is same day as booking
 * - "J+1" if RDV is next day
 * - "" otherwise
 */
function getConfType(rdvDate) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const rdvDay = new Date(rdvDate.getFullYear(), rdvDate.getMonth(), rdvDate.getDate());

  const diffMs = rdvDay.getTime() - today.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'J/J';
  if (diffDays === 1) return 'J+1';
  return '';
}

/**
 * Get Monday of the current week
 */
function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Get Sunday of the current week (week starts Sunday like Google Calendar)
 */
function getSunday(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sunday
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Get the start of the week for S (current) or S+1 (next week)
 */
function getWeekStart(week) {
  const monday = getMonday(new Date());
  if (week === 'S+1') {
    monday.setDate(monday.getDate() + 7);
  }
  return monday;
}

/**
 * Get the start of the week (Sunday) for S or S+1
 */
function getWeekStartSunday(week) {
  const sunday = getSunday(new Date());
  if (week === 'S+1') {
    sunday.setDate(sunday.getDate() + 7);
  }
  return sunday;
}

/**
 * Get all days of the week (Mon–Sun) starting from a Monday
 */
function getWeekDays(monday) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  return days;
}

/**
 * Get all 7 days starting from Sunday
 */
function getWeekDaysSunday(sunday) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(sunday);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  return days;
}

const DAY_NAMES = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

// Abbreviated, Sunday-first (matching Google Calendar / screenshot)
const DAY_ABBREVS = ['DIM.', 'LUN.', 'MAR.', 'MER.', 'JEU.', 'VEN.', 'SAM.'];

module.exports = {
  parseDateTime,
  formatDate,
  formatTime,
  getConfType,
  getMonday,
  getSunday,
  getWeekStart,
  getWeekStartSunday,
  getWeekDays,
  getWeekDaysSunday,
  DAY_NAMES,
  DAY_ABBREVS,
};
