const { Schema, model } = require("mongoose");

const SecurityLogSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true },
    type: {
      type: String,
      required: true,
      // ex: "channelDelete", "massBan", "dangerousRoleUpdate", "raidDetected", "punishmentApplied"
    },
    executorId: { type: String, required: true, index: true },
    targetId: { type: String, default: null },
    details: { type: Schema.Types.Mixed, default: {} },
    punishmentApplied: { type: String, default: null },
  },
  { timestamps: true }
);

// Index composé pour retrouver rapidement les actions récentes d'un user sur un serveur
SecurityLogSchema.index({ guildId: 1, executorId: 1, createdAt: -1 });

module.exports = model("SecurityLog", SecurityLogSchema);
