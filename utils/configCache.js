const GuildConfig = require("../models/GuildConfig");

const cache = new Map(); // guildId -> { config, expiresAt }
const TTL_MS = 30_000;

async function getGuildConfig(guildId) {
  const cached = cache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.config;
  }

  let doc = await GuildConfig.findOne({ guildId });
  if (!doc) {
    doc = await GuildConfig.create({ guildId });
  }

  cache.set(guildId, { config: doc, expiresAt: Date.now() + TTL_MS });
  return doc;
}

/** À appeler après toute modification de config (ex: commande /lotus config) */
function invalidate(guildId) {
  cache.delete(guildId);
}

module.exports = { 
  getGuildConfig, 
  invalidate,
  invalidateGuildConfig: invalidate // 👈 Alias de sécurité pour logProtector.js
};