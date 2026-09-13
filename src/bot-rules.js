// bot-rules.js — pure tactical helpers for the host-side bot controller.
// Kept free of DOM and Three.js so formation and targeting decisions can be
// regression-tested without constructing the rendered game.

// Stable posts inside the capture radius keep a team controlling the same
// objective without stacking every soldier at one exact coordinate. Opposing
// teams use interleaved rings, producing a readable skirmish around the point.
export function hillPost(hill, id, team) {
  if (!hill || ![hill.x, hill.z, hill.r].every(Number.isFinite) || hill.r <= 0)
    return null;
  const slot = Math.abs(Number.isInteger(id) ? id : 0) % 5;
  const radius = Math.min(4.5, Math.max(1.5, hill.r * 0.55));
  const offset = team === 'blue' ? Math.PI / 5 : 0;
  const angle = slot / 5 * Math.PI * 2 + offset;
  return { x: hill.x + Math.cos(angle) * radius,
    z: hill.z + Math.sin(angle) * radius };
}

// Lower is better. A modest current-target bonus creates hysteresis: bots do
// not reset their reaction timer because another enemy became a fraction of a
// block closer, but a flag carrier or badly wounded target can still earn a
// deliberate switch.
export function botTargetScore(distance, health = 100, carrier = false,
  current = false) {
  if (![distance, health].every(Number.isFinite)) return Infinity;
  return distance - (carrier ? 20 : 0) - Math.max(0, 100 - health) * 0.15
    - (current ? 5 : 0);
}

// Repulsion direction for nearby allies. The caller blends this with its
// tactical movement vector; returning zero means no separation is needed.
export function botSeparation(position, allies, selfId, radius = 2.4, out = null) {
  const result = out ?? { x: 0, z: 0 };
  result.x = 0; result.z = 0;
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)
      || !Array.isArray(allies) || !Number.isFinite(radius) || radius <= 0)
    return result;
  let x = 0, z = 0;
  for (const ally of allies) {
    const allyPos = ally?.body?.pos ?? ally;
    const allyId = ally?.id ?? ally?.ridx ?? ally?.name;
    if (!ally || allyId === selfId || ally.alive === false
        || !Number.isFinite(allyPos?.x) || !Number.isFinite(allyPos?.z)) continue;
    let dx = position.x - allyPos.x, dz = position.z - allyPos.z;
    let d = Math.hypot(dx, dz);
    if (d >= radius) continue;
    if (d < 1e-4) {
      const angle = ((Number(selfId) || 0) * 2.399963 + (Number(allyId) || 0)) % (Math.PI * 2);
      dx = Math.cos(angle); dz = Math.sin(angle); d = 1;
    }
    const weight = (radius - d) / radius;
    x += dx / d * weight; z += dz / d * weight;
  }
  const length = Math.hypot(x, z);
  if (length > 1e-6) { result.x = x / length; result.z = z / length; }
  return result;
}

// Difficulty changes how quickly and accurately a bot processes information;
// it never changes damage, health, movement speed, vision range, or access to
// hidden state. That keeps hard bots sharper without quietly making them
// superhuman.
export const BOT_DIFFICULTY = Object.freeze({
  easy: Object.freeze({ key: 'easy', reaction: 1.28, aimError: 1.32,
    memory: 1.7, thinkInterval: 0.28, hearing: 30 }),
  normal: Object.freeze({ key: 'normal', reaction: 1, aimError: 1,
    memory: 2.4, thinkInterval: 0.2, hearing: 38 }),
  hard: Object.freeze({ key: 'hard', reaction: 0.78, aimError: 0.78,
    memory: 3.1, thinkInterval: 0.14, hearing: 46 }),
});

export function botDifficulty(key) {
  return BOT_DIFFICULTY[key] ?? BOT_DIFFICULTY.normal;
}

export const BOT_DIFFICULTY_CODES = Object.freeze(['easy', 'normal', 'hard']);
export function botDifficultyCode(key) {
  const code = BOT_DIFFICULTY_CODES.indexOf(botDifficulty(key).key);
  return code < 0 ? 1 : code;
}
export function botDifficultyKey(code) {
  return Number.isInteger(code) ? (BOT_DIFFICULTY_CODES[code] ?? 'normal') : 'normal';
}

const finitePoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.z);
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;

export const BOT_LIFE_EDIT_BUDGET = 12;
export const BOT_EDIT_REFILL_SECONDS = 8;
// Terrain is an emergency tool, not ordinary navigation. A small token bucket
// bounds bursts while replenishing slowly enough that a long-lived bot can
// eventually escape changed terrain instead of becoming permanently inert.
export function botTerrainEditAllowed(bot, { water = false, stuck = 0,
  undermining = false, tacticalBuild = false } = {}) {
  if (!bot || !Number.isFinite(bot._editTokens) || bot._editTokens < 1) return false;
  return water || undermining || stuck >= 2 || tacticalBuild;
}

