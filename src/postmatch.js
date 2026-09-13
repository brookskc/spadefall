// postmatch.js — fixed, descriptive rules for the results screen.
// Nothing in this module grants power, currency, or progression.

export const POSTMATCH_ROLES = Object.freeze([
  'ARCHITECT', 'BREACHER', 'VANGUARD', 'ANCHOR', 'SCOUT',
]);

const specialty = (row, key) => Math.max(0, Number(row?.specialties?.[key]) || 0);

// The classifier intentionally uses existing authoritative contribution rows
// only. Ties resolve in a fixed order, and every row receives one descriptive
// role so the results copy never becomes a free-form personality judgement.
export function classifyRole(row = {}) {
  const terrain = specialty(row, 'terrain');
  const sniper = specialty(row, 'sniper');
  const objective = Math.max(0, Number(row.objective) || 0);
  const kills = Math.max(0, Number(row.k) || 0);
  const assists = Math.max(0, Number(row.a) || 0);
  const deaths = Math.max(0, Number(row.d) || 0);
  if (sniper > 0 && sniper >= terrain && sniper >= objective && sniper >= kills)
    return 'SCOUT';
  if (terrain >= 25 && terrain >= objective && terrain >= kills + assists)
    return 'BREACHER';
  if (terrain > 0 && terrain >= objective)
    return 'ARCHITECT';
  if (objective > 0 && objective + assists >= kills && deaths <= kills + 2)
    return 'ANCHOR';
  return 'VANGUARD';
}

export function classifyRoles(entries = []) {
  return entries.map(([key, row]) => ({
    key: String(key), name: String(row?.name ?? ''), team: row?.team === 'blue' ? 'blue' : 'green',
    role: classifyRole(row),
  }));
}

export function roleLabel(role) {
  return POSTMATCH_ROLES.includes(role) ? role : 'VANGUARD';
}

const humanKey = key => typeof key === 'string' && /^p\d+$/.test(key);

// A commendation is offered only to an eligible same-team human. The host
// applies this same predicate to the untrusted target key/index.
export function eligibleCommendationTargets(entries = [], voterKey) {
  const rows = classifyRoles(entries);
  const voter = rows.find(row => row.key === voterKey);
  if (!voter) return [];
  return rows.filter(row => humanKey(row.key) && row.key !== voterKey && row.team === voter.team);
}

export function recordCommendation(state = {}, voterKey, targetKey, entries = []) {
  const voters = state.voters instanceof Set ? state.voters : new Set(state.voters ?? []);
  const counts = state.counts instanceof Map ? state.counts : new Map(state.counts ?? []);
  if (!humanKey(voterKey) || voters.has(voterKey)) return { accepted: false, voters, counts };
  if (!eligibleCommendationTargets(entries, voterKey).some(row => row.key === targetKey))
    return { accepted: false, voters, counts };
  voters.add(voterKey);
  counts.set(targetKey, (counts.get(targetKey) ?? 0) + 1);
  return { accepted: true, voters, counts };
}

export function normalizeCommendationState(voters = [], counts = []) {
  const validVoters = [...new Set((Array.isArray(voters) ? voters : []).filter(humanKey))].slice(0, 10);
  const validCounts = (Array.isArray(counts) ? counts : []).filter(row =>
    Array.isArray(row) && row.length === 2 && humanKey(row[0])
      && Number.isInteger(row[1]) && row[1] >= 0 && row[1] <= 10)
    .slice(0, 10);
  return { voters: validVoters, counts: validCounts };
}

export const RIVALRY_MAX_HUMANS = 10;

export function rivalryDisposition({ active = [], opted = [], ready = [] } = {}) {
  const humans = [...new Set((Array.isArray(active) ? active : []).filter(humanKey))].slice(0, RIVALRY_MAX_HUMANS);
  const optSet = new Set((Array.isArray(opted) ? opted : []).filter(key => humans.includes(key)));
  const readySet = new Set((Array.isArray(ready) ? ready : []).filter(key => humans.includes(key)));
  return {
    eligible: humans.length >= 2,
    unanimous: humans.length >= 2 && humans.every(key => optSet.has(key)),
    ready: humans.length >= 2 && humans.every(key => readySet.has(key)),
    active: humans.length >= 2 && humans.every(key => optSet.has(key))
      && humans.every(key => readySet.has(key)),
  };
}

export function terrainSample(world, { width = 16, depth = 16 } = {}) {
  const w = Math.max(1, Math.min(32, Math.floor(width)));
  const d = Math.max(1, Math.min(32, Math.floor(depth)));
  const maxX = Math.max(1, Number(world?.sizeX ?? world?.sx ?? 256));
  const maxZ = Math.max(1, Number(world?.sizeZ ?? world?.sz ?? 256));
  const occupancy = [], heights = [];
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
    const wx = Math.min(maxX - 1, Math.floor((x + .5) * maxX / w));
    const wz = Math.min(maxZ - 1, Math.floor((z + .5) * maxZ / d));
    let top = 0;
    if (typeof world?.surface === 'function') top = Number(world.surface(wx, wz)) || 0;
    let occupied = 0;
    if (typeof world?.get === 'function') occupied = world.get(wx, Math.floor(top), wz) ? 1 : 0;
    occupancy.push(occupied); heights.push(Math.max(0, Math.min(255, Math.floor(top))));
  }
  return Object.freeze({ width: w, depth: d, occupancy, heights });
}

export function terrainEvolution(before, after) {
  if (!before || !after || before.width !== after.width || before.depth !== after.depth)
    return { changed: 0, total: 0, ratio: 0 };
  let changed = 0;
  for (let i = 0; i < before.occupancy.length; i++)
    if (before.occupancy[i] !== after.occupancy[i] || before.heights[i] !== after.heights[i]) changed++;
  const total = before.width * before.depth;
  return { changed, total, ratio: total ? changed / total : 0 };
}

export function terrainHighlights(metrics = {}, engineering = {}) {
  const m = metrics ?? {}, e = engineering ?? {};
  const candidates = [];
  if ((m.collapseKills ?? 0) > 0) candidates.push([100, 'COLLAPSE TURNED THE FIGHT']);
  if ((m.collapsed ?? 0) >= 16) candidates.push([90, 'STRUCTURE COLLAPSED']);
  if ((e.route ?? 0) > 0) candidates.push([80, 'ROUTES OPENED AND USED']);
  if ((e.breach ?? 0) > 0) candidates.push([70, 'BREACHES OPENED']);
  if ((e.cover ?? 0) + (e.sightline ?? 0) > 0) candidates.push([60, 'TEAM COVER CHANGED THE FIGHT']);
  if ((m.built ?? 0) >= 12 && (m.removed ?? 0) >= 12) candidates.push([50, 'BATTLEFIELD REWRITTEN']);
  if ((m.built ?? 0) >= 12) candidates.push([40, 'FORTIFICATIONS ROSE']);
  if ((m.removed ?? 0) >= 12) candidates.push([30, 'NEW ROUTES OPENED']);
  return candidates.sort((a, b) => b[0] - a[0]).slice(0, 2).map(([, text]) => text);
}
