const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const { getGuildConfig, invalidate } = require("../utils/configCache");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("lotus-whitelist")
    .setDescription("Manages the anti-nuke whitelist (grants extra tolerance before sanctions)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Adds a member to the whitelist")
        .addUserOption((opt) =>
          opt.setName("member").setDescription("Member to whitelist").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Removes a member from the whitelist")
        .addUserOption((opt) =>
          opt.setName("member").setDescription("Member to remove").setRequired(true)
        )
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("Displays the current whitelist")),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildConfig = await getGuildConfig(interaction.guild.id);

    // --- SUBCOMMAND: LIST ---
    if (sub === "list") {
      const list = guildConfig.whitelist?.length
        ? guildConfig.whitelist.map((id) => `<@${id}>`).join("\n")
        : "No members whitelisted.";
      return interaction.reply({ content: `**Current whitelist:**\n${list}`, ephemeral: true });
    }

    const user = interaction.options.getUser("member");

    // --- SECURITY & HIERARCHY CHECKS ---
    const isExecutorServerOwner = interaction.user.id === interaction.guild.ownerId;
    const isExecutorBotOwner = process.env.OWNER_ID && interaction.user.id === process.env.OWNER_ID;
    const isExecutorBypass = isExecutorServerOwner || isExecutorBotOwner;

    // If the executor is NOT an Owner (Server or Bot), apply strict filtering
    if (!isExecutorBypass) {
      // 1. Protect owners from regular admins
      const isTargetOwner =
        user.id === interaction.guild.ownerId ||
        (process.env.OWNER_ID && user.id === process.env.OWNER_ID);

      if (isTargetOwner) {
        return interaction.reply({
          content: "❌ **Security:** Only the server owner or the bot owner can change an owner's status.",
          ephemeral: true,
        });
      }

      // 2. Prevent a regular admin from changing their own status
      if (user.id === interaction.user.id) {
        return interaction.reply({
          content: "❌ You cannot change your own whitelist status.",
          ephemeral: true,
        });
      }

      // 3. Discord role hierarchy
      const targetMember = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (
        targetMember &&
        targetMember.roles.highest.position >= interaction.member.roles.highest.position
      ) {
        return interaction.reply({
          content:
            "❌ **Security:** You cannot modify the whitelist of a member with a role equal to or higher than yours.",
          ephemeral: true,
        });
      }
    }

    // --- SUBCOMMAND: ADD ---
    if (sub === "add") {
      if (guildConfig.whitelist.includes(user.id)) {
        return interaction.reply({ content: `${user} is already whitelisted.`, ephemeral: true });
      }
      guildConfig.whitelist.push(user.id);
      await guildConfig.save();
      invalidate(interaction.guild.id);
      return interaction.reply({ content: `✅ ${user} added to the whitelist.`, ephemeral: true });
    }

    // --- SUBCOMMAND: REMOVE ---
    if (sub === "remove") {
      if (!guildConfig.whitelist.includes(user.id)) {
        return interaction.reply({ content: `⚠️ ${user} is not in the whitelist.`, ephemeral: true });
      }
      guildConfig.whitelist = guildConfig.whitelist.filter((id) => id !== user.id);
      await guildConfig.save();
      invalidate(interaction.guild.id);
      return interaction.reply({ content: `✅ ${user} removed from the whitelist.`, ephemeral: true });
    }
  },
};
