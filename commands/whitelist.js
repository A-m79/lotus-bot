const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const { getGuildConfig, invalidate } = require("../utils/configCache");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("lotus-whitelist")
    .setDescription("Gère la liste blanche anti-nuke (jamais sanctionnés)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("ajouter")
        .setDescription("Ajoute un membre à la whitelist")
        .addUserOption((opt) =>
          opt.setName("membre").setDescription("Membre à whitelist").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("retirer")
        .setDescription("Retire un membre de la whitelist")
        .addUserOption((opt) =>
          opt.setName("membre").setDescription("Membre à retirer").setRequired(true)
        )
    )
    .addSubcommand((sub) => sub.setName("liste").setDescription("Affiche la whitelist actuelle")),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildConfig = await getGuildConfig(interaction.guild.id);

    if (sub === "ajouter") {
      const user = interaction.options.getUser("membre");
      if (guildConfig.whitelist.includes(user.id)) {
        return interaction.reply({ content: `${user} est déjà whitelisté.`, ephemeral: true });
      }
      guildConfig.whitelist.push(user.id);
      await guildConfig.save();
      invalidate(interaction.guild.id);
      return interaction.reply({ content: `✅ ${user} ajouté à la whitelist.`, ephemeral: true });
    }

    if (sub === "retirer") {
      const user = interaction.options.getUser("membre");
      guildConfig.whitelist = guildConfig.whitelist.filter((id) => id !== user.id);
      await guildConfig.save();
      invalidate(interaction.guild.id);
      return interaction.reply({ content: `✅ ${user} retiré de la whitelist.`, ephemeral: true });
    }

    if (sub === "liste") {
      const list = guildConfig.whitelist.length
        ? guildConfig.whitelist.map((id) => `<@${id}>`).join("\n")
        : "Aucun membre whitelisté.";
      return interaction.reply({ content: `**Whitelist actuelle:**\n${list}`, ephemeral: true });
    }
  },
};
