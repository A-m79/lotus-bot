const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } = require("discord.js");
const GuildConfig = require("../models/GuildConfig");
const { invalidateGuildConfig } = require("./configCache");
const { ensureQuarantineSetup } = require("../modules/punisher");

const recreatingGuilds = new Set();
const savedMemberRoles = new Map();

/**
 * Handles the deletion of a protected channel/category (logs, alerts, quarantine,
 * Lotus category). Returns `true` if the incident did involve a protected
 * element (whether actively handled, ignored because it was the owner, or
 * already being processed) — in that case, antiNuke.js must NOT also fire its
 * own generic sanction, to avoid a double role strip / double alert.
 * Returns `false` if the deleted channel wasn't protected at all: antiNuke.js
 * should then handle the event normally through its generic pipeline.
 */
async function handleLogChannelDeletion(guild, deletedChannel, executor) {
  const config = await GuildConfig.findOne({ guildId: guild.id });
  if (!config) return false;

  const isLogChannel = config.logChannelId === deletedChannel.id;
  const isAlertChannel = config.alertChannelId === deletedChannel.id;
  const isQuarantineChannel = deletedChannel.name === "🔒-quarantine";
  const isCategory = deletedChannel.type === ChannelType.GuildCategory;

  const logChan = config.logChannelId ? guild.channels.cache.get(config.logChannelId) : null;
  const alertChan = config.alertChannelId ? guild.channels.cache.get(config.alertChannelId) : null;

  const isLotusCategory =
    isCategory &&
    (deletedChannel.name.toLowerCase().includes("lotus") ||
      deletedChannel.name.toLowerCase().includes("security") ||
      (logChan && logChan.parentId === deletedChannel.id) ||
      (alertChan && alertChan.parentId === deletedChannel.id));

  const isProtected = isLogChannel || isAlertChannel || isQuarantineChannel || isLotusCategory;

  // Not a protected element: let antiNuke.js handle it normally (usual counter/threshold).
  if (!isProtected) return false;

  // 🛡️ OWNER IMMUNITY: intentional action, we do nothing, but we still signal
  // "handled" to prevent antiNuke.js from firing its own logic on this
  // (which would ignore the owner anyway too, so this return true mainly
  // exists for flow consistency).
  const botOwnerId = process.env.OWNER_ID;
  const isOwner = executor.id === guild.ownerId || (botOwnerId && executor.id === botOwnerId);
  if (isOwner) {
    console.log(`[LOG-PROTECTOR] Action ignored: performed by the Owner (${executor.tag}).`);
    return true;
  }

  // 🛑 Anti-duplicate lock: a recreation is already in progress for this server
  // (e.g. rapid deletion of several protected elements at once).
  if (recreatingGuilds.has(guild.id)) return true;
  recreatingGuilds.add(guild.id);

  try {
    console.log(`[LOG-PROTECTOR] Deletion of ${deletedChannel.name} by ${executor.tag} on ${guild.name}`);

    // Sanctioning the non-owner author
    const member = await guild.members.fetch(executor.id).catch(() => null);
    if (member && member.manageable) {
      const rolesToSave = member.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.id);
      savedMemberRoles.set(`${guild.id}_${executor.id}`, rolesToSave);

      await member.roles.set([], `[Lotus LogProtector] Unauthorized deletion of infrastructure (${deletedChannel.name})`).catch(() => null);
    }

    let descriptionMsg = "";

    // Find or guarantee the creation of the parent Lotus category
    let parentCategory = deletedChannel.parentId ? guild.channels.cache.get(deletedChannel.parentId) : null;
    if (!parentCategory) {
      parentCategory = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && (c.name.toLowerCase().includes("lotus") || c.name.toLowerCase().includes("security")));
    }
    if (!parentCategory) {
      parentCategory = await guild.channels
        .create({
          name: "LOTUS SECURITY",
          type: ChannelType.GuildCategory,
          permissionOverwrites: [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: guild.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageChannels] },
          ],
        })
        .catch(() => null);
    }

    if (isCategory) {
      const newCategory = await guild.channels
        .create({
          name: deletedChannel.name || "LOTUS SECURITY",
          type: ChannelType.GuildCategory,
          permissionOverwrites: [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: guild.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageChannels] },
          ],
        })
        .catch(() => null);

      if (newCategory) {
        if (logChan) await logChan.setParent(newCategory.id).catch(() => null);
        if (alertChan && alertChan.id !== logChan?.id) await alertChan.setParent(newCategory.id).catch(() => null);
      }

      descriptionMsg =
        `The **${deletedChannel.name}** category has been deleted.\n\n` +
        `• **Author:** ${executor.tag} (\`${executor.id}\`)\n` +
        `• **Sanction:** Roles removed.\n` +
        `• **Action:** Category auto-recreated ${newCategory ? `<#${newCategory.id}>` : "*(Failed)*"}.`;
    } else if (isQuarantineChannel) {
      const { quarantineChannel } = await ensureQuarantineSetup(guild);

      if (quarantineChannel && parentCategory) {
        await new Promise((r) => setTimeout(r, 500));
        await quarantineChannel.setParent(parentCategory.id, { lockPermissions: false }).catch(() => null);
      }

      descriptionMsg =
        `The **#🔒-quarantine** quarantine channel has been deleted.\n\n` +
        `• **Author:** ${executor.tag} (\`${executor.id}\`)\n` +
        `• **Sanction:** Roles removed.\n` +
        `• **Action:** Quarantine channel auto-recreated and placed under **${parentCategory ? parentCategory.name : "LOTUS SECURITY"}** ${quarantineChannel ? `<#${quarantineChannel.id}>` : ""}.`;
    } else {
      let channelTypeLabel = "security";
      if (isLogChannel && isAlertChannel) channelTypeLabel = "logs & alerts";
      else if (isLogChannel) channelTypeLabel = "logs";
      else if (isAlertChannel) channelTypeLabel = "alerts";

      const newChannel = await guild.channels
        .create({
          name: deletedChannel.name,
          type: ChannelType.GuildText,
          parent: parentCategory ? parentCategory.id : null,
          topic: `${channelTypeLabel} channel auto-recreated by Lotus Security System`,
          permissionOverwrites: [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: guild.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
          ],
        })
        .catch(() => null);

      if (newChannel) {
        if (isLogChannel) config.logChannelId = newChannel.id;
        if (isAlertChannel) config.alertChannelId = newChannel.id;
        await config.save();
        invalidateGuildConfig(guild.id);
      }

      descriptionMsg =
        `The **#${deletedChannel.name}** channel has been deleted.\n\n` +
        `• **Author:** ${executor.tag} (\`${executor.id}\`)\n` +
        `• **Sanction:** Roles removed.\n` +
        `• **Action:** Channel auto-recreated and restored ${newChannel ? `<#${newChannel.id}>` : "*(Failed)*"}.`;
    }

    const restoreButton = new ButtonBuilder()
      .setCustomId(`restore_roles_${guild.id}_${executor.id}`)
      .setLabel(`Restore roles for ${executor.username}`)
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🔄");

    const row = new ActionRowBuilder().addComponents(restoreButton);

    const embed = new EmbedBuilder()
      .setTitle("🚨 CRITICAL ALERT: Lotus Protection Triggered!")
      .setColor("#FF0000")
      .setDescription(descriptionMsg)
      .setFooter({ text: "Lotus Security System • Ultimate Protection" })
      .setTimestamp();

    const owner = await guild.fetchOwner().catch(() => null);
    if (owner) await owner.send({ embeds: [embed], components: [row] }).catch(() => null);

    if (botOwnerId && botOwnerId !== owner?.id) {
      const botOwner = await guild.client.users.fetch(botOwnerId).catch(() => null);
      if (botOwner) await botOwner.send({ embeds: [embed], components: [row] }).catch(() => null);
    }
  } finally {
    setTimeout(() => recreatingGuilds.delete(guild.id), 5000);
  }

  return true;
}

