const RDV_DURATION_MINUTES = 60;

const JOUR_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const JOUR_MAP = { lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6, dimanche: 0 };

const DEFAULT_OPENING_HOURS = {
  0: 'fermé',
  1: '09:00-19:30',
  2: '09:00-19:30',
  3: '09:00-19:30',
  4: '09:00-19:30',
  5: '09:00-19:30',
  6: '09:00-19:30',
};

function getAgencyOpeningHours(agency) {
  if (agency.opening_hours) return agency.opening_hours;
  return DEFAULT_OPENING_HOURS;
}

function isWithinOpeningHours(agency, dateTime, options = {}) {
  const durationMinutes = options.durationMinutes || RDV_DURATION_MINUTES;
  const openingHours = getAgencyOpeningHours(agency || {});
  const dayOfWeek = dateTime.getDay();
  const daySchedule = openingHours[String(dayOfWeek)];

  if (!daySchedule || daySchedule === 'fermé' || daySchedule === 'ferme') {
    return { open: false, reason: `L'agence **${agency.name}** est fermée le ${JOUR_NAMES[dayOfWeek]}.` };
  }

  const match = String(daySchedule).match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!match) {
    return { open: false, reason: `Horaires invalides pour **${agency.name}** le ${JOUR_NAMES[dayOfWeek]}: ${daySchedule}.` };
  }

  const openMinutes = Number(match[1]) * 60 + Number(match[2]);
  const closeMinutes = Number(match[3]) * 60 + Number(match[4]);
  const rdvMinutes = dateTime.getHours() * 60 + dateTime.getMinutes();
  const rdvEndMinutes = rdvMinutes + durationMinutes;
  const openStr = `${match[1].padStart(2, '0')}:${match[2]}`;
  const closeStr = `${match[3].padStart(2, '0')}:${match[4]}`;

  if (rdvMinutes < openMinutes || rdvEndMinutes > closeMinutes) {
    return { open: false, reason: `L'agence **${agency.name}** accepte des RDV de ${openStr} à ${closeStr} le ${JOUR_NAMES[dayOfWeek]}. Un RDV d'1h doit se terminer avant la fermeture.` };
  }

  return { open: true };
}

// ── Conversion vers / depuis le format de la base (dashboard) ──
// Bot      : { "0": "fermé", "1": "09:00-19:30" }  jour JavaScript (0 = dimanche)
// Base     : { "1": ["09:00","19:30"] }             jour ISO (1 = lundi … 7 = dimanche), absent = fermé

function toDbOpeningHours(botHours) {
  if (!botHours || typeof botHours !== 'object') return null;
  const out = {};
  for (const [jsDay, value] of Object.entries(botHours)) {
    if (Array.isArray(value)) { out[String(jsDay)] = value; continue; } // déjà au format base
    const m = String(value || '').match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
    if (!m) continue; // 'fermé' ou invalide → jour absent
    const iso = Number(jsDay) === 0 ? 7 : Number(jsDay);
    if (!(iso >= 1 && iso <= 7)) continue;
    out[String(iso)] = [`${m[1].padStart(2, '0')}:${m[2]}`, `${m[3].padStart(2, '0')}:${m[4]}`];
  }
  return out;
}

function fromDbOpeningHours(dbHours) {
  if (!dbHours || typeof dbHours !== 'object') return null;
  const out = {};
  for (let js = 0; js <= 6; js++) {
    const iso = js === 0 ? 7 : js;
    const v = dbHours[String(iso)];
    if (Array.isArray(v) && v.length === 2) out[String(js)] = `${v[0]}-${v[1]}`;
    else if (typeof v === 'string' && /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(v)) out[String(js)] = v;
    else out[String(js)] = 'fermé';
  }
  return out;
}

module.exports = {
  DEFAULT_OPENING_HOURS,
  JOUR_MAP,
  JOUR_NAMES,
  isWithinOpeningHours,
  toDbOpeningHours,
  fromDbOpeningHours,
};
