// engagement.js — local, bounded product-flow diagnostics.
//
// This is deliberately not an analytics client: it opens no connection,
// writes no storage, and accepts no names, chat, room codes, positions, or
// free-form text. A small aggregate plus recent-event ring is exposed through
// main.js's existing __spadefallDiagnostics handle so playtests can answer
// basic questions before later engagement features change the game.

export const ENGAGEMENT_FEATURES = Object.freeze([
  'privateContent',
  'firstMinute',
  'voxelStories',
  'deathRecap',
  'stayAsSquad',
  'teamBalance',
  'publicChat',
]);

// These features have completed their isolated rollout and are now part of
// ordinary matches.
export const DEFAULT_ENGAGEMENT_FEATURES = Object.freeze([
  'firstMinute',
  'voxelStories',
  'deathRecap',
  'stayAsSquad',
  'teamBalance',
]);

const FEATURE_BY_LOWER = new Map(ENGAGEMENT_FEATURES.map(name => [name.toLowerCase(), name]));

// Known query flags are additive to production defaults; unknown names are ignored.
export function parseEngagementFeatures(search = '') {
  const params = new URLSearchParams(String(search).replace(/^\?/, ''));
  const requested = new Set(DEFAULT_ENGAGEMENT_FEATURES);
  for (const row of params.getAll('features'))
    for (const raw of row.split(',')) {
      const known = FEATURE_BY_LOWER.get(raw.trim().toLowerCase());
      if (known) requested.add(known);
    }
  return Object.freeze(Object.fromEntries(
    ENGAGEMENT_FEATURES.map(name => [name, requested.has(name)])));
}

const EVENT_FIELDS = Object.freeze({
  page_ready: ['protocol'],
  lobby_action: ['action'],
  match_start: ['mode', 'map', 'network', 'source', 'humans', 'bots', 'round'],
  match_pause: ['reason'],
  match_resume: ['mode', 'map', 'network', 'source', 'humans', 'bots', 'round'],
  first_action: ['action', 'matchSecond'],
  death: ['cause'],
  kill: ['cause'],
  disconnect: ['reason'],
  match_finish: ['outcome', 'won', 'duration', 'overtime', 'scoreMargin'],
  continuation: ['action'],
});

const ENUMS = Object.freeze({
  action: new Set(['solo', 'host', 'join', 'quick', 'browse', 'browse_join', 'deploy',
    'shoot', 'dig', 'place', 'grenade', 'ping', 'objective', 'airstrike',
    'ready', 'spawn_front', 'spawn_base', 'continue',
    'other']),
  mode: new Set(['ctf', 'tdm', 'koth', 'other']),
  network: new Set(['solo', 'host', 'client', 'other']),
  source: new Set(['solo', 'host', 'join', 'quick', 'browse', 'rotation', 'resume', 'qa', 'other']),
  reason: new Set(['menu', 'pagehide', 'network', 'superseded', 'rotation', 'other']),
  cause: new Set(['weapon', 'grenade', 'spade', 'airstrike', 'collapse', 'fell', 'drowned',
    'void', 'suicide', 'environment', 'other']),
  outcome: new Set(['complete', 'abandoned', 'superseded', 'network', 'other']),
});

const NUMERIC_FIELDS = new Set(['protocol', 'map', 'humans', 'bots', 'round',
  'matchSecond', 'duration', 'scoreMargin']);
const BOOLEAN_FIELDS = new Set(['won', 'overtime']);
const nowDefault = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
const clampNumber = (value, min = -1e9, max = 1e9) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : 0;
};

function safeEnum(field, value) {
  const normalized = String(value ?? 'other').toLowerCase();
  return ENUMS[field]?.has(normalized) ? normalized : 'other';
}

export function sanitizeEngagementEvent(type, data = {}) {
  const fields = EVENT_FIELDS[type];
  if (!fields) return null;
  const clean = {};
  for (const field of fields) {
    if (!(field in data)) continue;
    if (NUMERIC_FIELDS.has(field)) clean[field] = clampNumber(data[field]);
    else if (BOOLEAN_FIELDS.has(field)) clean[field] = !!data[field];
    else clean[field] = safeEnum(field, data[field]);
  }
  return clean;
}

const addCount = (row, key, amount = 1) => {
  row[key] = (row[key] ?? 0) + amount;
};

export class EngagementTracker {
  constructor({ now = nowDefault, eventCapacity = 64, matchCapacity = 16,
    onStart = () => {}, onFinish = _summary => {} } = {}) {
    this.onStart = onStart; this.onFinish = onFinish;
    this.now = now;
    this.startedAt = now();
    this.eventCapacity = Math.max(16, eventCapacity | 0);
    this.matchCapacity = Math.max(4, matchCapacity | 0);
    this.events = [];
    this.matches = [];
    this.counts = {};
    this.actionCounts = {};
    this.active = null;
  }

  record(type, data = {}) {
    const clean = sanitizeEngagementEvent(type, data);
    if (!clean) return false;
    this.events.push({ type, atMs: Math.max(0, Math.round(this.now() - this.startedAt)), ...clean });
    if (this.events.length > this.eventCapacity) this.events.shift();
    addCount(this.counts, type);
    return true;
  }

