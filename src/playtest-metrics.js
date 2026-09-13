// playtest-metrics.js — local-only, bounded match instrumentation.
//
// This module deliberately has no network, storage, DOM, or identity output.
// The Game owns the authoritative call sites; this class only aggregates
// coarse match facts and strips its internal entity bookkeeping on snapshot.

export const PLAYTEST_SCOPES = Object.freeze(['authoritative', 'local']);
export const PLAYTEST_OUTCOMES = Object.freeze(['win', 'loss', 'draw', 'abandoned', 'active']);
export const PLAYTEST_CLASSES = Object.freeze(['rifle', 'smg', 'sniper', 'other']);
export const PLAYTEST_LANES = Object.freeze(['north', 'center', 'south']);
export const PLAYTEST_CONTINUATIONS = Object.freeze(['next', 'rivalry', 'done', 'stay_squad']);
// Spawn-death rate uses the first three seconds of a life, matching the
// authoritative spawn-protection window while keeping the metric comparable.
export const PLAYTEST_SPAWN_WINDOW_SECONDS = 3;
const MAX_HISTORY = 16;
const MAX_COUNT = 9999;
const MAX_SECONDS = 86400;

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const count = value => Math.max(0, Math.min(MAX_COUNT, Math.floor(finite(value))));
const seedValue = value => Math.max(0, Math.min(999999999, Math.floor(finite(value))));
const seconds = value => Math.max(0, Math.min(MAX_SECONDS, finite(value)));
const enumValue = (value, values, fallback) => values.includes(value) ? value : fallback;
const classKey = value => {
  if (value === 0) return 'rifle';
  if (value === 1) return 'smg';
  if (value === 5) return 'sniper';
  return enumValue(value, PLAYTEST_CLASSES, 'other');
};

function blankClassCounts() {
  return Object.fromEntries(PLAYTEST_CLASSES.map(key => [key, 0]));
}
function blankLaneCounts() {
  return Object.fromEntries(PLAYTEST_LANES.map(key => [key, 0]));
}
function blankMatch() {
  return {
    map: 0, mode: 'tdm', seed: null, side: 'green', scope: 'authoritative',
    humans: 0, bots: 0, firstContactSeconds: null,
    spawnDeaths: 0, deaths: 0, kills: 0, spawnDeathRate: 0,
    deathsByClass: blankClassCounts(), killsByClass: blankClassCounts(),
    laneEntries: blankLaneCounts(),
    koth: { activeSeconds: 0, contestedSeconds: 0, captures: 0, retakes: 0 },
    captures: 0, retakes: 0,
    engineering: {}, pings: { created: 0, nearTeammate: 0 },
    durationSeconds: 0, outcome: 'active', continuation: null,
    continuationCounts: Object.fromEntries(PLAYTEST_CONTINUATIONS.map(key => [key, 0])),
  };
}

const copyCounts = (source, keys) => Object.fromEntries(keys.map(key =>
  [key, count(source?.[key])]));

export function laneForZ(z, center = 128) {
  if (!Number.isFinite(z) || !Number.isFinite(center)) return null;
  const delta = z - center;
  return Math.abs(delta) <= 24 ? 'center' : delta < 0 ? 'north' : 'south';
}

/** Pure bounded per-match accumulator. Entity objects are accepted only for
 * internal crossing de-duplication and are never retained in snapshots. */
export class PlaytestMetrics {
  constructor(context = {}) {
    this.history = [];
    this.reset(context);
  }

  reset(context = {}) {
    this.match = blankMatch();
    this.match.map = Number.isInteger(context.map) ? Math.max(0, Math.min(99, context.map)) : 0;
    this.match.mode = typeof context.mode === 'string' && /^[a-z]{1,8}$/.test(context.mode)
      ? context.mode : 'tdm';
    this.match.seed = context.seed == null ? null : seedValue(context.seed);
    this.match.side = enumValue(context.side, ['green', 'blue'], 'green');
    this.match.scope = enumValue(context.scope, PLAYTEST_SCOPES, 'authoritative');
    this.match.humans = count(context.humans);
    this.match.bots = count(context.bots);
    this._routeNextSample = 0;
    this._routeLives = new Map();
    this._kothOwner = null;
    return this.snapshot();
  }

