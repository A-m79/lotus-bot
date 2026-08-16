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
    .setDescription("View or adjust this server's anti-nuke / anti-spam trigger thresholds")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub.setName("view").setDescription("Displays all current thresholds (default or custom)")
    )
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Sets a custom threshold for this server")
        .addStringOption((opt) =>
          opt
            .setName("type")
            .setDescription("Action type to adjust")
            .setRequired(true)
            .addChoices(...ACTION_CHOICES)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("value")
            .setDescription("Number of actions before the sanction triggers")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(50)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("reset")
        .setDescription("Removes the custom threshold and reverts to the default value")
        .addStringOption((opt) =>
          opt
            .setName("type")
            .setDescription("Action type to reset")
            .setRequired(true)
            .addChoices(...ACTION_CHOICES)
        )
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildConfig = await getGuildConfig(interaction.guild.id);

    if (sub === "view") {
      const lines = Object.keys(config.DEFAULT_THRESHOLDS).map((key) => {
        const custom = guildConfig.thresholds?.[key];
        const hasCustom = custom !== undefined && custom !== null;
        const effective = hasCustom ? custom : config.DEFAULT_THRESHOLDS[key];
        return `• \`${key}\` : **${effective}**${hasCustom ? " *(custom)*" : ""}`;
      });

      const embed = new EmbedBuilder()
        .setTitle("⚙️ Current Anti-Nuke / Anti-Spam Thresholds")
        .setColor(config.EMBED_COLOR)
        .setDescription(lines.join("\n"))
        .setFooter({
          text: "Windows: 10s (anti-nuke) • 7s (message flood) • 15s (mass mentions) • 60s (individual pings)",
        });

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === "set") {
      const type = interaction.options.getString("type");
      const value = interaction.options.getInteger("value");

      if (!guildConfig.thresholds) guildConfig.thresholds = {};
      guildConfig.thresholds[type] = value;
      guildConfig.markModified("thresholds");
      await guildConfig.save();
      invalidate(interaction.guild.id);

      return interaction.reply({
        content: `✅ Threshold \`${type}\` set to **${value}** for this server.`,
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
        content: `✅ Threshold \`${type}\` reset to its default value (**${config.DEFAULT_THRESHOLDS[type]}**).`,
        ephemeral: true,
      });
    }
  },
};
