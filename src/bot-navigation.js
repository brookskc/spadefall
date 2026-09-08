// bot-navigation.js — goal selection, patrol routing, and obstacle planning.
// The Bot class owns the per-frame orchestration; these helpers own the
// navigation algorithms and receive the small world-policy context they need.
import { CTF_CLOSE_SUPPORT_RANGE, CTF_FINAL_APPROACH_RANGE, chooseLocalRoute,
  ctfFinalApproachPolicy, hillPost } from './bot-rules.js';
import { pinefallRavineCenter } from './mapgen.js';

const CROWN_INDEX = 4;
const CROWN_CENTER = 128;
const CROWN_INNER_GATE = 12;
const CROWN_OUTER_GATE = 40;
const CROWN_GATE_REACHED = 4;

const CTF_MIDFIELD = 128;
const CTF_REACHED = 4;
const CTF_ROUTE_X_EAST = Object.freeze([
  Object.freeze([92, 116, 140, 164]),
  Object.freeze([86, 105, 145, 170]),
  // Pinefall's permanent ford itself spans x=122..134. The 146 checkpoint
  // lines up the east-bank approach; x=122 is already dry on the west side.
  // An older x=110 checkpoint kept westbound carriers marching along the
  // ford's fixed z after they had crossed, straight into the meandering
  // ravine bank instead of letting the home vector lead them away.
  Object.freeze([122, 134, 146]),
]);
const CTF_ROUTE_X_WEST = Object.freeze(CTF_ROUTE_X_EAST.map(route =>
  Object.freeze(route.slice().reverse())));
const PINEFALL_INDEX = 2;
const PINEFALL_FORD_MIN_X = 116;
const PINEFALL_FORD_MAX_X = 144;
const PINEFALL_FORD_Z_TOLERANCE = 10;
let cachedBeachheadSeed = null;
let cachedBeachheadZ = null;

// The three CTF maps each have one authored feature that a short-range
// obstacle probe cannot infer reliably: the two Greenbelt hedgerow gaps, the
// Beachhead trench, and Pinefall's protected ford. Keep these routes as a
// small pure policy rather than baking them into the local planner. A route
// is deliberately a sequence of x checkpoints: the carrier commits to one
// checkpoint at a time, then the ordinary planner owns the short movement
// between checkpoints.
const validPlanarPoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.z);

