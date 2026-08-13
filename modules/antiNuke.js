const { AuditLogEvent, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
const config = require("../config/config");
const rateTracker = require("../utils/rateTracker");
const { getExecutor } = require("../utils/getExecutor");
const { getGuildConfig } = require("../utils/configCache");
const { punish } = require("./punisher");
const { handleLogChannelDeletion } = require("../utils/logProtector");

function getThreshold(guildConfig, actionType) {
  return (
    guildConfig?.thresholds?.[actionType] ??
    config.DEFAULT_THRESHOLDS[actionType] ?? 3
  );
}

// 🛡️ IMMUNITÉ ABSOLUE : Réservée au Owner du serveur, au Bot et au Owner du Bot
function isOwner(guild, userId) {
  if (userId === guild.ownerId) return true;
  if (userId === guild.client.user.id) return true;
  if (process.env.OWNER_ID && userId === process.env.OWNER_ID) return true;
  return false;
}

function isWhitelisted(guildConfig, userId) {
  return guildConfig?.whitelist?.includes(userId) ?? false;
}

async function checkAndPunish({ guild, executorId, actionType, reasonLabel, details }) {
  const guildConfig = await getGuildConfig(guild.id);

  if (!guildConfig.antiNukeEnabled) return false;

  // 1. Check Owner (Immunité Totale)
  if (isOwner(guild, executorId)) return false;

  const baseThreshold = getThreshold(guildConfig, actionType);
  const isWL = isWhitelisted(guildConfig, executorId);

  // 2. SEUIL ZERO-TRUST :
  // Un Whitelisté a une marge (+3 actions) pour ses tâches de modération/maintenance.
  // Mais s'il dépasse ce seuil critique, la neutralisation se déclenche !
  const threshold = isWL ? baseThreshold + 3 : baseThreshold;

  const count = rateTracker.hit(guild.id, executorId, actionType, config.ANTINUKE_WINDOW_MS);

  if (count >= threshold) {
    rateTracker.reset(guild.id, executorId, actionType);
    await punish({
      guild,
      guildConfig,
      executorId,
      actionType,
      reason: `${reasonLabel} ${isWL ? "[SÉCURITÉ WHITELIST DÉPASSÉE]" : ""} (${count}/${threshold} en ${config.ANTINUKE_WINDOW_MS / 1000}s)`,
      details,
    });
    return true;
  }

  return false;
}

function registerAntiNuke(client) {
  // --- Suppression de salons ---
  client.on("channelDelete", async (channel) => {
    if (!channel.guild) return;
    const executor = await getExecutor(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
    if (!executor) return;

    // Protection du salon de logs/alertes
    await handleLogChannelDeletion(channel.guild, channel, executor);

    await checkAndPunish({
      guild: channel.guild,
      executorId: executor.id,
      actionType: "channelDelete",
      reasonLabel: "Suppression massive de salons",
      details: { channelId: channel.id, channelName: channel.name },
    });
  });

  // --- Création massive de salons ---
  client.on("channelCreate", async (channel) => {
    if (!channel.guild) return;
    const executor = await getExecutor(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
    if (!executor) return;

    await checkAndPunish({
      guild: channel.guild,
      executorId: executor.id,
      actionType: "channelCreate",
      reasonLabel: "Création massive de salons",
      details: { channelId: channel.id, channelName: channel.name },
    });
  });

  // --- Modifications de perms de salon (ex: salon privé rendu public à @everyone) ---
  client.on("channelUpdate", async (oldChannel, newChannel) => {
    if (!newChannel.guild) return;

    const oldEveryone = oldChannel.permissionOverwrites.cache.get(newChannel.guild.id);
    const newEveryone = newChannel.permissionOverwrites.cache.get(newChannel.guild.id);

    const oldCanView = !oldEveryone?.deny.has(PermissionFlagsBits.ViewChannel);
    const newCanView = newEveryone ? !newEveryone.deny.has(PermissionFlagsBits.ViewChannel) : true;

    if (!oldCanView && newCanView) {
      const executor = await getExecutor(newChannel.guild, AuditLogEvent.ChannelOverwriteUpdate, newChannel.id);
      if (!executor) return;

      await checkAndPunish({
        guild: newChannel.guild,
        executorId: executor.id,
        actionType: "channelUpdate",
        reasonLabel: `Rendu du salon #${newChannel.name} accessible à @everyone`,
        details: { channelId: newChannel.id, channelName: newChannel.name },
      });
    }
  });

  // --- Suppression & Création de Rôles ---
  client.on("roleDelete", async (role) => {
    const executor = await getExecutor(role.guild, AuditLogEvent.RoleDelete, role.id);
    if (!executor) return;

    await checkAndPunish({
      guild: role.guild,
      executorId: executor.id,
      actionType: "roleDelete",
      reasonLabel: "Suppression massive de rôles",
      details: { roleId: role.id, roleName: role.name },
    });
  });

  client.on("roleCreate", async (role) => {
    const executor = await getExecutor(role.guild, AuditLogEvent.RoleCreate, role.id);
    if (!executor) return;

    await checkAndPunish({
      guild: role.guild,
      executorId: executor.id,
      actionType: "roleCreate",
      reasonLabel: "Création massive de rôles",
      details: { roleId: role.id, roleName: role.name },
    });
  });

  // --- Bans & Kicks en masse ---
  client.on("guildBanAdd", async (ban) => {
    const executor = await getExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    if (!executor) return;

    await checkAndPunish({
      guild: ban.guild,
      executorId: executor.id,
      actionType: "memberBan",
      reasonLabel: "Bans en masse",
      details: { targetId: ban.user.id },
    });
  });

  client.on("guildMemberRemove", async (member) => {
    const executor = await getExecutor(member.guild, AuditLogEvent.MemberKick, member.id, 3000);
    if (!executor) return;

    await checkAndPunish({
      guild: member.guild,
      executorId: executor.id,
      actionType: "memberKick",
      reasonLabel: "Kicks en masse",
      details: { targetId: member.id },
    });
  });

  // --- Webhooks, Bots non autorisés ---
  client.on("webhooksUpdate", async (channel) => {
    const executor = await getExecutor(channel.guild, AuditLogEvent.WebhookCreate, undefined, 3000);
    if (!executor) return;

    await checkAndPunish({
      guild: channel.guild,
      executorId: executor.id,
      actionType: "webhookCreate",
      reasonLabel: "Création massive de webhooks",
      details: { channelId: channel.id },
    });
  });

  client.on("guildMemberAdd", async (member) => {
    if (!member.user.bot) return;

    const executor = await getExecutor(member.guild, AuditLogEvent.BotAdd, member.id, 5000);
    if (!executor) return;

    await checkAndPunish({
      guild: member.guild,
      executorId: executor.id,
      actionType: "botAdd",
      reasonLabel: "Ajout d'un bot non autorisé",
      details: { botId: member.id, botTag: member.user.tag },
    });
  });

  // --- Suppression Émojis & Stickers ---
  client.on("emojiDelete", async (emoji) => {
    const executor = await getExecutor(emoji.guild, AuditLogEvent.EmojiDelete, emoji.id);
    if (!executor) return;

    await checkAndPunish({
      guild: emoji.guild,
      executorId: executor.id,
      actionType: "emojiDelete",
      reasonLabel: "Suppression massive d'émojis",
      details: { emojiName: emoji.name },
    });
  });

  client.on("stickerDelete", async (sticker) => {
    const executor = await getExecutor(sticker.guild, AuditLogEvent.StickerDelete, sticker.id);
    if (!executor) return;

    await checkAndPunish({
      guild: sticker.guild,
      executorId: executor.id,
      actionType: "stickerDelete",
      reasonLabel: "Suppression massive de stickers",
      details: { stickerName: sticker.name },
    });
  });

  // --- Modification du Serveur (Nom, Vanity, Icône) ---
  client.on("guildUpdate", async (oldGuild, newGuild) => {
    const executor = await getExecutor(newGuild, AuditLogEvent.GuildUpdate, undefined, 3000);
    if (!executor) return;

    if (oldGuild.name !== newGuild.name || oldGuild.vanityURLCode !== newGuild.vanityURLCode) {
      await checkAndPunish({
        guild: newGuild,
        executorId: executor.id,
        actionType: "guildUpdate",
        reasonLabel: "Modification suspecte des paramètres du serveur",
        details: { oldName: oldGuild.name, newName: newGuild.name },
      });
    }
  });

  // --- Auto-Diagnostic : Détection Perte de Perms Admin sur Lotus ---
  client.on("guildMemberUpdate", async (oldMember, newMember) => {
    if (newMember.id !== client.user.id) return;

    const hadAdmin = oldMember.permissions.has(PermissionFlagsBits.Administrator);
    const hasAdmin = newMember.permissions.has(PermissionFlagsBits.Administrator);

    if (hadAdmin && !hasAdmin) {
      const executor = await getExecutor(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.id, 3000);
      const guild = newMember.guild;

      const owner = await guild.fetchOwner().catch(() => null);
      const adminRoles = guild.roles.cache.filter(
        (r) => r.permissions.has(PermissionFlagsBits.Administrator) && !r.managed
      );
      const adminMentions = adminRoles.map((r) => `<@&${r.id}>`).join(" ") || "@here";

      const embed = new EmbedBuilder()
        .setTitle("🚨 URGENT : Perte des Droits Administrateur de Lotus !")
        .setColor("#FF0000")
        .setDescription(
          `Les permissions Administrateur de Lotus ont été supprimées.\n\n` +
          `• **Auteur de la modification :** ${executor ? `${executor.tag} (\`${executor.id}\`)` : "Inconnu"}\n` +
          `• **Date & Heure :** <t:${Math.floor(Date.now() / 1000)}:F>\n\n` +
          `⚠️ **Lotus ne peut plus protéger le serveur correctement tant que ses accès ne sont pas rétablis.**`
        )
        .setTimestamp();

      if (owner) {
        await owner.send({ embeds: [embed] }).catch(() => null);
      }

      const guildConfig = await getGuildConfig(guild.id);
      const targetChannelId = guildConfig?.logChannelId || guildConfig?.alertChannelId;
      if (targetChannelId) {
        const channel = await guild.channels.fetch(targetChannelId).catch(() => null);
        if (channel?.isTextBased()) {
          await channel.send({ content: `🚨 ${adminMentions}`, embeds: [embed] }).catch(() => null);
        }
      }
    }
  });

  console.log("[AntiNuke Pro] Module Zero-Trust chargé et actif.");
}

module.exports = { registerAntiNuke };