/**
 * Suivi des invitations : identifie par quel lien (ou URL vanity) chaque
 * nouveau membre est arrivé, en comparant le nombre d'utilisations avant/après
 * chaque arrivée. Utile pour les enquêtes anti-raid : savoir quel lien a été
 * diffusé pour organiser un raid permet de le révoquer et de tracer sa source.
 *
 * Nécessite que le bot ait la permission "Gérer le serveur" (Manage Guild)
 * pour lire les invitations existantes.
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
    // Permission "Gérer le serveur" manquante : on ignore silencieusement,
    // le reste du bot fonctionne normalement sans cette fonctionnalité annexe.
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

  console.log("[InviteTracker] Suivi des invitations actif.");
}

/**
 * Retourne { code, type } si l'invitation utilisée par ce membre a pu être
 * identifiée dans les 5 minutes suivant son arrivée, sinon null.
 */
function getInviteInfo(guildId, memberId) {
  return resolvedJoins.get(`${guildId}:${memberId}`) ?? null;
}

module.exports = { registerInviteTracker, getInviteInfo };
