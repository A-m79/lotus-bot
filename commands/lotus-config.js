const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
const { getGuildConfig, invalidate } = require("../utils/configCache");
const config = require("../config/config");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("lotus-config")
    .setDescription("Configure Lotus for this server")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("logs")
        .setDescription("Sets the security logs channel")
        .addChannelOption((opt) =>
          opt.setName("channel").setDescription("Logs channel").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("alerts")
        .setDescription("Sets the critical alerts channel (nuke/raid detected)")
        .addChannelOption((opt) =>
          opt.setName("channel").setDescription("Alerts channel").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("punishment")
        .setDescription("Sets the punishment applied upon detection")
        .addStringOption((opt) =>
          opt
            .setName("type")
            .setDescription("Punishment type")
            .setRequired(true)
            .addChoices(
              { name: "Ban", value: "ban" },
              { name: "Kick", value: "kick" },
              { name: "Strip all roles", value: "stripRoles" },
              { name: "Quarantine", value: "quarantine" }
            )
        )
    )
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("Displays Lotus's current configuration")
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildConfig = await getGuildConfig(interaction.guild.id);

    if (sub === "logs") {
      const channel = interaction.options.getChannel("channel");
      guildConfig.logChannelId = channel.id;
      await guildConfig.save();
      invalidate(interaction.guild.id);
      return interaction.reply({
        content: `✅ Logs channel set to ${channel}.`,
        ephemeral: true,
      });
    }

    if (sub === "alerts") {
      const channel = interaction.options.getChannel("channel");
      guildConfig.alertChannelId = channel.id;
      await guildConfig.save();
      invalidate(interaction.guild.id);
      return interaction.reply({
        content: `✅ Alerts channel set to ${channel}.`,
        ephemeral: true,
      });
    }

    if (sub === "punishment") {
      const type = interaction.options.getString("type");
      guildConfig.punishment = type;
      await guildConfig.save();
      invalidate(interaction.guild.id);
      return interaction.reply({
        content: `✅ Default punishment set to \`${type}\`.`,
        ephemeral: true,
      });
    }

    if (sub === "status") {
      const embed = new EmbedBuilder()
        .setColor(config.EMBED_COLOR)
        .setTitle("🔒 Lotus Configuration")
        .addFields(
          { name: "Anti-Nuke", value: guildConfig.antiNukeEnabled ? "✅ Enabled" : "❌ Disabled", inline: true },
          { name: "Anti-Raid", value: guildConfig.antiRaidEnabled ? "✅ Enabled" : "❌ Disabled", inline: true },
          { name: "Anti-Spam", value: guildConfig.antiSpamEnabled ? "✅ Enabled" : "❌ Disabled", inline: true },
          { name: "Punishment", value: `\`${guildConfig.punishment}\``, inline: true },
          { name: "Logs channel", value: guildConfig.logChannelId ? `<#${guildConfig.logChannelId}>` : "Not set", inline: true },
          { name: "Alerts channel", value: guildConfig.alertChannelId ? `<#${guildConfig.alertChannelId}>` : "Not set", inline: true },
          { name: "Whitelist", value: guildConfig.whitelist.length ? guildConfig.whitelist.map((id) => `<@${id}>`).join(", ") : "Empty" }
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  },
};