/**
 * Handles the deletion of the "Lotus Quarantine" role specifically.
 * Same boolean return contract as handleLogChannelDeletion.
 */
async function handleRoleDeletion(guild, deletedRole, executor) {
  if (deletedRole.name !== "Lotus Quarantine") return false;

  const botOwnerId = process.env.OWNER_ID;
  const isOwner = executor.id === guild.ownerId || (botOwnerId && executor.id === botOwnerId);
  if (isOwner) return true;

  console.log(`[LOG-PROTECTOR] Quarantine role deletion by ${executor.tag} on ${guild.name}`);

  const member = await guild.members.fetch(executor.id).catch(() => null);
  if (member && member.manageable) {
    const rolesToSave = member.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.id);
    savedMemberRoles.set(`${guild.id}_${executor.id}`, rolesToSave);
    await member.roles.set([], `[Lotus LogProtector] Unauthorized deletion of the quarantine role`).catch(() => null);
  }

  await ensureQuarantineSetup(guild);

  const restoreButton = new ButtonBuilder()
    .setCustomId(`restore_roles_${guild.id}_${executor.id}`)
    .setLabel(`Restore roles for ${executor.username}`)
    .setStyle(ButtonStyle.Danger)
    .setEmoji("🔄");

  const row = new ActionRowBuilder().addComponents(restoreButton);

  const embed = new EmbedBuilder()
    .setTitle("🚨 CRITICAL ALERT: Quarantine Role Deleted!")
    .setColor("#FF0000")
    .setDescription(
      `The **Lotus Quarantine** security role has been deleted.\n\n` +
      `• **Author:** ${executor.tag} (\`${executor.id}\`)\n` +
      `• **Sanction:** Roles removed.\n` +
      `• **Action:** Role successfully auto-recreated.`
    )
    .setFooter({ text: "Lotus Security System • Ultimate Protection" })
    .setTimestamp();

  const owner = await guild.fetchOwner().catch(() => null);
  if (owner) await owner.send({ embeds: [embed], components: [row] }).catch(() => null);

  if (botOwnerId && botOwnerId !== owner?.id) {
    const botOwner = await guild.client.users.fetch(botOwnerId).catch(() => null);
    if (botOwner) await botOwner.send({ embeds: [embed], components: [row] }).catch(() => null);
  }

  return true;
}

async function handleRestoreRolesButton(interaction) {
  if (!interaction.customId.startsWith("restore_roles_")) return;

  await interaction.deferReply({ ephemeral: true });

  const [, , guildId, userId] = interaction.customId.split("_");
  const guild = interaction.client.guilds.cache.get(guildId);

  if (!guild) return interaction.editReply("❌ Server not found.");

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return interaction.editReply("❌ The member is no longer on the server.");

  const rolesToRestore = savedMemberRoles.get(`${guildId}_${userId}`);
  if (!rolesToRestore || !rolesToRestore.length) {
    return interaction.editReply("⚠️ No roles to restore (already restored or session expired).");
  }

  await member.roles.add(rolesToRestore).catch((err) => {
    return interaction.editReply(`❌ Error during restoration: ${err.message}`);
  });

  savedMemberRoles.delete(`${guildId}_${userId}`);

  return interaction.editReply(`✅ Roles successfully restored for **${member.user.tag}**!`);
}

module.exports = { handleLogChannelDeletion, handleRoleDeletion, handleRestoreRolesButton };
