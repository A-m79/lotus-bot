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

  // Capture des salons, y compris leurs permissions spécifiques (permissionOverwrites).
  // Pour les overwrites de type "rôle", on sauvegarde aussi le NOM du rôle (roleName) :
  // si un rôle est supprimé puis recréé par la restauration, il obtient un nouvel ID
  // Discord, donc on ne peut pas se fier uniquement à l'ID sauvegardé pour le retrouver.
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
      permissionOverwrites: c.permissionOverwrites
        ? c.permissionOverwrites.cache.map((ow) => ({
            id: ow.id,
            type: ow.type, // 0 = rôle, 1 = membre
            roleName: ow.type === 0 ? guild.roles.cache.get(ow.id)?.name ?? null : null,
            allow: ow.allow.bitfield.toString(),
            deny: ow.deny.bitfield.toString(),
          }))
        : [],
    }));

  await GuildBackup.findOneAndUpdate(
    { guildId: guild.id },
    { roles, channels, updatedAt: new Date() },
    { upsert: true, new: true }
  );

  const categories = channels.filter((c) => c.type === ChannelType.GuildCategory);
  const otherChannels = channels.filter((c) => c.type !== ChannelType.GuildCategory);

  return {
    roles,
    categories,
    otherChannels,
    updatedAt: new Date(),
  };
}

/**
 * Résout les overwrites sauvegardés en overwrites applicables sur le serveur actuel.
 * - Les overwrites de rôle sont résolus par NOM (l'ID d'origine peut avoir changé
 *   si le rôle a dû être recréé pendant la restauration).
 * - Les overwrites de membre sont conservés par ID, seulement si le membre est
 *   toujours présent sur le serveur (sinon Discord rejetterait l'overwrite).
 * Les entrées introuvables sont simplement ignorées (pas d'erreur bloquante).
 */
async function resolveOverwrites(guild, overwritesBackup) {
  if (!overwritesBackup || !overwritesBackup.length) return [];

  const resolved = [];
  for (const ow of overwritesBackup) {
    try {
      if (ow.type === 0) {
        const role = ow.roleName
          ? guild.roles.cache.find((r) => r.name === ow.roleName)
          : guild.roles.cache.get(ow.id);
        if (!role) continue;
        resolved.push({ id: role.id, type: 0, allow: BigInt(ow.allow), deny: BigInt(ow.deny) });
      } else {
        const member = await guild.members.fetch(ow.id).catch(() => null);
        if (!member) continue;
        resolved.push({ id: member.id, type: 1, allow: BigInt(ow.allow), deny: BigInt(ow.deny) });
      }
    } catch {
      // Overwrite ignoré si résolution impossible (rôle/membre supprimé, ID invalide...)
    }
  }
  return resolved;
}

async function restoreBackup(guild) {
  const backup = await GuildBackup.findOne({ guildId: guild.id });
  if (!backup) return null;

  const restoredRoles = [];
  const restoredChannels = [];
  let repairedPermissions = 0;

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

  // Restauration et positionnement des catégories (+ leurs permissions)
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

      // Réapplique les permissions de la catégorie (créée ou déjà existante) :
      // ça permet aussi de "réparer" une catégorie dont les permissions auraient
      // été modifiées sans que la catégorie elle-même soit supprimée.
      const overwrites = await resolveOverwrites(guild, cat.permissionOverwrites);
      if (overwrites.length) {
        const applied = await existingCat.permissionOverwrites
          .set(overwrites, "Lotus Backup Restore")
          .catch(() => null);
        if (applied) repairedPermissions++;
      }
    }
  }

  // Restauration des salons textuels / vocaux (+ leurs permissions)
  const currentChannels = await guild.channels.fetch();

  for (const ch of otherChannelsBackup) {
    const targetCount = otherChannelsBackup.filter(
      (c) => c.name === ch.name && c.type === ch.type && c.parentName === ch.parentName
    ).length;

    const matchingCurrent = currentChannels.filter(
      (c) => c.name === ch.name && c.type === ch.type && (c.parent ? c.parent.name : null) === ch.parentName
    );
    const currentCount = matchingCurrent.size;

    let targetChannel = null;

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
        targetChannel = newChannel;
      }
    } else {
      // Salon déjà présent en nombre suffisant : on prend le premier match pour
      // lui réappliquer ses permissions d'origine (répare un salon "ouvert" par erreur).
      targetChannel = matchingCurrent.first();
    }

    if (targetChannel) {
      const overwrites = await resolveOverwrites(guild, ch.permissionOverwrites);
      if (overwrites.length) {
        const applied = await targetChannel.permissionOverwrites
          .set(overwrites, "Lotus Backup Restore")
          .catch(() => null);
        if (applied) repairedPermissions++;
      }
    }
  }

  return {
    restoredRoles,
    restoredChannels,
    repairedPermissions,
    backupDate: backup.updatedAt,
  };
}

async function getBackupInfo(guildId) {
  return await GuildBackup.findOne({ guildId });
}

module.exports = { takeBackup, restoreBackup, getBackupInfo };
