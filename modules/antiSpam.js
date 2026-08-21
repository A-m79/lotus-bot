const { PermissionFlagsBits } = require("discord.js");
const config = require("../config/config");
const rateTracker = require("../utils/rateTracker");
const { getGuildConfig } = require("../utils/configCache");
const { punish } = require("./punisher");

// In-memory caches
const duplicateCache = new Map();
const massMentionCache = new Map(); // Tracks @everyone, @here, Roles (15s)
const userPingCache = new Map();    // Tracks user pings (60s)

/**
 * Determines the user's privilege level (Member, Admin, Whitelist)
 */
function getPermissionLevel(message, guildConfig) {
  const userId = message.author.id;
  const guild = message.guild;

  const isWL =
    userId === guild.ownerId ||
    userId === guild.client.user.id ||
    (process.env.OWNER_ID && userId === process.env.OWNER_ID) ||
    (guildConfig?.whitelist?.includes(userId) ?? false);

  if (isWL) return "whitelist";
  if (message.member?.permissions.has(PermissionFlagsBits.Administrator)) return "admin";
  return "member";
}

/**
 * Analyzes text content (Ads, Lines, Caps)
 */
function analyzeMessage(message, permLevel) {
  const content = message.content;
  if (!content) return null;

  // 1. Ads / Discord invite links (Members only)
  if (permLevel === "member") {
    const inviteRegex = /(discord\.(gg|io|me|li)|discord\.com\/(invite|app\/invite))/i;
    if (inviteRegex.test(content)) {
      return {
        type: "inviteSpam",
        reason: "Ad / Unauthorized Discord invite link",
      };
    }
  }

  // 2. Excessive line breaks
  const lineBreaks = (content.match(/\n/g) || []).length;
  const lineLimit = permLevel === "whitelist" ? 40 : permLevel === "admin" ? 25 : 12;
  if (lineBreaks >= lineLimit) {
    return {
      type: "lineSpam",
      reason: `Excessive line breaks (${lineBreaks} lines)`,
    };
  }

  // 3. CAPS LOCK (Members only)
  if (permLevel === "member" && content.length > 15) {
    const capsCount = (content.match(/[A-ZÀ-Ý]/g) || []).length;
    const ratio = capsCount / content.length;
    if (ratio >= 0.8) {
      return {
        type: "capsSpam",
        reason: `Excessive caps lock (${Math.round(ratio * 100)}%)`,
      };
    }
  }

  return null;
}

/**
 * Advanced, time-windowed mention checking (Mass vs Individual)
 */
function checkMentionLimits(message, permLevel, guildConfig) {
  // Kill switch: sécurité anti-mentions désactivée pour ce serveur.
  if (guildConfig?.pingSecurityEnabled === false) return null;

  const userId = message.author.id;
  const now = Date.now();
  const protectedIds = guildConfig?.protectedMentionIds ?? [];

  // A. Mass Mentions (@everyone, @here + rôles/personnes explicitement
  // protégés). Un rôle "normal" mentionné (ex: @soutiens) n'est PLUS compté
  // ici par défaut — seuls @everyone/@here et les IDs ajoutés dans
  // protectedMentionIds ont cette sévérité.
  const hasEveryoneOrHere = message.mentions.everyone;
  const protectedRoleMentions = message.mentions.roles.filter((r) =>
    protectedIds.includes(r.id)
  ).size;
  const protectedUserMentions = message.mentions.users.filter((u) =>
    protectedIds.includes(u.id)
  ).size;
  const massMentionsInMsg =
    (hasEveryoneOrHere ? 1 : 0) + protectedRoleMentions + protectedUserMentions;

  if (massMentionsInMsg > 0) {
    if (permLevel === "member") {
      return {
        type: "massMentionSpam",
        reason: "Unauthorized mass mention (@everyone/@here/protected role or user)",
      };
    }

    // Admin & Whitelist: Tolerance of 3 mass mentions per 15 seconds
    const stats = massMentionCache.get(userId) || { count: 0, first: now };
    if (now - stats.first > 15000) {
      stats.count = 0;
      stats.first = now;
    }

    stats.count += massMentionsInMsg;
    massMentionCache.set(userId, stats);

    if (stats.count > 3) {
      massMentionCache.delete(userId);
      return {
        type: "massMentionSpam",
        reason: `Excessive mass mentions (${stats.count}/3 in 15s)`,
      };
    }
  }

  // B. User Mentions (@User)
  const userMentions = message.mentions.users.filter(
    (u) => !u.bot && u.id !== userId
  );
  const userMentionsCount = userMentions.size;

  if (userMentionsCount > 0) {
    const limit = permLevel === "member" ? 2 : 6; // 2/min for Members, 6/min for Staff/WL
    const stats = userPingCache.get(userId) || { count: 0, first: now };

    if (now - stats.first > 60000) {
      stats.count = 0;
      stats.first = now;
    }

    stats.count += userMentionsCount;
    userPingCache.set(userId, stats);

    if (stats.count > limit) {
      userPingCache.delete(userId);
      return {
        type: "userPingSpam",
        reason: `User mention spam (${stats.count}/${limit} per minute)`,
      };
    }
  }

  return null;
}

