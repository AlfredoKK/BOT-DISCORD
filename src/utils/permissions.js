const { PermissionFlagsBits } = require('discord.js');

// Rôle(s) autorisés à utiliser /rdvadmin.
// - ADMIN_ROLE_IDS : liste d'IDs de rôles séparés par des virgules (recommandé)
// - ADMIN_ROLE_NAME : nom du rôle (défaut "admin", insensible à la casse)
// Les membres ayant la permission Discord "Administrateur" passent toujours.
function getAdminRoleIds() {
  return String(process.env.ADMIN_ROLE_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

function getAdminRoleName() {
  return String(process.env.ADMIN_ROLE_NAME || 'admin').trim().toLowerCase();
}

// Un nom de rôle correspond s'il est égal au nom configuré (après trim + minuscules),
// ou s'il commence par ce nom et ne continue que par des lettres : "Admin", "ADMIN",
// "Admins", "Administrateur", "Administrator" passent ; "Admin Support", "superadmin"
// ou "admin-stagiaire" ne passent pas.
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
  const allowedName = getAdminRoleName();

  return roles.some((role) =>
    allowedIds.includes(role.id) || roleNameMatches(role.name, allowedName)
  );
}

async function requireAdmin(interaction) {
  if (isAdmin(interaction.member)) return true;

  // Trace le refus pour pouvoir diagnostiquer un "Commande réservée aux administrateurs".
  const who = interaction.user?.tag || interaction.user?.id || 'inconnu';
  const roleNames = interaction.member?.roles?.cache?.map?.((r) => r.name) || [];
  console.warn(
    `[Permissions] /${interaction.commandName} refusé pour ${who} (guild ${interaction.guildId || '?'}) — rôles: ${roleNames.join(', ') || 'aucun'} ; attendu: ADMIN_ROLE_NAME="${getAdminRoleName()}"${getAdminRoleIds().length ? ` ou ADMIN_ROLE_IDS=${getAdminRoleIds().join(',')}` : ''}`
  );

  const msg = 'Commande réservée aux administrateurs.';
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content: msg }).catch(() => {});
  } else {
    await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
  }
  return false;
}

module.exports = { isAdmin, requireAdmin, roleNameMatches, getAdminRoleIds, getAdminRoleName };
