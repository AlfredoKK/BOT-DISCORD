const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { generateAuthUrl, exchangeCode, isAuthenticated } = require('../services/google-auth');
const calendar = require('../services/calendar');
const sheets = require('../services/sheets');
const { JOUR_MAP } = require('../services/opening-hours');
const { requireAdmin } = require('../utils/permissions');
const {
  loadAgencies,
  saveAgencies,
  getAgencyByChannel,
  requireAgency,
} = require('../utils/rdv-helpers');

// ── Slash command definition ──
// Commande réservée aux administrateurs (voir src/utils/permissions.js).
// setDefaultMemberPermissions(Administrator) la cache aux autres membres par défaut ;
// un rôle admin sans la permission Administrateur doit être autorisé dans
// Paramètres du serveur > Intégrations > <bot> > /rdvadmin.

const data = new SlashCommandBuilder()
  .setName('rdvadmin')
  .setDescription('Administration du bot RDV (admins uniquement)')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub.setName('auth').setDescription('Obtenir le lien d\'autorisation Google')
  )
  .addSubcommand((sub) =>
    sub.setName('callback').setDescription('Valider le code d\'autorisation Google')
      .addStringOption((opt) => opt.setName('code').setDescription('Code d\'autorisation').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('Afficher le statut du bot')
  )
  .addSubcommand((sub) =>
    sub.setName('config').setDescription('Configurer ce canal comme agence')
      .addStringOption((opt) => opt.setName('agence').setDescription('Nom de l\'agence').setRequired(true))
      .addStringOption((opt) => opt.setName('calendar_id').setDescription('ID du calendrier Google').setRequired(true))
      .addStringOption((opt) => opt.setName('spreadsheet_id').setDescription('ID du Google Sheets').setRequired(true))
      .addIntegerOption((opt) => opt.setName('max_rdv_heure').setDescription('Max RDV par heure').setRequired(true))
      .addStringOption((opt) => opt.setName('sheet_name').setDescription('Nom de l\'onglet dans le Sheets (ex: Feuille 1)').setRequired(false))
  )
  .addSubcommand((sub) =>
    sub.setName('deconfig').setDescription('Supprimer la configuration de ce canal')
  )
  .addSubcommand((sub) =>
    sub.setName('agences').setDescription('Lister toutes les agences configurées')
  )
  .addSubcommand((sub) =>
    sub.setName('calendars').setDescription('Lister les calendriers Google disponibles')
  )
  .addSubcommand((sub) =>
    sub.setName('pause').setDescription('Mettre en pause les RDV pour cette agence')
  )
  .addSubcommand((sub) =>
    sub.setName('play').setDescription('Reprendre les RDV pour cette agence')
  )
  .addSubcommand((sub) =>
    sub.setName('horaires').setDescription('Configurer les horaires d\'ouverture de l\'agence')
      .addStringOption((opt) => opt.setName('lundi').setDescription('ex: 09:00-19:00 ou fermé').setRequired(false))
      .addStringOption((opt) => opt.setName('mardi').setDescription('ex: 09:00-19:00 ou fermé').setRequired(false))
      .addStringOption((opt) => opt.setName('mercredi').setDescription('ex: 09:00-19:00 ou fermé').setRequired(false))
      .addStringOption((opt) => opt.setName('jeudi').setDescription('ex: 09:00-19:00 ou fermé').setRequired(false))
      .addStringOption((opt) => opt.setName('vendredi').setDescription('ex: 09:00-19:00 ou fermé').setRequired(false))
      .addStringOption((opt) => opt.setName('samedi').setDescription('ex: 09:00-19:00 ou fermé').setRequired(false))
      .addStringOption((opt) => opt.setName('dimanche').setDescription('ex: 09:00-19:00 ou fermé').setRequired(false))
  );

// ── Main execute ──

async function execute(interaction) {
  if (!(await requireAdmin(interaction))) return;

  const sub = interaction.options.getSubcommand();

  try {
    switch (sub) {
      case 'auth': return await handleAuth(interaction);
      case 'callback': return await handleCallback(interaction);
      case 'status': return await handleStatus(interaction);
      case 'config': return await handleConfig(interaction);
      case 'deconfig': return await handleDeconfig(interaction);
      case 'agences': return await handleAgences(interaction);
      case 'calendars': return await handleCalendars(interaction);
      case 'pause': return await handlePause(interaction);
      case 'play': return await handlePlay(interaction);
      case 'horaires': return await handleHoraires(interaction);
      default: return await interaction.reply({ content: 'Sous-commande inconnue.', ephemeral: true });
    }
  } catch (err) {
    console.error(`Error in /rdvadmin ${sub}:`, err);
    const msg = `Erreur: ${err.message}`;
    try {
      if (interaction.deferred || interaction.replied) {
        return await interaction.editReply({ content: msg });
      }
      return await interaction.reply({ content: msg, ephemeral: true });
    } catch (replyErr) {
      console.error(`Error replying for /rdvadmin ${sub}:`, replyErr);
    }
  }
}

// ── Auth ──

async function handleAuth(interaction) {
  const url = generateAuthUrl();
  await interaction.reply({
    content:
      `**Étape 1** — Cliquez sur ce lien pour autoriser :\n${url}\n\n` +
      `**Étape 2** — Après autorisation, la page ne chargera pas (c'est normal).\n` +
      `Copiez le **code** dans la barre d'adresse :\n` +
      `\`http://localhost:3000/oauth2callback?code=4/0XXXXX...\`\n\n` +
      `**Étape 3** — Collez le code ici :\n` +
      `\`/rdvadmin callback code:4/0XXXXX...\``,
    ephemeral: true,
  });
}

async function handleCallback(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const code = interaction.options.getString('code');
  await exchangeCode(code);
  await interaction.editReply('Google authentifié avec succès !');
}

// ── Status ──

async function handleStatus(interaction) {
  const agencies = loadAgencies();
  const agencyCount = Object.keys(agencies).length;
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  const authValid = isAuthenticated();

  const embed = new EmbedBuilder()
    .setTitle('Statut du bot')
    .setColor(authValid ? 0x34A853 : 0xDC3545)
    .addFields(
      { name: 'Uptime', value: `${hours}h ${minutes}m ${seconds}s`, inline: true },
      { name: 'Google Auth', value: authValid ? 'Valide' : 'Non configuré', inline: true },
      { name: 'Agences', value: String(agencyCount), inline: true },
    )
    .setTimestamp();

  if (agencyCount > 0) {
    const agencyList = Object.values(agencies).map((cfg) =>
      `**${cfg.name}** (max ${cfg.max_rdv_heure}/h) → <#${cfg.channel_id}>`
    ).join('\n');
    embed.addFields({ name: 'Agences configurées', value: agencyList, inline: false });
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ── Config ──

async function handleConfig(interaction) {
  await interaction.deferReply();
  const agenceName = interaction.options.getString('agence');
  const calendarId = interaction.options.getString('calendar_id');
  const spreadsheetId = interaction.options.getString('spreadsheet_id');
  const maxRdvHeure = interaction.options.getInteger('max_rdv_heure');
  const channelId = interaction.channelId;

  const sheetName = interaction.options.getString('sheet_name') || '';

  // If no sheet_name given, auto-detect by listing tabs
  let resolvedSheetName = sheetName;
  if (!resolvedSheetName) {
    try {
      const tabs = await sheets.listSheetTabs(spreadsheetId);
      console.log(`[CONFIG] Sheet tabs:`, tabs);
      // Use the first tab that isn't "TOTAUX" or similar summary tabs
      resolvedSheetName = tabs.find((t) => !t.toLowerCase().includes('totaux') && !t.toLowerCase().includes('résumé')) || tabs[0] || '';
    } catch (e) {
      console.error(`[CONFIG] Could not list tabs:`, e.message);
    }
  }

  const agencies = loadAgencies();

  // Un canal = une agence. Toute entrée déjà liée à ce canal est remplacée,
  // même si son nom diffère (ex: "PARIS 15" reconfigurée en "PARIS"),
  // sinon le bot continue d'utiliser la première entrée trouvée pour ce canal.
  const replaced = [];
  for (const [key, cfg] of Object.entries(agencies)) {
    if (cfg.channel_id === channelId && key !== agenceName.toLowerCase()) {
      replaced.push(cfg.name || key);
      delete agencies[key];
    }
  }

  agencies[agenceName.toLowerCase()] = {
    name: agenceName,
    calendar_id: calendarId,
    spreadsheet_id: spreadsheetId,
    max_rdv_heure: maxRdvHeure,
    granularite: 30,
    timezone: 'Europe/Paris',
    channel_id: channelId,
    sheet_name: resolvedSheetName,
  };
  saveAgencies(agencies);

  const embed = new EmbedBuilder()
    .setTitle(`Agence ${agenceName} configurée`)
    .setColor(0x34A853)
    .addFields(
      { name: 'Canal', value: `<#${channelId}>`, inline: true },
      { name: 'Max RDV/heure', value: String(maxRdvHeure), inline: true },
      { name: 'Calendrier', value: `\`${calendarId}\``, inline: false },
      { name: 'Spreadsheet', value: `\`${spreadsheetId}\``, inline: false },
      { name: 'Onglet', value: resolvedSheetName || '(premier onglet)', inline: false },
    )
    .setFooter({ text: 'Envoi auto agendas S & S+1 : 08h, 12h, 15h, 18h, 21h' })
    .setTimestamp();

  if (replaced.length > 0) {
    embed.addFields({
      name: 'Ancienne configuration remplacée',
      value: replaced.map((n) => `**${n}**`).join(', ') + ' (pause, horaires et plafond précédents perdus)',
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

// ── Deconfig ──

async function handleDeconfig(interaction) {
  const agency = getAgencyByChannel(interaction.channelId);
  if (!agency) return interaction.reply({ content: 'Ce canal n\'est lié à aucune agence.', ephemeral: true });

  const agencies = loadAgencies();
  delete agencies[agency.key];
  saveAgencies(agencies);
  await interaction.reply(`Agence **${agency.name}** supprimée de ce canal.`);
}

// ── Agences ──

async function handleAgences(interaction) {
  const agencies = loadAgencies();
  const entries = Object.entries(agencies);

  if (entries.length === 0) return interaction.reply({ content: 'Aucune agence configurée.', ephemeral: true });

  // Discord embed max 25 fields — use plain text list for 33+ agencies
  const lines = entries.map(([, cfg]) => {
    const status = cfg.paused ? '⏸️' : '▶️';
    return `${status} **${cfg.name}** — ${cfg.max_rdv_heure} RDV/h — <#${cfg.channel_id}>`;
  });

  // Split into chunks of 2000 chars (Discord message limit)
  const chunks = [];
  let current = '**Agences configurées :**\n\n';
  for (const line of lines) {
    if (current.length + line.length + 1 > 1900) {
      chunks.push(current);
      current = '';
    }
    current += line + '\n';
  }
  if (current) chunks.push(current);

  await interaction.reply(chunks[0]);
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp(chunks[i]);
  }
}

// ── Calendars ──

async function handleCalendars(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const calendars = await calendar.listCalendars();

  if (calendars.length === 0) return interaction.editReply('Aucun calendrier trouvé.');

  const lines = calendars.map((cal) => `**${cal.name}** → \`${cal.id}\``).join('\n');
  await interaction.editReply(`**Calendriers disponibles :**\n${lines}`);
}

// ── Pause / Play ──

async function handlePause(interaction) {
  await interaction.deferReply();
  const agency = requireAgency(interaction);
  if (!agency) return interaction.editReply('Ce canal n\'est lié à aucune agence.');

  const agencies = loadAgencies();
  if (!agencies[agency.key]) return interaction.editReply('Agence introuvable.');

  agencies[agency.key].paused = true;
  saveAgencies(agencies);

  await interaction.editReply(`⏸️ L'agence **${agency.name}** est maintenant **en pause**. Plus aucun RDV ne sera accepté jusqu'à \`/rdv play\`.`);
}

async function handlePlay(interaction) {
  await interaction.deferReply();
  const agency = requireAgency(interaction);
  if (!agency) return interaction.editReply('Ce canal n\'est lié à aucune agence.');

  const agencies = loadAgencies();
  if (!agencies[agency.key]) return interaction.editReply('Agence introuvable.');

  delete agencies[agency.key].paused;
  saveAgencies(agencies);

  await interaction.editReply(`▶️ L'agence **${agency.name}** est maintenant **active**. Les RDV sont de nouveau acceptés.`);
}

// ── Horaires ──

async function handleHoraires(interaction) {
  await interaction.deferReply();
  const agency = requireAgency(interaction);
  if (!agency) return interaction.editReply('Ce canal n\'est lié à aucune agence.');

  const agencies = loadAgencies();
  const cfg = agencies[agency.key];
  if (!cfg) return interaction.editReply('Agence introuvable.');

  // Initialize opening_hours if not set
  if (!cfg.opening_hours) cfg.opening_hours = {};

  const days = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
  let updated = false;

  for (const day of days) {
    const value = interaction.options.getString(day);
    if (value === null || value === undefined) continue;

    const jsDay = JOUR_MAP[day];
    const clean = value.trim().toLowerCase();

    if (clean === 'fermé' || clean === 'ferme' || clean === 'fermé' || clean === 'closed' || clean === 'off') {
      cfg.opening_hours[String(jsDay)] = 'fermé';
      updated = true;
    } else if (/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(clean)) {
      cfg.opening_hours[String(jsDay)] = clean;
      updated = true;
    } else {
      return interaction.editReply(`Format invalide pour **${day}**: "${value}". Utilisez HH:MM-HH:MM (ex: 09:00-19:00) ou "fermé".`);
    }
  }

  if (!updated) {
    // No options provided — show current schedule
    const lines = days.map((day) => {
      const jsDay = JOUR_MAP[day];
      const schedule = cfg.opening_hours[String(jsDay)];
      if (!schedule || schedule === 'fermé') return `**${day.charAt(0).toUpperCase() + day.slice(1)}** : Fermé`;
      return `**${day.charAt(0).toUpperCase() + day.slice(1)}** : ${schedule}`;
    });

    return interaction.editReply(`**Horaires de ${agency.name} :**\n${lines.join('\n')}\n\nPour modifier: \`/rdvadmin horaires samedi:fermé dimanche:fermé lundi:09:00-19:00\``);
  }

  saveAgencies(agencies);

  const lines = days.map((day) => {
    const jsDay = JOUR_MAP[day];
    const schedule = cfg.opening_hours[String(jsDay)];
    if (!schedule || schedule === 'fermé') return `**${day.charAt(0).toUpperCase() + day.slice(1)}** : Fermé`;
    return `**${day.charAt(0).toUpperCase() + day.slice(1)}** : ${schedule}`;
  });

  await interaction.editReply(`**Horaires mis à jour pour ${agency.name} :**\n${lines.join('\n')}`);
}

module.exports = { data, execute };

module.exports = { data, execute };
