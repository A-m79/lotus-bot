require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Partials, Collection, PermissionFlagsBits, GuildMFALevel } = require("discord.js");

const { connectDatabase } = require("./database/connect");
const { keepAlive } = require("./keepAlive");
const { getGuildConfig } = require("./utils/configCache");
const { handleRestoreRolesButton } = require("./utils/logProtector");
const { handleRestoreAdminButton, registerQuarantineSync } = require("./modules/punisher");
const { takeBackup } = require("./utils/backupEngine");
const config = require("./config/config");

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

  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  if (interaction.guildId) {
    const guildConfig = await getGuildConfig(interaction.guildId).catch(() => null);
    const isOwner = interaction.user.id === interaction.guild?.ownerId;
    const isBotOwner = process.env.OWNER_ID && interaction.user.id === process.env.OWNER_ID;
    const isWhitelisted = guildConfig?.whitelist?.includes(interaction.user.id);

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

// Last 2FA alert sent per server, to avoid spamming the owner (max 1x/24h)
const last2FAWarning = new Map();

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
      if (guild.mfaLevel === GuildMFALevel.None) {
        const lastWarn = last2FAWarning.get(guild.id) || 0;
        if (Date.now() - lastWarn > 24 * 60 * 60 * 1000) {
          last2FAWarning.set(guild.id, Date.now());
          const owner = await guild.fetchOwner().catch(() => null);
          if (owner) {
            await owner.send(
              `🔐 **Security reminder — ${guild.name}**\n\n` +
                `2FA is not required for moderation actions on this server ` +
                `(Server Settings → Moderation → Two-Factor Authentication). ` +
                `Without it, a simple stolen password is enough for an attacker to act ` +
                `as a moderator/admin, even without accessing the full Discord account.\n\n` +
                `This is a free, native Discord setting (no need for Lotus) — ` +
                `enable it to close this gap.`
            ).catch(() => null);
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

async function main() {
  await connectDatabase();

  registerAntiNuke(client);
  registerAntiRaid(client);
  registerAntiSpam(client);
  registerAltDetection(client);
  registerVerificationGate(client);
  registerInviteTracker(client);
  registerPhishingDetection(client);
  // Fix (leave/rejoin quarantine bypass): keeps GuildConfig.quarantinedUserIds
  // in sync whenever staff manually releases a member from the Lotus
  // Quarantine role, so they aren't stuck re-quarantined forever after being pardoned.
  registerQuarantineSync(client);

  await client.login(process.env.DISCORD_TOKEN);
  keepAlive(client);
}

main().catch((err) => {
  console.error("[Lotus] Fatal error on startup:", err);
  process.exit(1);
});
