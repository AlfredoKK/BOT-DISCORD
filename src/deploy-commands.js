require('dotenv').config();

const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

function loadCommandDefinitions() {
  const commands = [];
  const commandsPath = path.join(__dirname, 'commands');
  const commandFiles = fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

  for (const file of commandFiles) {
    const command = require(path.join(commandsPath, file));
    if (command.data) {
      commands.push(command.data.toJSON());
    }
  }
  return commands;
}

/**
 * Enregistre (ou remplace) l'ensemble des commandes slash auprès de Discord.
 * - Avec DISCORD_GUILD_ID : enregistrement sur ce serveur uniquement (instantané).
 * - Sans : enregistrement global (propagation jusqu'à ~1h).
 * Appelé par `npm run deploy` et automatiquement au démarrage du bot.
 */
async function registerCommands({ token = process.env.DISCORD_TOKEN, clientId = process.env.DISCORD_CLIENT_ID, guildId = process.env.DISCORD_GUILD_ID } = {}) {
  if (!token) throw new Error('DISCORD_TOKEN manquant');
  if (!clientId) throw new Error('DISCORD_CLIENT_ID manquant');

  const commands = loadCommandDefinitions();
  const rest = new REST({ version: '10' }).setToken(token);

  if (guildId) {
    console.log(`[Commands] Enregistrement de ${commands.length} commande(s) sur le serveur ${guildId}...`);
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  } else {
    console.log(`[Commands] Enregistrement global de ${commands.length} commande(s)...`);
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
  }

  console.log(`[Commands] Commandes enregistrées: ${commands.map((c) => `/${c.name}`).join(', ')}`);
  return commands;
}

module.exports = { registerCommands, loadCommandDefinitions };

if (require.main === module) {
  registerCommands().catch((err) => {
    console.error('Erreur lors de l\'enregistrement:', err);
    process.exit(1);
  });
}
