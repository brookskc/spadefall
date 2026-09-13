// Headless procedural-map soak. No browser, WebGL context, or DOM is needed:
// VoxelWorld's CPU terrain/storage path is enough to exercise routes; mesh
// creation is deliberately skipped so hundreds of seeds remain practical.
//
// Default: 4 deterministic seeds × 8 maps. For a longer release soak:
//   npm run test:fuzz -- --seeds=2000
// MAP_FUZZ_SEEDS / MAP_FUZZ_START remain available for CI matrices.
import * as THREE from 'three';
import { VoxelWorld, SEA, SX, SZ, PALETTE } from '../src/world.js';
import { BASE, MAPS, envelopeContains, generateMap, mapEnvelope,
  pinefallRavineCenter, signatureProtectedAreas } from '../src/mapgen.js';

const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))
  ?.slice(name.length + 3);
const count = Math.max(1, Number.parseInt(argument('seeds')
  ?? process.env.MAP_FUZZ_SEEDS ?? '4', 10) || 4);
const start = Number.parseInt(argument('start')
  ?? process.env.MAP_FUZZ_START ?? '1000', 10) || 1000;
const step = 7919;
const rectangularMaps = new Set([0, 1, 2, 6]);
const GRID_CACHE = new WeakMap();
const MAX_STEP_UP = 2;
const MAX_STEP_DOWN = 4;
const MAX_WATER_DROP = 6;
const MIN_ISOLATED_POCKET = 512;

function fail(mapIndex, seed, invariant, detail = '') {
  const name = MAPS[mapIndex]?.name ?? `map-${mapIndex}`;
  throw new Error(`[map-fuzz] map=${name} index=${mapIndex} seed=${seed} `
    + `invariant=${invariant}${detail ? ` detail=${detail}` : ''}`);
}

function check(condition, mapIndex, seed, invariant, detail = '') {
  if (!condition) fail(mapIndex, seed, invariant, detail);
}

function spawnPoint(team, world) {
  const b = BASE[team], dir = team === 'green' ? 1 : -1;
  const x = Math.round(b.x + dir * 12), z = Math.round(b.z);
  return { x, z, surface: world.surface(x, z) };
}

function makeGrid(world, envelope) {
  const cached = GRID_CACHE.get(world);
  if (cached) return cached;
  const size = SX * SZ;
  const heights = new Int16Array(size);
  heights.fill(-999);
  const water = new Uint8Array(size);
  for (let z = envelope.minZ + 1; z < envelope.maxZ; z++) {
    for (let x = envelope.minX + 1; x < envelope.maxX; x++) {
      if (!envelopeContains(envelope, x, z, 1)) continue;
      const surface = world.surface(x, z), i = z * SX + x;
      const isWater = surface < SEA;
      if (!isWater && (world.solid(x, surface + 1, z)
          || world.solid(x, surface + 2, z))) continue;
      heights[i] = isWater ? SEA : surface;
      water[i] = isWater ? 1 : 0;
    }
  }
  const grid = { envelope, heights, water };
  GRID_CACHE.set(world, grid);
  return grid;
}

function gridColumn(grid, x, z) {
  if (x < 0 || z < 0 || x >= SX || z >= SZ) return null;
  const i = z * SX + x, h = grid.heights[i];
  return h < 0 ? null : { h, water: !!grid.water[i] };
}

function nearestWalkable(world, envelope, point, radius = 8, grid = makeGrid(world, envelope)) {
  for (let r = 0; r <= radius; r++) {
    for (let dz = -r; dz <= r; dz++) for (const dx of [-r, r]) {
      const p = { x: point.x + dx, z: point.z + dz };
      if (gridColumn(grid, p.x, p.z)) return p;
    }
    for (let dx = -r + 1; dx < r; dx++) for (const dz of [-r, r]) {
      const p = { x: point.x + dx, z: point.z + dz };
      if (gridColumn(grid, p.x, p.z)) return p;
    }
  }
  return null;
}

