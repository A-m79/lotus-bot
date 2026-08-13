const { Schema, model } = require("mongoose");

const GuildConfigSchema = new Schema(
  {
    guildId: { type: String, required: true, unique: true, index: true },

    // Salons de logs/alertes
    logChannelId: { type: String, default: null },
    alertChannelId: { type: String, default: null },

    // Modules activés
    antiNukeEnabled: { type: Boolean, default: true },
    antiRaidEnabled: { type: Boolean, default: true },
    antiSpamEnabled: { type: Boolean, default: true },
    altDetectionEnabled: { type: Boolean, default: true },

    // Système de vérification à l'entrée (Gate)
    verificationEnabled: { type: Boolean, default: false },
    unverifiedRoleId: { type: String, default: null },
    verifiedRoleId: { type: String, default: null },
    verificationChannelId: { type: String, default: null },

    // Seuils custom
    thresholds: {
      channelDelete: Number,
      channelCreate: Number,
      channelUpdate: Number,
      roleDelete: Number,
      roleCreate: Number,
      memberBan: Number,
      memberKick: Number,
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
    lockdownActive: { type: Boolean, default: false },
    whitelist: { type: [String], default: [] },
  },
  { timestamps: true }
);

module.exports = model("GuildConfig", GuildConfigSchema);