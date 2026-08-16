const { EmbedBuilder, GuildVerificationLevel, ChannelType } = require("discord.js");
const config = require("../config/config");
const { getGuildConfig } = require("../utils/configCache");
const SecurityLog = require("../models/SecurityLog");

// Recent join timestamps, per server (in-memory sliding window)
const joinTimestamps = new Map(); // guildId -> number[]

/**
 * Suspicion score for a member who just joined (0 to 3).
 * The higher the score, the more the account looks like a raid account.
 */
function suspicionScore(member) {
  let score = 0;

  const accountAge = Date.now() - member.user.createdTimestamp;
  if (accountAge < config.ANTIRAID.MIN_ACCOUNT_AGE_MS) score += 1;

  if (!member.user.avatar) score += 1; // default avatar

  // Generic/random username pattern (e.g. "user1234567", digits at the end of the name)
  if (/\d{4,}$/.test(member.user.username)) score += 1;

  return score;
}

async function triggerLockdown(guild, guildConfig, joinCount) {
  if (guildConfig.lockdownActive) return; // already in lockdown, avoid spamming

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
  await guildConfig.save().catch(() => null);

  await SecurityLog.create({
    guildId: guild.id,
    type: "raidDetected",
    executorId: "system",
    details: { joinCount, windowMs: config.ANTIRAID.JOIN_WINDOW_MS },
    punishmentApplied: config.ANTIRAID.LOCKDOWN_ON_TRIGGER ? "lockdown" : "alert-only",
  }).catch(() => null);

  const targetChannelId = guildConfig.alertChannelId || guildConfig.logChannelId;
  if (targetChannelId) {
    const channel = await guild.channels.fetch(targetChannelId).catch(() => null);
    if (channel?.isTextBased()) {
      const embed = new EmbedBuilder()
        .setColor(config.EMBED_COLOR_ALERT || "#FF0000")
        .setAuthor({
          name: "LOTUS SECURITY SYSTEM",
          iconURL: guild.iconURL({ dynamic: true }) || undefined,
        })
        .setTitle("🚨 RAID DETECTED — SERVER UNDER PROTECTION")
        .setDescription(
          `> **Detection:** \`${joinCount} suspicious joins\` in under \`${config.ANTIRAID.JOIN_WINDOW_MS / 1000}s\`.\n` +
            (config.ANTIRAID.LOCKDOWN_ON_TRIGGER
              ? "> **Status:** Automatic lockdown enabled. Message sending disabled for members. Use `/lotus-panic off` once the threat has passed."
              : "> **Status:** Automatic lockdown disabled — manual review required.")
        )
        .setFooter({ text: "Lotus Security System • Anti-Raid Module" })
        .setTimestamp();

      await channel.send({
        content: "🚨 @here **MAJOR ALERT: ACTIVE RAID DETECTED!**",
        embeds: [embed],
      }).catch(() => null);
    }
  }
}

function registerAntiRaid(client) {
  client.on("guildMemberAdd", async (member) => {
    if (member.user.bot) return; // bots are handled by anti-nuke (botAdd)

    const guildConfig = await getGuildConfig(member.guild.id);
    if (!guildConfig?.antiRaidEnabled) return;

    const now = Date.now();
    const timestamps = (joinTimestamps.get(member.guild.id) || []).filter(
      (t) => now - t <= config.ANTIRAID.JOIN_WINDOW_MS
    );
    timestamps.push(now);
    joinTimestamps.set(member.guild.id, timestamps);

    // Only trigger if the account itself has a notable suspicion score
    const score = suspicionScore(member);

    if (timestamps.length >= config.ANTIRAID.JOIN_THRESHOLD && score >= 1) {
      await triggerLockdown(member.guild, guildConfig, timestamps.length);
    }
  });

  console.log("[AntiRaid] Module loaded and event listeners active.");
}

module.exports = { registerAntiRaid, suspicionScore };