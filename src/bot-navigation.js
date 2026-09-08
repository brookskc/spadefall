// bot-navigation.js — goal selection, patrol routing, and obstacle planning.
// The Bot class owns the per-frame orchestration; these helpers own the
// navigation algorithms and receive the small world-policy context they need.
import { CTF_CLOSE_SUPPORT_RANGE, CTF_FINAL_APPROACH_RANGE, chooseLocalRoute,
  ctfFinalApproachPolicy, hillPost } from './bot-rules.js';

const CROWN_INDEX = 4;
const CROWN_CENTER = 128;
const CROWN_INNER_GATE = 12;
const CROWN_OUTER_GATE = 40;
const CROWN_GATE_REACHED = 4;

const planarDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const crownCardinal = point => {
  const dx = point.x - CROWN_CENTER, dz = point.z - CROWN_CENTER;
  if (Math.abs(dx) >= Math.abs(dz)) return dx < 0 ? 'west' : 'east';
  return dz < 0 ? 'north' : 'south';
};
const crownGate = (direction, radius) => ({
  x: CROWN_CENTER + (direction === 'west' ? -radius : direction === 'east' ? radius : 0),
  z: CROWN_CENTER + (direction === 'north' ? -radius : direction === 'south' ? radius : 0),
});

// Crown's moat and ring fort are intentional topology, not generic local
// obstacles. A four-block feeler cannot discover a gate around either one,
// so provide only the next authored checkpoint. The ordinary local planner
// and combat movement still own every step between these points.
export function crownRouteWaypoint(position, target, mapIndex = 0) {
  if (mapIndex !== CROWN_INDEX || !position || !target
      || ![position.x, position.z, target.x, target.z].every(Number.isFinite)) return null;
  const center = { x: CROWN_CENTER, z: CROWN_CENTER };
  const currentRadius = planarDistance(position, center);
  const targetRadius = planarDistance(target, center);
  const currentDirection = crownCardinal(position);
  const targetDirection = crownCardinal(target);

  if (currentRadius > CROWN_OUTER_GATE - 2) {
    // Two points already outside on the same side do not cross the moat.
    // This also releases a bot that has just finished exiting a causeway.
    if (targetRadius > CROWN_OUTER_GATE - 2 && currentDirection === targetDirection)
      return null;
    const outer = crownGate(currentDirection, CROWN_OUTER_GATE);
    if (planarDistance(position, outer) > CROWN_GATE_REACHED) return outer;
    return crownGate(currentDirection, CROWN_INNER_GATE);
  }

  // In the moat/skirt, finish the current radial causeway before choosing a
  // different exit. This prevents diagonal shortcuts through the water.
  if (currentRadius > CROWN_INNER_GATE + 2) {
    const inner = crownGate(currentDirection, CROWN_INNER_GATE);
    if (planarDistance(position, inner) > CROWN_GATE_REACHED) return inner;
  }

  if (targetRadius <= 18) return null; // already through the ring gate
  const innerExit = crownGate(targetDirection, CROWN_INNER_GATE);
  if (planarDistance(position, innerExit) > CROWN_GATE_REACHED) return innerExit;
  const outerExit = crownGate(targetDirection, CROWN_OUTER_GATE);
  return planarDistance(position, outerExit) > CROWN_GATE_REACHED ? outerExit : null;
}

export function authoredRouteGoal(bot, target, context) {
  const waypoint = crownRouteWaypoint(bot?.body?.pos, target, bot?.game?.mapIndex);
  if (!waypoint) return target;
  return new context.THREE.Vector3(waypoint.x,
    bot.game.world.surface(Math.floor(waypoint.x), Math.floor(waypoint.z)), waypoint.z);
}

