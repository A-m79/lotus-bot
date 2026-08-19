const { Schema, model } = require("mongoose");

const GuildConfigSchema = new Schema(
  {
    guildId: { type: String, required: true, unique: true, index: true },

    // Logs/alerts channels
    logChannelId: { type: String, default: null },
    alertChannelId: { type: String, default: null },

    // Enabled modules
    antiNukeEnabled: { type: Boolean, default: true },
    antiRaidEnabled: { type: Boolean, default: true },
    antiSpamEnabled: { type: Boolean, default: true },
    altDetectionEnabled: { type: Boolean, default: true },

    // Entry verification system (Gate)
    verificationEnabled: { type: Boolean, default: false },
    unverifiedRoleId: { type: String, default: null },
    verifiedRoleId: { type: String, default: null },
    verificationChannelId: { type: String, default: null },

    // Custom thresholds
    thresholds: {
      channelDelete: Number,
      channelCreate: Number,
      channelUpdate: Number,
      roleDelete: Number,
      roleCreate: Number,
      memberBan: Number,
      memberKick: Number,
      memberPrune: Number,
      webhookCreate: Number,
      botAdd: Number,
      dangerousRoleUpdate: Number,
      emojiDelete: Number,
      stickerDelete: Number,
      guildUpdate: Number,
      antiSpam: Number,
    },

    punishment: {
      type: String,
      enum: ["ban", "kick", "stripRoles", "quarantine"],
      default: "stripRoles",
    },

    quarantineRoleId: { type: String, default: null },
    // Bug fixed: this field was already being written by lotus-setup.js but was
    // missing from the schema, so it was silently ignored by Mongoose (strict mode
    // by default) on every .save(). The quarantine channel lookup consistently fell
    // back to searching by name, which worked but never benefited from the fast
    // ID-based cache.
    quarantineChannelId: { type: String, default: null },

    // Persistent list of user IDs currently under quarantine, independent of
    // Discord roles. Discord wipes ALL of a member's roles when they leave the
    // server, so relying on the "Lotus Quarantine" role alone means a simple
    // leave + rejoin would silently clear the sanction. This list survives
    // that, and is checked by the verification gate on guildMemberAdd to
    // re-quarantine a returning member instead of sending them through the
    // normal (bypassable) verification flow. Entries are removed automatically
    // when staff manually take the quarantine role off a member.
    quarantinedUserIds: { type: [String], default: [] },

    lockdownActive: { type: Boolean, default: false },
    whitelist: { type: [String], default: [] },
    // Role IDs that grant the same anti-nuke threshold bonus as an individual
    // whitelist entry — any member holding one of these roles is treated as
    // whitelisted, without having to be listed individually (e.g. a shared
    // "bot-auto" role used by several trusted automation accounts).
    whitelistRoles: { type: [String], default: [] },

    // Fix (2FA reminder spammed on restart): this used to live in an
    // in-memory Map in index.js, reset to empty every time the process
    // restarts (redeploy, crash, free-tier sleep/wake). A restart within the
    // 24h window meant the "once per day max" reminder fired again from
    // scratch, even though one had already gone out recently. Storing the
    // timestamp in the database instead makes it survive restarts.
    last2FAWarningAt: { type: Date, default: null },

    // Lets the server owner permanently opt out of the 2FA reminder DM via
    // the button attached to it, for servers that intentionally don't want
    // to enable Discord's native moderator 2FA requirement.
    twoFactorReminderDisabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = model("GuildConfig", GuildConfigSchema);
