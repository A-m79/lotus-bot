const { EmbedBuilder } = require("discord.js");
const config = require("../config/config");
const SecurityLog = require("../models/SecurityLog");

const activePunishments = new Set();

const SEVERE_ACTIONS = [
  "CHANNEL_DELETE",
  "CHANNEL_UPDATE",
  "ROLE_DELETE",
  "MEMBER_BAN",
  "MEMBER_KICK",
  "WEBHOOK_CREATE",
  "BOT_ADD",
  "DANGEROUS_ROLE_UPDATE",
  "ROLE_NUKE",
  "ALT_DETECTION",
  "ANTI_RAID",
  "PANIC_MODE",
  "EMOJI_DELETE",
  "STICKER_DELETE",
  "GUILD_UPDATE",
];

function normalizeActionType(str) {
  return String(str).replace(/_/g, "").toUpperCase();
}

function isSevereAction(actionType) {
  const normalized = normalizeActionType(actionType);
  return SEVERE_ACTIONS.some((a) => normalizeActionType(a) === normalized);
}

function generateCaseId() {
  return `CASE-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
}

async function punish({
  guild,
  guildConfig,
  executorId,
  actionType,
  reason,
  details = {},
  customSanction = null,
}) {
  if (activePunishments.has(executorId)) return null;

  activePunishments.add(executorId);
  setTimeout(() => activePunishments.delete(executorId), 10000);

  const caseId = generateCaseId();
  const punishment = customSanction || guildConfig?.punishment || config.DEFAULT_PUNISHMENT;

  let member = null;
  let targetUser = null;

  try {
    member = await guild.members.fetch(executorId).catch(() => null);
    targetUser = member
      ? member.user
      : await guild.client.users.fetch(executorId).catch(() => null);
  } catch {}

  let punishmentApplied = "none";
  let statusIcon = "⚙️";
  let success = false;

  const me = await guild.members.fetchMe().catch(() => guild.members.me);
  const canManageTarget =
    member &&
    member.id !== guild.ownerId &&
    me &&
    me.roles.highest.position > member.roles.highest.position;

  try {
    if (member && canManageTarget) {
      switch (punishment) {
        case "ban":
          await guild.members.ban(executorId, { reason: `[Lotus #${caseId}] ${reason}` });
          punishmentApplied = "BAN (Bannissement définitif)";
          statusIcon = "🔨";
          success = true;
          break;

        case "kick":
          await member.kick(`[Lotus #${caseId}] ${reason}`);
          punishmentApplied = "KICK (Exclusion du serveur)";
          statusIcon = "🥾";
          success = true;
          break;

        case "timeout":
          const timeoutRoles = guildConfig?.quarantineRoleId ? [guildConfig.quarantineRoleId] : [];
          await member.roles.set(timeoutRoles, `[Lotus #${caseId}] Retrait des rôles + Isolement`);
          await new Promise((resolve) => setTimeout(resolve, 1500));
          await member.timeout(24 * 60 * 60 * 1000, `[Lotus #${caseId}] ${reason}`);
          punishmentApplied = "STRIP_ROLES + TIMEOUT (24h)";
          statusIcon = "☣️";
          success = true;
          break;

        case "quarantine":
          if (guildConfig?.quarantineRoleId) {
            const currentRoles = member.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.id);
            details.previousRoles = currentRoles;
            await member.roles.set([guildConfig.quarantineRoleId], `[Lotus #${caseId}] ${reason}`);
            punishmentApplied = "QUARANTAINE (Isolement)";
            statusIcon = "☣️";
          } else {
            await member.roles.set([], `[Lotus #${caseId}] ${reason}`);
            punishmentApplied = "STRIP_ROLES (Fallback: Pas de rôle Quarantaine)";
            statusIcon = "⚠️";
          }
          success = true;
          break;

        case "stripRoles":
        default:
          if (guildConfig?.quarantineRoleId) {
            await member.roles.set([guildConfig.quarantineRoleId], `[Lotus #${caseId}] ${reason}`);
            punishmentApplied = "STRIP_ROLES + ISOLEMENT";
            statusIcon = "☣️";
          } else {
            await member.roles.set([], `[Lotus #${caseId}] ${reason}`);
            punishmentApplied = "STRIP_ROLES (Retrait de tous les rôles)";
            statusIcon = "🚫";
          }
          success = true;
          break;
      }
    } else if (member && !canManageTarget) {
      punishmentApplied = "ÉCHEC (Hiérarchie : Le rôle du bot est trop bas)";
      statusIcon = "❌";
    } else if (punishment === "ban") {
      await guild.members.ban(executorId, { reason: `[Lotus #${caseId}] ${reason}` });
      punishmentApplied = "BAN (Bannissement à distance)";
      statusIcon = "🔨";
      success = true;
    }
  } catch (err) {
    console.error(`[Punisher #${caseId}] Erreur execution sur ${executorId}:`, err.message);
    punishmentApplied = `ERREUR : ${err.message}`;
    statusIcon = "⚠️";
  }

  // Notification MP au suspect
  if (targetUser && !targetUser.bot && success) {
    const dmEmbed = new EmbedBuilder()
      .setColor("#FF2A2A")
      .setTitle(`🛡️ Protection Lotus Security — ${guild.name}`)
      .setDescription(`Votre compte a déclenché une alerte de sécurité.`)
      .addFields(
        { name: "Raison", value: `\`${reason}\``, inline: false },
        { name: "Sanction", value: `\`${punishmentApplied}\``, inline: true },
        { name: "Dossier ID", value: `\`#${caseId}\``, inline: true }
      )
      .setFooter({ text: "Si vous pensez qu'il s'agit d'une erreur, contactez un administrateur." })
      .setTimestamp();

    await targetUser.send({ embeds: [dmEmbed] }).catch(() => null);
  }

  // Historisation MongoDB
  await SecurityLog.create({
    caseId,
    guildId: guild.id,
    type: actionType,
    executorId,
    details,
    reason,
    punishmentApplied,
    timestamp: new Date(),
  }).catch((err) => console.error("[SecurityLog DB Error]:", err));

  // Logs salon ou Fallback DM au proprio si le salon de log est introuvable
  const targetChannelId = guildConfig?.logChannelId || guildConfig?.alertChannelId;
  let logSent = false;

  const embed = new EmbedBuilder()
    .setColor(success ? "#FF2A2A" : "#FFCC00")
    .setAuthor({ name: "LOTUS SECURITY SYSTEM", iconURL: guild.iconURL({ dynamic: true }) || undefined })
    .setTitle(`${statusIcon} ${success ? "Menace Neutralisée" : "Alerte Sécurité"} — #${caseId}`)
    .setDescription(`> **Motif :** \`${reason}\``)
    .addFields(
      { name: "👤 Utilisateur", value: targetUser ? `${targetUser}\n\`${targetUser.tag}\`\n\`ID: ${executorId}\`` : `\`ID: ${executorId}\``, inline: true },
      { name: "🛡️ Détecteur", value: `\`${actionType.toUpperCase()}\``, inline: true },
      { name: "⚡ Sanction", value: `\`${punishmentApplied}\``, inline: true }
    )
    .setFooter({ text: `Lotus Security System • Case #${caseId}` })
    .setTimestamp();

  if (targetChannelId) {
    const channel = await guild.channels.fetch(targetChannelId).catch(() => null);
    if (channel?.isTextBased()) {
      const messageContent = isSevereAction(actionType) ? "🚨 @here **Alerte Sécurité Majeure Détectée !**" : undefined;
      await channel.send({ content: messageContent, embeds: [embed] }).catch(() => null);
      logSent = true;
    }
  }

  // Fallback DM au Propriétaire si salon de logs indisponible ou action sévère
  if (!logSent || isSevereAction(actionType)) {
    const owner = await guild.fetchOwner().catch(() => null);
    if (owner) {
      await owner.send({ content: `🚨 **Alerte Sécurité sur ${guild.name}**`, embeds: [embed] }).catch(() => null);
    }
  }

  return { caseId, punishmentApplied };
}

module.exports = { punish };