// Perpendicular offset so a team advances on a broad front instead of
// single file down the middle of the map.
export function laned(bot, pos, context) {
  const v = pos.clone ? pos.clone() : new context.THREE.Vector3(pos.x, pos.y ?? 0, pos.z);
  // Tapers the lane spread to zero as the destination gets close, rather
  // than holding a fixed lane offset (+-18, see the constructor) all
  // the way in. The spread is good for crossing open midfield without
  // bunching up — that's the whole reason lanes exist — but the enemy
  // base's perimeter wall (buildBase, mapgen.js) only opens gates
  // within 2 units of the flag's own z. A full 18-unit lane offset
  // points two-thirds of attacking bots at solid wall instead of a
  // gate or the flag itself — and goal() keeps recomputing that same
  // offset point every frame, so a bot stuck on it never moves off,
  // just digs at whatever's in front of it indefinitely. Full offset
  // stays in beyond ~35 units out (still spread crossing the field);
  // zero within 15 (already converged well before the wall's own
  // 9-unit radius comes into play).
  // In CTF, convergence is based on forward distance to the flag line. Using
  // Euclidean distance made the lane offset count against itself: a flanker
  // 44 blocks north of the stand remained "far away" forever and patrolled
  // beside the bunker instead of entering its gate.
  const d = bot.game.gameMode === 'ctf'
    ? Math.abs(v.x - bot.body.pos.x)
    : Math.hypot(v.x - bot.body.pos.x, v.z - bot.body.pos.z);
  const taper = Math.min(1, Math.max(0, (d - 15) / 20));
  let lane = bot.lane;
  if (bot.game.gameMode === 'ctf') {
    // Keep a broad crossing front without sending flankers beyond the
    // navigable approaches on the narrower authored bases.  They still
    // converge by forward distance below; this is a policy width, not a map
    // route or hidden waypoint.
    if (bot.tacticalRole === 'flank-left') lane = -32;
    else if (bot.tacticalRole === 'flank-right') lane = 32;
    else if (bot.tacticalRole === 'attack') lane = 0;
  }
  v.z += lane * taper;
  return v;
}

// Living non-carrier teammates sorted by id — stable ranks for roles.
function rank(bot) {
  const mates = bot.game.bots
    .filter(b => b.alive && b.team === bot.team && !b.carrier)
    .sort((a, b) => a.id - b.id);
  return mates.indexOf(bot);
}

// Deathmatch has no flag to chase, so hunt the freshest sign of the enemy
// (gunfire, kills, sightings — the game's intel feed). No intel? Roam.
function huntGoal(bot, context) {
  const g = bot.game, b = bot.body;
  const spot = g.huntSpot(bot.team, b.pos, bot.difficulty.hearing);
  if (spot) {
    const d = Math.hypot(spot.x - b.pos.x, spot.z - b.pos.z);
    // Stood on the spot and nobody's here — the trail is cold. Scratch it
    // off for the whole team so nobody else camps an empty corner.
    if (d < 9 && !bot.target) { g.consumeIntel(bot.team, spot, 16); return patrolGoal(bot, context); }
    const hunt = new context.THREE.Vector3(spot.x, g.world.surface(spot.x | 0, spot.z | 0), spot.z);
    if (bot.tacticalRole === 'flank-left') hunt.z -= 12;
    if (bot.tacticalRole === 'flank-right') hunt.z += 12;
    hunt.z = Math.max(2, Math.min(context.SZ - 2, hunt.z));
    return laned(bot, hunt, context);
  }
  return patrolGoal(bot, context);
}

// Roam the contested middle band, biased toward the enemy half — a patrol,
// not a camp. Fresh waypoint on arrival or on a timeout.
function patrolGoal(bot, context) {
  const b = bot.body, w = bot.game.world, envelope = context.mapEnvelope(bot.game.mapIndex);
  const arrived = bot.patrol && Math.hypot(bot.patrol.x - b.pos.x, bot.patrol.z - b.pos.z) < 7;
  if (!bot.patrol || arrived || bot.patrolT <= 0) {
    bot.patrolT = 18;
    for (let tries = 0; tries < 8; tries++) {
      const advance = 0.24 + Math.random() * 0.52;
      const px = bot.heading > 0
        ? envelope.minX + advance * (envelope.maxX - envelope.minX)
        : envelope.maxX - advance * (envelope.maxX - envelope.minX);
      const flank = (Math.random() - 0.5) * (envelope.maxZ - envelope.minZ) * 0.72;
      const taper = Math.min(1, Math.abs(px - (envelope.minX + envelope.maxX) / 2)
        / ((envelope.maxX - envelope.minX) * 0.32));
      const p = context.clampToEnvelope(envelope, px,
        (envelope.minZ + envelope.maxZ) / 2 + flank * (1 - taper * 0.6), 5);
      const pz = p.z;
      if (w.surface(px | 0, pz | 0) < context.SEA) continue; // don't patrol the sea
      bot.patrol = new context.THREE.Vector3(px, w.surface(px | 0, pz | 0), pz);
      break;
    }
    bot.patrol ??= new context.THREE.Vector3(context.SX / 2, w.surface(context.SX / 2, context.SZ / 2), context.SZ / 2);
  }
  return laned(bot, bot.patrol, context);
}

