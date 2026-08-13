require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Partials, Collection, PermissionFlagsBits } = require("discord.js");

const { connectDatabase } = require("./database/connect");
const { keepAlive } = require("./keepAlive");
const { getGuildConfig } = require("./utils/configCache");
const { handleRestoreRolesButton } = require("./utils/logProtector");
const { takeBackup } = require("./utils/backupEngine");
const config = require("./config/config");

const { registerAntiNuke } = require("./modules/antiNuke");
const { registerAntiRaid } = require("./modules/antiRaid");
const { registerAntiSpam } = require("./modules/antiSpam");
const { registerAltDetection } = require("./modules/altDetection");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildEmojisAndStickers,
  ],
  partials: [Partials.GuildMember, Partials.User],
});

// Chargement des commandes
client.commands = new Collection();
const commandsPath = path.join(__dirname, "commands");
const commandFiles = fs.readdirSync(commandsPath).filter((f) => f.endsWith(".js"));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  client.commands.set(command.data.name, command);
}

// Interactions : Commandes Slash + Boutons
client.on("interactionCreate", async (interaction) => {
  // 1. Bouton de rétablissement de rôles (logProtector)
  if (interaction.isButton() && interaction.customId.startsWith("restore_roles_")) {
    return handleRestoreRolesButton(interaction);
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
        content: "❌ Seuls les membres figurant sur la **Whitelist** peuvent exécuter les commandes Lotus.",
        ephemeral: true,
      });
    }
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`[Command] Erreur sur /${interaction.commandName}:`, err);
    const payload = { content: "❌ Une erreur est survenue lors de l'exécution.", ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => null);
    } else {
      await interaction.reply(payload).catch(() => null);
    }
  }
});

// Tâches Périodiques (Backup 24h & Diagnostic)
function setupCronTasks() {
  // Backup auto toutes les 24h
  setInterval(async () => {
    console.log("[AUTO-BACKUP] Lancement de la sauvegarde automatique globale...");
    for (const guild of client.guilds.cache.values()) {
      await takeBackup(guild).catch((e) => console.error(`[AUTO-BACKUP] Échec sur ${guild.name}:`, e.message));
    }
  }, config.AUTO_BACKUP_INTERVAL_MS);

  // Auto-diagnostic des perms de Lotus toutes les 15 minutes
  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
      if (me && !me.permissions.has(PermissionFlagsBits.Administrator)) {
        const owner = await guild.fetchOwner().catch(() => null);
        if (owner) {
          await owner.send(
            `⚠️ **Rappel Diagnostic :** Lotus n'a plus les permissions Administrateur sur **${guild.name}**.`
          ).catch(() => null);
        }
      }
    }
  }, config.SELF_DIAGNOSTIC_INTERVAL_MS);
}

client.once("ready", () => {
  console.log(`[Lotus] Connecté en tant que ${client.user.tag}.`);
  client.user.setActivity("la sécurité du serveur 🛡️", { type: 3 });
  setupCronTasks();
});

async function main() {
  await connectDatabase();

  registerAntiNuke(client);
  registerAntiRaid(client);
  registerAntiSpam(client);
  registerAltDetection(client);

  await client.login(process.env.DISCORD_TOKEN);
  keepAlive(client);
}

main().catch((err) => {
  console.error("[Lotus] Erreur fatale au démarrage:", err);
  process.exit(1);
});