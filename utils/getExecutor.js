const { AuditLogEvent } = require("discord.js");

/**
 * Discord doesn't directly include "who performed the action" in most
 * events (channelDelete, roleDelete, etc.): you have to look up the
 * matching Audit Log entry, the most recent one that actually matches
 * the intended target.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').AuditLogEvent} auditType
 * @param {string} targetId - ID of the target (deleted channel/role/user) to match the right entry
 * @param {number} maxAgeMs - ignores entries that are too old (avoids matching a stale action)
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
    console.error("[getExecutor] Unable to read audit logs:", err.message);
    return null;
  }
}

module.exports = { getExecutor, AuditLogEvent };