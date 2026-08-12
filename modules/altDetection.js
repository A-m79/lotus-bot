const { punish } = require("./punisher");
const { getGuildConfig } = require("../utils/configCache");

// Patterns de pseudos suspects (Spam, Crypto, Liens)
const SUSPICIOUS_PATTERNS = [
  /telegram/i,
  /t\.me\//i,
  /crypto/i,
  /airdrop/i,
  /whatsapp/i,
  /claim.*nft/i,
  /discord\.gg/i,
  /https?:\/\//i,
];

function isWhitelisted(guild, guildConfig, userId) {
  if (userId === guild.ownerId) return true;
  if (process.env.OWNER_ID && userId === process.env.OWNER_ID) return true;
  return guildConfig?.whitelist?.includes(userId) ?? false;
}

function registerAltDetection(client) {
  client.on("guildMemberAdd", async (member) => {
    if (!member.guild || member.user.bot) return;

    const { guild, user } = member;
    const guildConfig = await getGuildConfig(guild.id).catch(() => null);

    // Module activable/désactivable via config (activé par défaut si non spécifié)
    if (guildConfig?.altDetectionEnabled === false) return;
    if (isWhitelisted(guild, guildConfig, user.id)) return;

    const now = Date.now();
    const accountAgeMs = now - user.createdTimestamp;
    const accountAgeDays = Math.floor(accountAgeMs / (1000 * 60 * 60 * 24));
    const accountAgeHours = Math.floor(accountAgeMs / (1000 * 60 * 60));

    // Seuil de jours minimum configurable (7 jours par défaut)
    const minAgeDays = guildConfig?.thresholds?.altMinAgeDays ?? 7;

    let riskScore = 0;
    const flags = [];

    // 1. Âge du compte
    if (accountAgeDays < minAgeDays) {
      riskScore += 50;
      flags.push(`Compte trop récent (${accountAgeHours < 24 ? `${accountAgeHours}h` : `${accountAgeDays}j`})`);
    }

    // 2. Pas d'avatar personnalisé
    if (!user.avatar) {
      riskScore += 25;
      flags.push("Avatar par défaut");
    }

    // 3. Pseudo ou Nom d'affichage suspect
    const fullName = `${user.username} ${user.displayName || ""}`;
    if (SUSPICIOUS_PATTERNS.some((p) => p.test(fullName))) {
      riskScore += 40;
      flags.push("Pseudo suspect (Lien / Pub / Crypto)");
    }

    // Sanction si le score de risque est supérieur ou égal à 50
    if (riskScore >= 50) {
      const reason = `Compte suspect / Alt détecté (${flags.join(", ")})`;

      await punish({
        guild,
        guildConfig,
        executorId: user.id,
        actionType: "ALT_DETECTION",
        reason,
        details: {
          "Création": `${accountAgeDays}j (${accountAgeHours}h)`,
          "Avatar": user.avatar ? "Personnalisé" : "Par défaut",
          "Score de risque": `${riskScore}/100`,
          "Indicateurs": flags.join(" | "),
        },
        customSanction: guildConfig?.altPunishment || null,
      });
    }
  });

  console.log("[Alt Detection Pro] Module d'analyse à l'arrivée actif.");
}

module.exports = { registerAltDetection };