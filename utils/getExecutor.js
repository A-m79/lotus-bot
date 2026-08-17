const { AuditLogEvent } = require("discord.js");

/**
 * Discord doesn't directly include "who performed the action" in most
 * events (channelDelete, roleDelete, etc.): you have to look up the
 * matching Audit Log entry, the most recent one that actually matches
 * the intended target.
 *
 * Bug fixed (silent anti-nuke bypass on fast bursts): this used to fetch
 * only the 5 most recent entries (`limit: 5`). During a fast burst (e.g.
 * 10+ channel deletions in under 10s), Discord writes audit log entries
 * for later deletions before this handler gets to run for an earlier one
 * (network latency + the retry/delay logic in antiNuke.js). Those newer
 * entries pushed the one we were looking for out of the top-5 window, so
 * `entry` was `undefined` and we silently returned `null` — the deletion
 * was never counted by rateTracker, so a fast, patient actor (even a
 * whitelisted one, since whitelist only grants a threshold bonus, not
 * immunity) could delete far more channels than the configured threshold
 * without ever being punished. Raising the limit to 25 (a single, cheap
 * audit-log call) keeps the correct entry in range even under a rapid
 * burst well beyond any realistic threshold.
 *
 * Bug fixed (deletions never punished at all): matching used
 * `e.target?.id === targetId`. For deletion events (channelDelete,
 * roleDelete, emojiDelete, stickerDelete...), the deleted object no longer
 * exists by the time discord.js tries to resolve `entry.target`, so it's
 * always `null`/`undefined` — the comparison failed on every single
 * deletion, `entry` was never found, and `getExecutor` silently returned
 * `null` for 100% of deletions (creation/update events were unaffected
 * since their target still exists and resolves fine). This is why mass
 * channel/role/emoji/sticker CREATION was correctly punished but mass
 * DELETION never triggered anything. `entry.targetId` is a raw ID string
 * that discord.js always populates regardless of whether the target object
 * itself can still be resolved, so it's used first; `entry.target?.id` is
 * kept as a fallback for safety.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').AuditLogEvent} auditType
 * @param {string} targetId - ID of the target (deleted channel/role/user) to match the right entry
 * @param {number} maxAgeMs - ignores entries that are too old (avoids matching a stale action)
 */
async function getExecutor(guild, auditType, targetId, maxAgeMs = 5000) {
  try {
    const logs = await guild.fetchAuditLogs({ type: auditType, limit: 25 });
    const entry = logs.entries.find(
      (e) =>
        (!targetId || e.targetId === targetId || e.target?.id === targetId) &&
        Date.now() - e.createdTimestamp <= maxAgeMs
    );
    return entry?.executor ?? null;
  } catch (err) {
    console.error("[getExecutor] Unable to read audit logs:", err.message);
    return null;
  }
}

module.exports = { getExecutor, AuditLogEvent };