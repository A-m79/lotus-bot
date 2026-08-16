module.exports = {
  // Time window (ms) during which a user's actions are counted for anti-nuke
  ANTINUKE_WINDOW_MS: 10_000,

  // Default thresholds before a sanction triggers (overridable per server via /lotus-thresholds)
  DEFAULT_THRESHOLDS: {
    channelDelete: 6,
    channelCreate: 5,
    channelUpdate: 2,       // making a private channel visible to @everyone
    roleDelete: 3,
    roleCreate: 3,
    memberBan: 5,
    memberKick: 5,
    memberPrune: 2,          // mass pruning of inactive members
    webhookCreate: 3,
    botAdd: 1,
    dangerousRoleUpdate: 2,
    emojiDelete: 5,
    stickerDelete: 5,
    guildUpdate: 1,          // name/vanity URL change: suspicious on the 1st offense if not the owner
    antiSpam: 4,
  },

  DEFAULT_PUNISHMENT: "stripRoles",

  DANGEROUS_PERMISSIONS: [
    "Administrator",
    "BanMembers",
    "KickMembers",
    "ManageGuild",
    "ManageRoles",
    "ManageChannels",
    "ManageWebhooks",
    "MentionEveryone",
  ],

  ANTIRAID: {
    JOIN_WINDOW_MS: 15_000,
    JOIN_THRESHOLD: 8,
    MIN_ACCOUNT_AGE_MS: 1000 * 60 * 60 * 24 * 3,
    LOCKDOWN_ON_TRIGGER: true,
  },

  // Periodic bot self-diagnostic (checks Lotus still has admin permissions)
  SELF_DIAGNOSTIC_INTERVAL_MS: 15 * 60 * 1000, // every 15 minutes

  // Scheduled automatic backup (backup/restore)
  AUTO_BACKUP_INTERVAL_MS: 24 * 60 * 60 * 1000, // every 24h

  EMBED_COLOR: 0x8e5cff,
  EMBED_COLOR_ALERT: 0xff4d4d,
};
