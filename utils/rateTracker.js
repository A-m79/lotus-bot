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
   * Records an occurrence and returns the number of occurrences within the
   * given window.
   *
   * Bug fixed (sustained/% checks permanently under-reporting): this used
   * to filter the STORED array down to the caller's own `windowMs` before
   * saving it back — since the only caller of hit() in the codebase passes
   * the short burst window (10s), every single hit() call was silently
   * truncating the shared history down to 10 seconds, no matter how long a
   * window some OTHER function (count(), for the 90s sustained check) might
   * need to read later. In practice this meant count(sustainedWindowMs)
   * could never see anything older than ~10s, because hit() had already
   * erased it from storage on its very next call — the sustained/paced and
   * percent-based checks could never accumulate past whatever the short
   * window's steady-state count happened to be, making them functionally
   * dead for any burst spread across more than ~10 seconds.
   *
   * Fix: storage now always retains history up to the LONGEST window any
   * caller might need (the sustained window, from config), regardless of
   * the short windowMs passed to this specific call. The count returned to
   * THIS caller is still correctly scoped to their own windowMs — only the
   * persisted data keeps the longer history alive for other callers.
   */
  hit(guildId, userId, actionType, windowMs) {
    const key = this._key(guildId, userId, actionType);
    const now = Date.now();
    const timestamps = this.store.get(key) || [];

    const retentionMs = Math.max(windowMs, config.ANTINUKE_SUSTAINED_WINDOW_MS || 120_000);
    const retained = timestamps.filter((t) => now - t <= retentionMs);
    retained.push(now);

    this.store.set(key, retained);

    return retained.filter((t) => now - t <= windowMs).length;
  }

  /**
   * Fix (paced/slow nuke detection): read-only variant of hit() — does NOT
   * push a new timestamp, it just counts how many already-recorded
   * timestamps fall within the given window. This lets a single event
   * (one call to hit() for the short burst window) also be checked against
   * a second, longer window (e.g. 90s) to catch someone deliberately
   * pacing their actions just under the short-window threshold (e.g.
   * deleting channels one by one with a few seconds of confirmation delay
   * between each, which never crosses a 10s-window threshold even though
   * dozens get deleted over a couple of minutes). Relies on hit() now
   * retaining enough history for this to actually see it (see fix above).
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
   * silently wipe timestamps that count() still needs to check the 90s
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