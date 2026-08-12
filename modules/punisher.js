const { EmbedBuilder, PermissionFlagsBits } = require("discord.js");
const config = require("../config/config");
const SecurityLog = require("../models/SecurityLog");

// Verrou en mémoire pour éviter d'exécuter des sanctions/MP en double lors d'une rafale de messages
const activePunishments = new Set();

function generateCaseId() {
  return `CASE-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
}

async function punish({
  guild,
  guildConfig,
  executorId,
  actionType,
  reason,
  details = {},
  customSanction = null,
}) {
  // Ignorer si une sanction est déjà en cours d'application pour cet utilisateur
  if (activePunishments.has(executorId)) {
    return null;
  }

  activePunishments.add(executorId);
  setTimeout(() => activePunishments.delete(executorId), 10000); // Libération après 10s

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
  let success = false;

  // 1. Contrôle de hiérarchie des rôles
  const me = await guild.members.fetchMe().catch(() => guild.members.me);
  const canManageTarget =
    member &&
    member.id !== guild.ownerId &&
    me &&
    me.roles.highest.position > member.roles.highest.position;

  // 2. Exécution de la sanction
  try {
    if (member && canManageTarget) {
      switch (punishment) {
        case "ban":
          await guild.members.ban(executorId, { reason: `[Lotus #${caseId}] ${reason}` });
          punishmentApplied = "BAN (Bannissement définitif)";
          statusIcon = "🔨";
          success = true;
          break;

        case "kick":
          await member.kick(`[Lotus #${caseId}] ${reason}`);
          punishmentApplied = "KICK (Exclusion du serveur)";
          statusIcon = "🥾";
          success = true;
          break;

        case "timeout":
          // D'ABORD : Retrait des rôles (retire Admin) + Attribution rôle Quarantaine direct en 1 seule requête
          const timeoutRoles = guildConfig?.quarantineRoleId ? [guildConfig.quarantineRoleId] : [];
          await member.roles.set(timeoutRoles, `[Lotus #${caseId}] Retrait des rôles + Isolement`);

          // PAUSE : 1.5s pour que l'API Discord enregistre la perte de la permission Admin
          await new Promise((resolve) => setTimeout(resolve, 1500));

          // ENSUITE : Application du Timeout
          await member.timeout(24 * 60 * 60 * 1000, `[Lotus #${caseId}] ${reason}`);
          punishmentApplied = "STRIP_ROLES + TIMEOUT (24h)";
          statusIcon = "☣️";
          success = true;
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
          success = true;
          break;

        case "stripRoles":
        default:
          if (guildConfig?.quarantineRoleId) {
            await member.roles.set([guildConfig.quarantineRoleId], `[Lotus #${caseId}] ${reason}`);
            punishmentApplied = "STRIP_ROLES + ISOLEMENT";
            statusIcon = "☣️";
          } else {
            await member.roles.set([], `[Lotus #${caseId}] ${reason}`);
            punishmentApplied = "STRIP_ROLES (Retrait de tous les rôles)";
            statusIcon = "🚫";
          }
          success = true;
          break;
      }
    } else if (member && !canManageTarget) {
      punishmentApplied = "ÉCHEC (Hiérarchie : Le rôle du bot est trop bas)";
      statusIcon = "❌";
    } else if (punishment === "ban") {
      await guild.members.ban(executorId, { reason: `[Lotus #${caseId}] ${reason}` });
      punishmentApplied = "BAN (Bannissement à distance)";
      statusIcon = "🔨";
      success = true;
    }
  } catch (err) {
    console.error(`[Punisher #${caseId}] Erreur execution sur ${executorId}:`, err.message);
    punishmentApplied = `ERREUR : ${err.message}`;
    statusIcon = "⚠️";
  }

  // 3. Notification MP (DM) uniquement si la sanction s'est appliquée sans erreur
  if (targetUser && !targetUser.bot && success) {
    const dmEmbed = new EmbedBuilder()
      .setColor("#FF2A2A")
      .setTitle(`🛡️ Protection Lotus Security — ${guild.name}`)
      .setDescription(`Votre compte a déclenché une alerte de sécurité.`)
      .addFields(
        { name: "Raison", value: `\`${reason}\``, inline: false },
        { name: "Sanction", value: `\`${punishmentApplied}\``, inline: true },
        { name: "Dossier ID", value: `\`#${caseId}\``, inline: true }
      )
      .setFooter({ text: "Si vous pensez qu'il s'agit d'une erreur, contactez un administrateur." })
      .setTimestamp();

    await targetUser.send({ embeds: [dmEmbed] }).catch(() => null);
  }

  // 4. Historisation MongoDB
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

  // 5. Logs salon (#logs-lotus ou #alert)
  const targetChannelId = guildConfig?.logChannelId || guildConfig?.alertChannelId;

  if (targetChannelId) {
    const channel = await guild.channels.fetch(targetChannelId).catch(() => null);

    if (channel?.isTextBased()) {
      const colors = {
        ban: "#000000",
        kick: "#FF0055",
        timeout: "#FF9900",
        quarantine: "#A800FF",
        stripRoles: "#FFCC00",
      };
      const embedColor = success
        ? colors[punishment] || config.EMBED_COLOR_ALERT || "#FF2A2A"
        : "#FFCC00";

      const embed = new EmbedBuilder()
        .setColor(embedColor)
        .setAuthor({
          name: `PROTECTION AU SOMMET • ${guild.name.toUpperCase()}`,
          iconURL: guild.iconURL({ dynamic: true }) || undefined,
        })
        .setTitle(`${statusIcon} ${success ? "Menace Neutralisée" : "Alerte Sécurité"} — #${caseId}`)
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