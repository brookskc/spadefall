// streaks.js — pure contribution meter for the airstrike reward.

export const AIRSTRIKE_COST = 700;
export const STREAK_CAP = AIRSTRIKE_COST;

export function gainStreak(current, contribution) {
  const value = Number.isFinite(current) ? Math.max(0, current) : 0;
  const gain = Number.isFinite(contribution) ? Math.max(0, contribution) : 0;
  return Math.min(STREAK_CAP, value + gain);
}

export function spendStreak(current, cost) {
  const value = Number.isFinite(current) ? Math.max(0, current) : 0;
  const price = Number.isFinite(cost) ? Math.max(0, cost) : Infinity;
  return value >= price ? value - price : null;
}

export function availableStreakAbility(points) {
  return points >= AIRSTRIKE_COST ? 'airstrike' : null;
}

// Pick a compact enemy pressure point, rejecting isolated targets and spots
// where friendlies dominate. Inputs are plain {x,z,team} rows for headless use.
export function chooseBotAirstrikeTarget(enemies = [], friendlies = [], reserved = []) {
  const valid = enemies.filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.z));
  let best = null, bestScore = -Infinity;
  for (const point of valid) {
    const foes = valid.filter(p => Math.hypot(p.x - point.x, p.z - point.z) <= 16).length;
    const allies = friendlies.filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.z)
      && Math.hypot(p.x - point.x, p.z - point.z) <= 13).length;
    const duplicate = reserved.some(p => Number.isFinite(p?.x) && Number.isFinite(p?.z)
      && Math.hypot(p.x - point.x, p.z - point.z) < 24);
    if (duplicate) continue;
    const score = foes * 3 - allies * 4;
    if (foes >= 2 && allies < foes && score > bestScore) { best = point; bestScore = score; }
  }
  return best ? { x: best.x, z: best.z } : null;
}

// Short lead from observed velocity only. It is deliberately clamped to map
// bounds and does not predict health, intent, or any unobserved future state.
export function predictBotAirstrikePoint(point, velocity, leadSeconds = 0.45,
  maxX = 256, maxZ = 256) {
  if (!point || !velocity || ![point.x, point.z, velocity.x, velocity.z]
    .every(Number.isFinite)) return null;
  const lead = Math.max(0, Math.min(0.75, leadSeconds));
  return { x: Math.max(0, Math.min(maxX, point.x + velocity.x * lead)),
    z: Math.max(0, Math.min(maxZ, point.z + velocity.z * lead)) };
}

export function steerBotAirstrike(current, target, maxDistance) {
  if (!current || !target || !Number.isFinite(maxDistance) || maxDistance < 0) return null;
  const dx = target.x - current.x, dz = target.z - current.z, d = Math.hypot(dx, dz);
  if (!d || d <= maxDistance) return { x: target.x, z: target.z };
  return { x: current.x + dx / d * maxDistance, z: current.z + dz / d * maxDistance };
}
