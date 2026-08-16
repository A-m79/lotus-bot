const { punish } = require("./punisher");
const { getGuildConfig } = require("../utils/configCache");
const { getInviteInfo } = require("./inviteTracker");
const { EmbedBuilder } = require("discord.js");

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

    if (guildConfig?.altDetectionEnabled === false) return;
    if (isWhitelisted(guild, guildConfig, user.id)) return;

    const now = Date.now();
    const accountAgeMs = now - user.createdTimestamp;
    const accountAgeDays = Math.floor(accountAgeMs / (1000 * 60 * 60 * 24));
    const accountAgeHours = Math.floor(accountAgeMs / (1000 * 60 * 60));

    const flags = [];
    let isUltraRecent = accountAgeDays < 14; // Direct quarantine if < 14 days

    if (accountAgeDays < 30) {
      flags.push(`Recent account (${accountAgeDays}d)`);
    }
    if (!user.avatar) {
      flags.push("Default avatar");
    }
    const fullName = `${user.username} ${user.displayName || ""}`;
    if (SUSPICIOUS_PATTERNS.some((p) => p.test(fullName))) {
      flags.push("Suspicious username");
    }

    // 1. SEVERE CASE: Account < 14 days old -> Direct quarantine
    if (isUltraRecent) {
      // Short delay to give inviteTracker.js time to resolve the invite used
      // (it listens to the same guildMemberAdd event; execution order between
      // modules isn't guaranteed without this brief delay).
      await new Promise((r) => setTimeout(r, 500));
      const inviteInfo = getInviteInfo(guild.id, user.id);

      return punish({
        guild,
        guildConfig,
        executorId: user.id,
        actionType: "ALT_DETECTION",
        reason: `Extremely recent account (${accountAgeDays}d / <14d)`,
        details: {
          "Created": `${accountAgeDays}d (${accountAgeHours}h)`,
          "Avatar": user.avatar ? "Custom" : "Default",
          "Flags": flags.join(" | "),
          ...(inviteInfo ? { "Joined via": `${inviteInfo.type === "vanity" ? "Vanity URL" : "Invite"} \`${inviteInfo.code}\`` } : {}),
        },
        customSanction: "quarantine",
      });
    }

    // 2. SUSPICIOUS CASE: Account between 14 and 30 days old, default avatar, etc. -> Staff warning
    if (flags.length > 0) {
      const targetChannelId = guildConfig?.alertChannelId || guildConfig?.logChannelId;
      if (!targetChannelId) return;

      const channel = await guild.channels.fetch(targetChannelId).catch(() => null);
      if (!channel?.isTextBased()) return;

      await new Promise((r) => setTimeout(r, 500));
      const inviteInfo = getInviteInfo(guild.id, user.id);

      const embed = new EmbedBuilder()
        .setColor("#FFCC00")
        .setAuthor({
          name: `SUSPICION WARNING • ${guild.name.toUpperCase()}`,
          iconURL: guild.iconURL({ dynamic: true }) || undefined,
        })
        .setTitle(`👀 Suspicious New Member — ${user.tag}`)
        .setDescription(`A member has joined but shows suspicious criteria. No automatic sanction has been applied.`)
        .addFields(
          { name: "👤 User", value: `${user}\n\`ID: ${user.id}\``, inline: true },
          { name: "📅 Account age", value: `\`${accountAgeDays} day(s)\``, inline: true },
          { name: "🔍 Flags", value: `\`${flags.join(" | ")}\``, inline: false }
        )
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
        .setFooter({ text: "Lotus Security • Suspicion Module" })
        .setTimestamp();

      if (inviteInfo) {
        embed.addFields({
          name: "🔗 Joined via",
          value: `${inviteInfo.type === "vanity" ? "Vanity URL" : "Invite"} \`${inviteInfo.code}\``,
          inline: true,
        });
      }

      await channel.send({ embeds: [embed] }).catch(() => null);
    }
  });

  console.log("[Alt Detection Pro] Detection and warning module active (+ invite tracking).");
}

module.exports = { registerAltDetection };