const { AuditLogEvent } = require("discord.js");
const config = require("../config/config");
const rateTracker = require("../utils/rateTracker");
const { getExecutor } = require("../utils/getExecutor");
const { getGuildConfig } = require("../utils/configCache");
const { punish } = require("./punisher");

/**
 * Retourne le seuil effectif pour une action donnée (config serveur > défaut global)
 */
function getThreshold(guildConfig, actionType) {
  return (
    guildConfig?.thresholds?.[actionType] ??
    config.DEFAULT_THRESHOLDS[actionType]
  );
}

/**
 * Vrai si l'ID est whitelisté (jamais sanctionné, même owner/bot lui-même)
 */
function isWhitelisted(guild, guildConfig, userId) {
  if (userId === guild.ownerId) return true;
  if (userId === guild.client.user.id) return true;
  if (process.env.OWNER_ID && userId === process.env.OWNER_ID) return true;
  return guildConfig?.whitelist?.includes(userId) ?? false;
}

/**
 * Fonction centrale : incrémente le compteur, compare au seuil, sanctionne si dépassé.
 * Retourne true si une sanction a été appliquée (permet d'éviter les triggers redondants).
 */
async function checkAndPunish({ guild, executorId, actionType, reasonLabel, details }) {
  const guildConfig = await getGuildConfig(guild.id);

  if (!guildConfig.antiNukeEnabled) return false;
  if (isWhitelisted(guild, guildConfig, executorId)) return false;

  const threshold = getThreshold(guildConfig, actionType);
  const count = rateTracker.hit(guild.id, executorId, actionType, config.ANTINUKE_WINDOW_MS);

  if (count >= threshold) {
    rateTracker.reset(guild.id, executorId, actionType);
    await punish({
      guild,
      guildConfig,
      executorId,
      actionType,
      reason: `${reasonLabel} (${count}/${threshold} en ${config.ANTINUKE_WINDOW_MS / 1000}s)`,
      details,
    });
    return true;
  }

  return false;
}

