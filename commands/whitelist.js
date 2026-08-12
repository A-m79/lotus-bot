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

    // --- SOUS-COMMANDE : LISTE ---
    if (sub === "liste") {
      const list = guildConfig.whitelist?.length
        ? guildConfig.whitelist.map((id) => `<@${id}>`).join("\n")
        : "Aucun membre whitelisté.";
      return interaction.reply({ content: `**Whitelist actuelle:**\n${list}`, ephemeral: true });
    }

    const user = interaction.options.getUser("membre");

    // --- CONTRÔLES DE SÉCURITÉ ET HIÉRARCHIE ---
    const isExecutorServerOwner = interaction.user.id === interaction.guild.ownerId;
    const isExecutorBotOwner = process.env.OWNER_ID && interaction.user.id === process.env.OWNER_ID;
    const isExecutorBypass = isExecutorServerOwner || isExecutorBotOwner;

    // Si l'exécuteur N'EST PAS un Owner (Serveur ou Bot), on applique le filtrage strict
    if (!isExecutorBypass) {
      // 1. Protection des propriétaires contre les admins classiques
      const isTargetOwner =
        user.id === interaction.guild.ownerId ||
        (process.env.OWNER_ID && user.id === process.env.OWNER_ID);

      if (isTargetOwner) {
        return interaction.reply({
          content: "❌ **Sécurité :** Seul le propriétaire du serveur ou du bot peut modifier le statut d'un propriétaire.",
          ephemeral: true,
        });
      }

      // 2. Interdiction de modifier son propre statut pour un simple admin
      if (user.id === interaction.user.id) {
        return interaction.reply({
          content: "❌ Vous ne pouvez pas modifier votre propre statut dans la whitelist.",
          ephemeral: true,
        });
      }

      // 3. Hiérarchie des rôles Discord
      const targetMember = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (
        targetMember &&
        targetMember.roles.highest.position >= interaction.member.roles.highest.position
      ) {
        return interaction.reply({
          content:
            "❌ **Sécurité :** Vous ne pouvez pas modifier la whitelist d'un membre ayant un rôle supérieur ou égal au vôtre.",
          ephemeral: true,
        });
      }
    }

    // --- SOUS-COMMANDE : AJOUTER ---
    if (sub === "ajouter") {
      if (guildConfig.whitelist.includes(user.id)) {
        return interaction.reply({ content: `${user} est déjà whitelisté.`, ephemeral: true });
      }
      guildConfig.whitelist.push(user.id);
      await guildConfig.save();
      invalidate(interaction.guild.id);
      return interaction.reply({ content: `✅ ${user} ajouté à la whitelist.`, ephemeral: true });
    }

    // --- SOUS-COMMANDE : RETIRER ---
    if (sub === "retirer") {
      if (!guildConfig.whitelist.includes(user.id)) {
        return interaction.reply({ content: `⚠️ ${user} n'est pas dans la whitelist.`, ephemeral: true });
      }
      guildConfig.whitelist = guildConfig.whitelist.filter((id) => id !== user.id);
      await guildConfig.save();
      invalidate(interaction.guild.id);
      return interaction.reply({ content: `✅ ${user} retiré de la whitelist.`, ephemeral: true });
    }
  },
};