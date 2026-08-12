const { Schema, model } = require("mongoose");

const GuildConfigSchema = new Schema(
  {
    guildId: { type: String, required: true, unique: true, index: true },

    // Salon où Lotus envoie les logs de sécurité
    logChannelId: { type: String, default: null },
    // Salon où Lotus envoie les alertes critiques (nuke/raid détecté)
    alertChannelId: { type: String, default: null },

    // Modules activés
    antiNukeEnabled: { type: Boolean, default: true },
    antiRaidEnabled: { type: Boolean, default: true },
    antiSpamEnabled: { type: Boolean, default: true },

    // Seuils custom (fusionnés avec les defaults si non définis)
    thresholds: {
      channelDelete: Number,
      channelCreate: Number,
      roleDelete: Number,
      memberBan: Number,
      memberKick: Number,
      webhookCreate: Number,
      botAdd: Number,
      dangerousRoleUpdate: Number,
    },

    punishment: {
      type: String,
      enum: ["ban", "kick", "stripRoles", "quarantine"],
      default: "stripRoles",
    },

    // Rôle "quarantaine" utilisé pour isoler un compte suspect/compromis
    quarantineRoleId: { type: String, default: null },

    // État du lockdown (anti-raid déclenché)
    lockdownActive: { type: Boolean, default: false },

    // Liste blanche : ID whitelist (ne déclenchent jamais l'anti-nuke)
    whitelist: { type: [String], default: [] },
  },
  { timestamps: true }
);

module.exports = model("GuildConfig", GuildConfigSchema);
