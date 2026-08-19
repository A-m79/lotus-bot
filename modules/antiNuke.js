const { AuditLogEvent, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
const config = require("../config/config");
const rateTracker = require("../utils/rateTracker");
const { getExecutor } = require("../utils/getExecutor");
const { getGuildConfig } = require("../utils/configCache");
const { punish } = require("./punisher");
const { handleLogChannelDeletion, handleRoleDeletion } = require("../utils/logProtector");
const SecurityLog = require("../models/SecurityLog");

// Temporary tracking of channels created per user, for full Rollback
const createdChannelsTracker = new Map();

function trackCreatedChannel(guildId, userId, channelId) {
  const key = `${guildId}:${userId}`;
  if (!createdChannelsTracker.has(key)) {
    createdChannelsTracker.set(key, []);
  }
  const userChannels = createdChannelsTracker.get(key);
  userChannels.push({ channelId, timestamp: Date.now() });

  const windowMs = config.ANTINUKE_WINDOW_MS || 10000;
  const filtered = userChannels.filter((item) => Date.now() - item.timestamp < windowMs);
  createdChannelsTracker.set(key, filtered);
}

function getAndClearCreatedChannels(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const userChannels = createdChannelsTracker.get(key) || [];
  createdChannelsTracker.delete(key);
  return userChannels.map((item) => item.channelId);
}

function getThreshold(guildConfig, actionType) {
  return (
    guildConfig?.thresholds?.[actionType] ??
    config.DEFAULT_THRESHOLDS?.[actionType] ?? 3
  );
}

function isOwner(guild, userId) {
  if (userId === guild.ownerId) return true;
  if (userId === guild.client.user.id) return true;
  if (process.env.OWNER_ID && userId === process.env.OWNER_ID) return true;
  return false;
}

function isWhitelisted(guild, guildConfig, userId) {
  if (guildConfig?.whitelist?.includes(userId)) return true;

  if (!guildConfig?.whitelistRoles?.length) return false;

  // Uses the gateway cache only (no extra API fetch) — the member is normally
  // already cached since the GuildMembers intent is enabled and the member
  // just performed the action that triggered this check.
  const member = guild.members.cache.get(userId);
  if (!member) return false;

  return member.roles.cache.some((r) => guildConfig.whitelistRoles.includes(r.id));
}

// Fix (protection scaled to server size): maps an actionType to a function
// reading the CURRENT total of that resource on the guild. Used to compute
// what % of it was just destroyed, since a fixed absolute count threshold
// is meaningless for a server that doesn't have that many resources to
// begin with (e.g. a 10-channel server can never hit a "12 deletions"
// threshold — it runs out of channels first).
const RESOURCE_TOTAL_GETTERS = {
  channelDelete: (guild) => guild.channels.cache.size,
  roleDelete: (guild) => guild.roles.cache.size,
  emojiDelete: (guild) => guild.emojis.cache.size,
  stickerDelete: (guild) => guild.stickers.cache.size,
  memberBan: (guild) => guild.memberCount,
  memberKick: (guild) => guild.memberCount,
};

async function getExecutorWithRetry(guild, auditLogEvent, targetId = undefined, maxDelay = 3000, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const executor = await getExecutor(guild, auditLogEvent, targetId, maxDelay);
    if (executor) return executor;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

async function checkAndPunish({ guild, executorId, actionType, reasonLabel, details }) {
  const guildConfig = await getGuildConfig(guild.id);

  if (!guildConfig.antiNukeEnabled) return false;

  if (isOwner(guild, executorId)) return false;

  const baseThreshold = getThreshold(guildConfig, actionType);
  const isWL = isWhitelisted(guild, guildConfig, executorId);

  // Whitelist gives extra margin (+3 tolerated actions) but no longer grants
  // total immunity: a compromised whitelisted account must remain punishable.
  const threshold = isWL ? baseThreshold + 3 : baseThreshold;

  const windowMs = config.ANTINUKE_WINDOW_MS || 10000;
  const count = rateTracker.hit(guild.id, executorId, actionType, windowMs);

  // Fix (paced/slow nuke detection): some actions (e.g. deleting a text
  // channel) require manually retyping the channel name to confirm, which
  // is naturally slower than a scripted/bot nuke. A deliberate actor can
  // stay under the short-window threshold indefinitely while still wiping
  // the whole server over a couple of minutes. This second, longer-window
  // check (read-only, doesn't double-count the same hit() timestamp) catches
  // that sustained pattern even when the short burst window never triggers.
  const sustainedWindowMs = config.ANTINUKE_SUSTAINED_WINDOW_MS || 120_000;
  const sustainedMultiplier = config.ANTINUKE_SUSTAINED_MULTIPLIER || 2.5;
  const sustainedThreshold = Math.ceil(threshold * sustainedMultiplier);
  const sustainedCount = rateTracker.count(guild.id, executorId, actionType, sustainedWindowMs);

  const burstTriggered = count >= threshold;
  const sustainedTriggered = sustainedCount >= sustainedThreshold;

  // Fix (protection scaled to server size): checks the destruction RATIO
  // regardless of raw counts or thresholds, so a small server (which could
  // never reach the absolute thresholds above without running out of
  // resources) is still protected.
  let percentTriggered = false;
  let percentDetail = "";

  const resourceGetter = RESOURCE_TOTAL_GETTERS[actionType];
  const percentThreshold = config.ANTINUKE_PERCENT_THRESHOLDS?.[actionType];
  const percentMinCount = config.ANTINUKE_PERCENT_MIN_COUNT ?? 3;

  if (resourceGetter && percentThreshold && sustainedCount >= percentMinCount) {
    const currentTotal = resourceGetter(guild);
    // The event fires AFTER the resource is already removed from the
    // guild's cache, so we reconstruct the pre-burst total by adding back
    // however many we've already counted as destroyed in the sustained
    // window (all by this same executor).
    const estimatedOriginalTotal = currentTotal + sustainedCount;

    if (estimatedOriginalTotal > 0) {
      const destroyedRatio = sustainedCount / estimatedOriginalTotal;
      if (destroyedRatio >= percentThreshold) {
        percentTriggered = true;
        percentDetail = `(${sustainedCount}/${estimatedOriginalTotal} = ${Math.round(destroyedRatio * 100)}% destroyed in ${sustainedWindowMs / 1000}s)`;
      }
    }
  }

  if (burstTriggered || sustainedTriggered || percentTriggered) {
    rateTracker.reset(guild.id, executorId, actionType);

    const reasonDetail = burstTriggered
      ? `(${count}/${threshold} in ${windowMs / 1000}s)`
      : percentTriggered
      ? percentDetail
      : `(${sustainedCount}/${sustainedThreshold} in ${sustainedWindowMs / 1000}s — paced/sustained pattern)`;

    await punish({
      guild,
      guildConfig,
      executorId,
      actionType,
      reason: `${reasonLabel} ${isWL ? "[WHITELIST SECURITY EXCEEDED]" : ""} ${reasonDetail}`,
      details,
    });
    return true;
  }

  return false;
}

function registerAntiNuke(client) {
  // --- Channel deletion ---
  client.on("channelDelete", async (channel) => {
    if (!channel.guild) return;
    const executor = await getExecutorWithRetry(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
    if (!executor) return;

    const handledByLogProtector = await handleLogChannelDeletion(channel.guild, channel, executor);
    if (handledByLogProtector) {
      rateTracker.hit(channel.guild.id, executor.id, "channelDelete", config.ANTINUKE_WINDOW_MS || 10000);
      return;
    }

    await checkAndPunish({
      guild: channel.guild,
      executorId: executor.id,
      actionType: "channelDelete",
      reasonLabel: "Mass channel deletion",
      details: { channelId: channel.id, channelName: channel.name },
    });
  });

  // --- Mass channel creation ---
  client.on("channelCreate", async (channel) => {
    if (!channel.guild) return;

    const executor = await getExecutorWithRetry(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
    if (!executor) return;

    trackCreatedChannel(channel.guild.id, executor.id, channel.id);

    const punished = await checkAndPunish({
      guild: channel.guild,
      executorId: executor.id,
      actionType: "channelCreate",
      reasonLabel: "Mass channel creation",
      details: { channelId: channel.id, channelName: channel.name },
    });

    if (punished) {
      const channelsToDelete = getAndClearCreatedChannels(channel.guild.id, executor.id);

      if (!channelsToDelete.includes(channel.id)) {
        channelsToDelete.push(channel.id);
      }

      for (const chId of channelsToDelete) {
        const targetCh = channel.guild.channels.cache.get(chId);
        if (targetCh) {
          await targetCh.delete("[Lotus Anti-Nuke] Cleanup following mass creation").catch(() => null);
        }
      }
    }
  });

  // --- Channel permission changes ---
  client.on("channelUpdate", async (oldChannel, newChannel) => {
    if (!newChannel.guild) return;

    const oldEveryone = oldChannel.permissionOverwrites.cache.get(newChannel.guild.id);
    const newEveryone = newChannel.permissionOverwrites.cache.get(newChannel.guild.id);

    const oldCanView = !oldEveryone?.deny.has(PermissionFlagsBits.ViewChannel);
    const newCanView = newEveryone ? !newEveryone.deny.has(PermissionFlagsBits.ViewChannel) : true;

    if (!oldCanView && newCanView) {
      const executor = await getExecutorWithRetry(newChannel.guild, AuditLogEvent.ChannelOverwriteUpdate, newChannel.id);
      if (!executor) return;

      await checkAndPunish({
        guild: newChannel.guild,
        executorId: executor.id,
        actionType: "channelUpdate",
        reasonLabel: `Made channel #${newChannel.name} visible to @everyone`,
        details: { channelId: newChannel.id, channelName: newChannel.name },
      });
    }
  });

  // --- Role deletion & creation ---
  client.on("roleDelete", async (role) => {
    if (!role.guild) return;
    const executor = await getExecutorWithRetry(role.guild, AuditLogEvent.RoleDelete, role.id);
    if (!executor) return;

    const handledByLogProtector = await handleRoleDeletion(role.guild, role, executor);
    if (handledByLogProtector) {
      rateTracker.hit(role.guild.id, executor.id, "roleDelete", config.ANTINUKE_WINDOW_MS || 10000);
      return;
    }

    await checkAndPunish({
      guild: role.guild,
      executorId: executor.id,
      actionType: "roleDelete",
      reasonLabel: "Mass role deletion",
      details: { roleId: role.id, roleName: role.name },
    });
  });

  client.on("roleCreate", async (role) => {
    if (!role.guild) return;
    const executor = await getExecutorWithRetry(role.guild, AuditLogEvent.RoleCreate, role.id);
    if (!executor) return;

    const punished = await checkAndPunish({
      guild: role.guild,
      executorId: executor.id,
      actionType: "roleCreate",
      reasonLabel: "Mass role creation",
      details: { roleId: role.id, roleName: role.name },
    });

    if (punished) {
      await role.delete("[Lotus Anti-Nuke] Rogue role cleanup").catch(() => null);
    }
  });

  // --- Mass bans & kicks ---
  client.on("guildBanAdd", async (ban) => {
    const executor = await getExecutorWithRetry(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    if (!executor) return;

    await checkAndPunish({
      guild: ban.guild,
      executorId: executor.id,
      actionType: "memberBan",
      reasonLabel: "Mass bans",
      details: { targetId: ban.user.id },
    });
  });

  client.on("guildMemberRemove", async (member) => {
    const executor = await getExecutorWithRetry(member.guild, AuditLogEvent.MemberKick, member.id, 3000);
    if (!executor) return;

    await checkAndPunish({
      guild: member.guild,
      executorId: executor.id,
      actionType: "memberKick",
      reasonLabel: "Mass kicks",
      details: { targetId: member.id },
    });
  });

  // --- Mass purge (Prune) ---
  // Distinct from individual kicks: Discord generates a SINGLE audit log entry
  // of type MemberPrune for a purge, with the number of members removed at
  // once (entry.extra.removed). The old pipeline based on guildMemberRemove +
  // AuditLogEvent.MemberKick NEVER detected this case (different audit type),
  // so a mass purge went completely unnoticed until now.
  client.on("guildAuditLogEntryCreate", async (entry, guild) => {
    if (entry.action !== AuditLogEvent.MemberPrune) return;
    if (!entry.executorId) return;

    const removedCount = entry.extra?.removed ?? 0;

    await checkAndPunish({
      guild,
      executorId: entry.executorId,
      actionType: "memberPrune",
      reasonLabel: `Mass purge of inactive members (${removedCount} removed at once)`,
      details: { removedCount, periodDays: entry.extra?.days ?? "?" },
    });
  });

  // --- Webhooks, unauthorized bots ---
  client.on("webhooksUpdate", async (channel) => {
    const executor = await getExecutorWithRetry(channel.guild, AuditLogEvent.WebhookCreate, undefined, 3000);
    if (!executor) return;

    await checkAndPunish({
      guild: channel.guild,
      executorId: executor.id,
      actionType: "webhookCreate",
      reasonLabel: "Mass webhook creation",
      details: { channelId: channel.id },
    });
  });

  client.on("guildMemberAdd", async (member) => {
    if (!member.user.bot) return;

    const executor = await getExecutorWithRetry(member.guild, AuditLogEvent.BotAdd, member.id, 5000);
    if (!executor) return;

    await checkAndPunish({
      guild: member.guild,
      executorId: executor.id,
      actionType: "botAdd",
      reasonLabel: "Unauthorized bot added",
      details: { botId: member.id, botTag: member.user.tag },
    });
  });

  // --- Emoji & Sticker deletion ---
  client.on("emojiDelete", async (emoji) => {
    const executor = await getExecutorWithRetry(emoji.guild, AuditLogEvent.EmojiDelete, emoji.id);
    if (!executor) return;

    await checkAndPunish({
      guild: emoji.guild,
      executorId: executor.id,
      actionType: "emojiDelete",
      reasonLabel: "Mass emoji deletion",
      details: { emojiName: emoji.name },
    });
  });

  client.on("stickerDelete", async (sticker) => {
    const executor = await getExecutorWithRetry(sticker.guild, AuditLogEvent.StickerDelete, sticker.id);
    if (!executor) return;

    await checkAndPunish({
      guild: sticker.guild,
      executorId: executor.id,
      actionType: "stickerDelete",
      reasonLabel: "Mass sticker deletion",
      details: { stickerName: sticker.name },
    });
  });

  // --- Server modification ---
  client.on("guildUpdate", async (oldGuild, newGuild) => {
    // 🚨 Ownership transfer: critical case handled separately, without the
    // usual threshold or sanction pipeline. We can't "punish" the new owner
    // (they now have total control, independent of roles), so we just send
    // an immediate maximum-priority alert to every available channel
    // (previous owner, bot owner, alert channel).
    if (oldGuild.ownerId !== newGuild.ownerId) {
      const botOwnerId = process.env.OWNER_ID;
      const previousOwner = await newGuild.client.users.fetch(oldGuild.ownerId).catch(() => null);
      const newOwner = await newGuild.client.users.fetch(newGuild.ownerId).catch(() => null);

      const embed = new EmbedBuilder()
        .setTitle("🚨🚨 SERVER OWNERSHIP TRANSFER DETECTED 🚨🚨")
        .setColor("#FF0000")
        .setDescription(
          `Ownership of **${newGuild.name}** has just changed hands.\n\n` +
            `• **Previous owner:** ${previousOwner ? `${previousOwner.tag} (\`${previousOwner.id}\`)` : `\`${oldGuild.ownerId}\``}\n` +
            `• **New owner:** ${newOwner ? `${newOwner.tag} (\`${newOwner.id}\`)` : `\`${newGuild.ownerId}\``}\n` +
            `• **Date & Time:** <t:${Math.floor(Date.now() / 1000)}:F>\n\n` +
            `⚠️ If this transfer was not intentional, the previous or new owner's account is likely compromised. ` +
            `The new owner now has total control over the server, including Lotus's configuration.`
        )
        .setTimestamp();

      if (previousOwner) await previousOwner.send({ embeds: [embed] }).catch(() => null);
      if (botOwnerId) {
        const botOwner = await newGuild.client.users.fetch(botOwnerId).catch(() => null);
        if (botOwner && botOwner.id !== previousOwner?.id) {
          await botOwner.send({ embeds: [embed] }).catch(() => null);
        }
      }

      const guildConfig = await getGuildConfig(newGuild.id).catch(() => null);
      const targetChannelId = guildConfig?.alertChannelId || guildConfig?.logChannelId;
      if (targetChannelId) {
        const channel = await newGuild.channels.fetch(targetChannelId).catch(() => null);
        if (channel?.isTextBased()) {
          await channel.send({ content: "🚨 @here **OWNERSHIP TRANSFER DETECTED!**", embeds: [embed] }).catch(() => null);
        }
      }

      await SecurityLog.create({
        guildId: newGuild.id,
        type: "OWNERSHIP_TRANSFER",
        executorId: newGuild.ownerId,
        reason: "Server ownership transfer detected",
        details: { previousOwnerId: oldGuild.ownerId, newOwnerId: newGuild.ownerId },
        punishmentApplied: "alert-only",
      }).catch(() => null);

      return;
    }

    // --- Name / Vanity URL (behavior unchanged) ---
    const executor = await getExecutorWithRetry(newGuild, AuditLogEvent.GuildUpdate, undefined, 3000);
    if (!executor) return;

    if (oldGuild.name !== newGuild.name || oldGuild.vanityURLCode !== newGuild.vanityURLCode) {
      await checkAndPunish({
        guild: newGuild,
        executorId: executor.id,
        actionType: "guildUpdate",
        reasonLabel: "Suspicious server settings change",
        details: { oldName: oldGuild.name, newName: newGuild.name },
      });
    }
  });

  // --- Self-Diagnostic: Loss of Admin Permissions ---
  client.on("guildMemberUpdate", async (oldMember, newMember) => {
    if (newMember.id !== client.user.id) return;

    const hadAdmin = oldMember.permissions.has(PermissionFlagsBits.Administrator);
    const hasAdmin = newMember.permissions.has(PermissionFlagsBits.Administrator);

    if (hadAdmin && !hasAdmin) {
      const executor = await getExecutorWithRetry(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.id, 3000);
      const guild = newMember.guild;

      const owner = await guild.fetchOwner().catch(() => null);
      const adminRoles = guild.roles.cache.filter(
        (r) => r.permissions.has(PermissionFlagsBits.Administrator) && !r.managed
      );
      const adminMentions = adminRoles.map((r) => `<@&${r.id}>`).join(" ") || "@here";

      const embed = new EmbedBuilder()
        .setTitle("🚨 URGENT: Lotus Lost Administrator Rights!")
        .setColor("#FF0000")
        .setDescription(
          `Lotus's Administrator permissions have been removed.\n\n` +
          `• **Author of the change:** ${executor ? `${executor.tag} (\`${executor.id}\`)` : "Unknown"}\n` +
          `• **Date & Time:** <t:${Math.floor(Date.now() / 1000)}:F>\n\n` +
          `⚠️ **Lotus can no longer properly protect the server until its access is restored.**`
        )
        .setTimestamp();

      if (owner) {
        await owner.send({ embeds: [embed] }).catch(() => null);
      }

      const guildConfig = await getGuildConfig(guild.id);
      const targetChannelId = guildConfig?.logChannelId || guildConfig?.alertChannelId;
      if (targetChannelId) {
        const channel = await guild.channels.fetch(targetChannelId).catch(() => null);
        if (channel?.isTextBased()) {
          await channel.send({ content: `🚨 ${adminMentions}`, embeds: [embed] }).catch(() => null);
        }
      }
    }
  });

  console.log("[AntiNuke Pro] Zero-Trust Module + Quarantine Protection + Prune + Ownership active.");
}

module.exports = { registerAntiNuke };
