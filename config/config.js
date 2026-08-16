module.exports = {
  // Time window (ms) during which a user's actions are counted for anti-nuke
  ANTINUKE_WINDOW_MS: 10_000,

  // Fix (paced/slow nuke detection): a second, longer window used alongside
  // ANTINUKE_WINDOW_MS. Some actions (e.g. deleting a text channel) require
  // manually retyping the channel name to confirm, which is naturally slower
  // than a scripted/bot nuke — a deliberate actor can stay under the 10s
  // burst threshold indefinitely while still wiping the whole server over a
  // couple of minutes. This window catches that sustained pattern.
  ANTINUKE_SUSTAINED_WINDOW_MS: 90_000,
  // Multiplier applied to the (whitelist-adjusted) short-window threshold to
  // get the sustained-window threshold. Tuned down from an initial 2.5x
  // (which required 23 actions for a whitelisted user — unrealistically
  // high for most servers' actual channel count) to 1.3x: for a
  // channelDelete threshold of 9 (whitelisted), that's 12 deletions in 90s,
  // a pace slow enough to be clearly "patient" rather than a scripted
  // burst, while still being a plausible number of channels to lose on a
  // small-to-medium server before Lotus reacts.
  ANTINUKE_SUSTAINED_MULTIPLIER: 1.3,

  // Fix (protection scaled to server size): a fixed absolute threshold (e.g.
  // "12 channel deletions") is meaningless for a small server that only has
  // 10 channels total — it would NEVER trigger, no matter how corrupted the
  // whitelisted account is, because the whole server gets wiped out before
  // the count is reached. This checks the DESTRUCTION RATIO instead: if a
  // given % of the server's current channels/roles/emojis/members is wiped
  // out within the sustained window, it triggers regardless of the raw
  // count or the fixed thresholds above. Applies on top of, not instead of,
  // the burst/sustained absolute checks.
  ANTINUKE_PERCENT_THRESHOLDS: {
    channelDelete: 0.3,   // 30% of channels gone
    roleDelete: 0.3,      // 30% of roles gone
    emojiDelete: 0.4,
    stickerDelete: 0.4,
    memberBan: 0.15,      // banning members is destructive at a much lower %
    memberKick: 0.15,
  },
  // Minimum raw count required before the % check applies at all — avoids a
  // false alarm from a single legitimate deletion on a tiny server (e.g. 1
  // channel deleted out of 3 would be 33%, technically over threshold, but
  // is very likely a normal admin action, not a nuke).
  ANTINUKE_PERCENT_MIN_COUNT: 3,

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
