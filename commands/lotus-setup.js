const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, EmbedBuilder } = require("discord.js");
const GuildConfig = require("../models/GuildConfig");
const { postVerificationMessage } = require("../modules/verificationGate");

// Import sécurisé du cache
const configCache = require("../utils/configCache");

/**
 * Nettoie le cache de manière universelle selon la structure de configCache.js
 */
function safeInvalidateCache(guildId) {
  if (!configCache) return;

  if (typeof configCache.invalidateGuildConfig === "function") {
    configCache.invalidateGuildConfig(guildId);
  } else if (typeof configCache.clearCache === "function") {
    configCache.clearCache(guildId);
  } else if (typeof configCache.delete === "function") {
    configCache.delete(guildId);
  } else if (configCache instanceof Map) {
    configCache.delete(guildId);
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("lotus-setup")
    .setDescription("Analyse et configure/répare automatiquement l'infrastructure de sécurité Lotus.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
      }

      const guild = interaction.guild;
      let config = await GuildConfig.findOne({ guildId: guild.id });
      if (!config) {
        config = new GuildConfig({ guildId: guild.id });
      }

      const actionsTaken = [];

      // 1. Détection ou création de la Catégorie
      let category = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase().includes("lotus")
      );

      if (!category) {
        category = await guild.channels.create({
          name: "SÉCURITÉ LOTUS",
          type: ChannelType.GuildCategory,
          permissionOverwrites: [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: guild.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageChannels] },
          ],
        });
        actionsTaken.push("📂 **Catégorie :** `SÉCURITÉ LOTUS` créée avec succès.");
      } else {
        actionsTaken.push(`📂 **Catégorie :** Retrouvée (<#${category.id}>).`);
      }

      // 2. Détection ou création du Salon de Logs
      let logChannel = config.logChannelId ? guild.channels.cache.get(config.logChannelId) : null;
      if (!logChannel) {
        logChannel = guild.channels.cache.find(
          (c) => c.type === ChannelType.GuildText && c.name === "logs-lotus" && c.parentId === category.id
        );
      }

      if (!logChannel) {
        logChannel = await guild.channels.create({
          name: "logs-lotus",
          type: ChannelType.GuildText,
          parent: category.id,
          topic: "Logs de sécurité générés par Lotus Security",
          permissionOverwrites: [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: guild.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
          ],
        });
        config.logChannelId = logChannel.id;
        actionsTaken.push("📜 **Salon Logs :** `#logs-lotus` créé et configuré.");
      } else {
        if (logChannel.parentId !== category.id) {
          await logChannel.setParent(category.id).catch(() => null);
        }
        config.logChannelId = logChannel.id;
        actionsTaken.push(`📜 **Salon Logs :** Retrouvé et vérifié (<#${logChannel.id}>).`);
      }

      // 3. Détection ou création du Salon d'Alertes
      let alertChannel = config.alertChannelId ? guild.channels.cache.get(config.alertChannelId) : null;
      if (!alertChannel) {
        alertChannel = guild.channels.cache.find(
          (c) => c.type === ChannelType.GuildText && c.name === "alertes-lotus" && c.parentId === category.id
        );
      }

      if (!alertChannel) {
        alertChannel = await guild.channels.create({
          name: "alertes-lotus",
          type: ChannelType.GuildText,
          parent: category.id,
          topic: "Alertes critiques envoyées par Lotus Security",
          permissionOverwrites: [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: guild.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
          ],
        });
        config.alertChannelId = alertChannel.id;
        actionsTaken.push("🚨 **Salon Alertes :** `#alertes-lotus` créé et configuré.");
      } else {
        if (alertChannel.parentId !== category.id) {
          await alertChannel.setParent(category.id).catch(() => null);
        }
        config.alertChannelId = alertChannel.id;
        actionsTaken.push(`🚨 **Salon Alertes :** Retrouvé et vérifié (<#${alertChannel.id}>).`);
      }

      // 4. Détection ou création du Rôle de Quarantaine
      let quarantineRole = config.quarantineRoleId ? guild.roles.cache.get(config.quarantineRoleId) : null;
      if (!quarantineRole) {
        quarantineRole = guild.roles.cache.find((r) => r.name === "Lotus Quarantaine");
      }

      if (!quarantineRole) {
        quarantineRole = await guild.roles.create({
          name: "Lotus Quarantaine",
          color: "#2f3136",
          reason: "Création automatique du rôle de quarantaine par /lotus-setup",
        });
        config.quarantineRoleId = quarantineRole.id;
        actionsTaken.push("☣️ **Rôle Quarantaine :** `Lotus Quarantaine` créé.");
      } else {
        config.quarantineRoleId = quarantineRole.id;
        actionsTaken.push(`☣️ **Rôle Quarantaine :** Retrouvé (<@&${quarantineRole.id}>).`);
      }

      // 5. Détection ou création du Salon de Quarantaine
      let quarantineChannel = config.quarantineChannelId ? guild.channels.cache.get(config.quarantineChannelId) : null;
      if (!quarantineChannel) {
        quarantineChannel = guild.channels.cache.find(
          (c) => c.type === ChannelType.GuildText && (c.name === "quarantaine-lotus" || c.name === "🔒-quarantaine") && c.parentId === category.id
        );
      }

      if (!quarantineChannel) {
        quarantineChannel = await guild.channels.create({
          name: "🔒-quarantaine",
          type: ChannelType.GuildText,
          parent: category.id,
          topic: "Espace d'isolement sécurisé pour les membres sous sanctions Lotus Security",
          permissionOverwrites: [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            {
              id: quarantineRole.id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
              deny: [
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.AddReactions,
                PermissionFlagsBits.CreatePublicThreads,
                PermissionFlagsBits.CreatePrivateThreads,
                PermissionFlagsBits.SendMessagesInThreads,
                PermissionFlagsBits.UseApplicationCommands,
                PermissionFlagsBits.Speak,
              ],
            },
            {
              id: guild.client.user.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.ManageChannels,
              ],
            },
          ],
        });

        const infoEmbed = new EmbedBuilder()
          .setTitle("🔒 Zone de Confinement — Lotus Security")
          .setColor("#2b2d31")
          .setDescription(
            "**Ce salon est un espace d'isolement sécurisé.**\n\n" +
            "Si vous avez accès à ce salon, votre compte a été placé en **quarantaine automatique** à la suite d'un déclenchement du système de sécurité.\n\n" +
            "• **Accès Restreint :** Vous ne pouvez ni envoyer de messages, ni interagir avec le serveur.\n" +
            "• **Visibilité Staff :** Les administrateurs peuvent vous identifier et examiner votre dossier ici.\n\n" +
            "*Veuillez patienter qu'un administrateur traite votre cas.*"
          )
          .setFooter({ text: "Lotus Security System • Zone restreinte" });

        const pinnedMsg = await quarantineChannel.send({ embeds: [infoEmbed] }).catch(() => null);
        if (pinnedMsg) await pinnedMsg.pin().catch(() => null);

        config.quarantineChannelId = quarantineChannel.id;
        actionsTaken.push("🔒 **Salon Quarantaine :** `#🔒-quarantaine` créé sous la catégorie.");
      } else {
        if (quarantineChannel.parentId !== category.id) {
          await quarantineChannel.setParent(category.id).catch(() => null);
        }
        config.quarantineChannelId = quarantineChannel.id;
        actionsTaken.push(`🔒 **Salon Quarantaine :** Retrouvé et vérifié (<#${quarantineChannel.id}>).`);
      }

      // 6. Détection ou création du Rôle "Non-Vérifié" (gate d'entrée)
      let unverifiedRole = config.unverifiedRoleId ? guild.roles.cache.get(config.unverifiedRoleId) : null;
      if (!unverifiedRole) {
        unverifiedRole = guild.roles.cache.find((r) => r.name === "Lotus Non-Vérifié");
      }

      if (!unverifiedRole) {
        unverifiedRole = await guild.roles.create({
          name: "Lotus Non-Vérifié",
          color: "#99AAB5",
          reason: "Création automatique du rôle de vérification par /lotus-setup",
        });
        config.unverifiedRoleId = unverifiedRole.id;
        actionsTaken.push("🕐 **Rôle Non-Vérifié :** `Lotus Non-Vérifié` créé.");
      } else {
        config.unverifiedRoleId = unverifiedRole.id;
        actionsTaken.push(`🕐 **Rôle Non-Vérifié :** Retrouvé (<@&${unverifiedRole.id}>).`);
      }

      // 7. Détection ou création du Salon de Vérification (MASQUÉ UNE FOIS VÉRIFIÉ)
      let verificationChannel = config.verificationChannelId ? guild.channels.cache.get(config.verificationChannelId) : null;
      if (!verificationChannel) {
        verificationChannel = guild.channels.cache.find(
          (c) => c.type === ChannelType.GuildText && c.name === "✅-vérification"
        );
      }

      // Permissions : @everyone masqué, visible UNIQUEMENT pour le rôle "Lotus Non-Vérifié"
      const verificationPermissions = [
        {
          id: guild.id,
          deny: [PermissionFlagsBits.ViewChannel], // Bloqué pour tout le monde par défaut (y compris membres vérifiés)
        },
        {
          id: unverifiedRole.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], // Autorisé UNIQUEMENT aux non-vérifiés
          deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions],
        },
        {
          id: guild.client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ManageMessages,
          ],
        },
      ];

      if (!verificationChannel) {
        verificationChannel = await guild.channels.create({
          name: "✅-vérification",
          type: ChannelType.GuildText,
          topic: "Vérification obligatoire avant d'accéder au reste du serveur",
          permissionOverwrites: verificationPermissions,
        });
        config.verificationChannelId = verificationChannel.id;
        actionsTaken.push("✅ **Salon Vérification :** `#✅-vérification` créé (réservé aux non-vérifiés).");
      } else {
        // Applique les nouvelles permissions même si le salon existait déjà
        await verificationChannel.permissionOverwrites.set(verificationPermissions).catch(() => null);
        config.verificationChannelId = verificationChannel.id;
        actionsTaken.push(`✅ **Salon Vérification :** Retrouvé et permissions ajustées (<#${verificationChannel.id}>).`);
      }

      // 8. Masquage de tous les AUTRES salons existants pour le rôle Non-Vérifié
      const allChannels = await guild.channels.fetch();
      let protectedCount = 0;
      for (const [, ch] of allChannels) {
        if (!ch || !ch.permissionOverwrites) continue;
        if (ch.id === verificationChannel.id) continue;
        if (ch.parentId === category.id) continue;

        await ch.permissionOverwrites
          .edit(unverifiedRole.id, { ViewChannel: false }, { reason: "Lotus Verification Gate : masquage initial" })
          .catch(() => null);
        protectedCount++;
      }
      actionsTaken.push(`🙈 **Masquage :** ${protectedCount} salon(s) existant(s) rendus invisibles aux membres non-vérifiés.`);

      // 9. Envoi (ou vérification) du message de vérification avec le bouton
      await postVerificationMessage(verificationChannel);
      actionsTaken.push("🔘 **Message de vérification :** Bouton de démarrage du challenge posté et épinglé.");

      // 10. Activation forcée de tous les modules de protection & Sanction
      config.antiNukeEnabled = true;
      config.antiRaidEnabled = true;
      config.antiSpamEnabled = true;
      config.altDetectionEnabled = true;
      config.verificationEnabled = true;
      config.punishment = "quarantine";

      actionsTaken.push("🛡️ **Systèmes de Protection :** `Anti-Nuke`, `Anti-Raid`, `Anti-Spam`, `Anti-Double-Compte` et `Vérification à l'Entrée` **ACTIVÉS** (Mode: Quarantaine).");

      // 11. Sauvegarde BDD & Nettoyage du Cache
      await config.save();
      safeInvalidateCache(guild.id);

      const embed = new EmbedBuilder()
        .setTitle("⚙️ Audit & Diagnostic /lotus-setup - Lotus")
        .setColor("#00FF7F")
        .setDescription(
          "Lotus a analysé la structure du serveur, ré-aligné la configuration et armé le bouclier de sécurité :\n\n" +
            actionsTaken.join("\n")
        )
        .setFooter({ text: "Lotus Security System • Système armé et opérationnel" })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error("[LOTUS-SETUP ERROR]", error);
      const errorMsg = `❌ Erreur lors de l'exécution de lotus-setup : \`${error.message}\``;
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ content: errorMsg }).catch(() => null);
      } else {
        return interaction.reply({ content: errorMsg, ephemeral: true }).catch(() => null);
      }
    }
  },
};