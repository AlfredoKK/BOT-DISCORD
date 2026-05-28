const STATUS_PREFIXES = [
  'NON CONF - ',
  'CONF - ',
  'J/J - ',
  'ANNULÉ - ',
  'ANNULE - ',
  'PAS VENU - ',
  'NO SHOW - ',
  'VENDU - ',
];

const NON_COUNTING_PREFIXES = [
  'ANNULÉ - ',
  'ANNULE - ',
  'PAS VENU - ',
  'NO SHOW - ',
  'VENDU - ',
];

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

function getLeadingStatusPrefixes(title) {
  let cleaned = String(title || '').trim();
  const matches = [];
  let changed = true;

  while (changed && cleaned) {
    changed = false;
    for (const prefix of STATUS_PREFIXES) {
      if (normalizeText(cleaned).startsWith(normalizeText(prefix))) {
        matches.push(prefix.toUpperCase());
        cleaned = cleaned.slice(prefix.length).trim();
        changed = true;
        break;
      }
    }
  }

  return matches;
}

function stripLeadingStatusPrefixes(title) {
  let cleaned = String(title || '').trim();
  for (const prefix of getLeadingStatusPrefixes(title)) {
    cleaned = cleaned.slice(prefix.length).trim();
  }
  return cleaned;
}

function extractManagedBaseTitle(title) {
  const raw = String(title || '').trim();
  const matches = Array.from(raw.matchAll(/\bRDV MANDAT(?:\s+DOM)?\s*-\s*/gi));
  if (matches.length > 0) {
    const lastMatch = matches[matches.length - 1];
    return raw.slice(lastMatch.index).trim();
  }
  return stripLeadingStatusPrefixes(raw);
}

function stripStatusPrefixes(title) {
  return extractManagedBaseTitle(title);
}

function applyStatusPrefix(prefix, title) {
  const cleaned = stripStatusPrefixes(title);
  return prefix ? `${prefix} - ${cleaned}` : cleaned;
}

function getPrimaryStatusPrefix(title) {
  const prefixes = getLeadingStatusPrefixes(title);
  return prefixes.length > 0 ? prefixes[0].replace(/\s*-\s*$/, '').trim() : null;
}

function isManagedRdvTitle(title) {
  const base = stripStatusPrefixes(title).toUpperCase();
  return base.startsWith('RDV MANDAT - ') || base.startsWith('RDV MANDAT DOM - ');
}

function isCountableManagedRdvTitle(title) {
  if (!isManagedRdvTitle(title)) return false;
  const prefixes = getLeadingStatusPrefixes(title);
  return !prefixes.some((prefix) => NON_COUNTING_PREFIXES.includes(prefix));
}

function looksLikeLink(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return /^(https?:\/\/|www\.)/i.test(text) || /^[^\s]+\.[a-z]{2,}(\/\S*)?$/i.test(text);
}

function isYearToken(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length !== 4) return false;
  const year = Number(digits);
  return year >= 1900 && year <= 2100;
}

function isKilometrageToken(value) {
  return /\b\d[\d\s]*\s*KM\b/i.test(String(value || '').trim());
}

function isPriceToken(value) {
  return /^\d[\d\s]*\s*€$/u.test(String(value || '').trim());
}

function buildManagedRdvDescription(liens, commentaire, adresse) {
  const cleanLiens = String(liens || '').trim();
  const cleanCommentaire = String(commentaire || '').trim();
  const cleanAdresse = String(adresse || '').trim();
  const sections = [];

  if (cleanAdresse) sections.push(`Adresse:\n${cleanAdresse}`);
  if (cleanLiens) sections.push(`Liens:\n${cleanLiens}`);
  if (cleanCommentaire) sections.push(`Commentaire:\n${cleanCommentaire}`);

  return sections.join('\n\n').trim();
}

function parseManagedRdvDescription(description) {
  const text = String(description || '').trim();
  if (!text) return { liens: '', commentaire: '', adresse: '' };

  const sections = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  let liens = '';
  let commentaire = '';
  let adresse = '';

  for (const section of sections) {
    const lines = section.split('\n');
    const header = normalizeText(lines[0]);
    const body = lines.slice(1).join('\n').trim();

    if (/^LIENS?\s*:?\s*$/.test(header)) {
      liens = body;
      continue;
    }

    if (/^(COMMENTAIRE|NOTES?)\s*:?\s*$/.test(header)) {
      commentaire = body;
      continue;
    }

    if (/^ADRESSE\s*:?\s*$/.test(header)) {
      adresse = body;
      continue;
    }
  }

  if (liens || commentaire || adresse) {
    return { liens, commentaire, adresse };
  }

  if (looksLikeLink(text)) {
    return { liens: text, commentaire: '', adresse: '' };
  }

  return { liens: '', commentaire: text, adresse: '' };
}

