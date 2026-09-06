// multiplayer.js — pure multiplayer rules shared by Game and headless tests.
// Keep this module free of DOM and Three.js dependencies so authority rules
// can be regression-tested without launching a browser.

export const TEAM_SIZE = 5;
export const MAX_HUMANS = TEAM_SIZE * 2;
export const KOTH_TEAM_SIZE = 4;

// A single concentrated hill becomes grenade-heavy and visually crowded at
// 5v5. CTF and TDM still need five soldiers per side to keep their larger
// routes populated, while KOTH deliberately runs one seat lighter per team.
export const teamSizeForMode = mode => mode === 'koth' ? KOTH_TEAM_SIZE : TEAM_SIZE;

export const MOVEMENT = Object.freeze({
  horizontalSpeed: 9,
  horizontalSlack: 0.45,
  horizontalBurst: 1.35,
  maxRiseSpeed: 12,
  // Body step-up is an instantaneous one-voxel y correction. The burst must
  // cover that discrete move plus quantization slack; sustained climbing is
  // still rate-limited by maxRiseSpeed and the token refill below.
  riseBurst: 1.35,
  maxFallSpeed: 40,
  fallBurst: 2.5,
  verticalSlack: 0.35,
  maxElapsed: 0.25,
});

export const isRecord = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const finiteNumber = value => Number.isFinite(value);

export const finiteVector = value =>
  Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);

export function teamCounts(hostTeam, remotes) {
  const counts = { green: 0, blue: 0 };
  if (hostTeam === 'green' || hostTeam === 'blue') counts[hostTeam]++;
  for (const player of remotes ?? [])
    if (player?.team === 'green' || player?.team === 'blue') counts[player.team]++;
  return counts;
}

// Honor a preference while that side has a human seat. With optional balance
// enabled, an existing count gap takes precedence and the arrival fills the
// smaller human side. Null means the room is full.
export function chooseTeam(preference, counts, teamSize = TEAM_SIZE, balance = false) {
  const green = Math.max(0, counts?.green | 0);
  const blue = Math.max(0, counts?.blue | 0);
  const roomOn = team => (team === 'green' ? green : blue) < teamSize;
  if (!roomOn('green') && !roomOn('blue')) return null;
  if (!roomOn('green')) return 'blue';
  if (!roomOn('blue')) return 'green';
  // Optional Phase 8 policy: a preference is still honored when human
  // counts are tied, but it cannot grow an already larger side. Bots fill
  // the remaining seats either way, so this concerns human composition.
  if (balance && green !== blue) return green < blue ? 'green' : 'blue';
  if ((preference === 'green' || preference === 'blue') && roomOn(preference))
    return preference;
  return green <= blue ? 'green' : 'blue';
}

export function spawnRow(body, yaw = 0) {
  const p = body?.pos;
  if (!p || ![p.x, p.y, p.z, yaw].every(Number.isFinite)) return null;
  return [p.x, p.y, p.z, yaw];
}

export function parseSpawnRow(row) {
  if (!Array.isArray(row) || row.length !== 4 || !row.every(Number.isFinite)) return null;
  return { x: row[0], y: row[1], z: row[2], yaw: row[3] };
}

// Build host-migration state from the identity roster, not from the client's
// position replica. Interest management deliberately removes out-of-sight
// rows from that replica; those soldiers still belong to the room and must be
// given a migration seat even though the new host cannot restore their exact
// (and intentionally hidden) position. `row: null` tells the promoted host to
// redeploy that survivor safely when their connection arrives.
export function migrationSurvivors(roster, ownIdx, replicated) {
  const survivors = new Map();
  if (!(roster instanceof Map)) return survivors;
  for (const [idx, meta] of roster) {
    if (!Number.isInteger(idx) || idx === ownIdx || !isRecord(meta)
        || meta.pid === 'HOST' || typeof meta.pid !== 'string' || !meta.pid
        || typeof meta.name !== 'string'
        || (meta.team !== 'green' && meta.team !== 'blue')) continue;
    survivors.set(meta.pid, {
      idx, name: meta.name, team: meta.team,
      row: replicated instanceof Map ? (replicated.get(idx) ?? null) : null,
    });
  }
  return survivors;
}