// This is the same value-noise cell used by mapgen's Beachhead generator.
// Only one integer cell is needed for the trench's seed-derived z, so avoid
// constructing a 4096-cell grid on every bot think.
function beachheadTrenchZ(seed = 1979) {
  seed = Number.isFinite(seed) ? Math.trunc(seed) : 1979;
  if (seed === cachedBeachheadSeed) return cachedBeachheadZ;
  const row = ((seed % 13) + 13) % 13;
  const wanted = (row << 6) | 7;
  let state = seed | 0;
  let value = 0;
  for (let i = 0; i <= wanted; i++) {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  cachedBeachheadSeed = seed;
  cachedBeachheadZ = CTF_MIDFIELD + 20 + Math.floor(value * 12);
  return cachedBeachheadZ;
}

function nextRouteCheckpoint(position, routeX, routeZ, homeWest, out = null) {
  for (const x of routeX) {
    const ahead = homeWest ? position.x > x + CTF_REACHED
      : position.x < x - CTF_REACHED;
    if (ahead) {
      if (out) { out.x = x; out.z = routeZ; return out; }
      return { x, z: routeZ };
    }
  }
  return null;
}

/**
 * Return the next authored CTF carrier checkpoint, or null when the carrier
 * is on the unobstructed home-side approach. The path is mirrored in x for
 * the two teams; both teams use the same safe lateral lane on a given seed.
 * This function intentionally returns x/z only. authoredRouteGoal projects
 * that point to the current world surface, so it remains robust to edits and
 * terrain-height variation.
 *
 * The object form is accepted as a convenience for diagnostics and pure
 * tests; the positional form keeps this helper inexpensive in the hot loop.
 */
export function ctfCarrierWaypoint(position, home, mapIndex = 0, team = 'green', seed = 1979,
  out = null) {
  if (position?.position && home === undefined) {
    ({ position, home, mapIndex = 0, team = 'green', seed = 1979 } = position);
  }
  if (![0, 1, 2].includes(mapIndex) || !validPlanarPoint(position)
      || !validPlanarPoint(home) || !['green', 'blue'].includes(team)) return null;
  const homeWest = home.x < CTF_MIDFIELD
    || (home.x === CTF_MIDFIELD && team === 'green');
  // A seeded north/south choice keeps runs from becoming one fixed lane while
  // remaining symmetric: swapping teams mirrors x, not the authored terrain.
  const laneZ = (((Number.isFinite(seed) ? Math.trunc(seed) : 1979) & 1) === 0)
    ? CTF_MIDFIELD + 48 : CTF_MIDFIELD - 48;
  let routeZ;
  if (mapIndex === 0) {
    // Open gap region is z<88 or z>168; x checkpoints straddle both belts.
    routeZ = laneZ;
  } else if (mapIndex === 1) {
    // The covered trench runs x=92..166. These points enter, cross, and exit
    // it with a little margin so exact surface height is never part of policy.
    routeZ = beachheadTrenchZ(seed);
  } else {
    // Pinefall's low protected ford is eight blocks off the seeded ravine
    // center. Approach and leave it on the same z; this also permits the
    // existing bridge/rim logic to take over if players edit the ford.
    routeZ = pinefallRavineCenter(seed, CTF_MIDFIELD) + 8;
  }
  return nextRouteCheckpoint(position,
    (homeWest ? CTF_ROUTE_X_WEST : CTF_ROUTE_X_EAST)[mapIndex], routeZ, homeWest, out);
}

// Descriptive alias for callers that prefer the longer policy name.
export const ctfCarrierRouteWaypoint = ctfCarrierWaypoint;

/**
 * Whether a carrier is still committed to Pinefall's authored low ford.
 *
 * This is deliberately narrower than "the bot is in water": only an active
 * CTF carrier on Pinefall, inside the ford's bounded x/z corridor, receives
 * this exception. Generic wet-land seeking remains authoritative everywhere
 * else, including a carrier that leaves the authored crossing.
 */
export function pinefallCarrierFordCommitted(position, mapIndex = 0,
  seed = 1979, carrier = true, gameMode = 'ctf') {
  if (!carrier || gameMode !== 'ctf' || mapIndex !== PINEFALL_INDEX
      || !validPlanarPoint(position)
      || position.x < PINEFALL_FORD_MIN_X
      || position.x > PINEFALL_FORD_MAX_X) return false;
  const fordZ = pinefallRavineCenter(seed, CTF_MIDFIELD) + 8;
  return Math.abs(position.z - fordZ) <= PINEFALL_FORD_Z_TOLERANCE;
}

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

export function authoredRouteGoal(bot, target, context, out = null) {
  const waypoint = bot?.carrier && bot?.game?.gameMode === 'ctf'
    ? ctfCarrierWaypoint(bot.body.pos, target, bot.game.mapIndex, bot.team, bot.game.seed, out)
    : crownRouteWaypoint(bot?.body?.pos, target, bot?.game?.mapIndex);
  if (!waypoint) {
    if (!out) return target;
    return out.copy ? out.copy(target) : Object.assign(out, target);
  }
  const y = bot.game.world.surface(Math.floor(waypoint.x), Math.floor(waypoint.z));
  if (!out) return new context.THREE.Vector3(waypoint.x, y, waypoint.z);
  return out.set ? out.set(waypoint.x, y, waypoint.z)
    : Object.assign(out, { x: waypoint.x, y, z: waypoint.z });
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
    const carrier = g.teamOf(bot.team).find(e => e !== bot && e.alive && e.carrier);
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
  const supportDistance = g.teamOf(bot.team).filter(entity => entity !== bot && entity.alive)
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
