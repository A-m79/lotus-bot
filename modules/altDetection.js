const { punish } = require("./punisher");
const { getGuildConfig } = require("../utils/configCache");
const { EmbedBuilder } = require("discord.js");

const SUSPICIOUS_PATTERNS = [
  /telegram/i,
  /t\.me\//i,
  /crypto/i,
  /airdrop/i,
  /whatsapp/i,
  /claim.*nft/i,
  /discord\.gg/i,
  /https?:\/\//i,
];

function isWhitelisted(guild, guildConfig, userId) {
  if (userId === guild.ownerId) return true;
  if (process.env.OWNER_ID && userId === process.env.OWNER_ID) return true;
  return guildConfig?.whitelist?.includes(userId) ?? false;
}

function registerAltDetection(client) {
  client.on("guildMemberAdd", async (member) => {
    if (!member.guild || member.user.bot) return;

    const { guild, user } = member;
    const guildConfig = await getGuildConfig(guild.id).catch(() => null);

    if (guildConfig?.altDetectionEnabled === false) return;
    if (isWhitelisted(guild, guildConfig, user.id)) return;

    const now = Date.now();
    const accountAgeMs = now - user.createdTimestamp;
    const accountAgeDays = Math.floor(accountAgeMs / (1000 * 60 * 60 * 24));
    const accountAgeHours = Math.floor(accountAgeMs / (1000 * 60 * 60));

    const flags = [];
    let isUltraRecent = accountAgeDays < 14; // Quarantaine directe si < 14 jours

    if (accountAgeDays < 30) {
      flags.push(`Compte récent (${accountAgeDays}j)`);
    }
    if (!user.avatar) {
      flags.push("Avatar par défaut");
    }
    const fullName = `${user.username} ${user.displayName || ""}`;
    if (SUSPICIOUS_PATTERNS.some((p) => p.test(fullName))) {
      flags.push("Pseudo suspect");
    }

    // 1. CAS GRAVE : Compte < 14 jours -> Quarantaine directe
    if (isUltraRecent) {
      return punish({
        guild,
        guildConfig,
        executorId: user.id,
        actionType: "ALT_DETECTION",
        reason: `Compte extrêmement récent (${accountAgeDays}j / <14j)`,
        details: {
          "Création": `${accountAgeDays}j (${accountAgeHours}h)`,
          "Avatar": user.avatar ? "Personnalisé" : "Par défaut",
          "Indicateurs": flags.join(" | "),
        },
        customSanction: "quarantine",
      });
    }

    // 2. CAS SUSPECT : Compte entre 14 et 30 jours, avatar par défaut, etc. -> Avertissement aux staff
    if (flags.length > 0) {
      const targetChannelId = guildConfig?.alertChannelId || guildConfig?.logChannelId;
      if (!targetChannelId) return;

      const channel = await guild.channels.fetch(targetChannelId).catch(() => null);
      if (!channel?.isTextBased()) return;

      const embed = new EmbedBuilder()
        .setColor("#FFCC00")
        .setAuthor({
          name: `AVERTISSEMENT SUSPICION • ${guild.name.toUpperCase()}`,
          iconURL: guild.iconURL({ dynamic: true }) || undefined,
        })
        .setTitle(`👀 Nouveau Membre Suspect — ${user.tag}`)
        .setDescription(`Un membre est arrivé mais présente des critères suspects. Aucune sanction automatique n'a été appliquée.`)
        .addFields(
          { name: "👤 Utilisateur", value: `${user}\n\`ID: ${user.id}\``, inline: true },
          { name: "📅 Ancienneté", value: `\`${accountAgeDays} jour(s)\``, inline: true },
          { name: "🔍 Signalements", value: `\`${flags.join(" | ")}\``, inline: false }
        )
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
        .setFooter({ text: "Lotus Security • Module de Suspicion" })
        .setTimestamp();

      await channel.send({ embeds: [embed] }).catch(() => null);
    }
  });

  console.log("[Alt Detection Pro] Module de détection et d'avertissement actif.");
}

module.exports = { registerAltDetection };