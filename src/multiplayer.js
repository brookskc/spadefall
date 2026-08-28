// multiplayer.js — pure multiplayer rules shared by Game and headless tests.
// Keep this module free of DOM and Three.js dependencies so authority rules
// can be regression-tested without launching a browser.

export const TEAM_SIZE = 5;
export const MAX_HUMANS = TEAM_SIZE * 2;

export const MOVEMENT = Object.freeze({
  horizontalSpeed: 9,
  horizontalSlack: 3,
  maxRiseSpeed: 12,
  maxFallSpeed: 40,
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

// Honor a preference only while that side has a human seat. Otherwise choose
// the less populated side that still has room. Null means the room is full.
export function chooseTeam(preference, counts, teamSize = TEAM_SIZE) {
  const green = Math.max(0, counts?.green | 0);
  const blue = Math.max(0, counts?.blue | 0);
  const roomOn = team => (team === 'green' ? green : blue) < teamSize;
  if ((preference === 'green' || preference === 'blue') && roomOn(preference))
    return preference;
  if (!roomOn('green') && !roomOn('blue')) return null;
  if (!roomOn('green')) return 'blue';
  if (!roomOn('blue')) return 'green';
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

// Validate displacement only. Terrain overlap and ballistic/ground-support
// checks remain Game responsibilities because they need the live VoxelWorld.
export function validateMovementReport(previous, report, elapsed, limits = MOVEMENT) {
  if (!previous || !report || ![previous.x, previous.y, previous.z,
      report.x, report.y, report.z, report.yaw].every(Number.isFinite))
    return { ok: false, reason: 'non-finite' };

  const dt = Math.max(1 / 60, Math.min(limits.maxElapsed, elapsed || 0));
  const horizontal = Math.hypot(report.x - previous.x, report.z - previous.z);
  if (horizontal > limits.horizontalSpeed * limits.horizontalSlack * dt)
    return { ok: false, reason: 'horizontal-speed' };

  const dy = report.y - previous.y;
  if (dy > limits.maxRiseSpeed * dt + limits.verticalSlack)
    return { ok: false, reason: 'vertical-rise' };
  if (dy < -(limits.maxFallSpeed * dt + limits.verticalSlack))
    return { ok: false, reason: 'vertical-fall' };

  return { ok: true, dt };
}

export function normalizeDirection(value) {
  if (!finiteVector(value)) return null;
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!Number.isFinite(length) || length < 1e-6) return null;
  return [value[0] / length, value[1] / length, value[2] / length];
}