  beginMatch(context = {}) {
    const clean = sanitizeEngagementEvent('match_start', context);
    const key = `${clean?.round ?? 0}:${clean?.mode ?? 'other'}:${clean?.map ?? 0}`;
    if (this.active?.key === key) {
      if (this.active.paused) {
        this.active.paused = false;
        this.record('match_resume', context);
      }
      return false;
    }
    if (this.active) this.finishMatch({ outcome: 'superseded' });
    this.active = {
      key,
      context: clean ?? {},
      startedAt: this.now(),
      paused: false,
      firstAction: null,
      actions: {},
      contribution: { points: 0, objective: 0, assists: 0 },
      deaths: 0,
      spawnDeaths: 0,
      kills: 0,
    };
    this.record('match_start', context);
    this.onStart();
    return true;
  }

  pauseMatch(reason = 'menu') {
    if (!this.active || this.active.paused) return false;
    this.active.paused = true;
    this.record('match_pause', { reason });
    return true;
  }

  action(action, matchSecond = null) {
    if (!this.active) return false;
    const kind = safeEnum('action', action);
    addCount(this.active.actions, kind);
    addCount(this.actionCounts, kind);
    if (!this.active.firstAction) {
      const second = matchSecond == null
        ? Math.max(0, (this.now() - this.active.startedAt) / 1000)
        : Math.max(0, Number(matchSecond) || 0);
      this.active.firstAction = { action: kind, matchSecond: second };
      this.record('first_action', this.active.firstAction);
    }
    return true;
  }

  contribution({ points = 0, objective = 0, assists = 0 } = {}) {
    if (!this.active) return false;
    this.active.contribution.points += Math.max(0, Number(points) || 0);
    this.active.contribution.objective += Math.max(0, Number(objective) || 0);
    this.active.contribution.assists += Math.max(0, Number(assists) || 0);
    if (objective > 0) this.action('objective');
    return true;
  }

  combat(kind, cause = 'other', spawnAge = null) {
    if (!this.active || !['death', 'kill'].includes(kind)) return false;
    this.active[kind === 'death' ? 'deaths' : 'kills']++;
    if (kind === 'death' && Number.isFinite(spawnAge) && spawnAge >= 0 && spawnAge <= 3)
      this.active.spawnDeaths++;
    return this.record(kind, { cause });
  }

  finishMatch(data = {}) {
    if (!this.active) return null;
    const active = this.active;
    // The authoritative final scoreboard is a better source than incremental
    // local observations (especially on a thin client). When supplied, it
    // replaces rather than adds to the running totals.
    if (data.points != null)
      active.contribution.points = Math.max(0, Number(data.points) || 0);
    if (data.objective != null)
      active.contribution.objective = Math.max(0, Number(data.objective) || 0);
    if (data.assists != null)
      active.contribution.assists = Math.max(0, Number(data.assists) || 0);
    const duration = Number.isFinite(Number(data.duration))
      ? Math.max(0, Number(data.duration))
      : Math.max(0, (this.now() - active.startedAt) / 1000);
    const event = {
      outcome: data.outcome ?? 'complete',
      won: data.won,
      duration,
      overtime: data.overtime,
      scoreMargin: data.scoreMargin,
    };
    this.record('match_finish', event);
    const summary = {
      ...active.context,
      outcome: safeEnum('outcome', event.outcome),
      won: event.won == null ? null : !!event.won,
      duration,
      overtime: !!event.overtime,
      scoreMargin: clampNumber(event.scoreMargin ?? 0),
      firstAction: active.firstAction ? { ...active.firstAction } : null,
      actions: { ...active.actions },
      contribution: { ...active.contribution },
      deaths: active.deaths,
      spawnDeaths: active.spawnDeaths,
      kills: active.kills,
    };
    this.matches.push(summary);
    if (this.matches.length > this.matchCapacity) this.matches.shift();
    this.active = null;
    this.onFinish(summary);
    return summary;
  }

  abandon(reason = 'pagehide') {
    if (!this.active) return null;
    if (reason === 'network') this.record('disconnect', { reason });
    return this.finishMatch({ outcome: reason === 'network' ? 'network' : 'abandoned' });
  }

  snapshot() {
    return {
      elapsedMs: Math.max(0, Math.round(this.now() - this.startedAt)),
      counts: { ...this.counts },
      actionCounts: { ...this.actionCounts },
      active: this.active ? {
        ...this.active.context,
        paused: this.active.paused,
        firstAction: this.active.firstAction ? { ...this.active.firstAction } : null,
        actions: { ...this.active.actions },
        contribution: { ...this.active.contribution },
        deaths: this.active.deaths,
        kills: this.active.kills,
      } : null,
      matches: this.matches.map(row => ({ ...row, actions: { ...row.actions },
        contribution: { ...row.contribution },
        firstAction: row.firstAction ? { ...row.firstAction } : null })),
      events: this.events.map(event => ({ ...event })),
    };
  }
}