function column(world, envelope, x, z, grid = makeGrid(world, envelope)) {
  return gridColumn(grid, x, z);
}

function walkable(world, envelope, x, z) {
  return !!column(world, envelope, x, z);
}

// Conservative 2-D approximation of the Body's ordinary traversal: one/two
// voxel rises are legal, while water transitions are allowed so the dedicated
// water-exit checks can prove a route remains available.
function reachable(world, envelope, source, target, { allowHazardousDrops = false } = {}) {
  const grid = makeGrid(world, envelope);
  const start = nearestWalkable(world, envelope, source, 8, grid);
  const goal = nearestWalkable(world, envelope, target, 8, grid);
  if (!start || !goal) return false;
  const startKey = `${start.x},${start.z}`, goalKey = `${goal.x},${goal.z}`;
  const queue = [start], seen = new Set([startKey]);
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head], c = column(world, envelope, current.x, current.z, grid);
    if (!c) continue;
    if (`${current.x},${current.z}` === goalKey) return true;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = current.x + dx, z = current.z + dz, key = `${x},${z}`;
      if (seen.has(key)) continue;
      const next = column(world, envelope, x, z, grid);
      if (!next) continue;
      const rise = next.h - c.h, drop = c.h - next.h;
      if (!allowHazardousDrops
          && ((!c.water && !next.water && (rise > MAX_STEP_UP || drop > MAX_STEP_DOWN))
            || (c.water && !next.water && rise > MAX_STEP_UP)
            || (!c.water && next.water && drop > MAX_WATER_DROP))) continue;
      seen.add(key); queue.push({ x, z });
    }
  }
  return false;
}

function hasWaterExit(world, envelope) {
  const grid = makeGrid(world, envelope);
  for (let z = envelope.minZ + 1; z < envelope.maxZ; z++)
    for (let x = envelope.minX + 1; x < envelope.maxX; x++) {
      const here = column(world, envelope, x, z, grid);
      if (!here?.water) continue;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const next = column(world, envelope, x + dx, z + dz, grid);
        if (next && !next.water && next.h - here.h <= MAX_STEP_UP
            && reachable(world, envelope, { x, z }, { x: x + dx, z: z + dz })) return true;
      }
    }
  return false;
}

function protectedRouteReachable(world, envelope, areas) {
  const grid = makeGrid(world, envelope);
  return areas.every(area => {
    const p = nearestWalkable(world, envelope, { x: Math.round(area.x), z: Math.round(area.z) }, 8, grid);
    return !!p;
  });
}

function fallbackEndpoints(mapIndex, seed) {
  const cx = SX / 2, cz = SZ / 2;
  if (mapIndex === 0) return [
    { x: 104, z: cz - 43, kind: 'north-flank' },
    { x: 104, z: cz + 43, kind: 'south-flank' },
  ];
  if (mapIndex === 2) {
    const ravine = Math.round(pinefallRavineCenter(seed, 128));
    return [{ x: 128, z: ravine + 8, kind: 'ford' }];
  }
  if (mapIndex === 4) return [
    { x: cx - 32, z: cz, kind: 'west-causeway' },
    { x: cx + 32, z: cz, kind: 'east-causeway' },
  ];
  if (mapIndex === 5) return [
    { x: cx - 64, z: cz, kind: 'west-saddle' },
    { x: cx + 64, z: cz, kind: 'east-saddle' },
  ];
  if (mapIndex === 6) return [
    { x: cx, z: cz - 48, kind: 'north-catwalk' },
    { x: cx, z: cz + 48, kind: 'south-catwalk' },
  ];
  if (mapIndex === 7) return [
    { x: cx, z: cz - 24, kind: 'north-loop' },
    { x: cx - 24, z: cz, kind: 'west-loop' },
    { x: cx, z: cz + 24, kind: 'south-loop' },
    { x: cx + 24, z: cz, kind: 'east-loop' },
  ];
  return [];
}

