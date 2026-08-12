const { AuditLogEvent } = require("discord.js");

/**
 * Discord n'inclut pas directement "qui a fait l'action" dans la plupart
 * des events (channelDelete, roleDelete, etc.) : il faut aller chercher
 * l'entrée correspondante dans les Audit Logs, la plus récente et
 * correspondant bien à la cible visée.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').AuditLogEvent} auditType
 * @param {string} targetId - ID de la cible (channel/role/user supprimé) pour matcher la bonne entrée
 * @param {number} maxAgeMs - ignore les entrées trop vieilles (évite de matcher une vieille action)
 */
async function getExecutor(guild, auditType, targetId, maxAgeMs = 5000) {
  try {
    const logs = await guild.fetchAuditLogs({ type: auditType, limit: 5 });
    const entry = logs.entries.find(
      (e) =>
        (!targetId || e.target?.id === targetId) &&
        Date.now() - e.createdTimestamp <= maxAgeMs
    );
    return entry?.executor ?? null;
  } catch (err) {
    console.error("[getExecutor] Impossible de lire les audit logs:", err.message);
    return null;
  }
}

module.exports = { getExecutor, AuditLogEvent };
