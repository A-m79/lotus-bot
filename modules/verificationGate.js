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
const GuildConfig = require("../models/GuildConfig");
const rateTracker = require("../utils/rateTracker");

// Emoji pool for the challenge: on each attempt, 5 are drawn at
// random from this list, one is designated the "correct answer".
const EMOJI_POOL = [
  "🦊", "🐸", "🐢", "🦁", "🐼", "🐧", "🦉", "🐙",
  "🍇", "🍉", "🍋", "🍒", "🍓", "🥝", "🍍", "🥥",
  "⭐", "🔥", "💎", "🎯", "🎲", "🎈", "🧩", "🔑",
];

// In-memory state of ongoing challenges: `${guildId}:${userId}` -> { correctEmoji, expiresAt }
const pendingChallenges = new Map();
const CHALLENGE_TTL_MS = 60_000; // the challenge expires after 60s of inactivity

// Periodic cleanup of expired challenges
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
 * Applies the "Unverified" role to a new human member, if the gate is enabled.
 */
async function registerVerificationGate(client) {
  client.on("guildMemberAdd", async (member) => {
    if (member.user.bot) return;

    // Fix (leave/rejoin quarantine bypass): checked FIRST and read directly
    // from the database (never from configCache), so there is no possible
    // staleness window between a quarantine being applied and a member
    // rejoining. Discord wipes a member's roles on leave, so without this
    // check a quarantined member could simply leave and rejoin to be handed
    // the normal Unverified role again, pass the captcha, and fully escape
    // quarantine.
    const isQuarantined = await GuildConfig.exists({
      guildId: member.guild.id,
      quarantinedUserIds: member.id,
    }).catch(() => false);

    if (isQuarantined) {
      const guildConfigDoc = await GuildConfig.findOne({ guildId: member.guild.id }).lean().catch(() => null);
      let quarantineRoleId = guildConfigDoc?.quarantineRoleId;
      if (!quarantineRoleId) {
        const role = member.guild.roles.cache.find((r) => r.name === "Lotus Quarantine");
        quarantineRoleId = role?.id;
      }

      if (quarantineRoleId) {
        await member.roles
          .add(quarantineRoleId, "Lotus Verification Gate: member was already in quarantine before leaving")
          .catch(() => null);
      }

      await SecurityLog.create({
        guildId: member.guild.id,
        type: "QUARANTINE_BYPASS_ATTEMPT",
        executorId: member.id,
        reason: "Member left and rejoined while in quarantine (bypass attempt)",
        punishmentApplied: "RE_QUARANTINED",
      }).catch(() => null);

      return; // Skip the normal verification flow entirely
    }

    const guildConfig = await getGuildConfig(member.guild.id).catch(() => null);
    if (!guildConfig?.verificationEnabled || !guildConfig.unverifiedRoleId) return;

    const role = member.guild.roles.cache.get(guildConfig.unverifiedRoleId);
    if (!role) return;

    await member.roles.add(role, "Lotus Verification Gate: pending verification").catch(() => null);
  });

  // Automatically protects any NEW channel created after the initial /lotus-setup:
  // without this, a channel created afterwards would be visible by default to
  // unverified members (the gate would then only protect the channels that
  // existed at setup time).
  client.on("channelCreate", async (channel) => {
    if (!channel.guild || !channel.permissionOverwrites) return;

    const guildConfig = await getGuildConfig(channel.guild.id).catch(() => null);
    if (!guildConfig?.verificationEnabled || !guildConfig.unverifiedRoleId) return;

    // We don't touch the verification channel itself, nor anything under the
    // LOTUS SECURITY category (already protected by the category's @everyone deny).
    if (channel.id === guildConfig.verificationChannelId) return;
    const parent = channel.parent;
    if (parent && (parent.name.toLowerCase().includes("lotus") || parent.name.toLowerCase().includes("security"))) return;

    await channel.permissionOverwrites
      .edit(guildConfig.unverifiedRoleId, { ViewChannel: false }, { reason: "Lotus Verification Gate: automatic protection for new channels" })
      .catch(() => null);
  });

  console.log("[VerificationGate] Module loaded — entry verification gate active.");
}

/**
 * Sends the welcome message with the "Start Verification" button in the
 * verification channel. Called from /lotus-setup.
 * `force` = true to repost even if a message already exists (e.g. after a reset).
 */
async function postVerificationMessage(channel, force = false) {
  if (!force) {
    const pinned = await channel.messages.fetchPinned().catch(() => null);
    if (pinned && pinned.some((m) => m.author.id === channel.client.user.id)) {
      return; // Message already present, avoid duplicating
    }
  }

  const embed = new EmbedBuilder()
    .setTitle("🔐 Verification Required")
    .setColor("#8e5cff")
    .setDescription(
      "Welcome! To access the rest of the server, you must first confirm you're not a robot.\n\n" +
        "Click the button below, then follow the instructions shown (they are only visible to you)."
    )
    .setFooter({ text: "Lotus Security System • Anti-raid Verification" });

  const button = new ButtonBuilder()
    .setCustomId("lotus_verify_start")
    .setLabel("🔓 Start Verification")
    .setStyle(ButtonStyle.Success);

  const row = new ActionRowBuilder().addComponents(button);

  const msg = await channel.send({ embeds: [embed], components: [row] }).catch(() => null);
  if (msg) await msg.pin().catch(() => null);
  return msg;
}

