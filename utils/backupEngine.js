const GuildBackup = require("../models/GuildBackup");
const { ChannelType } = require("discord.js");

async function takeBackup(guild) {
  // Capture des rôles triés par position
  const roles = guild.roles.cache
    .filter((r) => !r.managed && r.id !== guild.id)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({
      name: r.name,
      color: r.color,
      hexColor: r.hexColor,
      hoist: r.hoist,
      permissions: r.permissions.bitfield.toString(),
      mentionable: r.mentionable,
      position: r.position,
    }));

  // Capture des salons triés par position
  const channels = guild.channels.cache
    .sort((a, b) => a.position - b.position)
    .map((c) => ({
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

  const categoryCount = channels.filter((c) => c.type === ChannelType.GuildCategory).length;
  const channelCount = channels.length - categoryCount;

  await GuildBackup.findOneAndUpdate(
    { guildId: guild.id },
    { roles, channels, updatedAt: new Date() },
    { upsert: true, new: true }
  );

  return {
    roleCount: roles.length,
    categoryCount,
    channelCount,
    updatedAt: new Date(),
  };
}

async function restoreBackup(guild) {
  const backup = await GuildBackup.findOne({ guildId: guild.id });
  if (!backup) return null;

  const restoredRoles = [];
  const restoredChannels = [];

  // 1. Restauration des rôles manquants
  for (const r of backup.roles) {
    let existingRole = guild.roles.cache.find((role) => role.name === r.name);
    if (!existingRole) {
      existingRole = await guild.roles
        .create({
          name: r.name,
          color: r.color,
          hoist: r.hoist,
          permissions: BigInt(r.permissions),
          mentionable: r.mentionable,
          position: r.position,
        })
        .catch(() => null);

      if (existingRole) restoredRoles.push(r.name);
    }
  }

  // Repositionnement hiérarchique des rôles
  for (const r of backup.roles) {
    const role = guild.roles.cache.find((existing) => existing.name === r.name);
    if (role && role.position !== r.position) {
      await role.setPosition(r.position).catch(() => null);
    }
  }

  // 2. Séparation Catégories et Salons
  const categoriesBackup = backup.channels.filter((c) => c.type === ChannelType.GuildCategory);
  const otherChannelsBackup = backup.channels.filter((c) => c.type !== ChannelType.GuildCategory);

  const createdCategories = new Map();

  // Restauration et positionnement des catégories
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
        .catch(() => null);

      if (existingCat) restoredChannels.push(`📁 ${cat.name} (Catégorie)`);
    }

    if (existingCat) {
      createdCategories.set(cat.name, existingCat.id);
      if (existingCat.position !== cat.position) {
        await existingCat.setPosition(cat.position).catch(() => null);
      }
    }
  }

  // Restauration des salons textuels / vocaux
  const currentChannels = await guild.channels.fetch();

  for (const ch of otherChannelsBackup) {
    const targetCount = otherChannelsBackup.filter(
      (c) => c.name === ch.name && c.type === ch.type && c.parentName === ch.parentName
    ).length;

    const currentCount = currentChannels.filter(
      (c) => c.name === ch.name && c.type === ch.type && (c.parent ? c.parent.name : null) === ch.parentName
    ).size;

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
        .catch(() => null);

      if (newChannel) {
        currentChannels.set(newChannel.id, newChannel);
        restoredChannels.push(`${ch.type === ChannelType.GuildVoice ? "🔊" : "#"} ${ch.name}`);
        if (ch.position !== undefined) {
          await newChannel.setPosition(ch.position).catch(() => null);
        }
      }
    }
  }

  return {
    restoredRoles,
    restoredChannels,
    backupDate: backup.updatedAt,
  };
}

async function getBackupInfo(guildId) {
  return await GuildBackup.findOne({ guildId });
}

module.exports = { takeBackup, restoreBackup, getBackupInfo };