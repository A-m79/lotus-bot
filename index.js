require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Partials, Collection } = require("discord.js");

const { connectDatabase } = require("./database/connect");
const { keepAlive } = require("./keepAlive");
const { getGuildConfig } = require("./utils/configCache");

const { registerAntiNuke } = require("./modules/antiNuke");
const { registerAntiRaid } = require("./modules/antiRaid");
const { registerAntiSpam } = require("./modules/antiSpam");
// NOTE : antiRoleNuke.js n'est plus enregistré. Sa logique (détection de création/
// suppression massive de rôles) a été fusionnée dans antiNuke.js pour éviter le
// double-tracking : les deux modules surveillaient roleDelete en parallèle avec des
// seuils et une whitelist différents, ce qui pouvait déclencher une double sanction.
// Le fichier modules/antiRoleNuke.js peut être supprimé du projet sans impact.
const { registerAltDetection } = require("./modules/altDetection");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration, // bans
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildWebhooks,
  ],
  partials: [Partials.GuildMember, Partials.User],
});

// --- Chargement des commandes ---
client.commands = new Collection();
const commandsPath = path.join(__dirname, "commands");
const commandFiles = fs.readdirSync(commandsPath).filter((f) => f.endsWith(".js"));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  client.commands.set(command.data.name, command);
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  // --- Restriction stricte Whitelist / Owners ---
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

client.once("ready", () => {
  console.log(`[Lotus] Connecté en tant que ${client.user.tag}.`);
  client.user.setActivity("la sécurité du serveur 🛡️", { type: 3 }); // Watching
});

async function main() {
  await connectDatabase();

  // Modules de protection
  registerAntiNuke(client);
  registerAntiRaid(client);
  registerAntiSpam(client);
  registerAltDetection(client);

  await client.login(process.env.DISCORD_TOKEN);

  // Serveur web pour garder le process actif sur Render (ping via UptimeRobot)
  keepAlive(client);
}

main().catch((err) => {
  console.error("[Lotus] Erreur fatale au démarrage:", err);
  process.exit(1);
});