function fallbackNetworkReachable(world, envelope, mapIndex, seed, green, blue) {
  const grid = makeGrid(world, envelope);
  return fallbackEndpoints(mapIndex, seed).every(endpoint => {
    const point = nearestWalkable(world, envelope, endpoint, 10, grid);
    return !!point
      && botRouteReachable(world, envelope, green, point)
      && botRouteReachable(world, envelope, point, blue);
  });
}

// This mirrors the bot's cheap local route contract: bounded cardinal steps,
// no arbitrary cliff jumps, and a route from each permanent foundation into
// the same playable component as at least one base. It is intentionally named
// separately from general reachability so future bot-route tests can tighten
// it without changing the world connectivity oracle.
function botRouteReachable(world, envelope, source, target) {
  return reachable(world, envelope, source, target);
}

function sizableWalkablePockets(world, envelope, sources) {
  const grid = makeGrid(world, envelope), seen = new Set(), pockets = [];
  const sourceKeys = new Set(sources.map(p => {
    const nearest = nearestWalkable(world, envelope, p, 8, grid);
    return nearest ? `${nearest.x},${nearest.z}` : `${p.x},${p.z}`;
  }));
  for (let z = envelope.minZ + 1; z < envelope.maxZ; z++) for (let x = envelope.minX + 1; x < envelope.maxX; x++) {
    const key = `${x},${z}`;
    if (seen.has(key) || !gridColumn(grid, x, z)) continue;
    const queue = [{ x, z }]; seen.add(key); let size = 0, touchesSource = false;
    let minX = x, maxX = x, minZ = z, maxZ = z;
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]; size++;
      minX = Math.min(minX, current.x); maxX = Math.max(maxX, current.x);
      minZ = Math.min(minZ, current.z); maxZ = Math.max(maxZ, current.z);
      if (sourceKeys.has(`${current.x},${current.z}`)) touchesSource = true;
      const c = gridColumn(grid, current.x, current.z);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = current.x + dx, nz = current.z + dz, nk = `${nx},${nz}`;
        if (seen.has(nk)) continue;
        const n = gridColumn(grid, nx, nz);
        if (!n) continue;
        const rise = n.h - c.h, drop = c.h - n.h;
        if ((!c.water && !n.water && (rise > MAX_STEP_UP || drop > MAX_STEP_DOWN))
            || (c.water && !n.water && rise > MAX_STEP_UP)
            || (!c.water && n.water && drop > MAX_WATER_DROP)) continue;
        seen.add(nk); queue.push({ x: nx, z: nz });
      }
    }
    if (size >= MIN_ISOLATED_POCKET && !touchesSource)
      pockets.push({ size, minX, maxX, minZ, maxZ });
  }
  return pockets;
}

// Report steep edges separately from route reachability. A map may contain
// harmless cliff faces, but no spawn/objective route may depend on crossing
// one: reachable()/botRouteReachable() reject these transitions in both
// directions, including water-to-bank and bank-to-water drops.
function hazardousDropEdges(world, envelope) {
  const grid = makeGrid(world, envelope); let count = 0;
  for (let z = envelope.minZ + 1; z < envelope.maxZ; z++) for (let x = envelope.minX + 1; x < envelope.maxX; x++) {
    const here = gridColumn(grid, x, z);
    if (!here || here.water) continue;
    for (const [dx, dz] of [[1, 0], [0, 1]]) {
      const next = gridColumn(grid, x + dx, z + dz);
      if (next && !next.water && here.h - next.h > MAX_STEP_DOWN) count++;
      if (next && next.water && here.h - next.h > MAX_WATER_DROP) count++;
    }
  }
  return count;
}

