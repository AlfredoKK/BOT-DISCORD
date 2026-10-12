// ══════════════════════════════════════════════════════════════
// Accès Supabase : UNE base par société, strictement séparées.
//   Licall    → SUPABASE_LICALL_URL   / SUPABASE_LICALL_SERVICE_ROLE_KEY
//   Kall Kall → SUPABASE_KALLKALL_URL / SUPABASE_KALLKALL_SERVICE_ROLE_KEY
//
// Chaque agence est routée vers SA base (société résolue par le classeur
// Sheets, le serveur Discord, ou un champ `societe` explicite). Si la
// société ne peut pas être déterminée, on n'écrit NULLE PART : jamais de
// mélange Licall / Kall Kall.
//
// Client PostgREST minimal (fetch natif Node ≥ 18), sans dépendance :
//   select / insert / upsert / update / remove / rpc. Toute réponse non
//   2xx lève une Error lisible (message PostgREST + code).
// ══════════════════════════════════════════════════════════════

const COMPANIES = {
  licall: {
    key: 'licall',
    label: 'Licall',
    urlVar: 'SUPABASE_LICALL_URL',
    keyVar: 'SUPABASE_LICALL_SERVICE_ROLE_KEY',
    guildVar: 'LICALL_GUILD_ID',
    guildDefault: '1443725425904848959',
    spreadsheetVar: 'LICALL_SPREADSHEET_ID',
    spreadsheetDefault: '16H-aZ8eV9M5Qd5ZToWFSluZFbtHKdP0wcS3mtBK_mzI',
  },
  kallkall: {
    key: 'kallkall',
    label: 'Kall Kall',
    urlVar: 'SUPABASE_KALLKALL_URL',
    keyVar: 'SUPABASE_KALLKALL_SERVICE_ROLE_KEY',
    guildVar: 'KALLKALL_GUILD_ID',
    guildDefault: '1445676914667946085',
    spreadsheetVar: 'KALLKALL_SPREADSHEET_ID',
    spreadsheetDefault: '1dshz0ZhA44VziYOirOwQj_AQFRJxehsV7yZnZ5LJ0BU',
  },
};

