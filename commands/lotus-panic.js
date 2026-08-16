const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  GuildVerificationLevel,
} = require("discord.js");
const { getGuildConfig, invalidate } = require("../utils/configCache");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("lotus-panic")
    .setDescription("Enables or disables panic mode (full server lockdown)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((opt) =>
      opt
        .setName("action")
        .setDescription("Enable or disable the lockdown")
        .setRequired(true)
        .addChoices(
          { name: "Enable", value: "on" },
          { name: "Disable", value: "off" }
        )
    ),

  async execute(interaction) {
    const action = interaction.options.getString("action");
    const guild = interaction.guild;
    const guildConfig = await getGuildConfig(guild.id);

    await interaction.deferReply({ ephemeral: true });

    const textChannels = guild.channels.cache.filter(
      (c) => c.type === ChannelType.GuildText
    );

    if (action === "on") {
      // Raises the verification level to max (strongly slows down new accounts)
      await guild.setVerificationLevel(GuildVerificationLevel.VeryHigh).catch(() => null);

      // Prevents @everyone from sending messages in all text channels
      for (const channel of textChannels.values()) {
        await channel.permissionOverwrites
          .edit(guild.roles.everyone, { SendMessages: false })
          .catch(() => null);
      }

      guildConfig.lockdownActive = true;
      await guildConfig.save();
      invalidate(guild.id);

      return interaction.editReply(
        "🔒 **Lockdown enabled.** Message sending blocked for @everyone and verification level set to maximum. Use `/lotus-panic off` once the threat has passed."
      );
    }

    if (action === "off") {
      await guild.setVerificationLevel(GuildVerificationLevel.Medium).catch(() => null);

      for (const channel of textChannels.values()) {
        await channel.permissionOverwrites
          .edit(guild.roles.everyone, { SendMessages: null })
          .catch(() => null);
      }

      guildConfig.lockdownActive = false;
      await guildConfig.save();
      invalidate(guild.id);

      return interaction.editReply("🔓 **Lockdown disabled.** The server has returned to normal.");
    }
  },
};
