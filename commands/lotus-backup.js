const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const { takeBackup, restoreBackup } = require("../utils/backupEngine");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("lotus-backup")
    .setDescription("Gestion des sauvegardes et restaurations du serveur")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("creer")
        .setDescription("Sauvegarder la structure actuelle des salons et rôles")
    )
    .addSubcommand((sub) =>
      sub
        .setName("restaurer")
        .setDescription("Restaure les salons et rôles manquants")
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const { guild } = interaction;

    await interaction.deferReply({ ephemeral: true });

    if (sub === "creer") {
      await takeBackup(guild);
      return interaction.editReply("💾 **Sauvegarde réussie !** La structure des salons et rôles est enregistrée.");
    }

    if (sub === "restaurer") {
      const success = await restoreBackup(guild);
      if (!success) {
        return interaction.editReply("❌ Aucune sauvegarde trouvée pour ce serveur.");
      }
      return interaction.editReply("🔄 **Restauration terminée !** Les salons et rôles manquants ont été re-créés.");
    }
  },
};