const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const { getGuildConfig, invalidateGuildConfig } = require("../utils/configCache");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("lotus-whitelist")
    .setDescription("Manages the anti-nuke whitelist (grants extra tolerance before sanctions)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Adds a member or role to the whitelist")
        .addUserOption((opt) =>
          opt.setName("member").setDescription("Member to whitelist").setRequired(false)
        )
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("Role to whitelist (e.g. a shared bot-auto role)").setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Removes a member or role from the whitelist")
        .addUserOption((opt) =>
          opt.setName("member").setDescription("Member to remove").setRequired(false)
        )
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("Role to remove").setRequired(false)
        )
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("Displays the current whitelist")),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildConfig = await getGuildConfig(interaction.guild.id);

    // --- SUBCOMMAND: LIST ---
    if (sub === "list") {
      const memberList = guildConfig.whitelist?.length
        ? guildConfig.whitelist.map((id) => `<@${id}>`).join("\n")
        : "*None.*";
      const roleList = guildConfig.whitelistRoles?.length
        ? guildConfig.whitelistRoles.map((id) => `<@&${id}>`).join("\n")
        : "*None.*";
      return interaction.reply({
        content: `**Whitelisted members:**\n${memberList}\n\n**Whitelisted roles:**\n${roleList}`,
        ephemeral: true,
      });
    }

    const user = interaction.options.getUser("member");
    const role = interaction.options.getRole("role");

    if (!user && !role) {
      return interaction.reply({
        content: "❌ Provide either a `member` or a `role`.",
        ephemeral: true,
      });
    }
    if (user && role) {
      return interaction.reply({
        content: "❌ Provide only one: a `member` OR a `role`, not both at once.",
        ephemeral: true,
      });
    }

    const isExecutorServerOwner = interaction.user.id === interaction.guild.ownerId;
    const isExecutorBotOwner = process.env.OWNER_ID && interaction.user.id === process.env.OWNER_ID;
    const isExecutorBypass = isExecutorServerOwner || isExecutorBotOwner;

    // ═══════════════════════════ MEMBER PATH ═══════════════════════════
    if (user) {
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

      if (sub === "add") {
        if (guildConfig.whitelist.includes(user.id)) {
          return interaction.reply({ content: `${user} is already whitelisted.`, ephemeral: true });
        }
        guildConfig.whitelist.push(user.id);
        await guildConfig.save();
        invalidateGuildConfig(interaction.guild.id);
        return interaction.reply({ content: `✅ ${user} added to the whitelist.`, ephemeral: true });
      }

      if (sub === "remove") {
        if (!guildConfig.whitelist.includes(user.id)) {
          return interaction.reply({ content: `⚠️ ${user} is not in the whitelist.`, ephemeral: true });
        }
        guildConfig.whitelist = guildConfig.whitelist.filter((id) => id !== user.id);
        await guildConfig.save();
        invalidateGuildConfig(interaction.guild.id);
        return interaction.reply({ content: `✅ ${user} removed from the whitelist.`, ephemeral: true });
      }
    }

    // ═══════════════════════════ ROLE PATH ═══════════════════════════
    if (role) {
      // Whitelisting @everyone would give the whole server the threshold
      // bonus at once, effectively neutering anti-nuke sensitivity guild-wide.
      if (role.id === interaction.guild.id) {
        return interaction.reply({
          content: "❌ **Security:** You cannot whitelist the @everyone role.",
          ephemeral: true,
        });
      }

      // Hierarchy check mirroring the member path: a regular admin can't
      // whitelist a role positioned at or above their own highest role.
      if (!isExecutorBypass && role.position >= interaction.member.roles.highest.position) {
        return interaction.reply({
          content:
            "❌ **Security:** You cannot modify the whitelist for a role equal to or higher than your own highest role.",
          ephemeral: true,
        });
      }

      guildConfig.whitelistRoles = guildConfig.whitelistRoles || [];

      if (sub === "add") {
        if (guildConfig.whitelistRoles.includes(role.id)) {
          return interaction.reply({ content: `${role} is already whitelisted.`, ephemeral: true });
        }
        guildConfig.whitelistRoles.push(role.id);
        await guildConfig.save();
        invalidateGuildConfig(interaction.guild.id);
        return interaction.reply({
          content: `✅ ${role} added to the whitelist — any member with this role now gets the threshold bonus.`,
          ephemeral: true,
        });
      }

      if (sub === "remove") {
        if (!guildConfig.whitelistRoles.includes(role.id)) {
          return interaction.reply({ content: `⚠️ ${role} is not in the whitelist.`, ephemeral: true });
        }
        guildConfig.whitelistRoles = guildConfig.whitelistRoles.filter((id) => id !== role.id);
        await guildConfig.save();
        invalidateGuildConfig(interaction.guild.id);
        return interaction.reply({ content: `✅ ${role} removed from the whitelist.`, ephemeral: true });
      }
    }
  },
};