  setRoster(humans, bots) {
    this.match.humans = count(humans);
    this.match.bots = count(bots);
  }

  updateDuration(duration) { this.match.durationSeconds = seconds(duration); }

  noteContact(at) {
    if (this.match.firstContactSeconds == null) this.match.firstContactSeconds = seconds(at);
  }

  noteDeath(gunClass, spawnProtected = false) {
    this.match.deaths = count(this.match.deaths + 1);
    const key = classKey(gunClass);
    this.match.deathsByClass[key] = count(this.match.deathsByClass[key] + 1);
    if (spawnProtected) this.match.spawnDeaths = count(this.match.spawnDeaths + 1);
    this._refreshSpawnRate();
  }

  noteKill(gunClass) {
    this.match.kills = count(this.match.kills + 1);
    const key = classKey(gunClass);
    this.match.killsByClass[key] = count(this.match.killsByClass[key] + 1);
  }

  _refreshSpawnRate() {
    this.match.spawnDeathRate = this.match.deaths
      ? Math.min(1, this.match.spawnDeaths / this.match.deaths) : 0;
  }

  noteRouteEntry(lane) {
    if (!PLAYTEST_LANES.includes(lane)) return false;
    this.match.laneEntries[lane] = count(this.match.laneEntries[lane] + 1);
    return true;
  }

  // Sample at most twice per second. `entity` and `life` stay private; the
  // output is only lane totals, never positions or roster keys.
  observeRoute(entity, team, x, z, now, life = null, center = 128) {
    if (now < this._routeNextSample) return;
    this._routeNextSample = now + 0.5;
    this._observeRoute(entity, team, x, z, life, center);
  }

  observeRoutes(entities, now, center = 128) {
    if (now < this._routeNextSample || !Array.isArray(entities)) return;
    this._routeNextSample = now + 0.5;
    for (const entity of entities) {
      if (!entity?.alive || !entity.body?.pos) continue;
      this._observeRoute(entity, entity.team, entity.body.pos.x, entity.body.pos.z,
        entity._spawnedAt, center);
    }
  }

  _observeRoute(entity, team, x, z, life = null, center = 128) {
    if (!entity || !['green', 'blue'].includes(team)
        || !Number.isFinite(x) || !Number.isFinite(z)) return;
    const state = this._routeLives.get(entity);
    const lifeKey = Number.isFinite(life) ? life : 0;
    const crossed = team === 'green' ? x >= center - 24 : x <= center + 24;
    if (!crossed) return;
    if (state?.life === lifeKey && state.crossed) return;
    const lane = laneForZ(z, center);
    this._routeLives.set(entity, { life: lifeKey, crossed: true });
    this.noteRouteEntry(lane);
  }

  noteKoth(dt, contested, owner = null, occupied = true) {
    const amount = Math.max(0, Math.min(60, finite(dt)));
    if (occupied)
      this.match.koth.activeSeconds = seconds(this.match.koth.activeSeconds + amount);
    if (occupied && contested)
      this.match.koth.contestedSeconds = seconds(this.match.koth.contestedSeconds + amount);
    if (owner && owner !== this._kothOwner) {
      if (this._kothOwner) this.match.koth.retakes = count(this.match.koth.retakes + 1);
      this.match.koth.captures = count(this.match.koth.captures + 1);
      this.match.retakes = count(this.match.retakes + (this._kothOwner ? 1 : 0));
      this.match.captures = count(this.match.captures + 1);
      this._kothOwner = owner;
    } else if (!owner) this._kothOwner = null;
  }

  resetKoth() { this._kothOwner = null; }

