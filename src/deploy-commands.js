require('dotenv').config();

const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if (command.data) {
    commands.push(command.data.toJSON());
  }
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

const GUILD_ID = process.env.DISCORD_GUILD_ID;

(async () => {
  try {
    if (GUILD_ID) {
      console.log(`Enregistrement de ${commands.length} commande(s) sur le serveur ${GUILD_ID}...`);
      await rest.put(
        Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, GUILD_ID),
        { body: commands }
      );
    } else {
      console.log(`Enregistrement global de ${commands.length} commande(s)...`);
      await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), {
        body: commands,
      });
    }

    console.log('Commandes enregistrées avec succès !');
  } catch (err) {
    console.error('Erreur lors de l\'enregistrement:', err);
  }
})();
