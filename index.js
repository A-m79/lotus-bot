require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Partials, Collection } = require("discord.js");

const { connectDatabase } = require("./database/connect");
const { keepAlive } = require("./keepAlive");
const { registerAntiNuke } = require("./modules/antiNuke");
const { registerAntiRaid } = require("./modules/antiRaid");
const { registerAntiSpam } = require("./modules/antiSpam");
const { registerAntiRoleNuke } = require("./modules/antiRoleNuke");

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
  registerAntiRoleNuke(client);

  await client.login(process.env.DISCORD_TOKEN);

  // Serveur web pour garder le process actif sur Render (ping via UptimeRobot)
  keepAlive(client);
}

main().catch((err) => {
  console.error("[Lotus] Erreur fatale au démarrage:", err);
  process.exit(1);
});