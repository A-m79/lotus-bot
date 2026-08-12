const GuildBackup = require("../models/GuildBackup");

async function takeBackup(guild) {
  const roles = guild.roles.cache
    .filter((r) => !r.managed && r.id !== guild.id)
    .map((r) => ({
      name: r.name,
      color: r.color,
      hoist: r.hoist,
      permissions: r.permissions.bitfield.toString(),
      mentionable: r.mentionable,
    }));

  const channels = guild.channels.cache.map((c) => ({
    name: c.name,
    type: c.type,
    parentName: c.parent ? c.parent.name : null,
    position: c.rawPosition,
  }));

  await GuildBackup.findOneAndUpdate(
    { guildId: guild.id },
    { roles, channels, updatedAt: new Date() },
    { upsert: true, new: true }
  );
}

async function restoreBackup(guild) {
  const backup = await GuildBackup.findOne({ guildId: guild.id });
  if (!backup) return false;

  // Restauration des rôles manquants
  for (const r of backup.roles) {
    if (!guild.roles.cache.some((existing) => existing.name === r.name)) {
      await guild.roles.create({
        name: r.name,
        color: r.color,
        hoist: r.hoist,
        permissions: BigInt(r.permissions),
        mentionable: r.mentionable,
      }).catch(() => null);
    }
  }

  // Restauration des salons manquants
  for (const c of backup.channels) {
    if (!guild.channels.cache.some((existing) => existing.name === c.name)) {
      await guild.channels.create({
        name: c.name,
        type: c.type,
      }).catch(() => null);
    }
  }
  return true;
}

module.exports = { takeBackup, restoreBackup };