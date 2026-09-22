const http = require('node:http');

// Serveur HTTP minimal pour la sonde de santé (Railway / uptime monitor).
// GET /health -> 200 si Discord est prêt, sinon 503. Toute autre route -> 404.

function buildHealthPayload(client) {
  let discordReady = false;
  try {
    discordReady = !!(client && typeof client.isReady === 'function' ? client.isReady() : client?.readyAt);
  } catch {
    discordReady = false;
  }

  let googleAuth = false;
  try {
    googleAuth = require('./services/google-auth').isAuthenticated();
  } catch {
    googleAuth = false;
  }

  let lastSchedulerRunAt = null;
  let lastSchedulerCheckAt = null;
  try {
    const scheduler = require('./services/scheduler');
    lastSchedulerRunAt = scheduler.getLastRunAt();
    lastSchedulerCheckAt = scheduler.getLastCheckAt ? scheduler.getLastCheckAt() : null;
  } catch {
    lastSchedulerRunAt = null;
  }

  return {
    status: discordReady ? 'ok' : 'degraded',
    discordReady,
    uptimeSeconds: Math.floor(process.uptime()),
    lastSchedulerRunAt: lastSchedulerRunAt ? new Date(lastSchedulerRunAt).toISOString() : null,
    lastSchedulerCheckAt: lastSchedulerCheckAt ? new Date(lastSchedulerCheckAt).toISOString() : null,
    googleAuth,
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || 'inconnu',
  };
}

/**
 * Démarre le serveur de santé. Ne fait jamais planter le bot : si le port est
 * pris ou qu'une erreur survient, on loggue et on continue.
 * @returns {import('node:http').Server|null}
 */
function startHealthServer({ client, port = process.env.PORT || 3000 } = {}) {
  let server;
  try {
    server = http.createServer((req, res) => {
      const url = (req.url || '/').split('?')[0];
      if (req.method === 'GET' && url === '/health') {
        const payload = buildHealthPayload(client);
        const body = JSON.stringify(payload);
        res.writeHead(payload.discordReady ? 200 : 503, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(body);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    server.on('error', (err) => {
      console.error(`[Health] Serveur de santé indisponible sur le port ${port}: ${err.message}`);
    });

    server.listen(Number(port), () => {
      console.log(`[Health] GET /health disponible sur le port ${port}`);
    });
  } catch (err) {
    console.error(`[Health] Impossible de démarrer le serveur de santé: ${err.message}`);
    return null;
  }
  return server;
}

module.exports = { startHealthServer, buildHealthPayload };
