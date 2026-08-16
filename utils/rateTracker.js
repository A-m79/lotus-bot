const config = require("../config/config");

/**
 * In-memory tracker (Map): counts occurrences of an action type
 * per user and per server, over a sliding time window.
 *
 * Internal structure:
 * Map<guildId:userId:actionType, number[]> -> action timestamps
 *
 * In-memory = ultra fast (no DB round-trip on every Discord event,
 * which can happen several times per second during an actual nuke).
 * If the process restarts, the counters reset: acceptable, since a nuke
 * plays out in seconds so long-term history lives in SecurityLog (Mongo).
 */
class RateTracker {
  constructor() {
    this.store = new Map();
  }

  _key(guildId, userId, actionType) {
    return `${guildId}:${userId}:${actionType}`;
  }

  /**
   * Records an occurrence and returns the number of occurrences
   * within the given time window.
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

  /**
   * Fix (paced/slow nuke detection): read-only variant of hit() — does NOT
   * push a new timestamp, it just counts how many already-recorded
   * timestamps fall within the given window. This lets a single event
   * (one call to hit() for the short burst window) also be checked against
   * a second, longer window (e.g. 2 minutes) to catch someone deliberately
   * pacing their actions just under the short-window threshold (e.g.
   * deleting channels one by one with a few seconds of confirmation delay
   * between each, which never crosses a 10s-window threshold even though
   * dozens get deleted over a couple of minutes).
   */
  count(guildId, userId, actionType, windowMs) {
    const key = this._key(guildId, userId, actionType);
    const now = Date.now();
    const timestamps = this.store.get(key) || [];
    return timestamps.filter((t) => now - t <= windowMs).length;
  }

  /** Resets the counter for a given user/action (after a sanction, to avoid double-punishing) */
  reset(guildId, userId, actionType) {
    this.store.delete(this._key(guildId, userId, actionType));
  }

  /**
   * Periodic cleanup to prevent the Map from growing indefinitely.
   * Fix (paced/slow nuke detection): default bumped from 60s to cover the
   * sustained (long) detection window with margin — otherwise this would
   * silently wipe timestamps that count() still needs to check the 2-minute
   * window, making the sustained check always under-report.
   */
  cleanup(maxAgeMs = (config.ANTINUKE_SUSTAINED_WINDOW_MS || 120_000) + 10_000) {
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

// Shared singleton across the whole bot
const rateTracker = new RateTracker();

// Cleanup every minute
setInterval(() => rateTracker.cleanup(), 60_000);

module.exports = rateTracker;
