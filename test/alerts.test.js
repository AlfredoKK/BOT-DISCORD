const assert = require('node:assert/strict');
const test = require('node:test');

// ── Mocks (même approche que test/capacity.test.js : require.cache) ──

const sentEmails = [];
let gmailSendImpl = async (req) => {
  sentEmails.push(req);
  return { data: { id: 'msg-1' } };
};

function mockModule(request, exports) {
  const resolved = require.resolve(request);
  delete require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

mockModule('googleapis', {
  google: {
    gmail: () => ({ users: { messages: { send: (req) => gmailSendImpl(req) } } }),
  },
});

mockModule('../src/services/google-auth', {
  getOAuth2Client: () => ({}),
  isAuthenticated: () => true,
  hasGmailScope: () => true,
});

delete require.cache[require.resolve('../src/services/alerts')];

process.env.ALERT_CHANNEL_ID = '123456789';
process.env.ALERT_EMAIL_TO = 'dev@example.com, second@example.com';
process.env.ALERT_EMAIL_FROM = 'bot@example.com';
process.env.ALERT_COOLDOWN_MINUTES = '15';
process.env.ALERTS_ENABLED = 'true';
process.env.RAILWAY_GIT_COMMIT_SHA = 'abc1234deadbeef';

const { installLogBuffer, clearRecentLogs } = require('../src/services/log-buffer');
const alerts = require('../src/services/alerts');

// Console silencieuse pendant les tests (le tampon de logs reste alimenté)
const originalConsole = {};
for (const level of ['log', 'warn', 'error', 'info']) {
  originalConsole[level] = console[level];
  console[level] = () => {};
}
installLogBuffer();
const warnings = [];
const silentWarn = console.warn;
console.warn = (...args) => { warnings.push(args.join(' ')); silentWarn(...args); };

function fakeClient() {
  const sent = [];
  return {
    sent,
    channels: {
      fetch: async (id) => {
        assert.equal(id, '123456789');
        return { send: async (payload) => { sent.push(payload); return { id: 'm1' }; } };
      },
    },
  };
}

function decodeRawEmail(raw) {
  const message = Buffer.from(raw, 'base64url').toString('utf8');
  const [headers, body] = message.split('\r\n\r\n');
  return { headers, body: Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8') };
}

test.beforeEach(() => {
  alerts.resetAlertStateForTests();
  sentEmails.length = 0;
  warnings.length = 0;
  clearRecentLogs();
  gmailSendImpl = async (req) => { sentEmails.push(req); return { data: { id: 'msg-1' } }; };
});

test('buildIncidentReport contient message, pile, commit, contexte et logs récents', () => {
  console.log('marqueur-log-avant-incident');
  const error = new Error('Explosion contrôlée');
  const report = alerts.buildIncidentReport({
    kind: 'commande',
    error,
    context: {
      commande: 'rdv',
      sousCommande: 'prendre',
      utilisateur: 'alice#0001',
      channelId: '42',
      agence: 'PARIS',
      extra: { a: 1 },
    },
  });

  assert.equal(report.title, '[BOT RDV] Incident : commande — Explosion contrôlée');
  assert.equal(report.signature, 'commande:Explosion contrôlée');
  assert.match(report.text, /Type d'incident\s+: commande/);
  assert.match(report.text, /Message d'erreur\s+: Explosion contrôlée/);
  assert.match(report.text, /Pile d'exécution/);
  assert.ok(report.text.includes(error.stack.split('\n')[1].trim()), 'la pile doit être incluse');
  assert.match(report.text, /Commit déployé : abc1234deadbeef/);
  assert.match(report.text, /- Commande : rdv/);
  assert.match(report.text, /- Sous-commande : prendre/);
  assert.match(report.text, /- Utilisateur : alice#0001/);
  assert.match(report.text, /- Canal \(id\) : 42/);
  assert.match(report.text, /- Agence : PARIS/);
  assert.match(report.text, /- extra :/);
  assert.match(report.text, /"a": 1/);
  assert.match(report.text, /Version Node\s+: v\d+/);
  assert.match(report.text, /Uptime/);
  assert.match(report.text, /marqueur-log-avant-incident/);
  assert.match(report.text, /Pour corriger : transmettre ce rapport tel quel au développeur \/ à Claude/);
  assert.match(report.text, /Date\/heure \(Paris\) : \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}/);
});

test('la signature tronque le message à 120 caractères et gère les erreurs non-Error', () => {
  const long = 'x'.repeat(300);
  const report = alerts.buildIncidentReport({ kind: 'k', error: long });
  assert.equal(report.signature, `k:${'x'.repeat(120)}`);
  assert.ok(report.title.length < 120);

  const none = alerts.buildIncidentReport({ kind: 'k' });
  assert.match(none.text, /Erreur inconnue/);
  assert.match(none.text, /aucune pile disponible/);
});

test('un token Google expiré ajoute le conseil de relancer /rdvadmin auth', () => {
  const report = alerts.buildIncidentReport({ kind: 'google-auth', error: new Error('invalid_grant: Token has been expired or revoked.') });
  assert.equal(report.googleAuthAdvice, true);
  assert.match(report.text, /CONSEIL : .*\/rdvadmin auth/);
  assert.equal(alerts.isGoogleAuthError('Token has been expired or revoked'), true);
  assert.equal(alerts.isGoogleAuthError('ECONNRESET'), false);
});

test('reportIncident envoie sur Discord et par e-mail, puis respecte le cooldown', async () => {
  const client = fakeClient();
  const error = new Error('Panne du scheduler');

  const first = await alerts.reportIncident({ kind: 'scheduler', error, context: { agence: 'LYON' }, client });
  assert.equal(first.sent, true);
  assert.deepEqual(first.discord, { ok: true });
  assert.deepEqual(first.email, { ok: true });

  // Discord : embed + pièce jointe .txt, sans mention
  assert.equal(client.sent.length, 1);
  const payload = client.sent[0];
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.files.length, 1);
  assert.match(payload.files[0].name, /^incident-scheduler-.*\.txt$/);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  const embedJson = payload.embeds[0].toJSON();
  assert.match(embedJson.title, /Incident : scheduler/);
  assert.equal(embedJson.description, 'Panne du scheduler');
  assert.ok(embedJson.fields.some((f) => f.name === 'Agence' && f.value === 'LYON'));
  assert.ok(embedJson.fields.some((f) => f.name === 'Commit' && f.value === 'abc1234deadbeef'));
  const attachmentText = payload.files[0].attachment.toString('utf8');
  assert.match(attachmentText, /RAPPORT D'INCIDENT/);
  assert.match(attachmentText, /Panne du scheduler/);

  // E-mail : RFC 2822 encodé base64url
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].userId, 'me');
  const mail = decodeRawEmail(sentEmails[0].requestBody.raw);
  assert.match(mail.headers, /From: bot@example\.com/);
  assert.match(mail.headers, /To: dev@example\.com, second@example\.com/);
  assert.match(mail.headers, /Subject: (\[BOT RDV\] Incident : scheduler — Panne du scheduler|=\?UTF-8\?B\?.+\?=)/);
  assert.match(mail.headers, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(mail.body, /Panne du scheduler/);
  assert.match(mail.body, /Pour corriger : transmettre ce rapport tel quel/);

  // Même signature juste après : ignorée
  const second = await alerts.reportIncident({ kind: 'scheduler', error: new Error('Panne du scheduler'), client });
  assert.equal(second.sent, false);
  assert.match(second.skipped, /cooldown/);
  assert.equal(client.sent.length, 1);
  assert.equal(sentEmails.length, 1);

  // Signature différente : envoyée
  const other = await alerts.reportIncident({ kind: 'scheduler', error: new Error('Autre panne'), client });
  assert.equal(other.sent, true);
  assert.equal(client.sent.length, 2);

  // force: true ignore le cooldown
  const forced = await alerts.reportIncident({ kind: 'scheduler', error: new Error('Panne du scheduler'), client, force: true });
  assert.equal(forced.sent, true);
  assert.equal(client.sent.length, 3);
  assert.equal(sentEmails.length, 3);

  const status = alerts.getAlertStatus();
  assert.deepEqual(status.emailTo, ['dev@example.com', 'second@example.com']);
  assert.equal(status.emailFrom, 'bot@example.com');
  assert.equal(status.channelId, '123456789');
  assert.equal(status.cooldownMinutes, 15);
  assert.equal(status.enabled, true);
  assert.ok('scheduler:Panne du scheduler' in status.lastSentBySignature);
});

test('un échec d\'un canal n\'empêche pas l\'autre et ne lève jamais', async () => {
  gmailSendImpl = async () => { throw new Error('réseau injoignable'); };
  const client = {
    channels: { fetch: async () => { throw new Error('Missing Access'); } },
  };

  const result = await alerts.reportIncident({ kind: 'commande', error: new Error('x'), client });
  assert.equal(result.sent, true);
  assert.equal(result.discord.ok, false);
  assert.match(result.discord.error, /Missing Access/);
  assert.equal(result.email.ok, false);
  assert.match(result.email.error, /réseau injoignable/);
});

test('un scope gmail.send manquant loggue l\'avertissement une seule fois', async () => {
  gmailSendImpl = async () => {
    const err = new Error('Request had insufficient authentication scopes.');
    err.code = 403;
    throw err;
  };
  const client = fakeClient();

  const r1 = await alerts.reportIncident({ kind: 'a', error: new Error('1'), client });
  const r2 = await alerts.reportIncident({ kind: 'b', error: new Error('2'), client });
  assert.equal(r1.email.ok, false);
  assert.equal(r1.email.scopeMissing, true);
  assert.equal(r2.email.scopeMissing, true);
  assert.equal(r1.discord.ok, true);

  const scopeWarnings = warnings.filter((w) => w.includes('Alerte e-mail impossible'));
  assert.equal(scopeWarnings.length, 1);
  assert.match(scopeWarnings[0], /Relancer \/rdvadmin auth puis \/rdvadmin callback avec le compte contact@licall\.fr/);
});

test('ALERTS_ENABLED=false garde le log mais n\'envoie rien', async () => {
  process.env.ALERTS_ENABLED = 'false';
  try {
    const client = fakeClient();
    const result = await alerts.reportIncident({ kind: 'test', error: new Error('off'), client, force: true });
    assert.equal(result.sent, false);
    assert.match(result.skipped, /désactivé/);
    assert.equal(client.sent.length, 0);
    assert.equal(sentEmails.length, 0);
    assert.equal(alerts.getAlertStatus().enabled, false);
  } finally {
    process.env.ALERTS_ENABLED = 'true';
  }
});

test('sans ALERT_CHANNEL_ID, Discord est ignoré proprement et setAlertClient sert de client par défaut', async () => {
  const saved = process.env.ALERT_CHANNEL_ID;
  process.env.ALERT_CHANNEL_ID = '';
  try {
    const result = await alerts.reportIncident({ kind: 'k', error: new Error('no channel'), client: fakeClient() });
    assert.equal(result.discord.ok, false);
    assert.match(result.discord.error, /ALERT_CHANNEL_ID/);
    assert.equal(result.email.ok, true);
  } finally {
    process.env.ALERT_CHANNEL_ID = saved;
  }

  const client = fakeClient();
  alerts.setAlertClient(client);
  const viaDefault = await alerts.reportIncident({ kind: 'k', error: new Error('client par défaut') });
  assert.equal(viaDefault.discord.ok, true);
  assert.equal(client.sent.length, 1);
});

test.after(() => {
  for (const level of Object.keys(originalConsole)) console[level] = originalConsole[level];
});

test('notifyOps sends a short Discord notice, dedupes by signature, and never throws', async () => {
  const alerts = require('../src/services/alerts');
  alerts.resetAlertStateForTests();
  const previous = process.env.ALERT_CHANNEL_ID;
  process.env.ALERT_CHANNEL_ID = '123';
  const sent = [];
  const client = { channels: { fetch: async () => ({ send: async (payload) => { sent.push(payload); } }) } };
  try {
    const first = await alerts.notifyOps({ kind: 'Refus de permission', message: 'X a tenté /rdvadmin play', context: { commande: 'rdvadmin', sousCommande: 'play', utilisateur: 'X' }, client });
    assert.equal(first.sent, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].embeds.length, 1);
    assert.equal(sent[0].files, undefined);
    const second = await alerts.notifyOps({ kind: 'Refus de permission', message: 'X a tenté /rdvadmin play', client });
    assert.equal(second.sent, false);
    assert.equal(second.skipped, 'cooldown');
    const forced = await alerts.notifyOps({ kind: 'Refus de permission', message: 'X a tenté /rdvadmin play', client, force: true });
    assert.equal(forced.sent, true);
    const broken = { channels: { fetch: async () => { throw new Error('boom'); } } };
    const failed = await alerts.notifyOps({ kind: 'autre', message: 'y', client: broken });
    assert.equal(failed.sent, false);
    assert.match(failed.discord.error, /boom/);
  } finally {
    if (previous === undefined) delete process.env.ALERT_CHANNEL_ID; else process.env.ALERT_CHANNEL_ID = previous;
    alerts.resetAlertStateForTests();
  }
});
