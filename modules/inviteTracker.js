/**
 * Invite tracking: identifies which link (or vanity URL) each new member
 * arrived through, by comparing use counts before/after each join. Useful
 * for anti-raid investigations: knowing which link was spread to organize
 * a raid lets you revoke it and trace its source.
 *
 * Requires the bot to have the "Manage Server" permission (Manage Guild)
 * to read existing invites.
 */

const inviteCache = new Map(); // guildId -> Map(code -> uses)
const resolvedJoins = new Map(); // `${guildId}:${memberId}` -> { code, type, expiresAt }

async function cacheGuildInvites(guild) {
  try {
    const invites = await guild.invites.fetch();
    const map = new Map();
    invites.forEach((inv) => map.set(inv.code, inv.uses ?? 0));

    if (guild.vanityURLCode) {
      const vanity = await guild.fetchVanityData().catch(() => null);
      if (vanity) map.set(`vanity:${vanity.code}`, vanity.uses ?? 0);
    }

    inviteCache.set(guild.id, map);
  } catch {
    // Missing "Manage Server" permission: silently ignored,
    // the rest of the bot works normally without this side feature.
  }
}

function registerInviteTracker(client) {
  client.once("ready", async () => {
    for (const guild of client.guilds.cache.values()) {
      await cacheGuildInvites(guild);
    }
  });

  client.on("guildCreate", (guild) => cacheGuildInvites(guild));
  client.on("inviteCreate", (invite) => invite.guild && cacheGuildInvites(invite.guild));
  client.on("inviteDelete", (invite) => invite.guild && cacheGuildInvites(invite.guild));

  client.on("guildMemberAdd", async (member) => {
    const guild = member.guild;
    const before = inviteCache.get(guild.id);

    await cacheGuildInvites(guild);
    const after = inviteCache.get(guild.id);

    if (!before || !after) return;

    let usedCode = null;
    let usedType = "invite";

    for (const [code, uses] of after.entries()) {
      const prevUses = before.get(code) ?? 0;
      if (uses > prevUses) {
        usedCode = code;
        usedType = code.startsWith("vanity:") ? "vanity" : "invite";
        break;
      }
    }

    if (usedCode) {
      resolvedJoins.set(`${guild.id}:${member.id}`, {
        code: usedCode.replace("vanity:", ""),
        type: usedType,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
    }
  });

  setInterval(() => {
    const now = Date.now();
    for (const [key, data] of resolvedJoins.entries()) {
      if (now > data.expiresAt) resolvedJoins.delete(key);
    }
  }, 60_000);

  console.log("[InviteTracker] Invite tracking active.");
}

/**
 * Returns { code, type } if the invite used by this member could be
 * identified within 5 minutes of their join, otherwise null.
 */
function getInviteInfo(guildId, memberId) {
  return resolvedJoins.get(`${guildId}:${memberId}`) ?? null;
}

module.exports = { registerInviteTracker, getInviteInfo };