/**
 * Entry point for all verification-related interactions
 * (start button + challenge answer buttons).
 */
async function handleVerificationInteraction(interaction) {
  if (!interaction.isButton()) return;

  const guild = interaction.guild;
  if (!guild) return;

  // --- Start button ---
  if (interaction.customId === "lotus_verify_start") {
    const guildConfig = await getGuildConfig(guild.id).catch(() => null);
    const member = interaction.member;

    if (!guildConfig?.unverifiedRoleId || !member.roles.cache.has(guildConfig.unverifiedRoleId)) {
      return interaction.reply({ content: "✅ You're already verified, nothing to do!", ephemeral: true });
    }

    // Anti-brute-force: checks if the user is temporarily locked out
    const lockKey = `${guild.id}:${interaction.user.id}`;
    const lock = pendingChallenges.get(`lock:${lockKey}`);
    if (lock && Date.now() < lock.expiresAt) {
      const remaining = Math.ceil((lock.expiresAt - Date.now()) / 1000);
      return interaction.reply({
        content: `⏳ Too many failed attempts. Try again in ${remaining}s.`,
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
      content: `🧩 **Click the following emoji to complete your verification:** ${correctEmoji}\n\n*(This challenge expires in 60 seconds.)*`,
      components: [row],
      ephemeral: true,
    });
  }

  // --- Answer buttons ---
  if (interaction.customId.startsWith("lotus_verify_answer_")) {
    const parts = interaction.customId.split("_");
    const guildId = parts[3];
    const userId = parts[4];
    const answerIdx = Number(parts[5]);

    // Defense: only the user who started the challenge can answer it
    if (interaction.user.id !== userId || guild.id !== guildId) {
      return interaction.reply({ content: "❌ This challenge doesn't belong to you.", ephemeral: true });
    }

    const key = `${guildId}:${userId}`;
    const challenge = pendingChallenges.get(key);

    if (!challenge || Date.now() > challenge.expiresAt) {
      pendingChallenges.delete(key);
      return interaction.reply({
        content: "⌛ Challenge expired. Click the verification button again to restart.",
        ephemeral: true,
      });
    }

    // We can't compare the clicked emoji directly (the customId only encodes
    // the button's index within ITS OWN row, specific to this interaction): we
    // read the clicked button's emoji back from the component itself.
    const clickedEmoji = interaction.component?.emoji?.name;
    const isCorrect = clickedEmoji === challenge.correctEmoji;

    pendingChallenges.delete(key);

    if (isCorrect) {
      const guildConfig = await getGuildConfig(guildId).catch(() => null);
      const member = await guild.members.fetch(userId).catch(() => null);

      if (member && guildConfig?.unverifiedRoleId) {
        await member.roles.remove(guildConfig.unverifiedRoleId, "Lotus Verification Gate: successfully verified").catch(() => null);
        if (guildConfig.verifiedRoleId) {
          await member.roles.add(guildConfig.verifiedRoleId, "Lotus Verification Gate: verified member role").catch(() => null);
        }
      }

      await SecurityLog.create({
        guildId,
        type: "VERIFICATION_SUCCESS",
        executorId: userId,
        reason: "Verification challenge passed",
        punishmentApplied: null,
      }).catch(() => null);

      return interaction.update({
        content: "✅ **Verification successful!** You now have access to the server. Welcome 🎉",
        components: [],
      });
    }

    // --- Wrong answer: increment the failure counter ---
    const failCount = rateTracker.hit(guildId, userId, "verifyFail", 2 * 60_000);

    await SecurityLog.create({
      guildId,
      type: "VERIFICATION_FAIL",
      executorId: userId,
      reason: `Wrong answer on the challenge (failure #${failCount})`,
      punishmentApplied: null,
    }).catch(() => null);

    if (failCount >= 5) {
      // Typical behavior of a raid bot clicking at random in a loop:
      // we escalate to automatic quarantine rather than allow infinite retries.
      rateTracker.reset(guildId, userId, "verifyFail");
      const guildConfig = await getGuildConfig(guildId).catch(() => null);

      await punish({
        guild,
        guildConfig,
        executorId: userId,
        actionType: "VERIFICATION_ABUSE",
        reason: "Repeated failures on the verification challenge (typical raid-bot behavior)",
        details: { failures: failCount },
        customSanction: "quarantine",
      });

      return interaction.update({
        content: "🚫 **Too many failures.** Your account has been placed in quarantine for staff review.",
        components: [],
      });
    }

    if (failCount >= 3) {
      // Temporary 30s lockout after 3 failures, to slow down a potential bot
      pendingChallenges.set(`lock:${guildId}:${userId}`, { expiresAt: Date.now() + 30_000 });
    }

    return interaction.reply({
      content: `❌ Wrong answer (${failCount}/5 before automatic quarantine). Click the verification button again to try again.`,
      ephemeral: true,
    });
  }
}

module.exports = { registerVerificationGate, postVerificationMessage, handleVerificationInteraction };
