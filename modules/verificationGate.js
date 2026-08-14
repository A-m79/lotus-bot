const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
} = require("discord.js");
const { getGuildConfig } = require("../utils/configCache");
const { punish } = require("./punisher");
const SecurityLog = require("../models/SecurityLog");
const rateTracker = require("../utils/rateTracker");

// Réserve d'emojis pour le challenge : à chaque tentative, 5 sont tirés au
// hasard parmi cette liste, un seul est désigné "bonne réponse".
const EMOJI_POOL = [
  "🦊", "🐸", "🐢", "🦁", "🐼", "🐧", "🦉", "🐙",
  "🍇", "🍉", "🍋", "🍒", "🍓", "🥝", "🍍", "🥥",
  "⭐", "🔥", "💎", "🎯", "🎲", "🎈", "🧩", "🔑",
];

// État en mémoire des challenges en cours : `${guildId}:${userId}` -> { correctEmoji, expiresAt }
const pendingChallenges = new Map();
const CHALLENGE_TTL_MS = 60_000; // le challenge expire après 60s d'inactivité

// Nettoyage périodique des challenges expirés
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of pendingChallenges.entries()) {
    if (now > data.expiresAt) pendingChallenges.delete(key);
  }
}, 30_000);

function buildChallenge() {
  const shuffled = [...EMOJI_POOL].sort(() => Math.random() - 0.5).slice(0, 5);
  const correctIndex = Math.floor(Math.random() * shuffled.length);
  return { emojis: shuffled, correctEmoji: shuffled[correctIndex] };
}

/**
 * Applique le rôle "Non-Vérifié" à un nouveau membre humain, si le gate est activé.
 */
async function registerVerificationGate(client) {
  client.on("guildMemberAdd", async (member) => {
    if (member.user.bot) return;

    const guildConfig = await getGuildConfig(member.guild.id).catch(() => null);
    if (!guildConfig?.verificationEnabled || !guildConfig.unverifiedRoleId) return;

    const role = member.guild.roles.cache.get(guildConfig.unverifiedRoleId);
    if (!role) return;

    await member.roles.add(role, "Lotus Verification Gate : en attente de vérification").catch(() => null);
  });

  // Protège automatiquement tout NOUVEAU salon créé après le /lotus-setup initial :
  // sans ça, un salon créé après coup serait visible par défaut par les membres
  // non-vérifiés (le gate ne protégerait alors plus que les salons existants au
  // moment du setup).
  client.on("channelCreate", async (channel) => {
    if (!channel.guild || !channel.permissionOverwrites) return;

    const guildConfig = await getGuildConfig(channel.guild.id).catch(() => null);
    if (!guildConfig?.verificationEnabled || !guildConfig.unverifiedRoleId) return;

    // On ne touche pas au salon de vérification lui-même, ni à rien sous la
    // catégorie SÉCURITÉ LOTUS (déjà protégée par le deny @everyone de la catégorie).
    if (channel.id === guildConfig.verificationChannelId) return;
    const parent = channel.parent;
    if (parent && (parent.name.toLowerCase().includes("lotus") || parent.name.toLowerCase().includes("sécurité"))) return;

    await channel.permissionOverwrites
      .edit(guildConfig.unverifiedRoleId, { ViewChannel: false }, { reason: "Lotus Verification Gate : protection auto des nouveaux salons" })
      .catch(() => null);
  });

  console.log("[VerificationGate] Module chargé — gate de vérification à l'entrée actif.");
}

/**
 * Envoie le message d'accueil avec le bouton "Commencer la vérification"
 * dans le salon de vérification. Appelé depuis /lotus-setup.
 * `force` = true pour republier même si un message existe déjà (ex: après reset).
 */
async function postVerificationMessage(channel, force = false) {
  if (!force) {
    const pinned = await channel.messages.fetchPinned().catch(() => null);
    if (pinned && pinned.some((m) => m.author.id === channel.client.user.id)) {
      return; // Message déjà présent, on ne duplique pas
    }
  }

  const embed = new EmbedBuilder()
    .setTitle("🔐 Vérification requise")
    .setColor("#8e5cff")
    .setDescription(
      "Bienvenue ! Pour accéder au reste du serveur, tu dois d'abord confirmer que tu n'es pas un robot.\n\n" +
        "Clique sur le bouton ci-dessous, puis suis les instructions affichées (elles ne sont visibles que par toi)."
    )
    .setFooter({ text: "Lotus Security System • Vérification anti-raid" });

  const button = new ButtonBuilder()
    .setCustomId("lotus_verify_start")
    .setLabel("🔓 Commencer la vérification")
    .setStyle(ButtonStyle.Success);

  const row = new ActionRowBuilder().addComponents(button);

  const msg = await channel.send({ embeds: [embed], components: [row] }).catch(() => null);
  if (msg) await msg.pin().catch(() => null);
  return msg;
}

/**
 * Point d'entrée pour toutes les interactions liées à la vérification
 * (bouton de démarrage + boutons de réponse au challenge).
 */
