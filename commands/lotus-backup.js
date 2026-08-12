const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
const { takeBackup, restoreBackup, getBackupInfo } = require("../utils/backupEngine");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("lotus-backup")
    .setDescription("Gestion complète des sauvegardes et restaurations du serveur")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub.setName("creer").setDescription("Sauvegarder la structure actuelle (rôles, positions, salons)")
    )
    .addSubcommand((sub) =>
      sub.setName("restaurer").setDescription("Restaure la hiérarchie et les éléments manquants")
    )
    .addSubcommand((sub) =>
      sub.setName("info").setDescription("Affiche les détails de la dernière sauvegarde enregistrée")
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const { guild } = interaction;

    await interaction.deferReply({ ephemeral: true });

    if (sub === "creer") {
      const stats = await takeBackup(guild);

      const embed = new EmbedBuilder()
        .setTitle("💾 Sauvegarde Réussie !")
        .setColor("#FF2A2A")
        .setDescription("La structure complète du serveur a été enregistrée.")
        .addFields(
          { name: "🎭 Rôles", value: `${stats.roleCount} rôle(s)`, inline: true },
          { name: "📁 Catégories", value: `${stats.categoryCount} catégorie(s)`, inline: true },
          { name: "💬 Salons", value: `${stats.channelCount} salon(s)`, inline: true },
          { name: "📅 Date", value: `<t:${Math.floor(stats.updatedAt.getTime() / 1000)}:F>` }
        )
        .setFooter({ text: "Lotus Security System" });

      return interaction.editReply({ embeds: [embed] });
    }

    if (sub === "info") {
      const backup = await getBackupInfo(guild.id);
      if (!backup) {
        return interaction.editReply("❌ Aucune sauvegarde trouvée pour ce serveur.");
      }

      const roleList = backup.roles.slice(0, 10).map((r) => `• \`${r.name}\` (${r.hexColor})`).join("\n");
      const channelList = backup.channels.slice(0, 10).map((c) => `• \`${c.name}\``).join("\n");

      const embed = new EmbedBuilder()
        .setTitle("📊 Sauvegarde Actuelle")
        .setColor("#FF2A2A")
        .addFields(
          { name: "📅 Enregistrée le", value: `<t:${Math.floor(new Date(backup.updatedAt).getTime() / 1000)}:F>` },
          { name: `🎭 Rôles (${backup.roles.length})`, value: roleList + (backup.roles.length > 10 ? "\n*...et plus*" : "") },
          { name: `📁 Salons/Catégories (${backup.channels.length})`, value: channelList + (backup.channels.length > 10 ? "\n*...et plus*" : "") }
        )
        .setFooter({ text: "Lotus Security System" });

      return interaction.editReply({ embeds: [embed] });
    }

    if (sub === "restaurer") {
      const result = await restoreBackup(guild);

      if (!result) {
        return interaction.editReply("❌ Aucune sauvegarde trouvée pour ce serveur.");
      }

      const rolesText = result.restoredRoles.length
        ? result.restoredRoles.map((r) => `• \`${r}\``).join("\n")
        : "Aucun rôle manquant.";

      const channelsText = result.restoredChannels.length
        ? result.restoredChannels.map((c) => `• ${c}`).join("\n")
        : "Aucun salon manquant.";

      const embed = new EmbedBuilder()
        .setTitle("🔄 Restauration Terminée !")
        .setColor("#57F287")
        .setDescription("Les positions et éléments manquants ont été réajustés.")
        .addFields(
          { name: `🎭 Rôles Restaurés (${result.restoredRoles.length})`, value: rolesText.slice(0, 1024) },
          { name: `📁 Salons Restaurés (${result.restoredChannels.length})`, value: channelsText.slice(0, 1024) }
        )
        .setFooter({ text: "Lotus Security System" });

      return interaction.editReply({ embeds: [embed] });
    }
  },
};