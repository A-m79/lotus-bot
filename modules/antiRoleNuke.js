const { AuditLogEvent } = require("discord.js");
const { punish } = require("./punisher");
const GuildConfig = require("../models/GuildConfig");

const roleTracker = new Map();

function registerAntiRoleNuke(client) {
  async function handleRoleAction(role, auditType, actionTypeLabel) {
    const guild = role.guild;
    const guildConfig = await GuildConfig.findOne({ guildId: guild.id });

    // Récupération de l'auteur de l'action via les Audit Logs
    const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: auditType }).catch(() => null);
    const entry = auditLogs?.entries.first();
    if (!entry || !entry.executor || entry.executor.bot) return;

    const executorId = entry.executor.id;

    // 1. IMMUNITÉ ABSOLUE : Owner du serveur / Owner du Bot uniquement
    const isOwner = executorId === guild.ownerId || (process.env.OWNER_ID && executorId === process.env.OWNER_ID);
    if (isOwner) return;

    // 2. SEUIL ZERO-TRUST :
    // 3 rôles pour un utilisateur standard, 5 rôles max en 10s pour un membre Whitelisté
    const isWL = guildConfig?.whitelist?.includes(executorId);
    const threshold = isWL ? 5 : 3;

    const now = Date.now();
    if (!roleTracker.has(executorId)) {
      roleTracker.set(executorId, []);
    }

    const timestamps = roleTracker.get(executorId);
    timestamps.push(now);

    // Ne conserve que les actions des 10 dernières secondes
    const recentActions = timestamps.filter((t) => now - t < 10000);
    roleTracker.set(executorId, recentActions);

    // Déclenchement si le seuil (3 normal, 5 whitelist) est atteint en 10s
    if (recentActions.length >= threshold) {
      roleTracker.delete(executorId);

      await punish({
        guild,
        guildConfig,
        executorId,
        actionType: "ROLE_NUKE",
        reason: `${actionTypeLabel} massive de rôles ${isWL ? "[SÉCURITÉ WHITELIST DÉPASSÉE]" : ""} (${recentActions.length}/${threshold} en 10s)`,
        details: {
          Rôle: role.name,
          Auteur: entry.executor.tag,
        },
      });
    }
  }

  client.on("roleCreate", (role) => handleRoleAction(role, AuditLogEvent.RoleCreate, "Création"));
  client.on("roleDelete", (role) => handleRoleAction(role, AuditLogEvent.RoleDelete, "Suppression"));
}

module.exports = { registerAntiRoleNuke };