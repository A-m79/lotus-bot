const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
const { getGuildConfig, invalidate } = require("../utils/configCache");
const config = require("../config/config");

/**
 * Resolves a stored ID to a readable mention, guessing role vs user from the
 * guild's role cache (falls back to a plain user mention if not a role).
 */
function formatMentionTarget(guild, id) {
  return guild.roles.cache.has(id) ? `<@&${id}>` : `<@${id}>`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("lotus-pingsecurity")
    .setDescription("Configure Lotus's mass-mention protection (@everyone/@here and protected pings)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("Shows the current ping security configuration")
    )
    .addSubcommand((sub) =>
      sub
        .setName("toggle")
        .setDescription("Enables or disables mass-mention protection entirely")
        .addBooleanOption((opt) =>
          opt
            .setName("enabled")
            .setDescription("true = protection active, false = fully disabled")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Adds a role or a person: mentioning it is treated as a mass mention")
        .addMentionableOption((opt) =>
          opt
            .setName("target")
            .setDescription("Role or member to protect")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Removes a role or a person from the protected mentions list")
        .addMentionableOption((opt) =>
          opt
            .setName("target")
            .setDescription("Role or member to unprotect")
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    const guildConfig = await getGuildConfig(interaction.guild.id);
    const sub = interaction.options.getSubcommand();

    if (sub === "status") {
      const enabled = guildConfig.pingSecurityEnabled !== false;
      const protectedIds = guildConfig.protectedMentionIds ?? [];

      const protectedList = protectedIds.length
        ? protectedIds.map((id) => `• ${formatMentionTarget(interaction.guild, id)}`).join("\n")
        : "*None — only @everyone/@here are treated as mass mentions.*";

      const embed = new EmbedBuilder()
        .setTitle("📯 Ping Security — Current Configuration")
        .setColor(config.EMBED_COLOR)
        .setDescription(
          `**Status:** ${enabled ? "🟢 Enabled" : "🔴 Disabled (no mention is ever flagged as spam)"}\n\n` +
            `**Always counted (if enabled):** \`@everyone\` / \`@here\`\n` +
            `**Also protected:**\n${protectedList}\n\n` +
            `Members: instant sanction on any protected mention.\nAdmin/Whitelist: tolerance of 3 in 15s.`
        )
        .setFooter({ text: "A role mentioned normally (e.g. @soutiens) is never flagged unless added here." });

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === "toggle") {
      const enabled = interaction.options.getBoolean("enabled");
      guildConfig.pingSecurityEnabled = enabled;
      await guildConfig.save();
      invalidate(interaction.guild.id);

      return interaction.reply({
        content: enabled
          ? "✅ Ping security **enabled** — `@everyone`/`@here` and protected mentions are monitored again."
          : "✅ Ping security **disabled** — no mention will be flagged as spam until re-enabled.",
        ephemeral: true,
      });
    }

    if (sub === "add") {
      const target = interaction.options.getMentionable("target");
      const list = guildConfig.protectedMentionIds ?? [];

      if (list.includes(target.id)) {
        return interaction.reply({
          content: `⚠️ ${formatMentionTarget(interaction.guild, target.id)} is already in the protected list.`,
          ephemeral: true,
        });
      }

      list.push(target.id);
      guildConfig.protectedMentionIds = list;
      guildConfig.markModified("protectedMentionIds");
      await guildConfig.save();
      invalidate(interaction.guild.id);

      return interaction.reply({
        content: `✅ ${formatMentionTarget(interaction.guild, target.id)} added — mentioning it now counts as a mass mention.`,
        ephemeral: true,
      });
    }

    if (sub === "remove") {
      const target = interaction.options.getMentionable("target");
      const list = guildConfig.protectedMentionIds ?? [];

      if (!list.includes(target.id)) {
        return interaction.reply({
          content: `⚠️ ${formatMentionTarget(interaction.guild, target.id)} isn't in the protected list.`,
          ephemeral: true,
        });
      }

      guildConfig.protectedMentionIds = list.filter((id) => id !== target.id);
      guildConfig.markModified("protectedMentionIds");
      await guildConfig.save();
      invalidate(interaction.guild.id);

      return interaction.reply({
        content: `✅ ${formatMentionTarget(interaction.guild, target.id)} removed from the protected list.`,
        ephemeral: true,
      });
    }
  },
};