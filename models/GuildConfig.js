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

    lockdownActive: { type: Boolean, default: false },
    whitelist: { type: [String], default: [] },
  },
  { timestamps: true }
);

module.exports = model("GuildConfig", GuildConfigSchema);