// If a permissive graph can connect a critical pair but the bounded bot graph
// cannot, the only possible connection relies on an unjumpable climb/drop.
// Keep this explicit so a future terrain tweak reports the exact sealed route
// instead of silently turning a spawn/objective region into a trap.
function unavoidableDropPair(world, envelope, pairs) {
  for (const [index, [source, target]] of pairs.entries()) {
    if (!reachable(world, envelope, source, target)
        && reachable(world, envelope, source, target, { allowHazardousDrops: true }))
      return { index, source, target };
  }
  return null;
}

function representativeBreach(world, mapIndex, seed, envelope) {
  const edits = [];
  if (mapIndex === 0) {
    for (let x = 103; x <= 106; x++) for (let z = 123; z <= 133; z++) {
      const top = world.surface(x, z);
      for (let y = Math.max(SEA + 1, top - 2); y <= top; y++)
        if (world.get(x, y, z)) edits.push({ x, y, z });
    }
  } else if (mapIndex === 2) {
    const z = Math.round(pinefallRavineCenter(seed, 128));
    // Leave both abutments and the protected ford untouched; remove a
    // meaningful three-column section of the ordinary bridge deck.
    for (let x = 123; x <= 125; x++) for (let dz = -2; dz <= 2; dz++) {
      const y = SEA + 1;
      if (world.get(x, y, z + dz)) edits.push({ x, y, z: z + dz });
    }
  } else if (mapIndex === 4) {
    for (let z = SZ / 2 - 36; z <= SZ / 2 - 28; z++)
      for (let x = SX / 2 - 2; x <= SX / 2 + 2; x++) {
        const y = SEA + 8;
        if (world.get(x, y, z)) edits.push({ x, y, z });
      }
  } else if (mapIndex === 5) {
    for (let x = SX / 2 - 24; x <= SX / 2 + 24; x++) for (let y = SEA + 11; y <= SEA + 16; y++) {
      const z = SZ / 2 - 64;
      if (world.get(x, y, z)) edits.push({ x, y, z });
    }
  } else if (mapIndex === 6) {
    for (let x = SX / 2 - 9; x <= SX / 2 + 9; x++)
      for (let y = SEA + 1; y <= SEA + 3; y++) {
        const z = SZ / 2 - 17;
        if (world.get(x, y, z)) edits.push({ x, y, z });
      }
  } else if (mapIndex === 7) {
    // Breach the north hill's east-side dirt seam; the radial lane, both ends,
    // and the permanent loop remain untouched.
    for (let z = SZ / 2 - 32 - 4; z <= SZ / 2 - 32 + 4; z++)
      for (let y = SEA + 1; y <= SEA + 2; y++) {
        const x = SX / 2 + 16;
        if (world.get(x, y, z)) edits.push({ x, y, z });
      }
  }
  if (!edits.length) return { removed: false, after: true, fallbackAfter: true, rebuilt: true };
  const prior = edits.map(edit => world.get(edit.x, edit.y, edit.z));
  for (const edit of edits) world.set(edit.x, edit.y, edit.z, 0);
  GRID_CACHE.delete(world);
  const green = spawnPoint('green', world), blue = spawnPoint('blue', world);
  const after = botRouteReachable(world, envelope, green, blue);
  const fallbackAfter = fallbackNetworkReachable(world, envelope, mapIndex, seed, green, blue);
  for (let i = 0; i < edits.length; i++) world.set(edits[i].x, edits[i].y, edits[i].z, prior[i]);
  GRID_CACHE.delete(world);
  const rebuilt = botRouteReachable(world, envelope, green, blue)
    && edits.every((edit, i) => world.get(edit.x, edit.y, edit.z) === prior[i]);
  return { removed: true, count: edits.length, after, fallbackAfter, rebuilt };
}

