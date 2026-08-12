const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
const { getGuildConfig, invalidate } = require("../utils/configCache");
const config = require("../config/config");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("lotus-config")
    .setDescription("Configure Lotus sur ce serveur")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("logs")
        .setDescription("Définit le salon de logs de sécurité")
        .addChannelOption((opt) =>
          opt.setName("salon").setDescription("Salon de logs").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("alertes")
        .setDescription("Définit le salon d'alertes critiques (nuke/raid détecté)")
        .addChannelOption((opt) =>
          opt.setName("salon").setDescription("Salon d'alertes").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("punition")
        .setDescription("Définit la sanction appliquée en cas de détection")
        .addStringOption((opt) =>
          opt
            .setName("type")
            .setDescription("Type de sanction")
            .setRequired(true)
            .addChoices(
              { name: "Ban", value: "ban" },
              { name: "Kick", value: "kick" },
              { name: "Retirer tous les rôles", value: "stripRoles" },
              { name: "Quarantaine", value: "quarantine" }
            )
        )
    )
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("Affiche la configuration actuelle de Lotus")
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildConfig = await getGuildConfig(interaction.guild.id);

    if (sub === "logs") {
      const channel = interaction.options.getChannel("salon");
      guildConfig.logChannelId = channel.id;
      await guildConfig.save();
      invalidate(interaction.guild.id);
      return interaction.reply({
        content: `✅ Salon de logs défini sur ${channel}.`,
        ephemeral: true,
      });
    }

    if (sub === "alertes") {
      const channel = interaction.options.getChannel("salon");
      guildConfig.alertChannelId = channel.id;
      await guildConfig.save();
      invalidate(interaction.guild.id);
      return interaction.reply({
        content: `✅ Salon d'alertes défini sur ${channel}.`,
        ephemeral: true,
      });
    }

    if (sub === "punition") {
      const type = interaction.options.getString("type");
      guildConfig.punishment = type;
      await guildConfig.save();
      invalidate(interaction.guild.id);
      return interaction.reply({
        content: `✅ Sanction par défaut définie sur \`${type}\`.`,
        ephemeral: true,
      });
    }

    if (sub === "status") {
      const embed = new EmbedBuilder()
        .setColor(config.EMBED_COLOR)
        .setTitle("🔒 Configuration Lotus")
        .addFields(
          { name: "Anti-Nuke", value: guildConfig.antiNukeEnabled ? "✅ Activé" : "❌ Désactivé", inline: true },
          { name: "Anti-Raid", value: guildConfig.antiRaidEnabled ? "✅ Activé" : "❌ Désactivé", inline: true },
          { name: "Anti-Spam", value: guildConfig.antiSpamEnabled ? "✅ Activé" : "❌ Désactivé", inline: true },
          { name: "Sanction", value: `\`${guildConfig.punishment}\``, inline: true },
          { name: "Salon logs", value: guildConfig.logChannelId ? `<#${guildConfig.logChannelId}>` : "Non défini", inline: true },
          { name: "Salon alertes", value: guildConfig.alertChannelId ? `<#${guildConfig.alertChannelId}>` : "Non défini", inline: true },
          { name: "Whitelist", value: guildConfig.whitelist.length ? guildConfig.whitelist.map((id) => `<@${id}>`).join(", ") : "Vide" }
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  },
};
