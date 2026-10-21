// Count browsers that actually enter play, separately from gameplay summaries.
export const PLAYER_ID_KEY = 'tos.analytics-player';
export const PLAYER_ID_TTL = 90 * 24 * 60 * 60 * 1000;
export const PLAYERS_ENDPOINT = 'https://spadefall-turn.spadefall.workers.dev/players';
const validId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
const browserStorage = () => {
  try { return globalThis.localStorage; } catch { return null; }
};

export function validPlayerEvent(value) {
  return !!(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 3 && value.v === 1
    && ['players-v1', 'qa-players'].includes(value.build) && validId(value.playerId));
}

export class AnonymousPlayers {
  constructor({ enabled = true, storage = browserStorage(), now = Date.now,
    random = () => globalThis.crypto.getRandomValues(new Uint8Array(16)),
    fetcher = globalThis.fetch,
    beacon = globalThis.navigator?.sendBeacon?.bind(globalThis.navigator) } = {}) {
    this.storage = storage; this.now = now; this.random = random;
    this.fetcher = fetcher; this.beacon = beacon;
    this.setEnabled(enabled);
  }
  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (!this.enabled) {
      try { this.storage?.removeItem(PLAYER_ID_KEY); } catch { /* best effort */ }
    }
  }
  identity() {
    if (!this.enabled || !this.storage) return null;
    try {
      const now = this.now();
      let stored;
      try { stored = JSON.parse(this.storage.getItem(PLAYER_ID_KEY)); } catch { /* reset invalid data */ }
      if (validId(stored?.id) && Number.isFinite(stored?.createdAt)
          && stored.createdAt <= now && now - stored.createdAt < PLAYER_ID_TTL) return stored.id;
      const bytes = this.random();
      if (bytes.length !== 16) return null;
      const id = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
      if (!validId(id)) return null;
      this.storage.setItem(PLAYER_ID_KEY, JSON.stringify({ id, createdAt: now }));
      // Storage must persist: don't inflate browser counts with temporary IDs.
      return JSON.parse(this.storage.getItem(PLAYER_ID_KEY))?.id === id ? id : null;
    } catch { return null; }
  }
  played() {
    const playerId = this.identity();
    if (!playerId) return false;
    const body = JSON.stringify({ v: 1, build: 'players-v1', playerId });
    try {
      if (this.beacon?.(PLAYERS_ENDPOINT, new Blob([body], { type: 'application/json' }))) return true;
      if (typeof this.fetcher !== 'function') return false;
      void this.fetcher(PLAYERS_ENDPOINT, { method: 'POST', headers: {
        'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
      return true;
    } catch { return false; }
  }
}