/**
 * Detects identical repeated messages with a dynamic threshold
 */
function isDuplicateSpam(userId, content, permLevel) {
  if (!content) return false;
  const cleanContent = content.trim().toLowerCase();

  const now = Date.now();
  const userDup = duplicateCache.get(userId);

  if (userDup && userDup.content === cleanContent && now - userDup.lastTime < 10000) {
    userDup.count += 1;
    userDup.lastTime = now;
    duplicateCache.set(userId, userDup);

    const dupLimit = permLevel === "whitelist" ? 8 : permLevel === "admin" ? 5 : 3;
    if (userDup.count >= dupLimit) {
      duplicateCache.delete(userId);
      return true;
    }
  } else {
    duplicateCache.set(userId, { content: cleanContent, count: 1, lastTime: now });
  }

  return false;
}

/**
 * Quickly purges the spammer's recent messages in the channel
 */
async function purgeAuthorMessages(channel, authorId) {
  try {
    const fetched = await channel.messages.fetch({ limit: 50 });
    const userMessages = fetched.filter((m) => m.author.id === authorId);
    if (userMessages.size > 0) {
      await channel.bulkDelete(userMessages).catch(() => null);
    }
  } catch {}
}

function registerAntiSpam(client) {
  client.on("messageCreate", async (message) => {
    if (!message.guild || message.author.bot) return;

    const guildConfig = await getGuildConfig(message.guild.id);
    if (!guildConfig?.antiSpamEnabled) return;

    const permLevel = getPermissionLevel(message, guildConfig);

    const thresholdMap = {
      member: 5,
      admin: 12,
      whitelist: 22,
    };
    const threshold = thresholdMap[permLevel];
    const windowMs = 7000;

    let triggered = false;
    let actionType = "antiSpam";
    let reason = "";

    // Vector A: Content analysis (Ads, Lines, Caps)
    const analysis = analyzeMessage(message, permLevel);
    if (analysis) {
      triggered = true;
      actionType = analysis.type;
      reason = analysis.reason;
    }

    // Vector B: Smart mention control (Mass & Individual)
    if (!triggered) {
      const mentionAnalysis = checkMentionLimits(message, permLevel, guildConfig);
      if (mentionAnalysis) {
        triggered = true;
        actionType = mentionAnalysis.type;
        reason = mentionAnalysis.reason;
      }
    }

    // Vector C: Identical message spam
    if (!triggered && isDuplicateSpam(message.author.id, message.content, permLevel)) {
      triggered = true;
      actionType = "duplicateSpam";
      reason = `Identical message spam (${permLevel.toUpperCase()})`;
    }

    // Vector D: Rate Limit / Flood
    const count = rateTracker.hit(
      message.guild.id,
      message.author.id,
      "antiSpam",
      windowMs
    );
    if (!triggered && count >= threshold) {
      triggered = true;
      actionType = "antiSpam";
      reason = `Message flood (${count}/${threshold} in ${windowMs / 1000}s)`;
      rateTracker.reset(message.guild.id, message.author.id, "antiSpam");
    }

    // Applying the sanction protocol
    if (triggered) {
      await purgeAuthorMessages(message.channel, message.author.id);

      await punish({
        guild: message.guild,
        guildConfig,
        executorId: message.author.id,
        actionType,
        reason: `[AntiSpam ${permLevel.toUpperCase()}] ${reason}`,
        details: {
          Channel: `#${message.channel.name}`,
          Status: permLevel.toUpperCase(),
          "Last message": message.content.slice(0, 80) || "[Text]",
        },
        customSanction: "timeout",
      });
    }
  });

  // Periodic memory cleanup
  setInterval(() => {
    const now = Date.now();
    for (const [userId, data] of duplicateCache.entries()) {
      if (now - data.lastTime > 15000) duplicateCache.delete(userId);
    }
    for (const [userId, data] of massMentionCache.entries()) {
      if (now - data.first > 15000) massMentionCache.delete(userId);
    }
    for (const [userId, data] of userPingCache.entries()) {
      if (now - data.first > 60000) userPingCache.delete(userId);
    }
  }, 30000);

  console.log("[AntiSpam Pro] Multi-tier shield (Dynamic mentions) armed.");
}

module.exports = { registerAntiSpam };