const GuildBackup = require("../models/GuildBackup");
const { ChannelType } = require("discord.js");

async function takeBackup(guild) {
  // Sauvegarde des rôles
  const roles = guild.roles.cache
    .filter((r) => !r.managed && r.id !== guild.id)
    .map((r) => ({
      name: r.name,
      color: r.color,
      hoist: r.hoist,
      permissions: r.permissions.bitfield.toString(),
      mentionable: r.mentionable,
      position: r.position,
    }));

  // Sauvegarde des salons (avec détails et catégories)
  const channels = guild.channels.cache.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    parentName: c.parent ? c.parent.name : null,
    position: c.rawPosition,
    topic: c.topic || null,
    nsfw: c.nsfw || false,
    bitrate: c.bitrate || null,
    userLimit: c.userLimit || null,
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

  // 1. Restauration des rôles manquants
  for (const r of backup.roles) {
    const existingRole = guild.roles.cache.find((role) => role.name === r.name);
    if (!existingRole) {
      await guild.roles.create({
        name: r.name,
        color: r.color,
        hoist: r.hoist,
        permissions: BigInt(r.permissions),
        mentionable: r.mentionable,
      }).catch((err) => console.error(`[Backup] Erreur création rôle ${r.name}:`, err));
    }
  }

  // 2. Séparation des Catégories et des Salons
  const categoriesBackup = backup.channels.filter((c) => c.type === ChannelType.GuildCategory);
  const otherChannelsBackup = backup.channels.filter((c) => c.type !== ChannelType.GuildCategory);

  const createdCategories = new Map();

  // 3. Restauration des Catégories en premier
  for (const cat of categoriesBackup) {
    let existingCat = guild.channels.cache.find(
      (c) => c.name === cat.name && c.type === ChannelType.GuildCategory
    );

    if (!existingCat) {
      existingCat = await guild.channels
        .create({
          name: cat.name,
          type: ChannelType.GuildCategory,
          position: cat.position,
        })
        .catch((err) => console.error(`[Backup] Erreur création catégorie ${cat.name}:`, err));
    }

    if (existingCat) {
      createdCategories.set(cat.name, existingCat.id);
    }
  }

  // 4. Restauration des Salons (Textuels, Vocaux, etc.)
  const currentChannels = await guild.channels.fetch();

  for (const ch of otherChannelsBackup) {
    // Calcul de la quantité requise d'après la sauvegarde vs la quantité actuelle
    const targetCount = otherChannelsBackup.filter(
      (c) => c.name === ch.name && c.type === ch.type && c.parentName === ch.parentName
    ).length;

    const currentCount = currentChannels.filter(
      (c) => c.name === ch.name && c.type === ch.type && (c.parent ? c.parent.name : null) === ch.parentName
    ).size;

    // S'il en manque, on le recrée
    if (currentCount < targetCount) {
      const parentId = ch.parentName
        ? createdCategories.get(ch.parentName) ||
          guild.channels.cache.find((c) => c.name === ch.parentName && c.type === ChannelType.GuildCategory)?.id
        : null;

      const newChannel = await guild.channels
        .create({
          name: ch.name,
          type: ch.type,
          parent: parentId || undefined,
          topic: ch.topic,
          nsfw: ch.nsfw,
          bitrate: ch.bitrate || undefined,
          userLimit: ch.userLimit || undefined,
          position: ch.position,
        })
        .catch((err) => console.error(`[Backup] Erreur création salon ${ch.name}:`, err));

      if (newChannel) {
        currentChannels.set(newChannel.id, newChannel);
      }
    }
  }

  return true;
}

module.exports = { takeBackup, restoreBackup };