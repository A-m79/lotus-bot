const { PermissionFlagsBits } = require("discord.js");
const config = require("../config/config");
const rateTracker = require("../utils/rateTracker");
const { getGuildConfig } = require("../utils/configCache");
const { punish } = require("./punisher");

// Cache mémoire pour la détection de répétition (Duplicate Spam)
const duplicateCache = new Map();

function isWhitelisted(guild, guildConfig, userId) {
  if (userId === guild.ownerId) return true;
  if (userId === guild.client.user.id) return true;
  if (process.env.OWNER_ID && userId === process.env.OWNER_ID) return true;
  return guildConfig?.whitelist?.includes(userId) ?? false;
}

/**
 * Analyse multicouche du contenu (Invites, Mentions, Retours à la ligne, CAPS)
 */
function analyzeMessage(message, isAdmin) {
  const content = message.content;
  if (!content) return null;

  // 1. Pubs / Liens d'invitation Discord
  const inviteRegex = /(discord\.(gg|io|me|li)|discord\.com\/(invite|app\/invite))/i;
  if (inviteRegex.test(content)) {
    return {
      type: "inviteSpam",
      reason: "Pub / Lien d'invitation Discord non autorisé sur ce serveur",
    };
  }

  // 2. Mentions massives (10 pour admin vs 5 pour membre)
  const totalMentions = message.mentions.users.size + message.mentions.roles.size;
  const mentionLimit = isAdmin ? 10 : 5;
  if (message.mentions.everyone || totalMentions >= mentionLimit) {
    return {
      type: "mentionSpam",
      reason: `Spam de mentions (${totalMentions} mentions)`,
    };
  }

  // 3. Retours à la ligne abusifs (25 pour admin vs 12 pour membre)
  const lineBreaks = (content.match(/\n/g) || []).length;
  const lineLimit = isAdmin ? 25 : 12;
  if (lineBreaks >= lineLimit) {
    return {
      type: "lineSpam",
      reason: `Abus de retours à la ligne (${lineBreaks} lignes)`,
    };
  }

  // 4. CAPS LOCK abusif (> 15 caractères)
  if (content.length > 15) {
    const capsCount = (content.match(/[A-ZÀ-Ý]/g) || []).length;
    const ratio = capsCount / content.length;
    if (ratio >= 0.8) {
      return {
        type: "capsSpam",
        reason: `Abus de majuscules (${Math.round(ratio * 100)}%)`,
      };
    }
  }

  return null;
}

/**
 * Détection des répétitions identiques (Supporte les caractères uniques "s", "f")
 */
function isDuplicateSpam(userId, content, isAdmin) {
  if (!content) return false;
  const cleanContent = content.trim().toLowerCase();

  const now = Date.now();
  const userDup = duplicateCache.get(userId);

  if (userDup && userDup.content === cleanContent && now - userDup.lastTime < 10000) {
    userDup.count += 1;
    userDup.lastTime = now;
    duplicateCache.set(userId, userDup);

    const dupLimit = isAdmin ? 5 : 3;
    if (userDup.count >= dupLimit) {
      duplicateCache.delete(userId);
      return true;
    }
  } else {
    duplicateCache.set(userId, { content: cleanContent, count: 1, lastTime: now });
  }

  return false;
}

function registerAntiSpam(client) {
  client.on("messageCreate", async (message) => {
    if (!message.guild || message.author.bot) return;

    const guildConfig = await getGuildConfig(message.guild.id);
    if (!guildConfig?.antiSpamEnabled) return;
    if (isWhitelisted(message.guild, guildConfig, message.author.id)) return;

    const isAdmin = message.member?.permissions.has(PermissionFlagsBits.Administrator);

    // Fenêtre élargie à 7s pour intercepter le spam manuel
    const baseThreshold =
      guildConfig?.thresholds?.antiSpam ??
      config.DEFAULT_THRESHOLDS?.antiSpam ??
      5;
    const threshold = isAdmin ? baseThreshold + 2 : baseThreshold;
    const windowMs = 7000;

    let triggered = false;
    let actionType = "antiSpam";
    let reason = "";

    // Vecteur A : Analyse du contenu (Invites, Mentions, Lines, Caps)
    const analysis = analyzeMessage(message, isAdmin);
    if (analysis) {
      triggered = true;
      actionType = analysis.type;
      reason = analysis.reason;
    }

    // Vecteur B : Spam de messages identiques ("s", "f", etc.)
    if (!triggered && isDuplicateSpam(message.author.id, message.content, isAdmin)) {
      triggered = true;
      actionType = "duplicateSpam";
      reason = "Spam de messages identiques en boucle";
    }

    // Vecteur C : Rate Limit / Flood rapide
    const count = rateTracker.hit(
      message.guild.id,
      message.author.id,
      "antiSpam",
      windowMs
    );
    if (!triggered && count >= threshold) {
      triggered = true;
      actionType = "antiSpam";
      reason = `Flood de messages (${count}/${threshold} en ${windowMs / 1000}s)`;
      rateTracker.reset(message.guild.id, message.author.id, "antiSpam");
    }

    // Application de la sanction
    if (triggered) {
      message.delete().catch(() => null);

      if (actionType === "antiSpam") {
        message.channel.bulkDelete(Math.min(count || 5, 100)).catch(() => null);
      }

      const customSanction = isAdmin ? "timeout" : null;

      await punish({
        guild: message.guild,
        guildConfig,
        executorId: message.author.id,
        actionType,
        reason: isAdmin ? `[Admin Intelligentsia] ${reason}` : reason,
        details: {
          Salon: `#${message.channel.name}`,
          Statut: isAdmin ? "Administrateur" : "Membre",
          "Dernier message": message.content.slice(0, 80) || "[Texte]",
        },
        customSanction,
      });
    }
  });

  // Nettoyage périodique du cache
  setInterval(() => {
    const now = Date.now();
    for (const [userId, data] of duplicateCache.entries()) {
      if (now - data.lastTime > 15000) duplicateCache.delete(userId);
    }
  }, 30000);

  console.log("[AntiSpam Pro] Module complet multi-vecteurs actif.");
}

module.exports = { registerAntiSpam };