const { PermissionFlagsBits } = require('discord.js');

// Rôles autorisés à utiliser /rdvadmin.
// - Par défaut : les rôles nommés "admin" et "team lead" (comparaison insensible à la casse,
//   voir roleNameMatches pour les variantes acceptées comme "Admins" ou "Administrateur").
// - ADMIN_ROLE_NAME : noms supplémentaires, séparés par des virgules (ajoutés aux défauts).
// - ADMIN_ROLE_IDS : IDs de rôles, séparés par des virgules (le plus sûr).
// Les membres ayant la permission Discord "Administrateur" passent toujours.
const DEFAULT_ADMIN_ROLE_NAMES = ['admin', 'team lead'];

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function getAdminRoleIds() {
  return String(process.env.ADMIN_ROLE_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

function getAdminRoleNames() {
  return Array.from(new Set([...DEFAULT_ADMIN_ROLE_NAMES, ...splitList(process.env.ADMIN_ROLE_NAME)]));
}

// Conservé pour compatibilité : premier nom de la liste.
function getAdminRoleName() {
  return getAdminRoleNames()[0];
}

// Un nom de rôle correspond s'il est égal à un nom autorisé (après trim + minuscules),
// ou s'il commence par ce nom et ne continue que par des lettres : "Admin", "ADMIN",
// "Admins", "Administrateur", "Team Lead", "Team Leader" passent ;
// "Admin Support", "superadmin", "admin-stagiaire" ou "Team Laura" ne passent pas.
function roleNameMatches(roleName, allowedName) {
  const name = String(roleName || '').trim().toLowerCase();
  if (!allowedName || !name) return false;
  if (name === allowedName) return true;
  if (!name.startsWith(allowedName)) return false;
  return /^[\p{L}]+$/u.test(name.slice(allowedName.length));
}

function isAdmin(member) {
  if (!member) return false;

  if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;

  const roles = member.roles?.cache;
  if (!roles) return false;

  const allowedIds = getAdminRoleIds();
  const allowedNames = getAdminRoleNames();

  return roles.some((role) =>
    allowedIds.includes(role.id) || allowedNames.some((allowed) => roleNameMatches(role.name, allowed))
  );
}

async function requireAdmin(interaction) {
  if (isAdmin(interaction.member)) return true;

  // Trace le refus pour pouvoir diagnostiquer un "Commande réservée aux administrateurs".
  const who = interaction.user?.tag || interaction.user?.id || 'inconnu';
  const roleNames = interaction.member?.roles?.cache?.map?.((r) => r.name) || [];
  console.warn(
    `[Permissions] /${interaction.commandName} refusé pour ${who} (guild ${interaction.guildId || '?'}) — rôles: ${roleNames.join(', ') || 'aucun'} ; attendu: rôles ${getAdminRoleNames().map((n) => `"${n}"`).join(' ou ')}${getAdminRoleIds().length ? ` ou ADMIN_ROLE_IDS=${getAdminRoleIds().join(',')}` : ''}`
  );

  try {
    const { notifyOps } = require('../services/alerts');
    notifyOps({
      kind: 'Refus de permission',
      message: `${who} a tenté /${interaction.commandName}${interaction.options?.getSubcommand?.(false) ? ` ${interaction.options.getSubcommand(false)}` : ''} sans rôle autorisé.`,
      context: { commande: interaction.commandName, sousCommande: interaction.options?.getSubcommand?.(false) || '', utilisateur: who, channelId: interaction.channelId, conseil: `Rôles de la personne : ${roleNames.join(', ') || 'aucun'}. Rôles acceptés : ${getAdminRoleNames().join(', ')}.` },
      client: interaction.client,
    }).catch(() => {});
  } catch { /* jamais bloquant */ }

  const msg = 'Commande réservée aux administrateurs.';
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content: msg }).catch(() => {});
  } else {
    await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
  }
  return false;
}

module.exports = { isAdmin, requireAdmin, roleNameMatches, getAdminRoleIds, getAdminRoleName, getAdminRoleNames, DEFAULT_ADMIN_ROLE_NAMES };
