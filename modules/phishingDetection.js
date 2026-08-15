/**
 * Détection des liens de phishing/scam Discord, Steam, crypto, etc.
 *
 * S'appuie sur la base communautaire "Discord-AntiScam/scam-links"
 * (https://github.com/Discord-AntiScam/scam-links), activement maintenue,
 * qui recense plus de 30 000 domaines confirmés utilisés pour du vol de
 * compte/token (faux "Nitro gratuit", faux support Steam, faux airdrops
 * crypto, faux bots de vérification, etc.).
 *
 * La liste est rechargée toutes les 6h en mémoire (Set pour un lookup en
 * O(1)) plutôt que de la requêter à chaque message — un scam ne devient
 * exploitable qu'une fois public de toute façon, donc un léger délai de
 * propagation n'a aucun impact réel sur la protection.
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
      console.log(`[PhishingDetection] Liste rechargée : ${scamDomains.size} domaines connus.`);
    }
  } catch (err) {
    // En cas d'échec (GitHub down, réseau...), on garde l'ancienne liste en
    // mémoire plutôt que de se retrouver avec une protection vide.
    console.error("[PhishingDetection] Échec du rechargement de la liste :", err.message);
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
      // URL malformée dans le message, on l'ignore simplement
    }
  }
  return hostnames;
}

/**
 * Vérifie le domaine exact ET ses domaines parents (ex: si "scam.com" est
 * listé, "sub.scam.com" doit aussi être détecté comme malveillant).
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
    if (!scamDomains.size) return; // liste pas encore chargée au démarrage

    const guildConfig = await getGuildConfig(message.guild.id).catch(() => null);
    if (guildConfig?.antiSpamEnabled === false) return;

    const hostnames = extractHostnames(message.content);
    if (!hostnames.length) return;

    const matched = hostnames.find((h) => isKnownScamDomain(h));
    if (!matched) return;

    // Suppression immédiate du message avant même d'appliquer la sanction,
    // pour limiter au maximum le temps où le lien reste cliquable par d'autres.
    await message.delete().catch(() => null);

    await punish({
      guild: message.guild,
      guildConfig,
      executorId: message.author.id,
      actionType: "PHISHING_LINK",
      reason: `Lien de phishing/scam détecté (\`${matched}\`) — base Discord-AntiScam`,
      details: {
        Domaine: matched,
        Salon: `#${message.channel.name}`,
      },
      // Toujours la quarantaine, même pour un admin ou un compte whitelisté :
      // un lien confirmé malveillant n'a pas droit à la tolérance habituelle,
      // c'est justement le signe le plus fort qu'un compte est compromis.
      customSanction: "quarantine",
    });
  });

  console.log("[PhishingDetection] Module de détection des liens de phishing actif.");
}

module.exports = { registerPhishingDetection };
