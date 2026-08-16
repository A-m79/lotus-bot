const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } = require("discord.js");
const { takeBackup, restoreBackup, getBackupInfo } = require("../utils/backupEngine");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("lotus-backup")
    .setDescription("Full management of server backups and restorations")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub.setName("create").setDescription("Back up the current structure (roles, positions, channels)")
    )
    .addSubcommand((sub) =>
      sub.setName("restore").setDescription("Restores the hierarchy and missing elements")
    )
    .addSubcommand((sub) =>
      sub.setName("info").setDescription("Displays details of the last saved backup")
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const { guild } = interaction;

    await interaction.deferReply({ ephemeral: true });

    if (sub === "create") {
      const data = await takeBackup(guild);

      // Role details
      const rolesFormatted = data.roles.length
        ? data.roles.map((r) => `• \`${r.name}\` (${r.hexColor})`).join("\n")
        : "No roles.";

      // Format channels by category
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
          structureFormatted += ` *(empty)*\n`;
        }
      }

      // Orphan channels (no category)
      const orphanChannels = data.otherChannels.filter((c) => !c.parentName);
      if (orphanChannels.length) {
        structureFormatted += `🌐 **No Category**\n`;
        orphanChannels.forEach((ch) => {
          const icon = ch.type === ChannelType.GuildVoice ? "🔊" : "#";
          structureFormatted += ` └ ${icon} \`${ch.name}\`\n`;
        });
      }

      const embed = new EmbedBuilder()
        .setTitle("💾 Detailed Backup Successful!")
        .setColor("#FF2A2A")
        .setDescription("The complete structure has been saved with the following parameters:")
        .addFields(
          {
            name: "⚙️ Captured Metadata",
            value:
              "• Hierarchy & Positions\n• Role permissions\n• Channel-specific permissions (overwrites)\n• Role colors & Hoist\n• Topics, Bitrate & Age-restricted option",
          },
          {
            name: `🎭 Roles saved (${data.roles.length})`,
            value: rolesFormatted.length > 1024 ? rolesFormatted.slice(0, 1000) + "\n*...and more*" : rolesFormatted,
          },
          {
            name: `📂 Channel Tree (${data.otherChannels.length + data.categories.length})`,
            value: structureFormatted.length > 1024 ? structureFormatted.slice(0, 1000) + "\n*...and more*" : structureFormatted || "No channels.",
          },
          {
            name: "📅 Save Date",
            value: `<t:${Math.floor(data.updatedAt.getTime() / 1000)}:F>`,
          }
        )
        .setFooter({ text: "Lotus Security System" });

      return interaction.editReply({ embeds: [embed] });
    }

    if (sub === "info") {
      const backup = await getBackupInfo(guild.id);
      if (!backup) {
        return interaction.editReply("❌ No backup found for this server.");
      }

      const roleList = backup.roles.map((r) => `• \`${r.name}\` (${r.hexColor})`).join("\n");
      const channelList = backup.channels.map((c) => `• \`${c.name}\``).join("\n");

      const embed = new EmbedBuilder()
        .setTitle("📊 Current Backup")
        .setColor("#FF2A2A")
        .addFields(
          { name: "📅 Saved on", value: `<t:${Math.floor(new Date(backup.updatedAt).getTime() / 1000)}:F>` },
          { name: `🎭 Roles (${backup.roles.length})`, value: roleList.length > 1024 ? roleList.slice(0, 1000) + "\n*...*" : roleList },
          { name: `📁 Channels/Categories (${backup.channels.length})`, value: channelList.length > 1024 ? channelList.slice(0, 1000) + "\n*...*" : channelList }
        )
        .setFooter({ text: "Lotus Security System" });

      return interaction.editReply({ embeds: [embed] });
    }

    if (sub === "restore") {
      const result = await restoreBackup(guild);

      if (!result) {
        return interaction.editReply("❌ No backup found for this server.");
      }

      const rolesText = result.restoredRoles.length
        ? result.restoredRoles.map((r) => `• \`${r}\``).join("\n")
        : "No missing roles.";

      const channelsText = result.restoredChannels.length
        ? result.restoredChannels.map((c) => `• ${c}`).join("\n")
        : "No missing channels.";

      const embed = new EmbedBuilder()
        .setTitle("🔄 Restoration Complete!")
        .setColor("#57F287")
        .setDescription("Positions, missing elements, and permissions have been readjusted.")
        .addFields(
          { name: `🎭 Roles Restored (${result.restoredRoles.length})`, value: rolesText.length > 1024 ? rolesText.slice(0, 1000) + "\n*...*" : rolesText },
          { name: `📁 Channels Restored (${result.restoredChannels.length})`, value: channelsText.length > 1024 ? channelsText.slice(0, 1000) + "\n*...*" : channelsText },
          { name: `🔐 Channel Permissions Reapplied`, value: `\`${result.repairedPermissions ?? 0}\` channel(s)/categorie(s)` }
        )
        .setFooter({ text: "Lotus Security System" });

      return interaction.editReply({ embeds: [embed] });
    }
  },
};