async function handleVerificationInteraction(interaction) {
  if (!interaction.isButton()) return;

  const guild = interaction.guild;
  if (!guild) return;

  // --- Bouton de démarrage ---
  if (interaction.customId === "lotus_verify_start") {
    const guildConfig = await getGuildConfig(guild.id).catch(() => null);
    const member = interaction.member;

    if (!guildConfig?.unverifiedRoleId || !member.roles.cache.has(guildConfig.unverifiedRoleId)) {
      return interaction.reply({ content: "✅ Tu es déjà vérifié, rien à faire !", ephemeral: true });
    }

    // Anti-brute-force : vérifie si l'utilisateur est temporairement verrouillé
    const lockKey = `${guild.id}:${interaction.user.id}`;
    const lock = pendingChallenges.get(`lock:${lockKey}`);
    if (lock && Date.now() < lock.expiresAt) {
      const remaining = Math.ceil((lock.expiresAt - Date.now()) / 1000);
      return interaction.reply({
        content: `⏳ Trop de tentatives échouées. Réessaie dans ${remaining}s.`,
        ephemeral: true,
      });
    }

    const { emojis, correctEmoji } = buildChallenge();
    pendingChallenges.set(`${guild.id}:${interaction.user.id}`, {
      correctEmoji,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });

    const buttons = emojis.map((emoji, idx) =>
      new ButtonBuilder()
        .setCustomId(`lotus_verify_answer_${guild.id}_${interaction.user.id}_${idx}`)
        .setEmoji(emoji)
        .setStyle(ButtonStyle.Secondary)
    );
    const row = new ActionRowBuilder().addComponents(buttons);

    return interaction.reply({
      content: `🧩 **Clique sur l'emoji suivant pour valider ta vérification :** ${correctEmoji}\n\n*(Ce challenge expire dans 60 secondes.)*`,
      components: [row],
      ephemeral: true,
    });
  }

  // --- Boutons de réponse ---
  if (interaction.customId.startsWith("lotus_verify_answer_")) {
    const parts = interaction.customId.split("_");
    const guildId = parts[3];
    const userId = parts[4];
    const answerIdx = Number(parts[5]);

    // Défense : seul l'utilisateur qui a lancé le challenge peut y répondre
    if (interaction.user.id !== userId || guild.id !== guildId) {
      return interaction.reply({ content: "❌ Ce challenge ne t'appartient pas.", ephemeral: true });
    }

    const key = `${guildId}:${userId}`;
    const challenge = pendingChallenges.get(key);

    if (!challenge || Date.now() > challenge.expiresAt) {
      pendingChallenges.delete(key);
      return interaction.reply({
        content: "⌛ Challenge expiré. Reclique sur le bouton de vérification pour recommencer.",
        ephemeral: true,
      });
    }

    // On ne peut pas comparer l'emoji cliqué directement (le customId n'encode que
    // l'index du bouton dans SA rangée, propre à cette interaction précise) : on
    // relit l'emoji du bouton cliqué depuis le composant lui-même.
    const clickedEmoji = interaction.component?.emoji?.name;
    const isCorrect = clickedEmoji === challenge.correctEmoji;

    pendingChallenges.delete(key);

    if (isCorrect) {
      const guildConfig = await getGuildConfig(guildId).catch(() => null);
      const member = await guild.members.fetch(userId).catch(() => null);

      if (member && guildConfig?.unverifiedRoleId) {
        await member.roles.remove(guildConfig.unverifiedRoleId, "Lotus Verification Gate : vérifié avec succès").catch(() => null);
        if (guildConfig.verifiedRoleId) {
          await member.roles.add(guildConfig.verifiedRoleId, "Lotus Verification Gate : rôle membre vérifié").catch(() => null);
        }
      }

      await SecurityLog.create({
        guildId,
        type: "VERIFICATION_SUCCESS",
        executorId: userId,
        reason: "Challenge de vérification réussi",
        punishmentApplied: null,
      }).catch(() => null);

      return interaction.update({
        content: "✅ **Vérification réussie !** Tu as maintenant accès au serveur. Bienvenue 🎉",
        components: [],
      });
    }

    // --- Mauvaise réponse : on incrémente le compteur d'échecs ---
    const failCount = rateTracker.hit(guildId, userId, "verifyFail", 2 * 60_000);

    await SecurityLog.create({
      guildId,
      type: "VERIFICATION_FAIL",
      executorId: userId,
      reason: `Mauvaise réponse au challenge (échec n°${failCount})`,
      punishmentApplied: null,
    }).catch(() => null);

    if (failCount >= 5) {
      // Comportement typique d'un bot de raid qui clique au hasard en boucle :
      // on escalade en quarantaine automatique plutôt que de laisser retenter indéfiniment.
      rateTracker.reset(guildId, userId, "verifyFail");
      const guildConfig = await getGuildConfig(guildId).catch(() => null);

      await punish({
        guild,
        guildConfig,
        executorId: userId,
        actionType: "VERIFICATION_ABUSE",
        reason: "Échecs répétés au challenge de vérification (comportement typique d'un bot de raid)",
        details: { échecs: failCount },
        customSanction: "quarantine",
      });

      return interaction.update({
        content: "🚫 **Trop d'échecs.** Ton compte a été placé en quarantaine pour examen par le staff.",
        components: [],
      });
    }

    if (failCount >= 3) {
      // Verrouillage temporaire de 30s après 3 échecs, pour ralentir un éventuel bot
      pendingChallenges.set(`lock:${guildId}:${userId}`, { expiresAt: Date.now() + 30_000 });
    }

    return interaction.reply({
      content: `❌ Mauvaise réponse (${failCount}/5 avant quarantaine automatique). Reclique sur le bouton de vérification pour réessayer.`,
      ephemeral: true,
    });
  }
}

module.exports = { registerVerificationGate, postVerificationMessage, handleVerificationInteraction };