export const smgClosingIntent = (gunClass, distance, visible = true) =>
  gunClass === 1 && visible && Number.isFinite(distance) && distance > 14;

// A final flag pickup is the one place a broad "someone is in the area"
// grouping rule is not enough: the carrier is immediately exposed leaving the
// stand.  Stage briefly for a teammate who can actually cover that exit, then
// fall back to an ordinary advance so a split team cannot wait forever.
export const CTF_FINAL_APPROACH_RANGE = 24;
export const CTF_CLOSE_SUPPORT_RANGE = 14;
export const CTF_STAGE_FALLBACK_SECONDS = 12;
// No support anywhere on the field (a split or dead team reports Infinity):
// waiting the full fallback in the enemy base is just feeding. Grab and go.
export const CTF_STAGE_LONE_FALLBACK_SECONDS = 6;
/** @param {{ distanceToFlag?: number, nearestSupportDistance?: number,
 * stagedSeconds?: number, escalation?: boolean }} context */
export function ctfFinalApproachPolicy({ distanceToFlag, nearestSupportDistance,
  stagedSeconds = 0, escalation = false } = {}) {
  if (!Number.isFinite(distanceToFlag) || distanceToFlag > CTF_FINAL_APPROACH_RANGE)
    return 'advance';
  if (Number.isFinite(nearestSupportDistance)
      && nearestSupportDistance <= CTF_CLOSE_SUPPORT_RANGE)
    return 'advance';
  const fallback = nearestSupportDistance === Infinity
    ? CTF_STAGE_LONE_FALLBACK_SECONDS : CTF_STAGE_FALLBACK_SECONDS;
  if (escalation || (Number.isFinite(stagedSeconds)
      && stagedSeconds >= fallback)) return 'advance';
  return 'stage';
}

// Once line of sight breaks, aim and movement use this fading last-known
// position rather than reading the live entity. The deterministic drift models
// uncertainty while keeping replays and tests stable.
export function rememberedEnemyPosition(sighting, now, memorySeconds, id = 0) {
  if (!finitePoint(sighting) || !Number.isFinite(sighting.t)
      || !Number.isFinite(now) || !Number.isFinite(memorySeconds)
      || memorySeconds <= 0) return null;
  const age = Math.max(0, now - sighting.t);
  if (age > memorySeconds) return null;
  const confidence = Math.max(0, 1 - age / memorySeconds);
  const uncertainty = (1 - confidence) * 3.5;
  const angle = ((Number(id) || 0) * 2.399963 + sighting.t * 0.37) % (Math.PI * 2);
  return { x: sighting.x + Math.cos(angle) * uncertainty,
    y: Number.isFinite(sighting.y) ? sighting.y : 0,
    z: sighting.z + Math.sin(angle) * uncertainty, confidence };
}

// A lightweight team director. Roles are recalculated from authoritative
// objective state, but assigned by stable id when proximity is not important,
// preventing bots from swapping jobs every frame.
export function assignBotRoles(mode, bots, context = {}) {
  const living = (Array.isArray(bots) ? bots : [])
    .filter(b => b && b.alive !== false && Number.isInteger(b.id) && finitePoint(b))
    .sort((a, b) => a.id - b.id);
  const roles = Object.fromEntries(living.map(b => [b.id, 'attack']));
  if (!living.length) return roles;

  const nearest = (point, pool = living) => finitePoint(point)
    ? [...pool].sort((a, b) => dist2(a, point) - dist2(b, point) || a.id - b.id)
    : [...pool];
  const unassigned = used => living.filter(b => !used.has(b.id) && !b.carrier);
  const set = (bot, role, used) => {
    if (!bot) return;
    roles[bot.id] = role;
    used.add(bot.id);
  };

  if (mode === 'koth') {
    const byHill = nearest(context.hill);
    if (byHill[0]) roles[byHill[0].id] = 'anchor';
    for (const b of byHill.slice(1, 3)) roles[b.id] = 'contest';
    for (const b of byHill.slice(3)) roles[b.id] = b.id % 2 ? 'flank-left' : 'flank-right';
    return roles;
  }

  if (mode === 'tdm') {
    roles[living[0].id] = 'support';
    for (const b of living.slice(1))
      roles[b.id] = b.id % 3 === 1 ? 'flank-left' : b.id % 3 === 2 ? 'flank-right' : 'pressure';
    return roles;
  }

  const used = new Set();
  if (context.ownFlagEmergency && finitePoint(context.ownFlag))
    for (const b of nearest(context.ownFlag).slice(0, 2)) set(b, 'recover', used);
  if (finitePoint(context.friendlyCarrier)) {
    // A pre-pickup staging runner is not technically a carrier yet. Reserve
    // its explicit id so it cannot be selected as its own zero-distance
    // escort; its existing attack role keeps it committed to the flag.
    if (Number.isInteger(context.friendlyCarrierId)) used.add(context.friendlyCarrierId);
    const escortCap = living.length >= 5 ? 2 : 1;
    for (const b of nearest(context.friendlyCarrier, unassigned(used)).slice(0, escortCap))
      set(b, 'escort', used);
  }
  set(nearest(context.ownStand, unassigned(used))[0], 'defend', used);
  set(nearest(context.midfield, unassigned(used))[0], 'mid', used);
  const attackers = unassigned(used);
  for (let i = 0; i < attackers.length; i++) {
    roles[attackers[i].id] = attackers.length >= 3
      ? ['flank-left', 'attack', 'flank-right'][i] : 'attack';
  }
  return roles;
}

