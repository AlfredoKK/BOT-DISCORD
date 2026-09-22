require('dotenv').config();

// Tampon des 80 dernières lignes de console, joint aux rapports d'incident.
// Doit être installé avant tout autre require pour capturer les logs de démarrage.
require('./services/log-buffer').installLogBuffer();

const { ensureDataDir } = require('./config/paths');
ensureDataDir();

const { Client, Collection, GatewayIntentBits } = require('discord.js');
const { Agent } = require('undici');
const fs = require('fs');
const path = require('path');
const { reportIncident, setAlertClient } = require('./services/alerts');
const { startHealthServer } = require('./health');

// Signale un incident sans jamais bloquer ni lever d'exception.
function alert(kind, error, context = {}) {
  try {
    reportIncident({ kind, error, context, client }).catch(() => {});
  } catch {
    // Le système d'alerte ne doit jamais faire tomber le bot.
  }
}

const discordRestAgent = new Agent({
  connections: 4,
  connectTimeout: 10_000,
  keepAliveMaxTimeout: 1_000,
  keepAliveTimeout: 1_000,
  pipelining: 0,
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
  rest: {
    agent: discordRestAgent,
    timeout: 20_000,
  },
});

// Load commands
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if (command.data && command.execute) {
    client.commands.set(command.data.name, command);
  }
}

// Handle interactions
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`Error executing /${interaction.commandName}:`, err);
    let sousCommande = null;
    try {
      sousCommande = interaction.options?.getSubcommand?.(false) || null;
    } catch {
      sousCommande = null;
    }
    alert('commande', err, {
      commande: interaction.commandName,
      sousCommande,
      utilisateur: interaction.user?.tag || interaction.user?.displayName || interaction.user?.username || 'inconnu',
      channelId: interaction.channelId,
      guildId: interaction.guildId,
    });
    const msg = 'Une erreur est survenue lors de l\'exécution de la commande.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: msg }).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
});

// Erreurs de la connexion Discord
client.on('error', (err) => {
  console.error('[Discord] Erreur client:', err);
  alert('discord-erreur', err);
});

client.on('shardDisconnect', (event, shardId) => {
  const code = event?.code ?? 'inconnu';
  console.error(`[Discord] Shard ${shardId} déconnecté (code ${code})`);
  alert('discord-déconnexion', new Error(`Shard ${shardId} déconnecté avec le code ${code}`), {
    codeFermeture: code,
    shardId,
    raison: event?.reason || '',
  });
});

client.on('shardResume', (shardId, replayedEvents) => {
  console.log(`[Discord] Shard ${shardId} reconnecté (${replayedEvents} événement(s) rejoué(s))`);
});

client.once('clientReady', async () => {
  console.log(`Bot connecté en tant que ${client.user.tag}`);
  console.log(`${client.commands.size} commande(s) chargée(s)`);
  setAlertClient(client);

  // Enregistre les commandes slash auprès de Discord à chaque démarrage,
  // pour que la liste visible dans Discord suive toujours le code déployé.
  // Désactivable avec REGISTER_COMMANDS_ON_START=false.
  if (process.env.REGISTER_COMMANDS_ON_START !== 'false') {
    try {
      const { registerCommands } = require('./deploy-commands');
      await registerCommands({ clientId: process.env.DISCORD_CLIENT_ID || client.user.id });
    } catch (err) {
      console.error('[Commands] Échec de l\'enregistrement des commandes:', err.message);
    }
  }

  // Start automatic agenda scheduler
  const { startScheduler } = require('./services/scheduler');
  startScheduler(client);
});

// Global error handlers
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  alert('rejet-non-géré', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  alert('exception-non-capturée', err);
});

// Sonde de santé HTTP (GET /health) — ne bloque jamais le démarrage du bot
startHealthServer({ client });

// pm2 graceful shutdown
process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  client.destroy();
  discordRestAgent.close().catch(() => {});
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
