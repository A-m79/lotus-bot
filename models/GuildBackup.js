const mongoose = require("mongoose");

const guildBackupSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  roles: Array,
  channels: Array,
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("GuildBackup", guildBackupSchema);