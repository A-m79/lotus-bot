const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } = require("discord.js");
const GuildConfig = require("../models/GuildConfig");

// Stockage temporaire en mémoire des rôles retirés pour rétablissement via bouton
const savedMemberRoles = new Map();

async function handleLogChannelDeletion(guild, deletedChannel, executor) {
  const config = await GuildConfig.findOne({ guildId: guild.id });
  if (!config) return;

  const isLogChannel = config.logChannelId === deletedChannel.id;
  const isAlertChannel = config.alertChannelId === deletedChannel.id;

  if (!isLogChannel && !isAlertChannel) return;

  console.log(`[LOG-PROTECTOR] Suppression du salon de logs (${deletedChannel.name}) par ${executor.tag} sur ${guild.name}`);

  // 1. Sanction Immédiate : Retrait de TOUS les rôles du suspect
  const member = await guild.members.fetch(executor.id).catch(() => null);
  if (member && member.manageable && member.id !== guild.ownerId) {
    const rolesToSave = member.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.id);
    savedMemberRoles.set(`${guild.id}_${executor.id}`, rolesToSave);

    await member.roles.set([], `[Lotus LogProtector] Suppression non autorisée du salon de logs #${deletedChannel.name}`).catch(() => null);
  }

  // 2. Auto-Reconstitution du Salon de Logs
  const newChannel = await guild.channels
    .create({
      name: "alertes-lotus",
      type: ChannelType.GuildText,
      topic: "Salon de sécurité auto-recréé par Lotus Security System",
      permissionOverwrites: [
        {
          id: guild.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: guild.client.user.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
        },
      ],
    })
    .catch(() => null);

  if (newChannel) {
    if (isLogChannel) config.logChannelId = newChannel.id;
    if (isAlertChannel) config.alertChannelId = newChannel.id;
    await config.save();
  }

  // 3. Bouton interactif pour rétablir la personne en 1 clic
  const restoreButton = new ButtonBuilder()
    .setCustomId(`restore_roles_${guild.id}_${executor.id}`)
    .setLabel(`Rétablir les rôles de ${executor.username}`)
    .setStyle(ButtonStyle.Danger)
    .setEmoji("🔄");

  const row = new ActionRowBuilder().addComponents(restoreButton);

  const embed = new EmbedBuilder()
    .setTitle("🚨 ALERTE CRITIQUE : Salon de Logs Supprimé !")
    .setColor("#FF0000")
    .setDescription(
      `Le salon de sécurité **#${deletedChannel.name}** a été supprimé.\n\n` +
      `• **Auteur :** ${executor.tag} (\`${executor.id}\`)\n` +
      `• **Sanction :** Retrait immédiat de tous ses rôles.\n` +
      `• **Action Lotus :** Salon auto-recréé avec succès ${newChannel ? `<#${newChannel.id}>` : "*(Échec)*"}.`
    )
    .setFooter({ text: "Lotus Security System • Protection Ultime" })
    .setTimestamp();

  // 4. Fallback DM au Owner du serveur & Owner du bot
  const owner = await guild.fetchOwner().catch(() => null);
  if (owner) {
    await owner.send({ embeds: [embed], components: [row] }).catch(() => null);
  }

  const botOwnerId = process.env.OWNER_ID;
  if (botOwnerId && botOwnerId !== owner?.id) {
    const botOwner = await guild.client.users.fetch(botOwnerId).catch(() => null);
    if (botOwner) await botOwner.send({ embeds: [embed], components: [row] }).catch(() => null);
  }
}

async function handleRestoreRolesButton(interaction) {
  if (!interaction.customId.startsWith("restore_roles_")) return;

  await interaction.deferReply({ ephemeral: true });

  const [, , guildId, userId] = interaction.customId.split("_");
  const guild = interaction.client.guilds.cache.get(guildId);

  if (!guild) return interaction.editReply("❌ Serveur introuvable.");

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return interaction.editReply("❌ Le membre n'est plus sur le serveur.");

  const rolesToRestore = savedMemberRoles.get(`${guildId}_${userId}`);
  if (!rolesToRestore || !rolesToRestore.length) {
    return interaction.editReply("⚠️ Aucun rôle à restaurer (déjà restaurés ou session expirée).");
  }

  await member.roles.add(rolesToRestore).catch((err) => {
    return interaction.editReply(`❌ Erreur lors du rétablissement : ${err.message}`);
  });

  savedMemberRoles.delete(`${guildId}_${userId}`);

  return interaction.editReply(`✅ Rôles rétablis avec succès pour **${member.user.tag}** !`);
}

module.exports = { handleLogChannelDeletion, handleRestoreRolesButton };