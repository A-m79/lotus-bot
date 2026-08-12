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
 * Analyse multicouche du contenu du message (seuils adaptés si Admin)
 */
function analyzeMessage(message, isAdmin) {
  const content = message.content;
  if (!content) return null;

  // 1. Détection des pub / liens d'invitation Discord (Invite Spam)
  const inviteRegex = /(discord\.(gg|io|me|li)|discord\.com\/(invite|app\/invite))/i;
  if (inviteRegex.test(content)) {
    return { type: "inviteSpam", reason: "Pub / Lien d'invitation Discord non autorisé sur ce serveur" };
  }

  // 2. Détection de mentions massives (Mention Spam) — Plus tolérant pour les admins
  const totalMentions = message.mentions.users.size + message.mentions.roles.size;
  const mentionLimit = isAdmin ? 10 : 5;
  if (message.mentions.everyone || totalMentions >= mentionLimit) {
    return {
      type: "mentionSpam",
      reason: `Spam de mentions (${totalMentions} mentions)`,
    };
  }

  // 3. Détection des retours à la ligne abusifs (Line-Break Spam) — 25 lignes pour un admin vs 12 pour un membre
  const lineBreaks = (content.match(/\n/g) || []).length;
  const lineLimit = isAdmin ? 25 : 12;
  if (lineBreaks >= lineLimit) {
    return { type: "lineSpam", reason: `Abus de retours à la ligne (${lineBreaks} lignes)` };
  }

  // 4. Détection du CAPS LOCK abusif (sur messages de plus de 15 caractères)
  if (content.length > 15) {
    const capsCount = (content.match(/[A-ZÀ-Ý]/g) || []).length;
    const ratio = capsCount / content.length;
    if (ratio >= 0.8) {
      return { type: "capsSpam", reason: `Abus de majuscules (${Math.round(ratio * 100)}%)` };
    }
  }

  return null;
}

/**
 * Détection des messages identiques répétés d'affilée
 */
function isDuplicateSpam(userId, content, isAdmin) {
  if (!content || content.length < 3) return false;

  const now = Date.now();
  const userDup = duplicateCache.get(userId);

  if (userDup && userDup.content === content && now - userDup.lastTime < 10000) {
    userDup.count += 1;
    userDup.lastTime = now;
    duplicateCache.set(userId, userDup);

    const dupLimit = isAdmin ? 5 : 3;
    if (userDup.count >= dupLimit) {
      duplicateCache.delete(userId);
      return true;
    }
  } else {
    duplicateCache.set(userId, { content, count: 1, lastTime: now });
  }

  return false;
}

function registerAntiSpam(client) {
  client.on("messageCreate", async (message) => {
    if (!message.guild || message.author.bot) return;

    const guildConfig = await getGuildConfig(message.guild.id);
    if (!guildConfig?.antiSpamEnabled) return;
    if (isWhitelisted(message.guild, guildConfig, message.author.id)) return;

    // Vérification des privilèges Administrateur
    const isAdmin = message.member?.permissions.has(PermissionFlagsBits.Administrator);

    // Seuil de flood dynamique (x2.5 pour les admins)
    const baseThreshold =
      guildConfig?.thresholds?.antiSpam ??
      config.DEFAULT_THRESHOLDS?.antiSpam ??
      5;
    const threshold = isAdmin ? Math.round(baseThreshold * 2.5) : baseThreshold;
    const windowMs = config.ANTISPAM_WINDOW_MS || 3000;

    let triggered = false;
    let actionType = "antiSpam";
    let reason = "";

    // A. Contrôle du contenu (Invites, Mentions, Caps, Lines)
    const analysis = analyzeMessage(message, isAdmin);
    if (analysis) {
      triggered = true;
      actionType = analysis.type;
      reason = analysis.reason;
    }

    // B. Contrôle de répétition exacte (Copier-coller en boucle)
    if (!triggered && isDuplicateSpam(message.author.id, message.content, isAdmin)) {
      triggered = true;
      actionType = "duplicateSpam";
      reason = "Répétition du même message plusieurs fois d'affilée";
    }

    // C. Contrôle de fréquence / Flood rapide (Rate Limit)
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

    // Execution de la sanction si un vecteur est déclenché
    if (triggered) {
      // Suppression du message fautif
      message.delete().catch(() => null);

      // Si c'est du flood, purge automatique des messages récents
      if (actionType === "antiSpam") {
        message.channel.bulkDelete(Math.min(count, 100)).catch(() => null);
      }

      // Sanction adoucie pour les Admins (Mute / Timeout) sauf en cas de flood extrême (>= 25 msgs)
      let customSanction = null;
      if (isAdmin) {
        customSanction = count >= 25 ? null : "timeout";
      }

      await punish({
        guild: message.guild,
        guildConfig,
        executorId: message.author.id,
        actionType,
        reason: isAdmin ? `[Admin Intelligentsia] ${reason}` : reason,
        details: {
          Salon: `#${message.channel.name}`,
          Statut: isAdmin ? "Administrateur" : "Membre",
          "Dernier message": message.content.slice(0, 80) || "[Fichier/Embed]",
        },
        customSanction,
      });
    }
  });

  // Nettoyage périodique de la mémoire pour préserver la RAM
  setInterval(() => {
    const now = Date.now();
    for (const [userId, data] of duplicateCache.entries()) {
      if (now - data.lastTime > 15000) {
        duplicateCache.delete(userId);
      }
    }
  }, 30000);

  console.log("[AntiSpam Pro] Module multi-vecteurs avec gestion Admin intelligent actif.");
}

module.exports = { registerAntiSpam };