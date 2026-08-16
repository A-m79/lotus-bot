const {
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const config = require("../config/config");
const SecurityLog = require("../models/SecurityLog");
const GuildConfig = require("../models/GuildConfig");

const activePunishments = new Set();

// Temporary storage for admin roles removed during a timeout, allowing
// the owner to restore them via the button sent in DM. Key: `${guildId}_${executorId}`.
const savedAdminRoles = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, data] of savedAdminRoles.entries()) {
    if (now > data.expiresAt) savedAdminRoles.delete(key);
  }
}, 60 * 60 * 1000);

const SEVERE_ACTIONS = [
  "CHANNEL_DELETE",
  "CHANNEL_CREATE",
  "CHANNEL_UPDATE",
  "ROLE_DELETE",
  "ROLE_CREATE",
  "MEMBER_BAN",
  "MEMBER_KICK",
  "MEMBER_PRUNE",
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
  "OWNERSHIP_TRANSFER",
  "PHISHING_LINK",
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
 * Ensures the Quarantine Role and Channel exist
 */
async function ensureQuarantineSetup(guild) {
  let quarantineRole = guild.roles.cache.find((r) => r.name === "Lotus Quarantine");
  if (!quarantineRole) {
    quarantineRole = await guild.roles.create({
      name: "Lotus Quarantine",
      color: "#2f3136",
      reason: "Automatic creation of the Lotus Security quarantine role",
    }).catch(() => null);
  }

  let quarantineChannel = guild.channels.cache.find(
    (c) => c.name === "🔒-quarantine" && c.type === ChannelType.GuildText
  );

  if (!quarantineChannel && quarantineRole) {
    quarantineChannel = await guild.channels.create({
      name: "🔒-quarantine",
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
      reason: "Automatic creation of the Lotus Security isolation channel",
    }).catch(() => null);

    if (quarantineChannel) {
      const infoEmbed = new EmbedBuilder()
        .setTitle("🔒 Containment Zone — Lotus Security")
        .setColor("#2b2d31")
        .setDescription(
          "**This channel is a secure isolation space.**\n\n" +
          "If you have access to this channel, your account has been placed in **automatic quarantine** following a security system trigger.\n\n" +
          "• **Restricted Access:** You cannot send messages or interact with the server.\n" +
          "• **Staff Visibility:** Administrators can identify you and review your situation here.\n\n" +
          "*Please wait for an administrator to handle your case.*"
        )
        .setFooter({ text: "Lotus Security System • Restricted Zone" });

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
  let adminRoleRemoved = false;
  // Fix (leave/rejoin quarantine bypass): tracks whether this call actually
  // placed the member into the isolation role, so we know to persist it below.
  let appliedQuarantine = false;

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
          punishmentApplied = "BAN (Permanent ban)";
          statusIcon = "🔨";
          success = true;
          break;

        case "kick":
          await member.kick(`[Lotus #${caseId}] ${reason}`);
          punishmentApplied = "KICK (Removed from server)";
          statusIcon = "🥾";
          success = true;
          break;

        case "timeout": {
          const hasAdminPerm = member.permissions.has(PermissionFlagsBits.Administrator);

          if (hasAdminPerm) {
            const adminRoleIds = member.roles.cache
              .filter((role) => role.permissions.has(PermissionFlagsBits.Administrator) && role.id !== guild.id)
              .map((r) => r.id);

            details.previousRoles = member.roles.cache
              .filter((r) => r.id !== guild.id)
              .map((r) => r.id);

            const safeRoles = member.roles.cache.filter(
              (role) => !role.permissions.has(PermissionFlagsBits.Administrator) && role.id !== guild.id
            );

            await member.roles.set(safeRoles, `[Lotus #${caseId}] Admin permission removed to apply Timeout`);
            await new Promise((resolve) => setTimeout(resolve, 1000));

            savedAdminRoles.set(`${guild.id}_${executorId}`, {
              roleIds: adminRoleIds,
              expiresAt: Date.now() + 24 * 60 * 60 * 1000,
            });
            adminRoleRemoved = adminRoleIds.length > 0;
          }

          await member.timeout(10 * 60 * 1000, `[Lotus #${caseId}] ${reason}`);

          punishmentApplied = hasAdminPerm
            ? "REMOVED_ADMIN_ROLE + TIMEOUT (10m)"
            : "TIMEOUT (10 minutes)";
          statusIcon = "⏰";
          success = true;
          break;
        }

        case "quarantine":
          if (qRoleId) {
            const currentRoles = member.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.id);
            details.previousRoles = currentRoles;
            await member.roles.set([qRoleId], `[Lotus #${caseId}] ${reason}`);
            punishmentApplied = "QUARANTINE (Isolation)";
            statusIcon = "☣️";
            appliedQuarantine = true;
          } else {
            await member.roles.set([], `[Lotus #${caseId}] ${reason}`);
            punishmentApplied = "STRIP_ROLES (Fallback: No Quarantine role)";
            statusIcon = "⚠️";
          }
          success = true;
          break;

        case "stripRoles":
        default:
          if (qRoleId) {
            await member.roles.set([qRoleId], `[Lotus #${caseId}] ${reason}`);
            punishmentApplied = "STRIP_ROLES + ISOLATION";
            statusIcon = "☣️";
            appliedQuarantine = true;
          } else {
            await member.roles.set([], `[Lotus #${caseId}] ${reason}`);
            punishmentApplied = "STRIP_ROLES (All roles removed)";
            statusIcon = "🚫";
          }
          success = true;
          break;
      }
    } else if (member && !canManageTarget) {
      punishmentApplied = "FAILED (Hierarchy: Bot's role is too low)";
      statusIcon = "❌";
    } else if (punishment === "ban") {
      await guild.members.ban(executorId, { reason: `[Lotus #${caseId}] ${reason}` });
      punishmentApplied = "BAN (Remote ban)";
      statusIcon = "🔨";
      success = true;
    }
  } catch (err) {
    console.error(`[Punisher #${caseId}] Execution error on ${executorId}:`, err.message);
    punishmentApplied = `ERROR: ${err.message}`;
    statusIcon = "⚠️";
  }

  // Fix (leave/rejoin quarantine bypass): persist quarantine state in the
  // database (not in Discord roles, which are wiped on leave) so that
  // verificationGate.js can re-quarantine the member instantly if they
  // leave and rejoin instead of letting them redo the captcha.
  if (appliedQuarantine) {
    await GuildConfig.updateOne(
      { guildId: guild.id },
      { $addToSet: { quarantinedUserIds: executorId } }
    ).catch((err) => console.error(`[Punisher #${caseId}] Failed to persist quarantine state:`, err.message));
  }

  if (targetUser && !targetUser.bot && success) {
    const dmEmbed = new EmbedBuilder()
      .setColor("#FF2A2A")
      .setTitle(`🛡️ Protection Lotus Security — ${guild.name}`)
      .setDescription(`Your account has triggered a security alert.`)
      .addFields(
        { name: "Reason", value: `\`${reason}\``, inline: false },
        { name: "Punishment", value: `\`${punishmentApplied}\``, inline: true },
        { name: "Case ID", value: `\`#${caseId}\``, inline: true }
      )
      .setFooter({ text: "If you believe this is a mistake, contact an administrator." })
      .setTimestamp();

    await targetUser.send({ embeds: [dmEmbed] }).catch(() => null);
  }

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

  const embed = new EmbedBuilder()
    .setColor(success ? "#FF2A2A" : "#FFCC00")
    .setAuthor({ name: "LOTUS SECURITY SYSTEM", iconURL: guild.iconURL({ dynamic: true }) || undefined })
    .setTitle(`${statusIcon} ${success ? "Threat Neutralized" : "Security Alert"} — #${caseId}`)
    .setDescription(`> **Reason:** \`${reason}\``)
    .addFields(
      { name: "👤 User", value: targetUser ? `${targetUser}\n\`${targetUser.tag}\`\n\`ID: ${executorId}\`` : `\`ID: ${executorId}\``, inline: true },
      { name: "🛡️ Detector", value: `\`${actionType.toUpperCase()}\``, inline: true },
      { name: "⚡ Punishment", value: `\`${punishmentApplied}\``, inline: true }
    )
    .setFooter({ text: `Lotus Security System • Case #${caseId}` })
    .setTimestamp();

  const targetChannelId = guildConfig?.logChannelId || guildConfig?.alertChannelId;
  let logSent = false;

  if (targetChannelId) {
    const channel = await guild.channels.fetch(targetChannelId).catch(() => null);
    if (channel?.isTextBased()) {
      const messageContent = isSevereAction(actionType) ? "🚨 @here **Major Security Alert Detected!**" : undefined;
      await channel.send({ content: messageContent, embeds: [embed] }).catch(() => null);
      logSent = true;
    }
  }

  if (!logSent || isSevereAction(actionType)) {
    const owner = await guild.fetchOwner().catch(() => null);
    if (owner) {
      await owner.send({ content: `🚨 **Security Alert on ${guild.name}**`, embeds: [embed] }).catch(() => null);
    }
  }

  if (adminRoleRemoved) {
    const restoreButton = new ButtonBuilder()
      .setCustomId(`restore_admin_${guild.id}_${executorId}`)
      .setLabel(`Restore admin role for ${targetUser?.username ?? executorId}`)
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🔄");

    const row = new ActionRowBuilder().addComponents(restoreButton);

    const restoreEmbed = new EmbedBuilder()
      .setTitle("⚠️ Administrator Role Automatically Removed")
      .setColor("#FF9900")
      .setDescription(
        `Member ${targetUser ? `**${targetUser.tag}**` : `\`${executorId}\``} triggered a sanction on **${guild.name}** ` +
          `(\`${reason}\`) and had their Administrator-granting role(s) temporarily removed, before a 10-minute timeout.\n\n` +
          `If this was a mistake (false positive), click the button below to restore their role immediately.\n` +
          `Otherwise, the timeout runs its course normally and the role stays removed until you click.`
      )
      .setFooter({ text: `Lotus Security System • Case #${caseId}` })
      .setTimestamp();

    const owner = await guild.fetchOwner().catch(() => null);
    const botOwnerId = process.env.OWNER_ID;

    if (owner) {
      await owner.send({ embeds: [restoreEmbed], components: [row] }).catch(() => null);
    }
    if (botOwnerId && botOwnerId !== owner?.id) {
      const botOwner = await guild.client.users.fetch(botOwnerId).catch(() => null);
      if (botOwner) await botOwner.send({ embeds: [restoreEmbed], components: [row] }).catch(() => null);
    }
  }

  return { caseId, punishmentApplied };
}

