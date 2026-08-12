const { Schema, model } = require("mongoose");

const SecurityLogSchema = new Schema(
  {
    caseId: { type: String, index: true, default: null }, // ex: "CASE-A7F92"
    guildId: { type: String, required: true, index: true },
    type: {
      type: String,
      required: true,
      // ex: "channelDelete", "massBan", "antiSpam", "raidDetected", etc.
    },
    executorId: { type: String, required: true, index: true },
    targetId: { type: String, default: null },
    reason: { type: String, default: null }, // Motif précis de la détection
    details: { type: Schema.Types.Mixed, default: {} },
    punishmentApplied: { type: String, default: null },
  },
  { timestamps: true }
);

// Indexations pour recherches ultra-rapides (par Case ID ou historique d'un membre)
SecurityLogSchema.index({ caseId: 1 });
SecurityLogSchema.index({ guildId: 1, executorId: 1, createdAt: -1 });

module.exports = model("SecurityLog", SecurityLogSchema);