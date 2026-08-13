const { EmbedBuilder, PermissionFlagsBits, ChannelType } = require("discord.js");
const config = require("../config/config");
const SecurityLog = require("../models/SecurityLog");

const activePunishments = new Set();

const SEVERE_ACTIONS = [
  "CHANNEL_DELETE",
  "CHANNEL_CREATE",
  "CHANNEL_UPDATE",
  "ROLE_DELETE",
  "ROLE_CREATE",
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

/**
 * Assure l'existence du Rôle et du Salon de Quarantaine
 */
async function ensureQuarantineSetup(guild) {
  let quarantineRole = guild.roles.cache.find((r) => r.name === "Lotus Quarantaine");
  if (!quarantineRole) {
    quarantineRole = await guild.roles.create({
      name: "Lotus Quarantaine",
      color: "#2f3136",
      reason: "Création automatique du rôle de quarantaine Lotus Security",
    }).catch(() => null);
  }

  let quarantineChannel = guild.channels.cache.find(
    (c) => c.name === "🔒-quarantaine" && c.type === ChannelType.GuildText
  );

  if (!quarantineChannel && quarantineRole) {
    quarantineChannel = await guild.channels.create({
      name: "🔒-quarantaine",
      type: ChannelType.GuildText,
      permissionOverwrites: [
        {
          id: guild.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: quarantineRole.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AddReactions,
            PermissionFlagsBits.CreatePublicThreads,
            PermissionFlagsBits.CreatePrivateThreads,
            PermissionFlagsBits.SendMessagesInThreads,
            PermissionFlagsBits.UseApplicationCommands,
            PermissionFlagsBits.Speak,
          ],
        },
        {
          id: guild.client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ManageChannels,
          ],
        },
      ],
      reason: "Création automatique du salon d'isolement Lotus Security",
    }).catch(() => null);

    if (quarantineChannel) {
      const infoEmbed = new EmbedBuilder()
        .setTitle("🔒 Zone de Confinement — Lotus Security")
        .setColor("#2b2d31")
        .setDescription(
          "**Ce salon est un espace d'isolement sécurisé.**\n\n" +
          "Si vous avez accès à ce salon, votre compte a été placé en **quarantaine automatique** suite à un déclenchement du système de sécurité.\n\n" +
          "• **Accès Restreint :** Vous ne pouvez ni envoyer de messages, ni interagir avec le serveur.\n" +
          "• **Visibilité Staff :** Les administrateurs peuvent vous identifier et examiner votre situation ici.\n\n" +
          "*Veuillez patienter qu'un administrateur traite votre dossier.*"
        )
        .setFooter({ text: "Lotus Security System • Zone restreinte" });

      const pinnedMsg = await quarantineChannel.send({ embeds: [infoEmbed] }).catch(() => null);
      if (pinnedMsg) await pinnedMsg.pin().catch(() => null);
    }
  }

  return { quarantineRole, quarantineChannel };
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

  // Garantir l'existence de la quarantaine si nécessaire
  const { quarantineRole } = await ensureQuarantineSetup(guild);
  const qRoleId = guildConfig?.quarantineRoleId || quarantineRole?.id;

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
          const timeoutRoles = qRoleId ? [qRoleId] : [];
          await member.roles.set(timeoutRoles, `[Lotus #${caseId}] Retrait des rôles + Isolement`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
          await member.timeout(24 * 60 * 60 * 1000, `[Lotus #${caseId}] ${reason}`);
          punishmentApplied = "STRIP_ROLES + TIMEOUT (24h)";
          statusIcon = "☣️";
          success = true;
          break;

        case "quarantine":
          if (qRoleId) {
            const currentRoles = member.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.id);
            details.previousRoles = currentRoles;
            await member.roles.set([qRoleId], `[Lotus #${caseId}] ${reason}`);
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
          if (qRoleId) {
            await member.roles.set([qRoleId], `[Lotus #${caseId}] ${reason}`);
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

  // Construction de l'Embed de Log
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

  // Logs salon principal (#logs-lotus / #alertes-lotus)
  const targetChannelId = guildConfig?.logChannelId || guildConfig?.alertChannelId;
  let logSent = false;

  if (targetChannelId) {
    const channel = await guild.channels.fetch(targetChannelId).catch(() => null);
    if (channel?.isTextBased()) {
      const messageContent = isSevereAction(actionType) ? "🚨 @here **Alerte Sécurité Majeure Détectée !**" : undefined;
      await channel.send({ content: messageContent, embeds: [embed] }).catch(() => null);
      logSent = true;
    }
  }

  // Fallback DM Propriétaire
  if (!logSent || isSevereAction(actionType)) {
    const owner = await guild.fetchOwner().catch(() => null);
    if (owner) {
      await owner.send({ content: `🚨 **Alerte Sécurité sur ${guild.name}**`, embeds: [embed] }).catch(() => null);
    }
  }

  return { caseId, punishmentApplied };
}

module.exports = { punish, ensureQuarantineSetup };