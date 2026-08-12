const { EmbedBuilder } = require("discord.js");
const config = require("../config/config");
const SecurityLog = require("../models/SecurityLog");

/**
 * Applique une sanction à un membre suite à une détection anti-nuke/anti-raid,
 * log l'incident en base, et envoie une alerte dans le salon configuré.
 */
async function punish({ guild, guildConfig, executorId, actionType, reason, details = {} }) {
  const punishment = guildConfig?.punishment || config.DEFAULT_PUNISHMENT;

  let member;
  try {
    member = await guild.members.fetch(executorId);
  } catch {
    // Le membre a peut-être déjà quitté / a été retiré
  }

  let punishmentApplied = "none";

  try {
    if (member) {
      switch (punishment) {
        case "ban":
          await guild.members.ban(executorId, { reason: `[Lotus] ${reason}` });
          punishmentApplied = "ban";
          break;

        case "kick":
          await member.kick(`[Lotus] ${reason}`);
          punishmentApplied = "kick";
          break;

        case "quarantine":
          if (guildConfig?.quarantineRoleId) {
            const currentRoles = member.roles.cache
              .filter((r) => r.id !== guild.id)
              .map((r) => r.id);
            await member.roles.set([guildConfig.quarantineRoleId], `[Lotus] ${reason}`);
            details.previousRoles = currentRoles;
            punishmentApplied = "quarantine";
          } else {
            // Pas de rôle quarantaine configuré -> fallback stripRoles
            await member.roles.set([], `[Lotus] ${reason}`);
            punishmentApplied = "stripRoles (fallback: pas de rôle quarantaine configuré)";
          }
          break;

        case "stripRoles":
        default:
          await member.roles.set([], `[Lotus] ${reason}`);
          punishmentApplied = "stripRoles";
          break;
      }
    }
  } catch (err) {
    console.error(`[Punisher] Échec de la sanction sur ${executorId}:`, err.message);
    punishmentApplied = `error: ${err.message}`;
  }

  // Log en base pour audit / futur dashboard
  await SecurityLog.create({
    guildId: guild.id,
    type: actionType,
    executorId,
    details,
    punishmentApplied,
  });

  // Alerte dans le salon configuré
  if (guildConfig?.alertChannelId) {
    const channel = await guild.channels
      .fetch(guildConfig.alertChannelId)
      .catch(() => null);

    if (channel?.isTextBased()) {
      const embed = new EmbedBuilder()
        .setColor(config.EMBED_COLOR_ALERT)
        .setTitle("🚨 Menace détectée")
        .setDescription(reason)
        .addFields(
          { name: "Utilisateur", value: `<@${executorId}> (${executorId})`, inline: true },
          { name: "Action", value: actionType, inline: true },
          { name: "Sanction", value: punishmentApplied, inline: true }
        )
        .setTimestamp();

      await channel.send({ embeds: [embed] }).catch(() => null);
    }
  }

  return punishmentApplied;
}

module.exports = { punish };
