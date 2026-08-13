const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
const GuildConfig = require("../models/GuildConfig");
const { invalidateGuildConfig } = require("../utils/configCache");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Analyse et configure/répare automatiquement l'infrastructure de sécurité Lotus.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    let config = await GuildConfig.findOne({ guildId: guild.id });
    if (!config) {
      config = new GuildConfig({ guildId: guild.id });
    }

    const actionsTaken = [];

    // 1. Détection ou création de la Catégorie
    let category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase().includes("lotus")
    );

    if (!category) {
      category = await guild.channels.create({
        name: "SÉCURITÉ LOTUS",
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: guild.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageChannels] },
        ],
      });
      actionsTaken.push("📂 **Catégorie :** `SÉCURITÉ LOTUS` créée avec succès.");
    } else {
      actionsTaken.push(`📂 **Catégorie :** Retrouvée (<#${category.id}>).`);
    }

    // 2. Détection ou création du Salon de Logs
    let logChannel = config.logChannelId ? guild.channels.cache.get(config.logChannelId) : null;
    if (!logChannel) {
      logChannel = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === "logs-lotus" && c.parentId === category.id
      );
    }

    if (!logChannel) {
      logChannel = await guild.channels.create({
        name: "logs-lotus",
        type: ChannelType.GuildText,
        parent: category.id,
        topic: "Logs de sécurité générés par Lotus Security",
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: guild.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
        ],
      });
      config.logChannelId = logChannel.id;
      actionsTaken.push("📜 **Salon Logs :** `#logs-lotus` créé et configuré.");
    } else {
      // Repositionne dans la bonne catégorie si besoin
      if (logChannel.parentId !== category.id) {
        await logChannel.setParent(category.id).catch(() => null);
      }
      config.logChannelId = logChannel.id;
      actionsTaken.push(`📜 **Salon Logs :** Retrouvé et vérifié (<#${logChannel.id}>).`);
    }

    // 3. Détection ou création du Salon d'Alertes
    let alertChannel = config.alertChannelId ? guild.channels.cache.get(config.alertChannelId) : null;
    if (!alertChannel) {
      alertChannel = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === "alertes-lotus" && c.parentId === category.id
      );
    }

    if (!alertChannel) {
      alertChannel = await guild.channels.create({
        name: "alertes-lotus",
        type: ChannelType.GuildText,
        parent: category.id,
        topic: "Alertes critiques envoyées par Lotus Security",
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: guild.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
        ],
      });
      config.alertChannelId = alertChannel.id;
      actionsTaken.push("🚨 **Salon Alertes :** `#alertes-lotus` créé et configuré.");
    } else {
      // Repositionne dans la bonne catégorie si besoin
      if (alertChannel.parentId !== category.id) {
        await alertChannel.setParent(category.id).catch(() => null);
      }
      config.alertChannelId = alertChannel.id;
      actionsTaken.push(`🚨 **Salon Alertes :** Retrouvé et vérifié (<#${alertChannel.id}>).`);
    }

    // 4. Sauvegarde BDD & Reset Cache
    await config.save();
    invalidateGuildConfig(guild.id);

    const embed = new EmbedBuilder()
      .setTitle("⚙️ Audit & Diagnostic /setup - Lotus")
      .setColor("#00FF7F")
      .setDescription(
        "Lotus a analysé la structure du serveur et ré-aligné la configuration de sécurité :\n\n" +
          actionsTaken.join("\n")
      )
      .setFooter({ text: "Lotus Security System • Système opérationnel" })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },
};