function runMap(mapIndex, seed) {
  const world = new VoxelWorld(new THREE.Scene());
  generateMap(world, seed, mapIndex, { buildMeshes: false });
  const envelope = mapEnvelope(mapIndex);
  const green = spawnPoint('green', world), blue = spawnPoint('blue', world);
  check(walkable(world, envelope, green.x, green.z)
    && walkable(world, envelope, blue.x, blue.z), mapIndex, seed,
  'spawn-headroom', JSON.stringify({ green, blue }));
  check(botRouteReachable(world, envelope, green, blue), mapIndex, seed,
    'base-reachability');

  const objectives = MAPS[mapIndex].hills ?? [{ x: SX / 2, z: SZ / 2 }];
  for (const [objectiveIndex, objective] of objectives.entries()) {
    check(botRouteReachable(world, envelope, green, objective), mapIndex, seed,
      'objective-reachability', `objective=${objectiveIndex}`);
  }
  if (rectangularMaps.has(mapIndex)) {
    const lanes = [-40, 0, 40].filter(offset => {
      const source = { x: green.x, z: green.z + offset };
      const target = { x: blue.x, z: blue.z + offset };
      return botRouteReachable(world, envelope, source, target);
    });
    check(lanes.length >= 2, mapIndex, seed, 'multiple-usable-lanes',
      `reachable=${lanes.length}/3`);
  }

  const areas = signatureProtectedAreas(mapIndex, seed);
  check(protectedRouteReachable(world, envelope, areas), mapIndex, seed,
    'signature-fallback-route', 'protected-center-unwalkable');
  // Protected centers alone are not enough: each permanent fallback endpoint
  // must join the same playable network from both bases. Destructible spans
  // may be removed, but these endpoints must remain useful.
  check(fallbackNetworkReachable(world, envelope, mapIndex, seed, green, blue), mapIndex, seed,
    'fallback-network-connectivity');
  const sources = [green, blue, ...objectives];
  const pockets = sizableWalkablePockets(world, envelope, sources);
  check(pockets.length === 0, mapIndex, seed, 'isolated-walkable-pocket',
    `components=${pockets.length} pockets=${JSON.stringify(pockets.slice(0, 4))}`);
  // Steep edges are allowed as authored cover, but critical routes above must
  // avoid every hazardous drop under the bounded traversal model. Compare to
  // a deliberately permissive graph to detect a route that would otherwise
  // depend on a physically impossible transition.
  const hazardous = hazardousDropEdges(world, envelope);
  const dropPair = unavoidableDropPair(world, envelope,
    [[green, blue], ...objectives.map(objective => [green, objective])]);
  check(!dropPair, mapIndex, seed, 'unavoidable-drop-transition',
    dropPair ? `pair=${dropPair.index} edges=${hazardous}` : `edges=${hazardous}`);
  if (mapIndex === 2)
    check(hasWaterExit(world, envelope), mapIndex, seed, 'water-exit');
  const breach = representativeBreach(world, mapIndex, seed, envelope);
  check(breach.after, mapIndex, seed, 'breach-preserves-bot-route',
    `removed=${breach.count ?? 0}`);
  check(breach.fallbackAfter, mapIndex, seed, 'permanent-fallback-after-destruction',
    `removed=${breach.count ?? 0}`);
  check(breach.rebuilt, mapIndex, seed, 'breach-rebuild-route',
    `removed=${breach.count ?? 0}`);
  check(fallbackNetworkReachable(world, envelope, mapIndex, seed, green, blue), mapIndex, seed,
    'fallback-after-rebuild');

  // Every generated voxel must remain in the ordinary shared palette. This
  // catches accidental geometry writes that would break meshing on one seed.
  for (let i = 0; i < world.data.length; i++) {
    const voxel = world.data[i];
    if (voxel >= PALETTE.length)
      fail(mapIndex, seed, 'valid-palette', `offset=${i} voxel=${voxel}`);
  }
}

const started = Date.now();
for (let i = 0; i < count; i++) {
  const seed = start + i * step;
  for (let mapIndex = 0; mapIndex < MAPS.length; mapIndex++) runMap(mapIndex, seed);
}
console.log(`[map-fuzz] ok seeds=${count} maps=${MAPS.length} `
  + `cases=${count * MAPS.length} elapsedMs=${Date.now() - started}`);
