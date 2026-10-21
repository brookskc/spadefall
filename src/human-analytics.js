// One anonymous local-human summary per played round. Never receives bots,
// names, chat, positions, room codes, cookies, or persistent identifiers.
export const HUMAN_ANALYTICS_ENDPOINT = 'https://spadefall-turn.spadefall.workers.dev/gameplay';
export const HUMAN_METRICS = Object.freeze(['playSeconds', 'roundSeconds', 'kills',
  'deaths', 'spawnDeaths', 'assists', 'points', 'objective', 'shots', 'digs',
  'places', 'grenades', 'pings', 'airstrikes', 'humans', 'bots',
  'rifleSeconds', 'smgSeconds', 'sniperSeconds']);
const MODES = ['tdm', 'koth', 'ctf', 'other'];
const NETWORKS = ['solo', 'host', 'client', 'other'];
const OUTCOMES = ['complete', 'abandoned', 'network', 'superseded', 'other'];
const ACTIONS = ['shoot', 'dig', 'place', 'grenade', 'ping', 'objective', 'airstrike',
  'ready', 'spawn_front', 'spawn_base', 'continue', 'other', 'none'];
const bounded = value => Math.max(0, Math.min(86400,
  Math.round((Number.isFinite(value) ? value : 0) * 10) / 10));
const choice = (value, values, fallback = 'other') => values.includes(value) ? value : fallback;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => key in value);

export function humanRoundSummary(summary, activity = {}, build = 'human-v1') {
  const a = summary?.actions ?? {}, c = summary?.contribution ?? {};
  const raw = { playSeconds: activity.playSeconds, roundSeconds: summary?.duration,
    kills: summary?.kills, deaths: summary?.deaths, spawnDeaths: summary?.spawnDeaths,
    assists: c.assists, points: c.points, objective: c.objective,
    shots: a.shoot, digs: a.dig, places: a.place, grenades: a.grenade,
    pings: a.ping, airstrikes: a.airstrike, humans: summary?.humans, bots: summary?.bots,
    rifleSeconds: activity.rifleSeconds, smgSeconds: activity.smgSeconds,
    sniperSeconds: activity.sniperSeconds };
  return { v: 1, build: /^[A-Za-z0-9._-]{1,24}$/.test(build) ? build : 'human-v1',
    mode: choice(summary?.mode, MODES), map: Math.max(0, Math.min(99, summary?.map | 0)),
    network: choice(summary?.network, NETWORKS), outcome: choice(summary?.outcome, OUTCOMES),
    result: summary?.won == null ? 'unknown' : summary.won ? 'win' : 'loss',
    firstAction: choice(summary?.firstAction?.action, ACTIONS, 'none'),
    metrics: Object.fromEntries(HUMAN_METRICS.map(key => [key, bounded(raw[key])])) };
}

// The edge rejects extra keys rather than silently accepting private fields.
export function validHumanRound(value) {
  return !!(exact(value, ['v', 'build', 'mode', 'map', 'network', 'outcome', 'result',
    'firstAction', 'metrics']) && value.v === 1
    && typeof value.build === 'string' && /^[A-Za-z0-9._-]{1,24}$/.test(value.build)
    && MODES.includes(value.mode) && NETWORKS.includes(value.network)
    && OUTCOMES.includes(value.outcome) && ['win', 'loss', 'unknown'].includes(value.result)
    && ACTIONS.includes(value.firstAction) && Number.isInteger(value.map)
    && value.map >= 0 && value.map <= 99 && exact(value.metrics, HUMAN_METRICS)
    && HUMAN_METRICS.every(key => Number.isFinite(value.metrics[key])
      && value.metrics[key] >= 0 && value.metrics[key] <= 86400));
}

export class HumanAnalytics {
  constructor({ enabled = true, build = 'human-v1', endpoint = HUMAN_ANALYTICS_ENDPOINT,
    fetcher = globalThis.fetch,
    beacon = globalThis.navigator?.sendBeacon?.bind(globalThis.navigator) } = {}) {
    this.enabled = enabled; this.build = build; this.endpoint = endpoint;
    this.fetcher = fetcher; this.beacon = beacon; this.activity = null;
  }
  start() { this.activity = {}; }
  step(dt, gunClass, visible = true) {
    if (!this.enabled || !this.activity || !visible) return;
    const seconds = Math.max(0, Math.min(1, Number.isFinite(dt) ? dt : 0));
    this.activity.playSeconds = Math.min(86400, (this.activity.playSeconds ?? 0) + seconds);
    const key = { 0: 'rifleSeconds', 1: 'smgSeconds', 5: 'sniperSeconds' }[gunClass];
    if (key) this.activity[key] = Math.min(86400, (this.activity[key] ?? 0) + seconds);
  }
  finish(summary) {
    if (!this.activity) return false;
    const activity = this.activity; this.activity = null;
    if (!this.enabled || !summary) return false;
    const body = JSON.stringify(humanRoundSummary(summary, activity, this.build));
    try {
      if (this.beacon?.(this.endpoint, new Blob([body], { type: 'application/json' }))) return true;
      if (typeof this.fetcher !== 'function') return false;
      void this.fetcher(this.endpoint, { method: 'POST', headers: {
        'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
      return true;
    } catch { return false; }
  }
}
