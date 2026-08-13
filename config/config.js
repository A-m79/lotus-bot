module.exports = {
  // Fenêtre de temps (ms) pendant laquelle on compte les actions d'un user pour l'anti-nuke
  ANTINUKE_WINDOW_MS: 10_000,

  // Seuils par défaut avant sanction (surchargeables par serveur via /lotus config)
  DEFAULT_THRESHOLDS: {
    channelDelete: 3,      // suppressions de salons
    channelCreate: 5,      // création massive de salons
    channelUpdate: 3,      // modification suspecte de permissions de salons (ex: rendre privé -> public)
    roleDelete: 3,         // suppressions de rôles
    roleCreate: 3,         // création massive de rôles
    memberBan: 5,          // bans en masse
    memberKick: 5,         // kicks en masse
    webhookCreate: 3,      // création de webhooks
    botAdd: 1,              // ajout d'un bot non whitelisté = sanction immédiate
    dangerousRoleUpdate: 2, // attribution de perms admin/dangereuses à un rôle/membre
    emojiDelete: 5,        // suppression massive d'émojis
    stickerDelete: 5,      // suppression massive de stickers
    guildUpdate: 2,        // modification du serveur (nom, icône, vanity URL, transfer)
    antiSpam: 4,            // messages en flood par fenêtre de 7s
  },

  // Sanction par défaut appliquée à l'auteur d'un nuke détecté
  // 'ban' | 'kick' | 'stripRoles' | 'quarantine'
  DEFAULT_PUNISHMENT: "stripRoles",

  // Permissions considérées comme "dangereuses" si accordées soudainement
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

  // Anti-raid : seuils de joins suspects
  ANTIRAID: {
    JOIN_WINDOW_MS: 15_000,
    JOIN_THRESHOLD: 8,
    MIN_ACCOUNT_AGE_MS: 1000 * 60 * 60 * 24 * 3, // 3 jours
    LOCKDOWN_ON_TRIGGER: true,
  },

  // Intervalle de backup automatique (24 heures)
  AUTO_BACKUP_INTERVAL_MS: 24 * 60 * 60 * 1000,

  // Intervalle d'auto-diagnostic des perms de Lotus (15 minutes)
  SELF_DIAGNOSTIC_INTERVAL_MS: 15 * 60 * 1000,

  EMBED_COLOR: 0x8e5cff,
  EMBED_COLOR_ALERT: 0xff4d4d,
};