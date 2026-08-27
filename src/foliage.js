// foliage.js — small decorative detail scattered across the ground: grass
// blades on grass, pebbles on dirt/sand, rubble on stone. The same trick
// the clouds already use for cheap detail (small instanced boxes, not
// textures) extended from the sky to the ground. BLUE/GREEN (the placed,
// team-colored block types) are deliberately excluded — scattering
// pebbles on a wall a player just built would read as a bug, not detail.
import * as THREE from 'three';
import { SX, SZ, SEA, BLOCK, PALETTE } from './world.js';

// Deterministic per-column hash — same spirit as world.js's own jitter(),
// an independent implementation since that one is private to world.js.
// salt keeps the density roll, position offset, rotation, and scale from
// all landing on the same value for a single column.
function hash(x, z, salt) {
  const s = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

// Three distinct shapes, not four — dirt and sand share the same pebble
// geometry and pool, differentiated only by per-instance color (their
// eligible columns never overlap, so nothing is lost by sharing one mesh
// instead of two). Capacities sized to the true theoretical maximum for
// a 256x256 map at each type's density below (e.g. grass: every single
// column being grass-topped AND clearing the density roll), not to
// whatever happened to show up on a handful of sample maps — the
// difference matters here specifically: since columns are scanned in a
// fixed x,z order and a pool that runs out mid-scan just stops cold, an
// undersized cap doesn't mean "slightly less coverage," it means
// decoration piling up in the low-x half of the map and vanishing
// entirely from the rest. Confirmed two real maps already hit a cap of
// 3000 before this fix. The extra reserved capacity costs nothing at
// render time either way — InstancedMesh's per-frame cost is driven by
// the runtime count actually in use, not the allocated buffer size.
const POOL_SPEC = {
  grass:  { geo: () => new THREE.BoxGeometry(0.07, 0.32, 0.07), cap: 11000, baseH: 0.16 },
  pebble: { geo: () => new THREE.BoxGeometry(0.16, 0.10, 0.16), cap: 7000,  baseH: 0.05 },
  rubble: { geo: () => new THREE.BoxGeometry(0.22, 0.15, 0.18), cap: 5500,  baseH: 0.075 },
};

// Which block type decorates which pool, what fraction of its eligible
// columns actually gets one, and (grass only) whether it's excluded
// underwater — a swaying blade below the sea plane would read as a
// visual bug; a pebble or rubble sitting on a submerged floor doesn't,
// so only grass carries the flag. Deliberately just data, matching the
// per-map atmosphere table's own philosophy: retuning any of this later
// is changing a number here, nothing structural.
const CONFIG = {
  [BLOCK.GRASS]: { pool: 'grass',  density: 0.16, noUnderwater: true },
  [BLOCK.DIRT]:  { pool: 'pebble', density: 0.10 },
  [BLOCK.SAND]:  { pool: 'pebble', density: 0.10 },
  [BLOCK.STONE]: { pool: 'rubble', density: 0.08 },
};

export class Foliage {
  constructor(scene) {
    this.pools = {};
    for (const [name, spec] of Object.entries(POOL_SPEC)) {
      const mesh = new THREE.InstancedMesh(spec.geo(), new THREE.MeshBasicMaterial({ vertexColors: true }), spec.cap);
      mesh.count = 0; // nothing placed yet — build() populates this on first map load
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); // edits happen throughout a match, not just once at load
      scene.add(mesh);
      this.pools[name] = { mesh, cap: spec.cap, baseH: spec.baseH, next: 0, free: [] };
    }
    this.columns = new Map(); // packed x*SZ+z -> { pool, index }
    // Scratch objects reused across every column, avoiding per-column
    // allocation churn during the full-map scan (up to SX*SZ columns).
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  _acquire(poolName) {
    const p = this.pools[poolName];
    if (p.free.length) return p.free.pop();
    if (p.next >= p.cap) return null; // pool exhausted — skip silently, matches tracer/flash pool behavior elsewhere
    const idx = p.next++;
    if (idx + 1 > p.mesh.count) p.mesh.count = idx + 1;
    return idx;
  }

  _release(poolName, index) {
    const p = this.pools[poolName];
    p.mesh.setMatrixAt(index, this._m.makeScale(0, 0, 0));
    p.mesh.instanceMatrix.needsUpdate = true;
    p.free.push(index);
  }

  // Re-evaluates exactly one column from scratch: releases whatever was
  // there, then decides fresh what belongs there now. Used both for the
  // full initial scan and for every dig/build afterward — a column dug
  // through grass into dirt is handled by the exact same path as one
  // going from nothing to grass, not a special case.
  _evaluateColumn(world, x, z) {
    const key = x * SZ + z;
    const existing = this.columns.get(key);
    if (existing) { this._release(existing.pool, existing.index); this.columns.delete(key); }

    const y = world.surface(x, z);
    // No separate "is this exposed" check needed here: surface() only
    // ever returns the highest solid block in the column by construction
    // (it scans top-down and returns the first hit), so everything above
    // y is already guaranteed air — a genuinely covered block can never
    // be what y points at.
    const top = world.get(x, y, z);
    const cfg = CONFIG[top];
    if (!cfg) return; // not a decoratable type (air, an unrecognized value, or BLUE/GREEN by design)
    if (cfg.noUnderwater && y < SEA) return;
    if (hash(x, z, 1) >= cfg.density) return; // this column didn't win the density roll for this type

    const idx = this._acquire(cfg.pool);
    if (idx === null) return;

    const p = this.pools[cfg.pool];
    const jx = 0.2 + hash(x, z, 2) * 0.6, jz = 0.2 + hash(x, z, 3) * 0.6; // scattered within the column, not grid-stamped
    const scale = 0.85 + hash(x, z, 5) * 0.3;
    this._q.setFromAxisAngle(this._up, hash(x, z, 4) * Math.PI * 2);
    this._v.set(x + jx, y + 1 + p.baseH * scale, z + jz);
    this._s.set(scale, scale, scale);
    p.mesh.setMatrixAt(idx, this._m.compose(this._v, this._q, this._s));
    p.mesh.setColorAt(idx, new THREE.Color(PALETTE[top].color));
    p.mesh.instanceMatrix.needsUpdate = true;
    p.mesh.instanceColor.needsUpdate = true;
    this.columns.set(key, { pool: cfg.pool, index: idx });
  }

  // Full rescan — called once per map load/rotation, after buildAll() so
  // the final terrain shape is known. Reused across rotations rather than
  // recreated (the InstancedMesh objects and materials persist), so
  // everything is explicitly cleared first: leftover placements from the
  // previous map's terrain shape must not survive into the new one.
  build(world) {
    for (const [, e] of this.columns) this._release(e.pool, e.index);
    this.columns.clear();
    for (const p of Object.values(this.pools)) { p.next = 0; p.free.length = 0; p.mesh.count = 0; }
    for (let x = 0; x < SX; x++)
      for (let z = 0; z < SZ; z++)
        this._evaluateColumn(world, x, z);
  }

  onEdit(x, z, world) {
    if (x < 0 || x >= SX || z < 0 || z >= SZ) return;
    this._evaluateColumn(world, x, z);
  }
}
