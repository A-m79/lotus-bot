const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require("discord.js");
const GuildConfig = require("../models/GuildConfig");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("lotus-setup")
    .setDescription("Configuration automatique des salons de sécurité et du rôle d'isolation")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const { guild } = interaction;

    try {
      // 1. Création ou récupération du rôle Quarantaine
      let quarantineRole = guild.roles.cache.find((r) => r.name === "Lotus Quarantaine");
      if (!quarantineRole) {
        quarantineRole = await guild.roles.create({
          name: "Lotus Quarantaine",
          color: "#1a1a1a",
          reason: "Rôle d'isolation Lotus Security",
        });
      }

      // 2. Masquage de tous les salons existants pour le rôle Quarantaine
      const channels = await guild.channels.fetch();
      for (const [_, channel] of channels) {
        if (channel && channel.permissionOverwrites) {
          await channel.permissionOverwrites.edit(quarantineRole.id, {
            ViewChannel: false,
            SendMessages: false,
            Connect: false,
          }).catch(() => null);
        }
      }

      // 3. Création de la catégorie de sécurité
      let category = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && c.name === "SÉCURITÉ LOTUS"
      );
      if (!category) {
        category = await guild.channels.create({
          name: "SÉCURITÉ LOTUS",
          type: ChannelType.GuildCategory,
        });
      }

      // 4. Création des salons logs et alertes
      let logChannel = guild.channels.cache.find((c) => c.name === "logs-lotus");
      if (!logChannel) {
        logChannel = await guild.channels.create({
          name: "logs-lotus",
          type: ChannelType.GuildText,
          parent: category.id,
        });
      }

      let alertChannel = guild.channels.cache.find((c) => c.name === "alertes-lotus");
      if (!alertChannel) {
        alertChannel = await guild.channels.create({
          name: "alertes-lotus",
          type: ChannelType.GuildText,
          parent: category.id,
        });
      }

      // 5. Enregistrement dans MongoDB
      await GuildConfig.findOneAndUpdate(
        { guildId: guild.id },
        {
          logChannelId: logChannel.id,
          alertChannelId: alertChannel.id,
          quarantineRoleId: quarantineRole.id,
        },
        { upsert: true, new: true }
      );

      const embed = new EmbedBuilder()
        .setColor("#00FF7F")
        .setTitle("⚙️ Configuration Lotus Finalisée")
        .setDescription("Le système d'isolation et d'archivage des alertes a été initialisé.")
        .addFields(
          { name: "📁 Catégorie", value: `${category}`, inline: true },
          { name: "📜 Salon Logs", value: `${logChannel}`, inline: true },
          { name: "🚨 Salon Alertes", value: `${alertChannel}`, inline: true },
          { name: "☣️ Rôle Isolation", value: `${quarantineRole} (Masqué sur tous les salons)`, inline: false }
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error("[Setup Error]:", err);
      await interaction.editReply({
        content: `❌ Erreur lors de la configuration : ${err.message}`,
      });
    }
  },
};