  noteObjectiveCapture(retake = false) {
    this.match.captures = count(this.match.captures + 1);
    if (retake) this.match.retakes = count(this.match.retakes + 1);
  }

  noteEngineering(kind) {
    if (typeof kind !== 'string' || !/^[a-z_]{1,16}$/.test(kind)) return false;
    this.match.engineering[kind] = count((this.match.engineering[kind] ?? 0) + 1);
    return true;
  }

  notePing(nearTeammate = false) {
    this.match.pings.created = count(this.match.pings.created + 1);
    if (nearTeammate) this.match.pings.nearTeammate = count(this.match.pings.nearTeammate + 1);
  }

  notePingNear() {
    this.match.pings.nearTeammate = count(this.match.pings.nearTeammate + 1);
  }

  continuation(action) {
    if (!PLAYTEST_CONTINUATIONS.includes(action)) return false;
    this.match.continuation = action;
    this.match.continuationCounts[action] = count(this.match.continuationCounts[action] + 1);
    return true;
  }

  finish(duration, won, abandoned = false) {
    this.match.durationSeconds = seconds(duration);
    this.match.outcome = abandoned ? 'abandoned' : won == null ? 'draw' : won ? 'win' : 'loss';
    this._refreshSpawnRate();
    this._pushHistory();
    return this.snapshot();
  }

  _pushHistory() {
    const finished = this.snapshot();
    this.history.push(finished);
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
  }

  snapshot() {
    const m = this.match;
    return {
      map: m.map, mode: m.mode, seed: m.seed, side: m.side, scope: m.scope,
      humans: count(m.humans), bots: count(m.bots),
      firstContactSeconds: m.firstContactSeconds == null ? null : seconds(m.firstContactSeconds),
      spawnDeaths: count(m.spawnDeaths), deaths: count(m.deaths), kills: count(m.kills),
      spawnDeathRate: Math.max(0, Math.min(1, finite(m.spawnDeathRate))),
      deathsByClass: copyCounts(m.deathsByClass, PLAYTEST_CLASSES),
      killsByClass: copyCounts(m.killsByClass, PLAYTEST_CLASSES),
      laneEntries: copyCounts(m.laneEntries, PLAYTEST_LANES),
      koth: { activeSeconds: seconds(m.koth.activeSeconds), contestedSeconds: seconds(m.koth.contestedSeconds),
        captures: count(m.koth.captures), retakes: count(m.koth.retakes) },
      captures: count(m.captures), retakes: count(m.retakes),
      engineering: Object.fromEntries(Object.keys(m.engineering).sort().slice(0, 12)
        .map(key => [key, count(m.engineering[key])])),
      pings: { created: count(m.pings.created), nearTeammate: count(m.pings.nearTeammate) },
      durationSeconds: seconds(m.durationSeconds), outcome: enumValue(m.outcome, PLAYTEST_OUTCOMES, 'active'),
      continuation: enumValue(m.continuation, PLAYTEST_CONTINUATIONS, null),
      continuationCounts: copyCounts(m.continuationCounts, PLAYTEST_CONTINUATIONS),
    };
  }

  diagnostics() {
    return { current: this.snapshot(), history: this.history.slice(-MAX_HISTORY).map(row => ({ ...row,
      deathsByClass: { ...row.deathsByClass }, killsByClass: { ...row.killsByClass },
      laneEntries: { ...row.laneEntries }, koth: { ...row.koth },
      engineering: { ...row.engineering }, pings: { ...row.pings },
      continuationCounts: { ...row.continuationCounts },
    })) };
  }
}

export function validPlaytestSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  return PLAYTEST_SCOPES.includes(snapshot.scope)
    && PLAYTEST_OUTCOMES.includes(snapshot.outcome)
    && Number.isInteger(snapshot.map) && Number.isInteger(snapshot.humans)
    && Number.isInteger(snapshot.bots)
    && (!('name' in snapshot) && !('chat' in snapshot) && !('room' in snapshot)
      && !('position' in snapshot) && !('playerId' in snapshot));
}