const MANAGED_TITLE_PREFIXES = ['RDV MANDAT', 'RDV MANDAT DOM'];

function parseManagedRdvEvent(eventData = {}) {
  const baseTitle = stripStatusPrefixes(eventData.summary || '');
  const parts = baseTitle.split(' - ').map((part) => part.trim()).filter(Boolean);
  const hasManagedPrefix = parts[0] && MANAGED_TITLE_PREFIXES.includes(parts[0].toUpperCase());
  const dataStart = hasManagedPrefix ? 1 : 0;
  const coreParts = parts.slice(dataStart);
  const nomClient = coreParts[0] || '';
  const telephone = coreParts[1] || '';
  const remaining = coreParts.slice(2);
  const { liens: descriptionLiens, commentaire: descriptionCommentaire, adresse: descriptionAdresse } = parseManagedRdvDescription(eventData.description || '');

  const usedIndexes = new Set();
  let marque = '';
  let modele = '';
  let annee = '';
  let kilometrage = '';
  let prix = '';
  let liens = descriptionLiens;
  let commentaire = descriptionCommentaire;
  let adresse = descriptionAdresse;

  const yearIndex = remaining.findIndex(isYearToken);
  if (yearIndex !== -1) {
    annee = remaining[yearIndex].replace(/\D/g, '');
    usedIndexes.add(yearIndex);
  }

  const kmIndex = remaining.findIndex(isKilometrageToken);
  if (kmIndex !== -1) {
    kilometrage = remaining[kmIndex].replace(/\s*KM$/i, '').trim();
    usedIndexes.add(kmIndex);
  }

  const priceIndexes = remaining
    .map((value, index) => ({ value, index }))
    .filter(({ value, index }) => isPriceToken(value) && !usedIndexes.has(index));
  if (priceIndexes.length > 0) {
    const priceToken = priceIndexes[priceIndexes.length - 1];
    prix = priceToken.value.replace(/\s*€\s*$/u, '').trim();
    usedIndexes.add(priceToken.index);
    for (const candidate of priceIndexes.slice(0, -1)) {
      usedIndexes.add(candidate.index);
    }
  }

  const linkIndexes = remaining
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => looksLikeLink(value));
  if (!liens && linkIndexes.length > 0) {
    liens = linkIndexes.map(({ value }) => value).join('\n');
  }
  for (const { index } of linkIndexes) {
    usedIndexes.add(index);
  }

  const freeTokens = remaining
    .map((value, index) => ({ value, index }))
    .filter(({ index }) => !usedIndexes.has(index))
    .map(({ value }) => value);

  marque = freeTokens[0] || '';
  modele = freeTokens[1] || '';
  if (modele && kilometrage && /\s+KM$/i.test(modele) && !/\d/.test(modele)) {
    modele = modele.replace(/\s+KM$/i, '').trim();
  }

  if (!commentaire && freeTokens.length > 2) {
    commentaire = freeTokens.slice(2).join(' - ');
  }

  if (!commentaire) {
    const extras = parts.slice(dataStart + 7).filter((extra) => {
      const trimmed = String(extra || '').trim();
      if (!trimmed) return false;
      if (looksLikeLink(trimmed)) return false;
      if (prix && isPriceToken(trimmed) && trimmed.replace(/\s*€\s*$/u, '').trim() === prix) return false;
      if (kilometrage && isKilometrageToken(trimmed) && trimmed.replace(/\s*KM$/i, '').trim() === kilometrage) return false;
      if (annee && isYearToken(trimmed) && trimmed.replace(/\D/g, '') === annee) return false;
      return true;
    });

    if (extras.length === 1) {
      if (liens) {
        if (extras[0].trim() !== liens) commentaire = extras[0];
      } else if (looksLikeLink(extras[0])) {
        liens = extras[0];
      } else {
        commentaire = extras[0];
      }
    } else if (extras.length > 1) {
      if (liens && extras[0].trim() === liens) {
        commentaire = extras.slice(1).join(' - ');
      } else if (!liens && looksLikeLink(extras[0])) {
        liens = extras[0];
        commentaire = extras.slice(1).join(' - ');
      } else {
        commentaire = extras.join(' - ');
      }
    }
  }

  return {
    nomClient,
    telephone,
    marque,
    modele,
    annee,
    kilometrage,
    prix,
    liens,
    commentaire,
    adresse,
  };
}

module.exports = {
  STATUS_PREFIXES,
  NON_COUNTING_PREFIXES,
  getLeadingStatusPrefixes,
  stripStatusPrefixes,
  getPrimaryStatusPrefix,
  applyStatusPrefix,
  isManagedRdvTitle,
  isCountableManagedRdvTitle,
  buildManagedRdvDescription,
  parseManagedRdvDescription,
  parseManagedRdvEvent,
};
