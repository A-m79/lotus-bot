const { EmbedBuilder, GuildVerificationLevel, ChannelType } = require("discord.js");
const config = require("../config/config");
const { getGuildConfig } = require("../utils/configCache");
const SecurityLog = require("../models/SecurityLog");

// Timestamps des joins récents, par serveur (fenêtre glissante en mémoire)
const joinTimestamps = new Map(); // guildId -> number[]

/**
 * Score de suspicion d'un membre qui vient de join (0 à 3).
 * Plus le score est haut, plus le compte ressemble à un compte de raid.
 */
function suspicionScore(member) {
  let score = 0;

  const accountAge = Date.now() - member.user.createdTimestamp;
  if (accountAge < config.ANTIRAID.MIN_ACCOUNT_AGE_MS) score += 1;

  if (!member.user.avatar) score += 1; // avatar par défaut

  // Pattern de nom générique/random (ex: "user1234567", suite de chiffres en fin de nom)
  if (/\d{4,}$/.test(member.user.username)) score += 1;

  return score;
}

async function triggerLockdown(guild, guildConfig, joinCount) {
  if (guildConfig.lockdownActive) return; // déjà en lockdown, on évite de spam

  if (config.ANTIRAID.LOCKDOWN_ON_TRIGGER) {
    await guild.setVerificationLevel(GuildVerificationLevel.VeryHigh).catch(() => null);

    const textChannels = guild.channels.cache.filter((c) => c.type === ChannelType.GuildText);
    for (const channel of textChannels.values()) {
      await channel.permissionOverwrites
        .edit(guild.roles.everyone, { SendMessages: false })
        .catch(() => null);
    }
  }

  guildConfig.lockdownActive = true;
  await guildConfig.save();

  await SecurityLog.create({
    guildId: guild.id,
    type: "raidDetected",
    executorId: "system",
    details: { joinCount, windowMs: config.ANTIRAID.JOIN_WINDOW_MS },
    punishmentApplied: config.ANTIRAID.LOCKDOWN_ON_TRIGGER ? "lockdown" : "alert-only",
  });

  if (guildConfig.alertChannelId) {
    const channel = await guild.channels.fetch(guildConfig.alertChannelId).catch(() => null);
    if (channel?.isTextBased()) {
      const embed = new EmbedBuilder()
        .setColor(config.EMBED_COLOR_ALERT)
        .setTitle("🚨 Raid détecté")
        .setDescription(
          `${joinCount} arrivées suspectes en moins de ${config.ANTIRAID.JOIN_WINDOW_MS / 1000}s.\n` +
            (config.ANTIRAID.LOCKDOWN_ON_TRIGGER
              ? "Lockdown automatique activé. Utilise `/lotus-panic off` une fois la menace passée."
              : "Lockdown automatique désactivé — vérifie manuellement.")
        )
        .setTimestamp();

      await channel.send({ embeds: [embed] }).catch(() => null);
    }
  }
}

function registerAntiRaid(client) {
  client.on("guildMemberAdd", async (member) => {
    if (member.user.bot) return; // les bots sont gérés par l'anti-nuke (botAdd)

    const guildConfig = await getGuildConfig(member.guild.id);
    if (!guildConfig.antiRaidEnabled) return;

    const now = Date.now();
    const timestamps = (joinTimestamps.get(member.guild.id) || []).filter(
      (t) => now - t <= config.ANTIRAID.JOIN_WINDOW_MS
    );
    timestamps.push(now);
    joinTimestamps.set(member.guild.id, timestamps);

    // On ne déclenche que si le compte lui-même a un score de suspicion notable,
    // pour éviter de lockdown le serveur lors d'un pic de joins légitimes (ex: partenariat)
    const score = suspicionScore(member);

    if (timestamps.length >= config.ANTIRAID.JOIN_THRESHOLD && score >= 1) {
      await triggerLockdown(member.guild, guildConfig, timestamps.length);
    }
  });

  console.log("[AntiRaid] Module chargé et event listeners actifs.");
}

module.exports = { registerAntiRaid, suspicionScore };