async function handleRestoreAdminButton(interaction) {
  if (!interaction.customId.startsWith("restore_admin_")) return;

  await interaction.deferReply({ ephemeral: true });

  const [, , guildId, userId] = interaction.customId.split("_");
  const guild = interaction.client.guilds.cache.get(guildId);

  if (!guild) return interaction.editReply("❌ Server not found (the bot may no longer be in it).");

  const isServerOwner = interaction.user.id === guild.ownerId;
  const isBotOwner = process.env.OWNER_ID && interaction.user.id === process.env.OWNER_ID;
  if (!isServerOwner && !isBotOwner) {
    return interaction.editReply("❌ Only the server owner or the bot owner can approve this restoration.");
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return interaction.editReply("❌ The member is no longer on the server.");

  const saved = savedAdminRoles.get(`${guildId}_${userId}`);
  if (!saved || !saved.roleIds.length) {
    return interaction.editReply("⚠️ Nothing to restore (already done or the 24h window has expired).");
  }

  await member.roles.add(saved.roleIds).catch((err) => {
    return interaction.editReply(`❌ Error during restoration: ${err.message}`);
  });

  savedAdminRoles.delete(`${guildId}_${userId}`);

  return interaction.editReply(`✅ Admin role(s) successfully restored for **${member.user.tag}**!`);
}

/**
 * Fix (leave/rejoin quarantine bypass): keeps the persistent quarantinedUserIds
 * list in sync when a staff member manually removes the Lotus Quarantine role
 * from a member (i.e. releases them). Without this, a released member would
 * stay stuck in the persistent list forever and get re-quarantined on every
 * future rejoin, even after being cleared by staff.
 */
function registerQuarantineSync(client) {
  client.on("guildMemberUpdate", async (oldMember, newMember) => {
    let qRoleId = null;

    const guildConfigDoc = await GuildConfig.findOne({ guildId: newMember.guild.id }).lean().catch(() => null);
    qRoleId = guildConfigDoc?.quarantineRoleId;

    if (!qRoleId) {
      const role = newMember.guild.roles.cache.find((r) => r.name === "Lotus Quarantine");
      qRoleId = role?.id;
    }
    if (!qRoleId) return;

    const hadRole = oldMember.roles.cache.has(qRoleId);
    const hasRole = newMember.roles.cache.has(qRoleId);

    // Role went from present to absent: staff released this member, so
    // clear them from the persistent quarantine list too.
    if (hadRole && !hasRole) {
      await GuildConfig.updateOne(
        { guildId: newMember.guild.id },
        { $pull: { quarantinedUserIds: newMember.id } }
      ).catch((err) => console.error("[Punisher] Failed to release quarantine state:", err.message));
    }
  });

  console.log("[Punisher] Quarantine persistence sync active.");
}

module.exports = { punish, ensureQuarantineSetup, handleRestoreAdminButton, registerQuarantineSync };
