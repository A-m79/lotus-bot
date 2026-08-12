const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } = require("discord.js");
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
      const data = await takeBackup(guild);

      // Détails des rôles
      const rolesFormatted = data.roles.length
        ? data.roles.map((r) => `• \`${r.name}\` (${r.hexColor})`).join("\n")
        : "Aucun rôle.";

      // Formater les salons par catégories
      let structureFormatted = "";
      for (const cat of data.categories) {
        structureFormatted += `📁 **${cat.name}**\n`;
        const children = data.otherChannels.filter((c) => c.parentName === cat.name);
        if (children.length) {
          children.forEach((ch) => {
            const icon = ch.type === ChannelType.GuildVoice ? "🔊" : "#";
            structureFormatted += ` └ ${icon} \`${ch.name}\`\n`;
          });
        } else {
          structureFormatted += ` *(vide)*\n`;
        }
      }

      // Salons orphelins (sans catégorie)
      const orphanChannels = data.otherChannels.filter((c) => !c.parentName);
      if (orphanChannels.length) {
        structureFormatted += `🌐 **Hors Catégorie**\n`;
        orphanChannels.forEach((ch) => {
          const icon = ch.type === ChannelType.GuildVoice ? "🔊" : "#";
          structureFormatted += ` └ ${icon} \`${ch.name}\`\n`;
        });
      }

      const embed = new EmbedBuilder()
        .setTitle("💾 Sauvegarde Détaillée Réussie !")
        .setColor("#FF2A2A")
        .setDescription("La structure complète a été enregistrée avec les paramètres suivants :")
        .addFields(
          {
            name: "⚙️ Métadonnées capturées",
            value: "• Hiérarchie & Positions\n• Permissions exactes\n• Couleurs & Hoist rôles\n• Sujets, Bitrate & Option +18",
          },
          {
            name: `🎭 Rôles enregistrés (${data.roles.length})`,
            value: rolesFormatted.length > 1024 ? rolesFormatted.slice(0, 1000) + "\n*...et autres*" : rolesFormatted,
          },
          {
            name: `📂 Arborescence des Salons (${data.otherChannels.length + data.categories.length})`,
            value: structureFormatted.length > 1024 ? structureFormatted.slice(0, 1000) + "\n*...et autres*" : structureFormatted || "Aucun salon.",
          },
          {
            name: "📅 Date d'enregistrement",
            value: `<t:${Math.floor(data.updatedAt.getTime() / 1000)}:F>`,
          }
        )
        .setFooter({ text: "Lotus Security System" });

      return interaction.editReply({ embeds: [embed] });
    }

    if (sub === "info") {
      const backup = await getBackupInfo(guild.id);
      if (!backup) {
        return interaction.editReply("❌ Aucune sauvegarde trouvée pour ce serveur.");
      }

      const roleList = backup.roles.map((r) => `• \`${r.name}\` (${r.hexColor})`).join("\n");
      const channelList = backup.channels.map((c) => `• \`${c.name}\``).join("\n");

      const embed = new EmbedBuilder()
        .setTitle("📊 Sauvegarde Actuelle")
        .setColor("#FF2A2A")
        .addFields(
          { name: "📅 Enregistrée le", value: `<t:${Math.floor(new Date(backup.updatedAt).getTime() / 1000)}:F>` },
          { name: `🎭 Rôles (${backup.roles.length})`, value: roleList.length > 1024 ? roleList.slice(0, 1000) + "\n*...*" : roleList },
          { name: `📁 Salons/Catégories (${backup.channels.length})`, value: channelList.length > 1024 ? channelList.slice(0, 1000) + "\n*...*" : channelList }
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
          { name: `🎭 Rôles Restaurés (${result.restoredRoles.length})`, value: rolesText.length > 1024 ? rolesText.slice(0, 1000) + "\n*...*" : rolesText },
          { name: `📁 Salons Restaurés (${result.restoredChannels.length})`, value: channelsText.length > 1024 ? channelsText.slice(0, 1000) + "\n*...*" : channelsText }
        )
        .setFooter({ text: "Lotus Security System" });

      return interaction.editReply({ embeds: [embed] });
    }
  },
};