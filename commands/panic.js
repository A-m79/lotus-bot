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
    .setDescription("Active ou désactive le mode panique (lockdown total du serveur)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((opt) =>
      opt
        .setName("action")
        .setDescription("Activer ou désactiver le lockdown")
        .setRequired(true)
        .addChoices(
          { name: "Activer", value: "on" },
          { name: "Désactiver", value: "off" }
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
      // Monte le niveau de vérification au max (ralentit fortement les nouveaux comptes)
      await guild.setVerificationLevel(GuildVerificationLevel.VeryHigh).catch(() => null);

      // Empêche @everyone d'envoyer des messages sur tous les salons textuels
      for (const channel of textChannels.values()) {
        await channel.permissionOverwrites
          .edit(guild.roles.everyone, { SendMessages: false })
          .catch(() => null);
      }

      guildConfig.lockdownActive = true;
      await guildConfig.save();
      invalidate(guild.id);

      return interaction.editReply(
        "🔒 **Lockdown activé.** Envoi de messages bloqué pour @everyone et vérification au maximum. Utilise `/lotus-panic off` quand la menace est passée."
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

      return interaction.editReply("🔓 **Lockdown désactivé.** Le serveur revient à la normale.");
    }
  },
};
