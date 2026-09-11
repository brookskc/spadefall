// telemetry.js — bounded, anonymous production health signals.
// There is deliberately no session/device/player/room identifier and no raw
// text field.  The server validates the same allowlist again before storage.

export const TELEMETRY_VERSION = 1;
export const TELEMETRY_ENDPOINT = 'https://spadefall-turn.spadefall.workers.dev/diagnostics';
export const TELEMETRY_LIMIT = 12;
export const TELEMETRY_FLUSH_AT = 8;

const TYPES = Object.freeze({
  connection_failure: {
    stage: ['signaling', 'ice', 'turn', 'welcome', 'reconnect', 'other'],
    reason: ['timeout', 'down', 'unavailable', 'closed', 'protocol', 'network', 'other'],
    relay: ['yes', 'no', 'unknown'],
  },
  crash: { kind: ['error', 'rejection', 'other'] },
  frame_budget: { tier: ['medium', 'high'], result: ['pass', 'fail'] },
  migration: { outcome: ['success', 'failure'], reason: ['timeout', 'closed', 'protocol', 'network', 'other'] },
  match_abandon: { reason: ['pagehide', 'network', 'menu', 'other'] },
  // Product funnel only: a bounded milestone and a coarse elapsed bucket.
  // It deliberately carries no identifier, mode, map, room, input detail,
  // position, or free text.
  funnel: { step: ['opened', 'play_selected', 'playable_match', 'joined',
    'first_spawn', 'first_shoot', 'first_dig', 'first_place', 'first_ping',
    'objective', 'first_death', 'match_complete', 'next_match'], },
});

const bucketSeconds = value => {
  const seconds = Math.max(0, Number(value) || 0);
  return seconds < 30 ? 0 : seconds < 120 ? 1 : seconds < 300 ? 2 : seconds < 600 ? 3 : 4;
};

export function errorFingerprint(value) {
  const normalized = String(value?.stack ?? value?.name ?? value ?? 'unknown')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/:\d+:\d+/g, ':#:#').slice(0, 1000);
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function sanitizeTelemetryEvent(type, data = {}) {
  const schema = TYPES[type];
  if (!schema) return null;
  const out = { type };
  for (const [field, allowed] of Object.entries(schema)) {
    const value = String(data[field]);
    if (!allowed.includes(value)) return null;
    out[field] = value;
  }
  if (type === 'crash') {
    if (!/^[a-f0-9]{8}$/.test(data.fingerprint)) return null;
    out.fingerprint = data.fingerprint;
  }
  if (type === 'frame_budget') {
    out.frame = Math.max(0, Math.min(4, Number(data.frame) | 0));
    out.long = Math.max(0, Math.min(4, Number(data.long) | 0));
  }
  if (type === 'match_abandon') out.time = bucketSeconds(data.seconds);
  if (type === 'funnel') out.time = bucketSeconds(data.seconds);
  return out;
}

export function telemetryEnvelope(build, events) {
  const clean = (events ?? []).slice(0, TELEMETRY_LIMIT)
    .map(event => sanitizeTelemetryEvent(event?.type, event)).filter(Boolean);
  return { v: TELEMETRY_VERSION, build: String(build ?? 'unknown').slice(0, 24), events: clean };
}

export class ProductionTelemetry {
  constructor({ build = 'unknown', endpoint = TELEMETRY_ENDPOINT,
    sample = Math.random() < 0.1, fetcher = globalThis.fetch } = {}) {
    this.build = build;
    this.endpoint = endpoint;
    this.sample = !!sample;
    this.fetcher = fetcher;
    this.events = [];
  }

  record(type, data = {}, { always = false } = {}) {
    if (!this.sample && !always) return false;
    const event = sanitizeTelemetryEvent(type, data);
    if (!event || this.events.length >= TELEMETRY_LIMIT) return false;
    this.events.push(event);
    // Never silently strand a full ring. Milestones are safe to send and this
    // keeps a long menu/match from losing its final funnel observations.
    if (this.events.length >= TELEMETRY_FLUSH_AT) this.flush();
    return true;
  }

  flush({ beacon = globalThis.navigator?.sendBeacon?.bind(globalThis.navigator) } = {}) {
    if (!this.events.length) return false;
    const body = JSON.stringify(telemetryEnvelope(this.build, this.events));
    this.events.length = 0;
    if (body.length > 4096) return false;
    if (beacon) return beacon(this.endpoint,
      new Blob([body], { type: 'application/json' }));
    if (typeof this.fetcher === 'function') {
      void this.fetcher(this.endpoint, { method: 'POST', headers: {
        'content-type': 'application/json',
      }, body, keepalive: true }).catch(() => {});
      return true;
    }
    return false;
  }
}
