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
export function botSeparation(position, allies, selfId, radius = 2.4) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)
      || !Array.isArray(allies) || !Number.isFinite(radius) || radius <= 0)
    return { x: 0, z: 0 };
  let x = 0, z = 0;
  for (const ally of allies) {
    if (!ally || ally.id === selfId || ally.alive === false
        || !Number.isFinite(ally.x) || !Number.isFinite(ally.z)) continue;
    let dx = position.x - ally.x, dz = position.z - ally.z;
    let d = Math.hypot(dx, dz);
    if (d >= radius) continue;
    if (d < 1e-4) {
      const angle = ((Number(selfId) || 0) * 2.399963 + (Number(ally.id) || 0)) % (Math.PI * 2);
      dx = Math.cos(angle); dz = Math.sin(angle); d = 1;
    }
    const weight = (radius - d) / radius;
    x += dx / d * weight; z += dz / d * weight;
  }
  const length = Math.hypot(x, z);
  return length > 1e-6 ? { x: x / length, z: z / length } : { x: 0, z: 0 };
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
  if (finitePoint(context.friendlyCarrier))
    set(nearest(context.friendlyCarrier, unassigned(used))[0], 'escort', used);
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