// Human orders are intentionally bounded: only the nearest few bots peel off,
// and flag carriers/recovery teams keep their critical jobs.
export function botsForSquadOrder(bots, order, limit = 2) {
  if (!finitePoint(order) || !Array.isArray(bots)) return [];
  return bots.filter(b => b?.alive !== false && !b?.carrier
      && !['recover', 'escort'].includes(b?.role))
    .sort((a, b) => dist2(a, order) - dist2(b, order) || a.id - b.id)
    .slice(0, Math.max(0, Math.floor(limit)))
    .map(b => b.id);
}

// Round-robin scheduling limits expensive perception/route decisions while
// physics and presentation continue every frame. Overdue bots remain due and
// are selected on the next frame, so the budget cannot starve one soldier.
export function scheduleBotBrains(bots, now, cursor = 0, budget = 3) {
  const list = Array.isArray(bots) ? bots : [];
  const ids = [];
  if (!list.length || !Number.isFinite(now) || budget <= 0)
    return { ids, cursor: 0 };
  let checked = 0, i = ((cursor % list.length) + list.length) % list.length;
  while (checked < list.length && ids.length < budget) {
    const bot = list[i];
    if (bot && bot.alive !== false && now >= (Number(bot.nextThink) || 0)) ids.push(bot.id);
    i = (i + 1) % list.length;
    checked++;
  }
  return { ids, cursor: i };
}

// Physics updates are intentionally rotated independently from the expensive
// brain budget. A fixed array order lets the first team consistently apply
// damage or claim an objective before the other team sees the new state; a
// deterministic one-seat rotation preserves replayability while sharing both
// early and late positions across every bot over time.
export function rotatingBotOrder(bots, frame = 0) {
  const list = Array.isArray(bots) ? bots.filter(Boolean) : [];
  if (!list.length) return [];
  const start = ((Math.floor(Number(frame) || 0) % list.length) + list.length) % list.length;
  return list.slice(start).concat(list.slice(0, start));
}

// Candidates are generated by the rendered controller because it owns the
// voxel world. This pure scorer chooses the route that makes useful forward
// progress with clear headroom and tolerable steps/drops.
export function chooseLocalRoute(candidates) {
  const valid = (Array.isArray(candidates) ? candidates : [])
    .filter(c => c && Number.isFinite(c.angle) && Number.isFinite(c.clear)
      && Number.isFinite(c.progress) && c.clear > 0 && c.maxStep <= 1 && c.maxDrop <= 2)
    .map(c => ({ ...c, score: c.clear * 2.2 + c.progress * 3
      - Math.abs(c.angle) * 0.45 - c.maxDrop * 0.7 }));
  valid.sort((a, b) => b.score - a.score || Math.abs(a.angle) - Math.abs(b.angle));
  return valid[0] ?? null;
}

export function botTelemetrySummary(rows) {
  const valid = (Array.isArray(rows) ? rows : []).filter(r => r && Number.isFinite(r.thinkMs));
  if (!valid.length) return { samples: 0, averageThinkMs: 0, maxThinkMs: 0,
    stuckRecoveries: 0, objectiveSeconds: 0 };
  return { samples: valid.length,
    averageThinkMs: valid.reduce((n, r) => n + r.thinkMs, 0) / valid.length,
    maxThinkMs: Math.max(...valid.map(r => r.thinkMs)),
    stuckRecoveries: valid.reduce((n, r) => n + (r.stuckRecoveries || 0), 0),
    objectiveSeconds: valid.reduce((n, r) => n + (r.objectiveSeconds || 0), 0) };
}