// Team-colored masonry overhead is a structure somebody built — and the
// collapse system can drop it. Don't camp under what you can't vouch for.
export function hasOverhead(bot, { BLOCK }) {
  const w = bot.game.world, b = bot.body;
  const fx = Math.floor(b.pos.x), fy = Math.floor(b.pos.y), fz = Math.floor(b.pos.z);
  for (let dy = 3; dy <= 6; dy++) {
    const v = w.get(fx, fy + dy, fz);
    if (v === BLOCK.BLUE || v === BLOCK.GREEN) return true;
  }
  return false;
}

function orderGoal(bot, context) {
  const order = bot.game.activeBotOrder?.(bot.team);
  if (!order || !order.responders?.includes(bot.id)
      || bot.carrier || ['recover', 'escort'].includes(bot.tacticalRole)) {
    bot.orderId = null;
    return null;
  }
  bot.orderId = order.id;
  return new context.THREE.Vector3(order.x,
    bot.game.world.surface(Math.floor(order.x), Math.floor(order.z)), order.z);
}

// Select the strategic destination. Recovery, explicit squad orders, hills,
// and CTF roles all outrank ordinary patrol/advance behavior.
export function goal(bot, context) {
  const g = bot.game;
  bot.responding = false;
  if (bot.carrier) return g.standOf(bot.team);                   // run it home
  const own = g.flags?.[bot.team];
  // Flag recovery outranks a voluntary squad order. The director assigns
  // only the closest pair, so the rest of the squad can still obey humans.
  if (own?.state === 'carried' || own?.state === 'dropped') {
    const emergency = own.state === 'dropped' ? own.pos
      : g.huntSpot(bot.team, bot.body.pos, bot.difficulty.hearing)
        ?? g.standOf(bot.team).clone().lerp(g.standOf(g.enemyOf(bot.team)), 0.5);
    if (bot.tacticalRole === 'recover' && emergency) {
      bot.responding = true;
      return new context.THREE.Vector3(emergency.x,
        g.world.surface(Math.floor(emergency.x), Math.floor(emergency.z)), emergency.z);
    }
  }
  const ordered = orderGoal(bot, context);
  if (ordered) return ordered;
  if (g.hill) {
    // Occupy a stable post INSIDE the hill instead of sending ten bodies to
    // the exact center coordinate. This reduces bunching and makes control
    // look like a squad holding ground rather than one tangled voxel stack.
    const post = hillPost({ x: g.hill.pos.x, z: g.hill.pos.z, r: g.hill.r },
      bot.id, bot.team);
    if (post) {
      // Flankers enter on opposite shoulders before converging; anchors and
      // contesters remain physically inside the scoring radius.
      if (bot.tacticalRole === 'flank-left') post.z -= Math.min(4, g.hill.r * 0.35);
      if (bot.tacticalRole === 'flank-right') post.z += Math.min(4, g.hill.r * 0.35);
      return new context.THREE.Vector3(post.x,
        g.world.surface(Math.floor(post.x), Math.floor(post.z)), post.z);
    }
    return g.hill.pos;
  }
  if (!own) {
    bot.role = 'attack';
    const target = huntGoal(bot, context);
    return target;
  }     // deathmatch: hunt
  // The host-side director assigns stable, mode-aware roles. The rank-based
  // fallback keeps old migrated bot rows safe until the first director tick.
  const botRank = rank(bot);
  bot.role = bot.tacticalRole
    ?? (botRank === 0 ? 'defend' : botRank === 1 ? 'mid' : 'attack');
  if (bot.role === 'escort') {
    const carrier = g.entities().find(e => e !== bot && e.alive
      && e.team === bot.team && e.carrier);
    const stagingRunner = !carrier ? g.bots.filter(e => e !== bot && e.alive
      && e.team === bot.team && !e.carrier && Number.isFinite(e.ctfStageAt))
      .sort((a, b) => a.ctfStageAt - b.ctfStageAt || a.id - b.id)[0] : null;
    const runner = carrier ?? stagingRunner;
    if (runner) {
      const home = g.standOf(bot.team);
      const toward = (carrier ? home : g.standOf(g.enemyOf(bot.team))).clone()
        .sub(runner.body.pos).setY(0);
      if (toward.lengthSq() > 0.01) toward.normalize();
      const side = new context.THREE.Vector3(-toward.z, 0, toward.x)
        .multiplyScalar(bot.id % 2 ? 2.5 : -2.5);
      // Before pickup, close to the runner's shoulder; once it has the flag,
      // screen several blocks ahead on the route home.
      return runner.body.pos.clone().addScaledVector(toward, carrier ? 4 : 1.5).add(side);
    }
  }
  if (bot.role === 'defend') return laned(bot, g.standOf(bot.team), context);
  if (bot.role === 'mid')
    return laned(bot, new context.THREE.Vector3(context.SX / 2, g.world.surface(context.SX / 2, context.SZ / 2), context.SZ / 2), context);
  const enemyFlag = g.flags[g.enemyOf(bot.team)];
  if (enemyFlag.state === 'dropped') return enemyFlag.pos;         // grab the loose flag
  const supportDistance = g.entities().filter(entity => entity !== bot
    && entity.alive && entity.team === bot.team)
    .reduce((nearest, entity) => Math.min(nearest,
      Math.hypot(entity.body.pos.x - bot.body.pos.x, entity.body.pos.z - bot.body.pos.z)), Infinity);
  const distanceToFlag = Math.hypot(enemyFlag.home.x - bot.body.pos.x,
    enemyFlag.home.z - bot.body.pos.z);
  if (distanceToFlag > CTF_FINAL_APPROACH_RANGE) bot.ctfStageAt = -Infinity;
  const stagedSeconds = Number.isFinite(bot.ctfStageAt) ? g.time - bot.ctfStageAt : 0;
  const approach = ctfFinalApproachPolicy({
    distanceToFlag,
    nearestSupportDistance: supportDistance, stagedSeconds,
    escalation: g._ctfEscalation?.active,
  });
  if (approach === 'stage') {
    if (!Number.isFinite(bot.ctfStageAt)) bot.ctfStageAt = g.time;
    // Hold just outside the stand instead of repeatedly brushing the pickup
    // radius. This is a local formation position, not a scripted route, and
    // combat steering can still take priority when an enemy is visible.
    const away = bot.body.pos.clone().sub(enemyFlag.home).setY(0);
    if (away.lengthSq() < 0.01) away.set(-bot.heading, 0, 0);
    away.normalize().multiplyScalar(CTF_FINAL_APPROACH_RANGE - 4);
    return enemyFlag.home.clone().add(away);
  }
  if (supportDistance <= CTF_CLOSE_SUPPORT_RANGE || stagedSeconds === 0)
    bot.ctfStageAt = -Infinity;
  return laned(bot, g.standOf(g.enemyOf(bot.team)), context);             // storm their base
}

