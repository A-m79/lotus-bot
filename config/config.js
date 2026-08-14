module.exports = {
  // Fenêtre de temps (ms) pendant laquelle on compte les actions d'un user pour l'anti-nuke
  ANTINUKE_WINDOW_MS: 10_000,

  // Seuils par défaut avant sanction (surchargeables par serveur via /lotus config)
  DEFAULT_THRESHOLDS: {
    channelDelete: 3,
    channelCreate: 5,
    channelUpdate: 2,       // ouverture de salon privé à @everyone
    roleDelete: 3,
    roleCreate: 3,
    memberBan: 5,
    memberKick: 5,
    webhookCreate: 3,
    botAdd: 1,
    dangerousRoleUpdate: 2,
    emojiDelete: 5,
    stickerDelete: 5,
    guildUpdate: 1,          // changement de nom/vanity URL : suspect dès la 1ère fois si non-owner
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

  // Auto-diagnostic périodique du bot (vérifie que Lotus a toujours ses perms admin)
  SELF_DIAGNOSTIC_INTERVAL_MS: 15 * 60 * 1000, // toutes les 15 minutes

  // Sauvegarde automatique programmée (backup/restore)
  AUTO_BACKUP_INTERVAL_MS: 24 * 60 * 60 * 1000, // toutes les 24h

  EMBED_COLOR: 0x8e5cff,
  EMBED_COLOR_ALERT: 0xff4d4d,
};
