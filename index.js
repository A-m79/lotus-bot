require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Partials, Collection, PermissionFlagsBits, GuildMFALevel, ButtonBuilder, ActionRowBuilder, ButtonStyle } = require("discord.js");

const { connectDatabase } = require("./database/connect");
const { keepAlive } = require("./keepAlive");
const { getGuildConfig } = require("./utils/configCache");
const { handleRestoreRolesButton } = require("./utils/logProtector");
const { handleRestoreAdminButton, registerQuarantineSync } = require("./modules/punisher");
const { takeBackup } = require("./utils/backupEngine");
const config = require("./config/config");
const GuildConfig = require("./models/GuildConfig");

const { registerAntiNuke } = require("./modules/antiNuke");
const { registerAntiRaid } = require("./modules/antiRaid");
const { registerAntiSpam } = require("./modules/antiSpam");
const { registerAltDetection } = require("./modules/altDetection");
const { registerVerificationGate, handleVerificationInteraction } = require("./modules/verificationGate");
const { registerInviteTracker } = require("./modules/inviteTracker");
const { registerPhishingDetection } = require("./modules/phishingDetection");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildEmojisAndStickers,
    GatewayIntentBits.GuildInvites,
  ],
  partials: [Partials.GuildMember, Partials.User],
});

// Loading commands
client.commands = new Collection();
const commandsPath = path.join(__dirname, "commands");
const commandFiles = fs.readdirSync(commandsPath).filter((f) => f.endsWith(".js"));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  client.commands.set(command.data.name, command);
}

// Interactions: Slash Commands + Buttons
client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton() && interaction.customId.startsWith("restore_roles_")) {
    return handleRestoreRolesButton(interaction);
  }

  if (interaction.isButton() && interaction.customId.startsWith("restore_admin_")) {
    return handleRestoreAdminButton(interaction);
  }

  if (interaction.isButton() && interaction.customId.startsWith("lotus_verify")) {
    return handleVerificationInteraction(interaction);
  }

  if (interaction.isButton() && interaction.customId.startsWith("disable_2fa_reminder_")) {
    return handleDisable2FAReminderButton(interaction);
  }

  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  if (interaction.guildId) {
    const guildConfig = await getGuildConfig(interaction.guildId).catch(() => null);
    const isOwner = interaction.user.id === interaction.guild?.ownerId;
    const isBotOwner = process.env.OWNER_ID && interaction.user.id === process.env.OWNER_ID;
    const isWhitelisted =
      (guildConfig?.whitelist?.includes(interaction.user.id) ?? false) ||
      (guildConfig?.whitelistRoles?.some((roleId) => interaction.member?.roles.cache.has(roleId)) ?? false);

    if (!isOwner && !isBotOwner && !isWhitelisted) {
      return interaction.reply({
        content: "❌ Only members on the **Whitelist** can run Lotus commands.",
        ephemeral: true,
      });
    }
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`[Command] Error on /${interaction.commandName}:`, err);
    const payload = { content: "❌ An error occurred while executing this command.", ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => null);
    } else {
      await interaction.reply(payload).catch(() => null);
    }
  }
});

/**
 * Handles the "Stop these reminders" button attached to the 2FA reminder DM.
 * The button is only clickable by the DM recipient (Discord enforces that
 * naturally for bot DMs), so no extra owner check is needed here.
 */
async function handleDisable2FAReminderButton(interaction) {
  const guildId = interaction.customId.replace("disable_2fa_reminder_", "");
  const guild = client.guilds.cache.get(guildId);

  await GuildConfig.findOneAndUpdate(
    { guildId },
    { $set: { twoFactorReminderDisabled: true } }
  ).catch(() => null);

  return interaction.update({
    content:
      `🔕 **Reminders stopped${guild ? ` for ${guild.name}` : ""}.**\n\n` +
      `You won't receive this 2FA reminder again for this server. You can still enable ` +
      `Server Settings → Moderation → Two-Factor Authentication at any time if you change your mind.`,
    embeds: [],
    components: [],
  }).catch(() => null);
}

