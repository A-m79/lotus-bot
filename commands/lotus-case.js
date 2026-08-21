const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
const SecurityLog = require("../models/SecurityLog");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("lotus-case")
    .setDescription("Displays details of a Lotus sanction via its case number")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((opt) =>
      opt
        .setName("id")
        .setDescription("Case number, e.g. CASE-UVS7Z (or just UVS7Z)")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    try {
      const focused = interaction.options.getFocused().trim().toLowerCase();

      // On tire les 100 cases les plus récentes plutôt que toute la
      // collection : Discord veut une réponse en moins de 3s, et on filtre
      // ensuite en mémoire (sur le caseId, le pseudo et le type de sanction).
      const logs = await SecurityLog.find({ guildId: interaction.guild.id })
        .sort({ createdAt: -1 })
        .limit(100)
        .select("caseId executorId type createdAt")
        .lean();

      const mapped = logs.map((log) => {
        // Cache uniquement (pas de fetch API) pour rester rapide : si le
        // membre n'est pas en cache, on retombe sur son ID brut.
        const member = interaction.guild.members.cache.get(log.executorId);
        const label = member ? member.user.tag : log.executorId ? `ID ${log.executorId}` : "Unknown";
        return {
          name: `${log.caseId} • ${label} • ${log.type}`.slice(0, 100),
          value: log.caseId,
          searchable: `${log.caseId} ${label} ${log.type}`.toLowerCase(),
        };
      });

      const filtered = focused ? mapped.filter((c) => c.searchable.includes(focused)) : mapped;

      return interaction.respond(filtered.slice(0, 25).map(({ name, value }) => ({ name, value })));
    } catch (error) {
      console.error("[LOTUS-CASE AUTOCOMPLETE ERROR]", error);
      return interaction.respond([]).catch(() => null);
    }
  },

  async execute(interaction) {
    let caseId = interaction.options.getString("id").trim().toUpperCase();
    if (!caseId.startsWith("CASE-")) caseId = `CASE-${caseId}`;

    const log = await SecurityLog.findOne({ guildId: interaction.guild.id, caseId });

    if (!log) {
      return interaction.reply({
        content: `❌ No case found for \`${caseId}\` on this server.`,
        ephemeral: true,
      });
    }

    const target = await interaction.client.users.fetch(log.executorId).catch(() => null);

    const detailsText =
      log.details && Object.keys(log.details).length
        ? Object.entries(log.details)
            .map(([k, v]) => `> **${k}** : \`${Array.isArray(v) ? v.join(", ") : v}\``)
            .join("\n")
        : "No additional details.";

    const embed = new EmbedBuilder()
      .setTitle(`📁 Case ${log.caseId}`)
      .setColor("#8e5cff")
      .addFields(
        {
          name: "👤 User",
          value: target ? `${target}\n\`${target.tag}\`\n\`ID: ${log.executorId}\`` : `\`ID: ${log.executorId}\``,
          inline: true,
        },
        { name: "🛡️ Type", value: `\`${log.type}\``, inline: true },
        { name: "⚡ Punishment", value: `\`${log.punishmentApplied ?? "N/A"}\``, inline: true },
        { name: "📝 Reason", value: log.reason || "Not specified", inline: false },
        { name: "🔍 Details", value: detailsText, inline: false },
        {
          name: "📅 Date",
          value: `<t:${Math.floor(new Date(log.createdAt).getTime() / 1000)}:F>`,
          inline: false,
        }
      )
      .setFooter({ text: "Lotus Security System" });

    if (target) embed.setThumbnail(target.displayAvatarURL({ dynamic: true }));

    return interaction.reply({ embeds: [embed], ephemeral: true });
  },
};