// Pure world-simulation rules with no DOM, networking, or renderer ownership.
import { BLOCK } from './world.js';

const DIRS6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const COLLAPSE_TERRAIN_CAP = 4000;
const COLLAPSE_BUILT_CAP = 12000;
export const collapseKey = (x, y, z) => x + ',' + y + ',' + z;
const isBuiltBlock = value => value === BLOCK.GREEN || value === BLOCK.BLUE;

export function unsupportedCollapseCells(blockAt, holes, {
  terrainCap = COLLAPSE_TERRAIN_CAP, builtCap = COLLAPSE_BUILT_CAP,
} = {}) {
  const seeded = new Set();
  const seeds = [];
  for (const hole of holes ?? [])
    for (const direction of DIRS6) {
      const x = hole.x + direction[0], y = hole.y + direction[1], z = hole.z + direction[2];
      const key = collapseKey(x, y, z), value = blockAt(x, y, z);
      if (!seeded.has(key) && value) {
        seeded.add(key); seeds.push({ x, y, z, v: value });
      }
    }

  const verdict = new Map();
  const doomed = new Set();
  for (const seed of seeds) {
    const seedKey = collapseKey(seed.x, seed.y, seed.z);
    if (verdict.has(seedKey)) continue;
    const component = new Set([seedKey]);
    const queue = [seed];
    let grounded = false, settled = false, builtOnly = isBuiltBlock(seed.v);
    for (let i = 0; i < queue.length && !settled; i++) {
      const cell = queue[i];
      if (cell.y === 0) { grounded = true; break; }
      if (component.size > (builtOnly ? builtCap : terrainCap)) { grounded = true; break; }
      for (const direction of DIRS6) {
        const x = cell.x + direction[0], y = cell.y + direction[1], z = cell.z + direction[2];
        const key = collapseKey(x, y, z);
        if (component.has(key)) continue;
        const value = blockAt(x, y, z);
        if (!value) continue;
        const known = verdict.get(key);
        if (known !== undefined) { grounded = known; settled = true; break; }
        if (!isBuiltBlock(value)) builtOnly = false;
        component.add(key); queue.push({ x, y, z, v: value });
      }
    }
    for (const key of component) verdict.set(key, grounded);
    if (!grounded) for (const key of component) doomed.add(key);
  }
  return doomed;
}
