const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
const { getGuildConfig, invalidate } = require("../utils/configCache");
const GuildConfig = require("../models/GuildConfig");
const config = require("../config/config");

const ACTION_CHOICES = Object.keys(config.DEFAULT_THRESHOLDS).map((key) => ({
  name: key,
  value: key,
}));

module.exports = {
  data: new SlashCommandBuilder()
    .setName("lotus-thresholds")
    .setDescription("Consulte ou ajuste les seuils de déclenchement anti-nuke / anti-spam de ce serveur")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub.setName("voir").setDescription("Affiche tous les seuils actuels (par défaut ou personnalisés)")
    )
    .addSubcommand((sub) =>
      sub
        .setName("definir")
        .setDescription("Définit un seuil personnalisé pour ce serveur")
        .addStringOption((opt) =>
          opt
            .setName("type")
            .setDescription("Type d'action à ajuster")
            .setRequired(true)
            .addChoices(...ACTION_CHOICES)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("valeur")
            .setDescription("Nombre d'actions avant déclenchement de la sanction")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(50)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("reset")
        .setDescription("Retire le seuil personnalisé et revient à la valeur par défaut")
        .addStringOption((opt) =>
          opt
            .setName("type")
            .setDescription("Type d'action à réinitialiser")
            .setRequired(true)
            .addChoices(...ACTION_CHOICES)
        )
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildConfig = await getGuildConfig(interaction.guild.id);

    if (sub === "voir") {
      const lines = Object.keys(config.DEFAULT_THRESHOLDS).map((key) => {
        const custom = guildConfig.thresholds?.[key];
        const hasCustom = custom !== undefined && custom !== null;
        const effective = hasCustom ? custom : config.DEFAULT_THRESHOLDS[key];
        return `• \`${key}\` : **${effective}**${hasCustom ? " *(personnalisé)*" : ""}`;
      });

      const embed = new EmbedBuilder()
        .setTitle("⚙️ Seuils Anti-Nuke / Anti-Spam actuels")
        .setColor(config.EMBED_COLOR)
        .setDescription(lines.join("\n"))
        .setFooter({
          text: "Fenêtres : 10s (anti-nuke) • 7s (flood messages) • 15s (mentions massives) • 60s (pings individuels)",
        });

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === "definir") {
      const type = interaction.options.getString("type");
      const value = interaction.options.getInteger("valeur");

      if (!guildConfig.thresholds) guildConfig.thresholds = {};
      guildConfig.thresholds[type] = value;
      guildConfig.markModified("thresholds");
      await guildConfig.save();
      invalidate(interaction.guild.id);

      return interaction.reply({
        content: `✅ Seuil \`${type}\` défini sur **${value}** pour ce serveur.`,
        ephemeral: true,
      });
    }

    if (sub === "reset") {
      const type = interaction.options.getString("type");

      await GuildConfig.updateOne(
        { guildId: interaction.guild.id },
        { $unset: { [`thresholds.${type}`]: "" } }
      );
      invalidate(interaction.guild.id);

      return interaction.reply({
        content: `✅ Seuil \`${type}\` réinitialisé à la valeur par défaut (**${config.DEFAULT_THRESHOLDS[type]}**).`,
        ephemeral: true,
      });
    }
  },
};
