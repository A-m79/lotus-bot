module.exports = {
  // Fenêtre de temps (ms) pendant laquelle on compte les actions d'un user pour l'anti-nuke
  ANTINUKE_WINDOW_MS: 10_000,

  // Seuils par défaut avant sanction (surchargeables par serveur via /lotus config)
  DEFAULT_THRESHOLDS: {
    channelDelete: 3,      // suppressions de salons en ANTINUKE_WINDOW_MS
    channelCreate: 5,      // création massive de salons (spam)
    roleDelete: 3,         // suppressions de rôles
    memberBan: 5,          // bans en masse
    memberKick: 5,         // kicks en masse
    webhookCreate: 3,      // création de webhooks (souvent utilisé pour leak/spam)
    botAdd: 1,              // ajout d'un bot non whitelisté = sanction immédiate
    dangerousRoleUpdate: 2, // attribution de perms admin/dangereuses à un rôle/membre
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
    JOIN_THRESHOLD: 8,        // X joins en JOIN_WINDOW_MS déclenche le mode raid
    MIN_ACCOUNT_AGE_MS: 1000 * 60 * 60 * 24 * 3, // 3 jours - en dessous = suspect
    LOCKDOWN_ON_TRIGGER: true,
  },

  EMBED_COLOR: 0x8e5cff, // violet "lotus"
  EMBED_COLOR_ALERT: 0xff4d4d,
};