// Public-room combat policy: enemy damage and self-damage are valid, but a
// player cannot hurt a teammate. A future private-room friendly-fire toggle
// can opt in without teaching every weapon/explosion/collapse path its own
// slightly different version of the rule.
export function combatDamageAllowed(victimTeam, attackerTeam, self = false,
  friendlyFire = false) {
  if (self || attackerTeam == null || victimTeam == null) return true;
  return friendlyFire || victimTeam !== attackerTeam;
}

const inCylinder = (x, y, z, area) => {
  if (!area || ![x, y, z, area.x, area.y, area.z, area.r].every(Number.isFinite)) return false;
  const below = Number.isFinite(area.below) ? area.below : 1;
  const above = Number.isFinite(area.above) ? area.above : 4;
  return Math.hypot(x + 0.5 - area.x, z + 0.5 - area.z) <= area.r
    && y + 1 > area.y - below && y < area.y + above;
};

// Keep the small pieces of geometry a match cannot function without clear.
// The surrounding bunker, hill rim, and approaches remain fully buildable;
// only the flag pedestal, reliable fallback spawn pads, and hill center are
// protected. Returns a stable reason so Game can provide useful feedback.
export function protectedBuildReason(x, y, z, areas = {}) {
  if (![x, y, z].every(Number.isFinite)) return 'invalid';
  if ((areas.flags ?? []).some(a => inCylinder(x, y, z, a))) return 'flag';
  if ((areas.spawns ?? []).some(a => inCylinder(x, y, z, a))) return 'spawn';
  if ((areas.signature ?? []).some(a => inCylinder(x, y, z, a))) return 'signature';
  if (inCylinder(x, y, z, areas.hill)) return 'hill';
  return null;
}

export function createMovementBudget(limits = MOVEMENT) {
  return {
    horizontal: limits.horizontalBurst,
    rise: limits.riseBurst,
    fall: limits.fallBurst,
  };
}

// Validate displacement against elapsed-time credit. The optional mutable
// budget is used by the host for live peers: credit refills with real elapsed
// simulation time and is capped, so a burst of reports in one frame cannot
// manufacture a fresh minimum-dt allowance for every packet. Callers that do
// not supply a budget retain a stateless check for tests and tooling.
export function validateMovementReport(previous, report, elapsed, limits = MOVEMENT,
  budget = null) {
  if (!previous || !report || ![previous.x, previous.y, previous.z,
      report.x, report.y, report.z, report.yaw].every(Number.isFinite))
    return { ok: false, reason: 'non-finite' };

  const dt = Math.max(0, Math.min(limits.maxElapsed, elapsed || 0));
  const horizontal = Math.hypot(report.x - previous.x, report.z - previous.z);
  const dy = report.y - previous.y;

  if (budget) {
    const horizontalCredit = Math.min(limits.horizontalBurst,
      Math.max(0, budget.horizontal ?? limits.horizontalBurst)
        + limits.horizontalSpeed * dt);
    const riseCredit = Math.min(limits.riseBurst,
      Math.max(0, budget.rise ?? limits.riseBurst) + limits.maxRiseSpeed * dt);
    const fallCredit = Math.min(limits.fallBurst,
      Math.max(0, budget.fall ?? limits.fallBurst) + limits.maxFallSpeed * dt);
    if (horizontal > horizontalCredit + 1e-6)
      return { ok: false, reason: 'horizontal-speed' };
    if (dy > riseCredit + 1e-6) return { ok: false, reason: 'vertical-rise' };
    if (-dy > fallCredit + 1e-6) return { ok: false, reason: 'vertical-fall' };
    budget.horizontal = horizontalCredit - horizontal;
    budget.rise = riseCredit - Math.max(0, dy);
    budget.fall = fallCredit - Math.max(0, -dy);
  } else {
    if (horizontal > limits.horizontalSpeed * dt + limits.horizontalSlack)
      return { ok: false, reason: 'horizontal-speed' };
    if (dy > limits.maxRiseSpeed * dt + limits.verticalSlack)
      return { ok: false, reason: 'vertical-rise' };
    if (dy < -(limits.maxFallSpeed * dt + limits.verticalSlack))
      return { ok: false, reason: 'vertical-fall' };
  }

  return { ok: true, dt };
}

export function normalizeDirection(value) {
  if (!finiteVector(value)) return null;
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!Number.isFinite(length) || length < 1e-6) return null;
  return [value[0] / length, value[1] / length, value[2] / length];
}
