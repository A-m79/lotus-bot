const { PermissionFlagsBits } = require("discord.js");
const config = require("../config/config");
const rateTracker = require("../utils/rateTracker");
const { getGuildConfig } = require("../utils/configCache");
const { punish } = require("./punisher");

// Cache mémoire pour la détection de répétition (Duplicate Spam)
const duplicateCache = new Map();

/**
 * Détermine le niveau de privilège de l'utilisateur (Member, Admin, Whitelist)
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
 * Analyse du contenu ajustée selon le niveau de privilège
 */
function analyzeMessage(message, permLevel) {
  const content = message.content;
  if (!content) return null;

  // 1. Pubs / Liens d'invitation Discord (Bloqué pour les membres standards uniquement)
  if (permLevel === "member") {
    const inviteRegex = /(discord\.(gg|io|me|li)|discord\.com\/(invite|app\/invite))/i;
    if (inviteRegex.test(content)) {
      return {
        type: "inviteSpam",
        reason: "Pub / Lien d'invitation Discord non autorisé",
      };
    }
  }

  // 2. Mentions massives
  const totalMentions = message.mentions.users.size + message.mentions.roles.size;
  const mentionLimit = permLevel === "whitelist" ? 18 : permLevel === "admin" ? 10 : 5;
  if (message.mentions.everyone || totalMentions >= mentionLimit) {
    return {
      type: "mentionSpam",
      reason: `Spam de mentions (${totalMentions} mentions)`,
    };
  }

  // 3. Retours à la ligne abusifs
  const lineBreaks = (content.match(/\n/g) || []).length;
  const lineLimit = permLevel === "whitelist" ? 40 : permLevel === "admin" ? 25 : 12;
  if (lineBreaks >= lineLimit) {
    return {
      type: "lineSpam",
      reason: `Abus de retours à la ligne (${lineBreaks} lignes)`,
    };
  }

  // 4. CAPS LOCK (Uniquement pour les membres standards)
  if (permLevel === "member" && content.length > 15) {
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
 * Détection des répétitions identiques avec seuil dynamique
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
 * Purge rapide des derniers messages du spammeur dans le salon
 */
async function purgeAuthorMessages(channel, authorId) {
  try {
    const fetched = await channel.messages.fetch({ limit: 50 });
    const userMessages = fetched.filter((m) => m.author.id === authorId);
    if (userMessages.size > 0) {
      await channel.bulkDelete(userMessages).catch(() => null);
    }
  } catch {
    // Ignore si messages trop anciens ou manque de permissions
  }
}

function registerAntiSpam(client) {
  client.on("messageCreate", async (message) => {
    if (!message.guild || message.author.bot) return;

    const guildConfig = await getGuildConfig(message.guild.id);
    if (!guildConfig?.antiSpamEnabled) return;

    // Détermination du statut de l'utilisateur
    const permLevel = getPermissionLevel(message, guildConfig);

    // Seuils de flood (en messages / 7 secondes)
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

    // Vecteur A : Analyse du contenu
    const analysis = analyzeMessage(message, permLevel);
    if (analysis) {
      triggered = true;
      actionType = analysis.type;
      reason = analysis.reason;
    }

    // Vecteur B : Spam de messages identiques
    if (!triggered && isDuplicateSpam(message.author.id, message.content, permLevel)) {
      triggered = true;
      actionType = "duplicateSpam";
      reason = `Spam de messages identiques (${permLevel.toUpperCase()})`;
    }

    // Vecteur C : Rate Limit / Flood
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

    // Application du protocole de sanction
    if (triggered) {
      // 1. Suppression immédiate de tous les messages de la session de spam
      await purgeAuthorMessages(message.channel, message.author.id);

      // 2. Exécution de la sanction via Punisher (Timeout forcé pour TOUT LE MONDE en anti-spam)
      await punish({
        guild: message.guild,
        guildConfig,
        executorId: message.author.id,
        actionType,
        reason: `[AntiSpam ${permLevel.toUpperCase()}] ${reason}`,
        details: {
          Salon: `#${message.channel.name}`,
          Statut: permLevel.toUpperCase(),
          "Dernier message": message.content.slice(0, 80) || "[Texte]",
        },
        customSanction: "timeout", // Forçage du Timeout systématique pour l'Anti-Spam
      });
    }
  });

  // Nettoyage automatique de la mémoire du cache
  setInterval(() => {
    const now = Date.now();
    for (const [userId, data] of duplicateCache.entries()) {
      if (now - data.lastTime > 15000) duplicateCache.delete(userId);
    }
  }, 30000);

  console.log("[AntiSpam Pro] Shield multi-niveaux (Timeout systématique) armé.");
}

module.exports = { registerAntiSpam };