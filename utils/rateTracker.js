/**
 * Tracker en mémoire (Map) : compte les occurrences d'un type d'action
 * par utilisateur et par serveur, sur une fenêtre de temps glissante.
 *
 * Structure interne :
 * Map<guildId:userId:actionType, number[]> -> timestamps des actions
 *
 * En mémoire = ultra rapide (pas de round-trip DB à chaque event Discord,
 * ce qui peut arriver plusieurs fois par seconde pendant un vrai nuke).
 * Si le process redémarre, les compteurs se reset : acceptable, un nuke
 * se joue en secondes donc l'historique long terme est dans SecurityLog (Mongo).
 */
class RateTracker {
  constructor() {
    this.store = new Map();
  }

  _key(guildId, userId, actionType) {
    return `${guildId}:${userId}:${actionType}`;
  }

  /**
   * Enregistre une occurrence et retourne le nombre d'occurrences
   * dans la fenêtre de temps donnée.
   */
  hit(guildId, userId, actionType, windowMs) {
    const key = this._key(guildId, userId, actionType);
    const now = Date.now();
    const timestamps = this.store.get(key) || [];

    const recent = timestamps.filter((t) => now - t <= windowMs);
    recent.push(now);

    this.store.set(key, recent);
    return recent.length;
  }

  /** Reset le compteur pour un user/action donné (après sanction, pour éviter double-punish) */
  reset(guildId, userId, actionType) {
    this.store.delete(this._key(guildId, userId, actionType));
  }

  /** Nettoyage périodique pour éviter que la Map grossisse indéfiniment */
  cleanup(maxAgeMs = 60_000) {
    const now = Date.now();
    for (const [key, timestamps] of this.store.entries()) {
      const recent = timestamps.filter((t) => now - t <= maxAgeMs);
      if (recent.length === 0) {
        this.store.delete(key);
      } else {
        this.store.set(key, recent);
      }
    }
  }
}

// Singleton partagé par tout le bot
const rateTracker = new RateTracker();

// Nettoyage toutes les minutes
setInterval(() => rateTracker.cleanup(), 60_000);

module.exports = rateTracker;