function setupCronTasks() {
  // Auto backup every 24h
  setInterval(async () => {
    console.log("[AUTO-BACKUP] Starting global automatic backup...");
    for (const guild of client.guilds.cache.values()) {
      await takeBackup(guild).catch((e) => console.error(`[AUTO-BACKUP] Failed on ${guild.name}:`, e.message));
    }
  }, config.AUTO_BACKUP_INTERVAL_MS);

  // Self-diagnostic of Lotus's perms + 2FA reminder every 15 minutes
  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));

      // 1. Lotus admin perms
      if (me && !me.permissions.has(PermissionFlagsBits.Administrator)) {
        const owner = await guild.fetchOwner().catch(() => null);
        if (owner) {
          await owner.send(
            `⚠️ **Diagnostic Reminder:** Lotus no longer has Administrator permissions on **${guild.name}**.`
          ).catch(() => null);
        }
      }

      // 2. Mandatory 2FA reminder for moderation (native Discord setting).
      // guild.mfaLevel === 0 (None) means the server does NOT require 2FA
      // to perform sensitive moderation actions (ban, kick, channel
      // deletion...) — a simple compromised password is then enough for an
      // attacker to act directly as a moderator/admin. This setting is free
      // and native to Discord; Lotus just checks that it's enabled and
      // sends a reminder once every 24h max if it isn't.
      //
      // Fix (reminder spammed on restart): the "last sent" timestamp used to
      // live in an in-memory Map, wiped on every process restart (redeploy,
      // crash, free-tier sleep/wake) — a restart within the 24h window meant
      // the reminder fired again immediately even though one had just gone
      // out. It's now read from and written to MongoDB via a single atomic
      // findOneAndUpdate: the update only matches (and only then do we send
      // the DM) if last2FAWarningAt is null or older than 24h, so two
      // overlapping runs of this interval can never both pass the check.
      if (guild.mfaLevel === GuildMFALevel.None) {
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const staleConfig = await GuildConfig.findOneAndUpdate(
          {
            guildId: guild.id,
            twoFactorReminderDisabled: { $ne: true },
            $or: [{ last2FAWarningAt: null }, { last2FAWarningAt: { $lte: cutoff } }],
          },
          { $set: { last2FAWarningAt: new Date() } }
        ).catch(() => null);

        if (staleConfig) {
          const owner = await guild.fetchOwner().catch(() => null);
          if (owner) {
            const disableButton = new ButtonBuilder()
              .setCustomId(`disable_2fa_reminder_${guild.id}`)
              .setLabel("🔕 Stop these reminders")
              .setStyle(ButtonStyle.Secondary);
            const row = new ActionRowBuilder().addComponents(disableButton);

            await owner.send({
              content:
                `🔐 **Security reminder — ${guild.name}**\n\n` +
                  `2FA is not required for moderation actions on this server ` +
                  `(Server Settings → Moderation → Two-Factor Authentication). ` +
                  `Without it, a simple stolen password is enough for an attacker to act ` +
                  `as a moderator/admin, even without accessing the full Discord account.\n\n` +
                  `This is a free, native Discord setting (no need for Lotus) — ` +
                  `enable it to close this gap.`,
              components: [row],
            }).catch(() => null);
          }
        }
      }
    }
  }, config.SELF_DIAGNOSTIC_INTERVAL_MS);
}

client.once("ready", () => {
  console.log(`[Lotus] Logged in as ${client.user.tag}.`);
  client.user.setActivity("server security 🛡️", { type: 3 });
  setupCronTasks();
});

// 🔧 TEMPORARY DEBUG — remove once the login-hang issue is diagnosed.
// discord.js surfaces some low-level connection problems as EVENTS rather
// than thrown/rejected errors, so a bare `await client.login()` can hang
// silently without ever showing up in a try/catch or in main().catch().
client.on("error", (err) => {
  console.error("[DEBUG client] 'error' event:", err);
});
client.on("shardError", (err, shardId) => {
  console.error(`[DEBUG client] 'shardError' event on shard ${shardId}:`, err);
});
client.on("warn", (info) => {
  console.warn("[DEBUG client] 'warn' event:", info);
});

async function main() {
  await connectDatabase();

  registerAntiNuke(client);
  registerAntiRaid(client);
  registerAntiSpam(client);
  registerAltDetection(client);
  registerVerificationGate(client);
  registerInviteTracker(client);
  registerPhishingDetection(client);
  registerQuarantineSync(client);

  // 🔧 TEMPORARY DEBUG — remove once the login-hang issue is diagnosed.
  console.log("[DEBUG main] About to call client.login()...");
  await client.login(process.env.DISCORD_TOKEN);
  console.log("[DEBUG main] client.login() resolved successfully.");

  keepAlive(client);
}

main().catch((err) => {
  console.error("[Lotus] Fatal error on startup:", err);
  process.exit(1);
});