const { EmbedBuilder } = require("discord.js");
const config = require("../config/config");
const SecurityLog = require("../models/SecurityLog");

/**
 * Génère un identifiant de dossier unique (Ex: CASE-A7F92)
 */
function generateCaseId() {
  return `CASE-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
}

/**
 * Moteur de sanction centralisé Lotus Security Pro
 */
async function punish({
  guild,
  guildConfig,
  executorId,
  actionType,
  reason,
  details = {},
  customSanction = null,
}) {
  const caseId = generateCaseId();
  const punishment = customSanction || guildConfig?.punishment || config.DEFAULT_PUNISHMENT;

  let member = null;
  let targetUser = null;

  try {
    member = await guild.members.fetch(executorId).catch(() => null);
    targetUser = member
      ? member.user
      : await guild.client.users.fetch(executorId).catch(() => null);
  } catch {
    // Membre inexistant ou hors du serveur
  }

  let punishmentApplied = "none";
  let statusIcon = "⚙️";

  // 1. Contrôle de hiérarchie des rôles
  const me = guild.members.me;
  const canManageTarget =
    member &&
    member.id !== guild.ownerId &&
    me.roles.highest.position > member.roles.highest.position;

  // 2. Notification MP (DM) à la cible avant sanction
  if (targetUser && !targetUser.bot) {
    const dmEmbed = new EmbedBuilder()
      .setColor("#FF2A2A")
      .setTitle(`🛡️ Protection Lotus Security — ${guild.name}`)
      .setDescription(`Votre compte a déclenché une alerte de sécurité.`)
      .addFields(
        { name: "Raison", value: `\`${reason}\``, inline: false },
        { name: "Sanction", value: `\`${punishment.toUpperCase()}\``, inline: true },
        { name: "Dossier ID", value: `\`#${caseId}\``, inline: true }
      )
      .setFooter({ text: "Si vous pensez qu'il s'agit d'une erreur, contactez un administrateur." })
      .setTimestamp();

    await targetUser.send({ embeds: [dmEmbed] }).catch(() => null); // Ignore si MPs fermés
  }

  // 3. Exécution de la sanction
  try {
    if (member && canManageTarget) {
      switch (punishment) {
        case "ban":
          await guild.members.ban(executorId, { reason: `[Lotus #${caseId}] ${reason}` });
          punishmentApplied = "BAN (Bannissement définitif)";
          statusIcon = "🔨";
          break;

        case "kick":
          await member.kick(`[Lotus #${caseId}] ${reason}`);
          punishmentApplied = "KICK (Exclusion du serveur)";
          statusIcon = "🥾";
          break;

        case "timeout":
          // Timeout natif Discord de 24h
          await member.timeout(24 * 60 * 60 * 1000, `[Lotus #${caseId}] ${reason}`);
          punishmentApplied = "TIMEOUT (Exclusion temporaire 24h)";
          statusIcon = "⏳";
          break;

        case "quarantine":
          if (guildConfig?.quarantineRoleId) {
            const currentRoles = member.roles.cache
              .filter((r) => r.id !== guild.id)
              .map((r) => r.id);
            details.previousRoles = currentRoles;
            await member.roles.set([guildConfig.quarantineRoleId], `[Lotus #${caseId}] ${reason}`);
            punishmentApplied = "QUARANTAINE (Isolement)";
            statusIcon = "☣️";
          } else {
            await member.roles.set([], `[Lotus #${caseId}] ${reason}`);
            punishmentApplied = "STRIP_ROLES (Fallback: Pas de rôle Quarantaine)";
            statusIcon = "⚠️";
          }
          break;

        case "stripRoles":
        default:
          await member.roles.set([], `[Lotus #${caseId}] ${reason}`);
          punishmentApplied = "STRIP_ROLES (Retrait de tous les rôles)";
          statusIcon = "🚫";
          break;
      }
    } else if (member && !canManageTarget) {
      punishmentApplied = "ÉCHEC (Hiérarchie : Le rôle du bot est trop bas)";
      statusIcon = "❌";
    } else if (punishment === "ban") {
      // Ban d'urgence à distance (Hackban) si le membre n'est plus sur le serveur
      await guild.members.ban(executorId, { reason: `[Lotus #${caseId}] ${reason}` });
      punishmentApplied = "BAN (Bannissement à distance)";
      statusIcon = "🔨";
    }
  } catch (err) {
    console.error(`[Punisher #${caseId}] Erreur execution sur ${executorId}:`, err.message);
    punishmentApplied = `ERREUR : ${err.message}`;
    statusIcon = "⚠️";
  }

  // 4. Historisation dans MongoDB
  await SecurityLog.create({
    caseId,
    guildId: guild.id,
    type: actionType,
    executorId,
    details,
    reason,
    punishmentApplied,
    timestamp: new Date(),
  }).catch((err) => console.error("[SecurityLog DB Error]:", err));

  // 5. Alertes visuelles pro dans le salon de logs
  if (guildConfig?.alertChannelId) {
    const channel = await guild.channels.fetch(guildConfig.alertChannelId).catch(() => null);

    if (channel?.isTextBased()) {
      // Couleurs adaptatives selon le type de punition
      const colors = {
        ban: "#000000",
        kick: "#FF0055",
        timeout: "#FF9900",
        quarantine: "#A800FF",
        stripRoles: "#FFCC00",
      };
      const embedColor = colors[punishment] || config.EMBED_COLOR_ALERT || "#FF2A2A";

      const embed = new EmbedBuilder()
        .setColor(embedColor)
        .setAuthor({
          name: `PROTECTION AU SOMMET • ${guild.name.toUpperCase()}`,
          iconURL: guild.iconURL({ dynamic: true }) || undefined,
        })
        .setTitle(`${statusIcon} Menace Neutralisée — #${caseId}`)
        .setDescription(`> **Motif :** \`${reason}\``)
        .addFields(
          {
            name: "👤 Utilisateur",
            value: targetUser
              ? `${targetUser}\n\`${targetUser.tag}\`\n\`ID: ${executorId}\``
              : `\`ID: ${executorId}\``,
            inline: true,
          },
          {
            name: "🛡️ Détecteur",
            value: `\`${actionType.toUpperCase()}\``,
            inline: true,
          },
          {
            name: "⚡ Sanction",
            value: `\`${punishmentApplied}\``,
            inline: true,
          }
        );

      // Métadonnées & Preuves formatées
      const filteredDetails = Object.entries(details).filter(([key]) => key !== "previousRoles");
      if (filteredDetails.length > 0) {
        const formattedDetails = filteredDetails
          .map(([key, val]) => `> **${key}** : \`${val}\``)
          .join("\n");
        embed.addFields({
          name: "🔍 Preuves & Métadonnées",
          value: formattedDetails,
          inline: false,
        });
      }

      if (targetUser?.displayAvatarURL()) {
        embed.setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 256 }));
      }

      embed
        .setFooter({ text: `Lotus Security System • Case #${caseId}` })
        .setTimestamp();

      await channel.send({ embeds: [embed] }).catch(() => null);
    }
  }

  return { caseId, punishmentApplied };
}

module.exports = { punish };