const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } = require("discord.js");
const GuildConfig = require("../models/GuildConfig");
const { invalidateGuildConfig } = require("./configCache");

const activeProtections = new Set();
const savedMemberRoles = new Map();

/**
 * S'assure que la catégorie de sécurité existe ou la recrée
 */
async function ensureCategory(guild, parentId, defaultName = "SÉCURITÉ LOTUS") {
  if (parentId) {
    const existingParent = guild.channels.cache.get(parentId);
    if (existingParent && existingParent.type === ChannelType.GuildCategory) {
      return existingParent;
    }
  }

  const existingByName = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === defaultName.toLowerCase()
  );
  if (existingByName) return existingByName;

  return await guild.channels
    .create({
      name: defaultName,
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        {
          id: guild.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: guild.client.user.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageChannels],
        },
      ],
    })
    .catch(() => null);
}

async function handleLogChannelDeletion(guild, deletedChannel, executor) {
  const lockKey = `${guild.id}_${deletedChannel.id}`;
  if (activeProtections.has(lockKey)) return;

  const config = await GuildConfig.findOne({ guildId: guild.id });
  if (!config) return;

  const logChan = config.logChannelId ? guild.channels.cache.get(config.logChannelId) : null;
  const alertChan = config.alertChannelId ? guild.channels.cache.get(config.alertChannelId) : null;

  const isLogChannel = config.logChannelId === deletedChannel.id;
  const isAlertChannel = config.alertChannelId === deletedChannel.id;
  const isCategory = deletedChannel.type === ChannelType.GuildCategory;

  // Vérifie si la catégorie supprimée hébergeait les salons de Lotus
  const isLotusCategory =
    isCategory &&
    ((logChan && logChan.parentId === deletedChannel.id) ||
      (alertChan && alertChan.parentId === deletedChannel.id));

  if (!isLogChannel && !isAlertChannel && !isLotusCategory) return;

  activeProtections.add(lockKey);

  try {
    console.log(`[LOG-PROTECTOR] Suppression détectée (${deletedChannel.name}) par ${executor.tag} sur ${guild.name}`);

    // 1. Sanction Immédiate : Retrait de TOUS les rôles du suspect (Immunité Owner)
    const member = await guild.members.fetch(executor.id).catch(() => null);
    if (member && member.manageable && member.id !== guild.ownerId) {
      const rolesToSave = member.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.id);
      savedMemberRoles.set(`${guild.id}_${executor.id}`, rolesToSave);

      await member.roles.set([], `[Lotus LogProtector] Suppression non autorisée de l'infrastructure de sécurité #${deletedChannel.name}`).catch(() => null);
    }

    let descriptionMsg = "";

    // 2. Auto-Reconstitution
    if (isCategory) {
      // Reconstitution de la Catégorie
      const newCategory = await ensureCategory(guild, null, deletedChannel.name || "SÉCURITÉ LOTUS");

      // Déplacement des salons de logs/alertes survivants dans la nouvelle catégorie
      if (logChan) await logChan.setParent(newCategory.id).catch(() => null);
      if (alertChan && alertChan.id !== logChan?.id) await alertChan.setParent(newCategory.id).catch(() => null);

      descriptionMsg =
        `La catégorie de sécurité **${deletedChannel.name}** a été supprimée.\n\n` +
        `• **Auteur :** ${executor.tag} (\`${executor.id}\`)\n` +
        `• **Sanction :** Retrait immédiat de tous ses rôles.\n` +
        `• **Action Lotus :** Catégorie auto-recréée avec succès ${newCategory ? `<#${newCategory.id}>` : "*(Échec)*"}.`;
    } else {
      // Reconstitution d'un Salon Textuel (Logs / Alertes)
      let channelTypeLabel = "sécurité";
      if (isLogChannel && isAlertChannel) channelTypeLabel = "logs & alertes";
      else if (isLogChannel) channelTypeLabel = "logs";
      else if (isAlertChannel) channelTypeLabel = "alertes";

      // S'assure que la catégorie parente existe toujours, sinon la crée
      const parentCategory = await ensureCategory(guild, deletedChannel.parentId, "SÉCURITÉ LOTUS");

      const newChannel = await guild.channels
        .create({
          name: deletedChannel.name,
          type: ChannelType.GuildText,
          parent: parentCategory ? parentCategory.id : null,
          topic: `Salon de ${channelTypeLabel} auto-recréé par Lotus Security System`,
          permissionOverwrites: [
            {
              id: guild.id,
              deny: [PermissionFlagsBits.ViewChannel],
            },
            {
              id: guild.client.user.id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
            },
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
        `Le salon de ${channelTypeLabel} **#${deletedChannel.name}** a été supprimé.\n\n` +
        `• **Auteur :** ${executor.tag} (\`${executor.id}\`)\n` +
        `• **Sanction :** Retrait immédiat de tous ses rôles.\n` +
        `• **Action Lotus :** Salon auto-recréé avec succès ${newChannel ? `<#${newChannel.id}>` : "*(Échec)*"}.`;
    }

    // 3. Bouton interactif & DM d'urgence
    const restoreButton = new ButtonBuilder()
      .setCustomId(`restore_roles_${guild.id}_${executor.id}`)
      .setLabel(`Rétablir les rôles de ${executor.username}`)
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🔄");

    const row = new ActionRowBuilder().addComponents(restoreButton);

    const embed = new EmbedBuilder()
      .setTitle("🚨 ALERTE CRITIQUE : Élément de Sécurité Supprimé !")
      .setColor("#FF0000")
      .setDescription(descriptionMsg)
      .setFooter({ text: "Lotus Security System • Protection Ultime" })
      .setTimestamp();

    const owner = await guild.fetchOwner().catch(() => null);
    if (owner) {
      await owner.send({ embeds: [embed], components: [row] }).catch(() => null);
    }

    const botOwnerId = process.env.OWNER_ID;
    if (botOwnerId && botOwnerId !== owner?.id) {
      const botOwner = await guild.client.users.fetch(botOwnerId).catch(() => null);
      if (botOwner) await botOwner.send({ embeds: [embed], components: [row] }).catch(() => null);
    }
  } finally {
    setTimeout(() => activeProtections.delete(lockKey), 5000);
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

module.exports = { handleLogChannelDeletion, handleRestoreRolesButton };