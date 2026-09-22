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

function isAdmin(member) {
  if (!member) return false;

  if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;

  const roles = member.roles?.cache;
  if (!roles) return false;

  const allowedIds = getAdminRoleIds();
  const allowedName = getAdminRoleName();

  return roles.some((role) =>
    allowedIds.includes(role.id) || role.name.trim().toLowerCase() === allowedName
  );
}

async function requireAdmin(interaction) {
  if (isAdmin(interaction.member)) return true;

  const msg = 'Commande réservée aux administrateurs.';
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content: msg }).catch(() => {});
  } else {
    await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
  }
  return false;
}

module.exports = { isAdmin, requireAdmin, getAdminRoleIds, getAdminRoleName };