// Probe several headings around a short obstacle and choose the best clear
// detour using the pure route policy from bot-rules.js.
export function planLocalRoute(bot, direct, fy, context) {
  const w = bot.game.world, b = bot.body;
  const side = bot.id % 2 ? -1 : 1;
  const degrees = [0, 30 * side, -30 * side, 60 * side, -60 * side,
    90 * side, -90 * side];
  const candidates = [];
  for (const deg of degrees) {
    const angle = deg * Math.PI / 180;
    const x = direct.x * Math.cos(angle) - direct.z * Math.sin(angle);
    const z = direct.x * Math.sin(angle) + direct.z * Math.cos(angle);
    let clear = 0, maxStep = 0, maxDrop = 0;
    for (const reach of [1.1, 2.1, 3.1, 4.1]) {
      const px = Math.floor(b.pos.x + x * reach);
      const pz = Math.floor(b.pos.z + z * reach);
      // A one-high obstacle with two cells above it is a step; a two-high
      // face is a wall. Open cells need support no more than two down or the
      // route is a fall/bridge decision handled by the existing rim logic.
      if (w.solid(px, fy, pz)) {
        if (w.solid(px, fy + 1, pz) || w.solid(px, fy + 2, pz)) break;
        maxStep = Math.max(maxStep, 1);
      } else {
        if (w.solid(px, fy + 1, pz)) break;
        let drop = 0;
        for (let y = fy - 1; y >= fy - 3 && !w.solid(px, y, pz); y--) drop++;
        maxDrop = Math.max(maxDrop, drop);
        if (drop > 2) break;
      }
      clear++;
    }
    candidates.push({ angle, x, z, clear, maxStep, maxDrop,
      progress: Math.cos(angle) * clear });
  }
  const best = chooseLocalRoute(candidates);
  return best ? new context.THREE.Vector3(best.x, 0, best.z).normalize() : null;
}
