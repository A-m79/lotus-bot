/**
 * Detection of Discord/Steam/crypto phishing/scam links, etc.
 *
 * Relies on the "Discord-AntiScam/scam-links" community database
 * (https://github.com/Discord-AntiScam/scam-links), actively maintained,
 * which tracks over 30,000 confirmed domains used for account/token theft
 * (fake "free Nitro", fake Steam support, fake crypto airdrops, fake
 * verification bots, etc.).
 *
 * The list is reloaded into memory every 6h (a Set for O(1) lookup) rather
 * than being queried on every message — a scam only becomes exploitable
 * once it's public anyway, so a slight propagation delay has no real
 * impact on protection.
 */

const { punish } = require("./punisher");
const { getGuildConfig } = require("../utils/configCache");

const LIST_URL = "https://raw.githubusercontent.com/Discord-AntiScam/scam-links/main/list.json";
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

let scamDomains = new Set();

async function refreshList() {
  try {
    const res = await fetch(LIST_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (Array.isArray(data) && data.length > 0) {
      scamDomains = new Set(data.map((d) => String(d).toLowerCase()));
      console.log(`[PhishingDetection] List reloaded: ${scamDomains.size} known domains.`);
    }
  } catch (err) {
    // On failure (GitHub down, network issue...), keep the previous list in
    // memory rather than ending up with no protection at all.
    console.error("[PhishingDetection] Failed to reload the list:", err.message);
  }
}

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

function extractHostnames(content) {
  const hostnames = [];
  const matches = content.match(URL_REGEX) || [];
  for (const match of matches) {
    try {
      hostnames.push(new URL(match).hostname.toLowerCase());
    } catch {
      // Malformed URL in the message, simply ignore it
    }
  }
  return hostnames;
}

/**
 * Checks the exact domain AND its parent domains (e.g. if "scam.com" is
 * listed, "sub.scam.com" must also be detected as malicious).
 */
function isKnownScamDomain(hostname) {
  if (scamDomains.has(hostname)) return true;

  const parts = hostname.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    if (scamDomains.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

function registerPhishingDetection(client) {
  refreshList();
  setInterval(refreshList, REFRESH_INTERVAL_MS);

  client.on("messageCreate", async (message) => {
    if (!message.guild || message.author.bot) return;
    if (!scamDomains.size) return; // list not loaded yet at startup

    const guildConfig = await getGuildConfig(message.guild.id).catch(() => null);
    if (guildConfig?.antiSpamEnabled === false) return;

    const hostnames = extractHostnames(message.content);
    if (!hostnames.length) return;

    const matched = hostnames.find((h) => isKnownScamDomain(h));
    if (!matched) return;

    // Delete the message immediately, before even applying the sanction,
    // to minimize the time the link stays clickable by others.
    await message.delete().catch(() => null);

    await punish({
      guild: message.guild,
      guildConfig,
      executorId: message.author.id,
      actionType: "PHISHING_LINK",
      reason: `Phishing/scam link detected (\`${matched}\`) — Discord-AntiScam database`,
      details: {
        Domain: matched,
        Channel: `#${message.channel.name}`,
      },
      // Always quarantine, even for an admin or a whitelisted account:
      // a confirmed malicious link doesn't get the usual tolerance — it's
      // precisely the strongest signal that an account is compromised.
      customSanction: "quarantine",
    });
  });

  console.log("[PhishingDetection] Phishing link detection module active.");
}

module.exports = { registerPhishingDetection };