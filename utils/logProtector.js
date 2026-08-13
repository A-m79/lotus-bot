const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } = require("discord.js");
const GuildConfig = require("../models/GuildConfig");
const { invalidateGuildConfig } = require("./configCache");
const { ensureQuarantineSetup } = require("../modules/punisher");

const recreatingGuilds = new Set();
const savedMemberRoles = new Map();

async function handleLogChannelDeletion(guild, deletedChannel, executor) {
  // 🛡️ IMMUNITÉ OWNER (Serveur + Bot)
  const botOwnerId = process.env.OWNER_ID;
  const isOwner = executor.id === guild.ownerId || (botOwnerId && executor.id === botOwnerId);

  if (isOwner) {
    console.log(`[LOG-PROTECTOR] Action ignorée : exécutée par le Owner (${executor.tag}).`);
    return;
  }

  // 🛑 Verrou anti-doublon
  if (recreatingGuilds.has(guild.id)) return;
  recreatingGuilds.add(guild.id);

  try {
    const config = await GuildConfig.findOne({ guildId: guild.id });
    if (!config) return;

    const isLogChannel = config.logChannelId === deletedChannel.id;
    const isAlertChannel = config.alertChannelId === deletedChannel.id;
    const isQuarantineChannel = deletedChannel.name === "🔒-quarantaine";
    const isCategory = deletedChannel.type === ChannelType.GuildCategory;

    const logChan = config.logChannelId ? guild.channels.cache.get(config.logChannelId) : null;
    const alertChan = config.alertChannelId ? guild.channels.cache.get(config.alertChannelId) : null;

    const isLotusCategory =
      isCategory &&
      (deletedChannel.name.toLowerCase().includes("lotus") ||
        deletedChannel.name.toLowerCase().includes("sécurité") ||
        (logChan && logChan.parentId === deletedChannel.id) ||
        (alertChan && alertChan.parentId === deletedChannel.id));

    if (!isLogChannel && !isAlertChannel && !isQuarantineChannel && !isLotusCategory) return;

    console.log(`[LOG-PROTECTOR] Suppression de ${deletedChannel.name} par ${executor.tag} sur ${guild.name}`);

    // Sanction de l'auteur non-owner
    const member = await guild.members.fetch(executor.id).catch(() => null);
    if (member && member.manageable) {
      const rolesToSave = member.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.id);
      savedMemberRoles.set(`${guild.id}_${executor.id}`, rolesToSave);

      await member.roles.set([], `[Lotus LogProtector] Suppression non autorisée de l'infrastructure (${deletedChannel.name})`).catch(() => null);
    }

    let descriptionMsg = "";

    // Recherche ou création de la catégorie parente Lotus de secours
    let parentCategory = deletedChannel.parentId ? guild.channels.cache.get(deletedChannel.parentId) : null;
    if (!parentCategory) {
      parentCategory = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase().includes("lotus"));
    }
    if (!parentCategory) {
      parentCategory = await guild.channels
        .create({
          name: "SÉCURITÉ LOTUS",
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
          name: deletedChannel.name || "SÉCURITÉ LOTUS",
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
        `La catégorie **${deletedChannel.name}** a été supprimée.\n\n` +
        `• **Auteur :** ${executor.tag} (\`${executor.id}\`)\n` +
        `• **Sanction :** Retrait de ses rôles.\n` +
        `• **Action :** Catégorie auto-recréée ${newCategory ? `<#${newCategory.id}>` : "*(Échec)*"}.`;
    } else if (isQuarantineChannel) {
      // Recréation et replacement explicite sous la catégorie Lotus
      const { quarantineChannel } = await ensureQuarantineSetup(guild);
      if (quarantineChannel && parentCategory) {
        await quarantineChannel.setParent(parentCategory.id).catch(() => null);
      }

      descriptionMsg =
        `Le salon de quarantaine **#🔒-quarantaine** a été supprimé.\n\n` +
        `• **Auteur :** ${executor.tag} (\`${executor.id}\`)\n` +
        `• **Sanction :** Retrait de ses rôles.\n` +
        `• **Action :** Salon de quarantaine auto-recréé et replacé ${quarantineChannel ? `<#${quarantineChannel.id}>` : "*(Échec)*"}.`;
    } else {
      let channelTypeLabel = "sécurité";
      if (isLogChannel && isAlertChannel) channelTypeLabel = "logs & alertes";
      else if (isLogChannel) channelTypeLabel = "logs";
      else if (isAlertChannel) channelTypeLabel = "alertes";

      const newChannel = await guild.channels
        .create({
          name: deletedChannel.name,
          type: ChannelType.GuildText,
          parent: parentCategory ? parentCategory.id : null,
          topic: `Salon de ${channelTypeLabel} auto-recréé par Lotus Security System`,
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
        `Le salon **#${deletedChannel.name}** a été supprimé.\n\n` +
        `• **Auteur :** ${executor.tag} (\`${executor.id}\`)\n` +
        `• **Sanction :** Retrait de ses rôles.\n` +
        `• **Action :** Salon auto-recréé et replacé ${newChannel ? `<#${newChannel.id}>` : "*(Échec)*"}.`;
    }

    const restoreButton = new ButtonBuilder()
      .setCustomId(`restore_roles_${guild.id}_${executor.id}`)
      .setLabel(`Rétablir les rôles de ${executor.username}`)
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🔄");

    const row = new ActionRowBuilder().addComponents(restoreButton);

    const embed = new EmbedBuilder()
      .setTitle("🚨 ALERTE CRITIQUE : Protection Lotus Déclenchée !")
      .setColor("#FF0000")
      .setDescription(descriptionMsg)
      .setFooter({ text: "Lotus Security System • Protection Ultime" })
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
}

async function handleRoleDeletion(guild, deletedRole, executor) {
  const botOwnerId = process.env.OWNER_ID;
  const isOwner = executor.id === guild.ownerId || (botOwnerId && executor.id === botOwnerId);
  if (isOwner) return;

  if (deletedRole.name === "Lotus Quarantaine") {
    console.log(`[LOG-PROTECTOR] Suppression du rôle de quarantaine par ${executor.tag} sur ${guild.name}`);

    const member = await guild.members.fetch(executor.id).catch(() => null);
    if (member && member.manageable) {
      const rolesToSave = member.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.id);
      savedMemberRoles.set(`${guild.id}_${executor.id}`, rolesToSave);
      await member.roles.set([], `[Lotus LogProtector] Suppression non autorisée du rôle de quarantaine`).catch(() => null);
    }

    await ensureQuarantineSetup(guild);

    const restoreButton = new ButtonBuilder()
      .setCustomId(`restore_roles_${guild.id}_${executor.id}`)
      .setLabel(`Rétablir les rôles de ${executor.username}`)
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🔄");

    const row = new ActionRowBuilder().addComponents(restoreButton);

    const embed = new EmbedBuilder()
      .setTitle("🚨 ALERTE CRITIQUE : Rôle de Quarantaine Supprimé !")
      .setColor("#FF0000")
      .setDescription(
        `Le rôle de sécurité **Lotus Quarantaine** a été supprimé.\n\n` +
        `• **Auteur :** ${executor.tag} (\`${executor.id}\`)\n` +
        `• **Sanction :** Retrait de ses rôles.\n` +
        `• **Action :** Rôle auto-recréé avec succès.`
      )
      .setFooter({ text: "Lotus Security System • Protection Ultime" })
      .setTimestamp();

    const owner = await guild.fetchOwner().catch(() => null);
    if (owner) await owner.send({ embeds: [embed], components: [row] }).catch(() => null);

    if (botOwnerId && botOwnerId !== owner?.id) {
      const botOwner = await guild.client.users.fetch(botOwnerId).catch(() => null);
      if (botOwner) await botOwner.send({ embeds: [embed], components: [row] }).catch(() => null);
    }
  }
}

async function handleRestoreRolesButton(interaction) {
  if (!interaction.customId.startsWith("restore_roles_")) return;

  await interaction.deferReply({ ephemeral: true });

  const [, , guildId, userId] = interaction.customId.split("_");
  const guild = interaction.client.guilds.cache.get(guildId);

  if (!guild) return interaction.editReply("❌ Serveur introuvable.");

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return interaction.editReply("❌ Le membre n'est plus sur le serveur.");

  const rolesToRestore = savedMemberRoles.get(`${guildId}_${userId}`);
  if (!rolesToRestore || !rolesToRestore.length) {
    return interaction.editReply("⚠️ Aucun rôle à restaurer (déjà restaurés ou session expirée).");
  }

  await member.roles.add(rolesToRestore).catch((err) => {
    return interaction.editReply(`❌ Erreur lors du rétablissement : ${err.message}`);
  });

  savedMemberRoles.delete(`${guildId}_${userId}`);

  return interaction.editReply(`✅ Rôles rétablis avec succès pour **${member.user.tag}** !`);
}

module.exports = { handleLogChannelDeletion, handleRoleDeletion, handleRestoreRolesButton };