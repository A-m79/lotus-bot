const { Schema, model } = require("mongoose");

const SecurityLogSchema = new Schema(
  {
    caseId: { type: String, index: true, default: null }, // e.g. "CASE-A7F92"
    guildId: { type: String, required: true, index: true },
    type: {
      type: String,
      required: true,
      // e.g. "channelDelete", "massBan", "antiSpam", "raidDetected", etc.
    },
    executorId: { type: String, required: true, index: true },
    targetId: { type: String, default: null },
    reason: { type: String, default: null }, // Precise reason for the detection
    details: { type: Schema.Types.Mixed, default: {} },
    punishmentApplied: { type: String, default: null },
  },
  { timestamps: true }
);

// Indexes for ultra-fast lookups (by Case ID or a member's history)
SecurityLogSchema.index({ caseId: 1 });
SecurityLogSchema.index({ guildId: 1, executorId: 1, createdAt: -1 });

module.exports = model("SecurityLog", SecurityLogSchema);