const DEFAULT_TIMEOUT_MS = 15_000;

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['false', '0', 'non', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

/** Interrupteur global de la double écriture (défaut : coupé). */
function isDbWriteEnabled(env = process.env) {
  return parseBool(env.DB_WRITE_ENABLED, false);
}

function companyConfig(companyKey, env = process.env) {
  const c = COMPANIES[companyKey];
  if (!c) return null;
  return {
    key: c.key,
    label: c.label,
    url: String(env[c.urlVar] || '').trim().replace(/\/+$/, ''),
    serviceRoleKey: String(env[c.keyVar] || '').trim(),
    guildId: String(env[c.guildVar] || c.guildDefault).trim(),
    spreadsheetId: String(env[c.spreadsheetVar] || c.spreadsheetDefault).trim(),
  };
}

/** Les deux bases sont-elles configurées (URL + clé) ? */
function getDbStatus(env = process.env) {
  const out = {};
  for (const key of Object.keys(COMPANIES)) {
    const c = companyConfig(key, env);
    out[key] = { label: c.label, configured: Boolean(c.url && c.serviceRoleKey), url: c.url };
  }
  return out;
}

/**
 * Société d'une agence : `societe` explicite, sinon classeur Sheets, sinon
 * serveur Discord. Retourne 'licall' | 'kallkall' | null.
 */
function resolveCompany(agency = {}, guildId = null, env = process.env) {
  const explicit = String(agency.societe || '').trim().toLowerCase();
  if (explicit && COMPANIES[explicit]) return explicit;

  for (const key of Object.keys(COMPANIES)) {
    const c = companyConfig(key, env);
    if (agency.spreadsheet_id && c.spreadsheetId && agency.spreadsheet_id === c.spreadsheetId) return key;
  }
  const gid = String(guildId || agency.guild_id || '').trim();
  if (gid) {
    for (const key of Object.keys(COMPANIES)) {
      const c = companyConfig(key, env);
      if (c.guildId && gid === c.guildId) return key;
    }
  }
  return null;
}

// ── Client PostgREST ─────────────────────────────────────────

function buildQuery(params = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Valeur de filtre `in.(a,b,c)` correctement échappée pour PostgREST. */
function inList(values) {
  const quoted = values.map((v) => `"${String(v).replace(/"/g, '\\"')}"`);
  return `in.(${quoted.join(',')})`;
}

async function readError(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    try { body = { message: await res.text() }; } catch { body = null; }
  }
  const msg = body?.message || body?.error || body?.hint || `HTTP ${res.status}`;
  const code = body?.code ? ` [${body.code}]` : '';
  const details = body?.details ? ` — ${body.details}` : '';
  const err = new Error(`Supabase ${res.status}${code}: ${msg}${details}`);
  err.status = res.status;
  err.code = body?.code;
  return err;
}

function createClient({ url, serviceRoleKey, label, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!url || !serviceRoleKey) throw new Error(`Supabase ${label || ''}: URL ou clé service_role manquante`);
  const doFetch = fetchImpl || globalThis.fetch;
  const base = `${url}/rest/v1`;

  async function request(method, path, { params, body, prefer } = {}) {
    const headers = {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (prefer) headers.Prefer = prefer;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}${path}${buildQuery(params)}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw await readError(res);
      if (res.status === 204) return null;
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error(`Supabase ${label || ''}: délai dépassé (${timeoutMs} ms)`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    label,
    url,
    /** select(table, { select, ...filtres PostgREST, limit, order }) → tableau */
    select: (table, params = {}) => request('GET', `/${table}`, { params: { select: '*', ...params } }),
    insert: (table, rows, { returning = true } = {}) =>
      request('POST', `/${table}`, { body: rows, prefer: returning ? 'return=representation' : 'return=minimal' }),
    /** upsert(table, rows, { onConflict, ignoreDuplicates }) */
    upsert: (table, rows, { onConflict, ignoreDuplicates = false, returning = true } = {}) =>
      request('POST', `/${table}`, {
        params: onConflict ? { on_conflict: onConflict } : {},
        body: rows,
        prefer: `resolution=${ignoreDuplicates ? 'ignore' : 'merge'}-duplicates,${returning ? 'return=representation' : 'return=minimal'}`,
      }),
    update: (table, filters, patch) =>
      request('PATCH', `/${table}`, { params: filters, body: patch, prefer: 'return=representation' }),
    remove: (table, filters) =>
      request('DELETE', `/${table}`, { params: filters, prefer: 'return=representation' }),
    rpc: (fn, args = {}) => request('POST', `/rpc/${fn}`, { body: args }),
    /** count(table, filtres) → entier */
    count: async (table, filters = {}) => {
      const headers = {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: 'count=exact',
        Range: '0-0',
      };
      const res = await doFetch(`${base}/${table}${buildQuery({ select: 'id', ...filters })}`, { method: 'GET', headers });
      if (!res.ok && res.status !== 206) throw await readError(res);
      const range = res.headers.get('content-range') || '';
      const total = range.split('/')[1];
      return Number(total) || 0;
    },
  };
}

// Un client par société, créé paresseusement et mis en cache.
const clientCache = new Map();
// Tests : client simulé par société (prioritaire sur la configuration).
const clientOverrides = new Map();

function getClient(companyKey, env = process.env) {
  if (clientOverrides.has(companyKey)) return clientOverrides.get(companyKey);
  const c = companyConfig(companyKey, env);
  if (!c || !c.url || !c.serviceRoleKey) return null;
  const cacheKey = `${c.key}|${c.url}|${c.serviceRoleKey.slice(-8)}`;
  if (!clientCache.has(cacheKey)) {
    clientCache.set(cacheKey, createClient({ url: c.url, serviceRoleKey: c.serviceRoleKey, label: c.label }));
  }
  return clientCache.get(cacheKey);
}

/**
 * Base d'une agence : { company, label, db } ou { company:null, reason }.
 * Ne lève jamais.
 */
function getDbForAgency(agency, guildId = null, env = process.env) {
  const company = resolveCompany(agency, guildId, env);
  if (!company) {
    return { company: null, db: null, reason: `société indéterminable pour ${agency?.name || 'cette agence'} (ni classeur connu, ni serveur Discord connu)` };
  }
  const db = getClient(company, env);
  if (!db) {
    return { company, label: COMPANIES[company].label, db: null, reason: `base ${COMPANIES[company].label} non configurée (variables ${COMPANIES[company].urlVar} / ${COMPANIES[company].keyVar})` };
  }
  return { company, label: COMPANIES[company].label, db, reason: null };
}

function resetClientCacheForTests() {
  clientCache.clear();
  clientOverrides.clear();
}

function setClientOverrideForTests(companyKey, client) {
  if (client) clientOverrides.set(companyKey, client);
  else clientOverrides.delete(companyKey);
}

module.exports = {
  COMPANIES,
  isDbWriteEnabled,
  companyConfig,
  getDbStatus,
  resolveCompany,
  createClient,
  getClient,
  getDbForAgency,
  inList,
  resetClientCacheForTests,
  setClientOverrideForTests,
};