function registerAntiNuke(client) {
  // --- Suppression de salons ---
  client.on("channelDelete", async (channel) => {
    if (!channel.guild) return;
    const executor = await getExecutor(
      channel.guild,
      AuditLogEvent.ChannelDelete,
      channel.id
    );
    if (!executor) return;

    await checkAndPunish({
      guild: channel.guild,
      executorId: executor.id,
      actionType: "channelDelete",
      reasonLabel: "Suppression massive de salons",
      details: { channelId: channel.id, channelName: channel.name },
    });
  });

  // --- Création massive de salons (spam / préparation de nuke) ---
  client.on("channelCreate", async (channel) => {
    if (!channel.guild) return;
    const executor = await getExecutor(
      channel.guild,
      AuditLogEvent.ChannelCreate,
      channel.id
    );
    if (!executor) return;

    await checkAndPunish({
      guild: channel.guild,
      executorId: executor.id,
      actionType: "channelCreate",
      reasonLabel: "Création massive de salons",
      details: { channelId: channel.id, channelName: channel.name },
    });
  });

  // --- Suppression de rôles ---
  // (fusionné avec l'ancien module antiRoleNuke.js pour éviter le double-tracking :
  // ce handler seul gère désormais roleDelete, avec la whitelist complète et le
  // check antiNukeEnabled que l'ancien module n'avait pas)
  client.on("roleDelete", async (role) => {
    const executor = await getExecutor(role.guild, AuditLogEvent.RoleDelete, role.id);
    if (!executor) return;

    await checkAndPunish({
      guild: role.guild,
      executorId: executor.id,
      actionType: "roleDelete",
      reasonLabel: "Suppression massive de rôles",
      details: { roleId: role.id, roleName: role.name },
    });
  });

  // --- Création massive de rôles ---
  // (idem : reprend ce que faisait antiRoleNuke.js sur roleCreate, mais via le
  // pipeline commun checkAndPunish plutôt qu'un tracker parallèle indépendant)
  client.on("roleCreate", async (role) => {
    const executor = await getExecutor(role.guild, AuditLogEvent.RoleCreate, role.id);
    if (!executor) return;

    await checkAndPunish({
      guild: role.guild,
      executorId: executor.id,
      actionType: "roleCreate",
      reasonLabel: "Création massive de rôles",
      details: { roleId: role.id, roleName: role.name },
    });
  });

  // --- Bans en masse ---
  client.on("guildBanAdd", async (ban) => {
    const executor = await getExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    if (!executor) return;

    await checkAndPunish({
      guild: ban.guild,
      executorId: executor.id,
      actionType: "memberBan",
      reasonLabel: "Bans en masse",
      details: { targetId: ban.user.id },
    });
  });

  // --- Kicks en masse (détecté via memberRemove + audit log Kick) ---
  client.on("guildMemberRemove", async (member) => {
    const executor = await getExecutor(member.guild, AuditLogEvent.MemberKick, member.id, 3000);
    if (!executor) return; // pas de kick correspondant -> départ volontaire, on ignore

    await checkAndPunish({
      guild: member.guild,
      executorId: executor.id,
      actionType: "memberKick",
      reasonLabel: "Kicks en masse",
      details: { targetId: member.id },
    });
  });

  // --- Création massive de webhooks ---
  client.on("webhooksUpdate", async (channel) => {
    const executor = await getExecutor(
      channel.guild,
      AuditLogEvent.WebhookCreate,
      undefined,
      3000
    );
    if (!executor) return;

    await checkAndPunish({
      guild: channel.guild,
      executorId: executor.id,
      actionType: "webhookCreate",
      reasonLabel: "Création massive de webhooks",
      details: { channelId: channel.id },
    });
  });

  // --- Ajout d'un bot non whitelisté = sanction immédiate (seuil = 1 par défaut) ---
  client.on("guildMemberAdd", async (member) => {
    if (!member.user.bot) return;

    const executor = await getExecutor(
      member.guild,
      AuditLogEvent.BotAdd,
      member.id,
      5000
    );
    if (!executor) return;

    await checkAndPunish({
      guild: member.guild,
      executorId: executor.id,
      actionType: "botAdd",
      reasonLabel: "Ajout d'un bot non autorisé",
      details: { botId: member.id, botTag: member.user.tag },
    });
  });

  // --- Attribution de permissions dangereuses à un rôle (ex: Administrator) ---
  client.on("roleUpdate", async (oldRole, newRole) => {
    const gainedDangerous = config.DANGEROUS_PERMISSIONS.some(
      (perm) => !oldRole.permissions.has(perm) && newRole.permissions.has(perm)
    );
    if (!gainedDangerous) return;

    const executor = await getExecutor(
      newRole.guild,
      AuditLogEvent.RoleUpdate,
      newRole.id,
      3000
    );
    if (!executor) return;

    await checkAndPunish({
      guild: newRole.guild,
      executorId: executor.id,
      actionType: "dangerousRoleUpdate",
      reasonLabel: `Attribution de permissions dangereuses au rôle ${newRole.name}`,
      details: { roleId: newRole.id },
    });
  });

  // --- Attribution d'un rôle dangereux directement à un membre ---
  client.on("guildMemberUpdate", async (oldMember, newMember) => {
    const oldRoles = oldMember.roles.cache;
    const newRoles = newMember.roles.cache;

    const addedRoles = newRoles.filter((r) => !oldRoles.has(r.id));
    const gainedDangerousRole = addedRoles.some((r) =>
      config.DANGEROUS_PERMISSIONS.some((perm) => r.permissions.has(perm))
    );
    if (!gainedDangerousRole) return;

    const executor = await getExecutor(
      newMember.guild,
      AuditLogEvent.MemberRoleUpdate,
      newMember.id,
      3000
    );
    if (!executor) return;

    await checkAndPunish({
      guild: newMember.guild,
      executorId: executor.id,
      actionType: "dangerousRoleUpdate",
      reasonLabel: `Attribution d'un rôle dangereux à ${newMember.user.tag}`,
      details: { targetId: newMember.id },
    });
  });

  console.log("[AntiNuke] Module chargé et event listeners actifs.");
}

module.exports = { registerAntiNuke };
