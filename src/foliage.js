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
// salt keeps the density roll, position offset, per-blade rotation, and
// per-blade scale from all landing on the same value for one column.
function hash(x, z, salt) {
  const s = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

// Three distinct shapes, not four — dirt and sand share the same pebble
// geometry and pool, differentiated only by per-instance color (their
// eligible columns never overlap, so nothing is lost by sharing one mesh
// instead of two). Grass places `perColumn` blades per winning column
// instead of one: a single rigid vertical box read as a cactus spine, not
// a blade of grass — a small cluster of shorter blades at slightly
// different heights and leans is what actually makes it read as
// vegetation rather than an isolated spike. Capacities sized to the true
// theoretical maximum for a 256x256 map at each type's density and
// perColumn count below, not to whatever happened to show up on a
// handful of sample maps — an undersized cap doesn't mean "slightly less
// coverage" here, since columns are scanned in a fixed x,z order and a
// pool running out mid-scan just stops cold, piling decoration into the
// low-x half of the map and vanishing from the rest. The extra reserved
// capacity costs nothing at render time either way — InstancedMesh's
// per-frame cost is driven by the runtime count actually in use, not the
// allocated buffer size.
const POOL_SPEC = {
  grass:  { geo: () => new THREE.BoxGeometry(0.05, 0.22, 0.05), cap: 30000, baseH: 0.11, perColumn: 3 },
  pebble: { geo: () => new THREE.BoxGeometry(0.16, 0.10, 0.16), cap: 7000,  baseH: 0.05, perColumn: 1 },
  rubble: { geo: () => new THREE.BoxGeometry(0.22, 0.15, 0.18), cap: 5500,  baseH: 0.075, perColumn: 1 },
};

// Which block type decorates which pool, what fraction of its eligible
// columns actually gets a cluster, and (grass only) whether it's excluded
// underwater — a swaying blade below the sea plane would read as a
// visual bug; a pebble or rubble sitting on a submerged floor doesn't, so
// only grass carries the flag. Deliberately just data, matching the
// per-map atmosphere table's own philosophy: retuning any of this later
// is changing a number here, nothing structural.
const CONFIG = {
  [BLOCK.GRASS]: { pool: 'grass',  density: 0.14, noUnderwater: true },
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
      this.pools[name] = { mesh, cap: spec.cap, baseH: spec.baseH, perColumn: spec.perColumn, next: 0, free: [] };
    }
    this.columns = new Map(); // packed x*SZ+z -> { pool, indices: [...] }
    // Scratch objects reused across every column/blade, avoiding
    // per-instance allocation churn during the full-map scan (up to
    // SX*SZ columns, each producing up to perColumn blades).
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._qTilt = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._tiltAxis = new THREE.Vector3(1, 0, 0);
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

  _releaseAll(pool, indices) {
    for (const idx of indices) this._release(pool, idx);
  }

  // Places one blade/pebble/rock instance. i distinguishes blades within
  // the same cluster (0 for pebble/rubble, which only ever place one) so
  // each gets its own independent hash salts rather than all landing on
  // the same position/rotation/scale.
  _placeOne(p, poolName, x, y, z, top, i) {
    const idx = this._acquire(poolName);
    if (idx === null) return null;

    const salt = i * 10; // keeps each blade in a cluster independently randomized
    const jx = 0.2 + hash(x, z, salt + 2) * 0.6, jz = 0.2 + hash(x, z, salt + 3) * 0.6; // scattered within the column, not grid-stamped
    const scale = 0.8 + hash(x, z, salt + 5) * 0.4;
    // Lean, not just spin: a tilt away from vertical by up to ~20 degrees,
    // then spun around Y so the tilt direction itself varies per instance
    // instead of every blade leaning the same way. This is the specific
    // fix for the "looks like a rigid spike" complaint — a perfectly
    // vertical, perfectly straight blade reads as architecture, not grass.
    const spin = hash(x, z, salt + 4) * Math.PI * 2;
    const tilt = poolName === 'grass' ? hash(x, z, salt + 6) * 0.35 : 0; // ~0-20°, pebbles/rubble stay upright
    this._q.setFromAxisAngle(this._up, spin);
    this._qTilt.setFromAxisAngle(this._tiltAxis, tilt);
    this._q.multiply(this._qTilt);
    this._v.set(x + jx, y + 1 + p.baseH * scale, z + jz);
    this._s.set(scale, scale, scale);
    p.mesh.setMatrixAt(idx, this._m.compose(this._v, this._q, this._s));
    p.mesh.setColorAt(idx, new THREE.Color(PALETTE[top].color));
    p.mesh.instanceMatrix.needsUpdate = true;
    p.mesh.instanceColor.needsUpdate = true;
    return idx;
  }

  // Re-evaluates exactly one column from scratch: releases whatever was
  // there, then decides fresh what belongs there now. Used both for the
  // full initial scan and for every dig/build afterward — a column dug
  // through grass into dirt is handled by the exact same path as one
  // going from nothing to grass, not a special case.
  _evaluateColumn(world, x, z) {
    const key = x * SZ + z;
    const existing = this.columns.get(key);
    if (existing) { this._releaseAll(existing.pool, existing.indices); this.columns.delete(key); }

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

    const p = this.pools[cfg.pool];
    const indices = [];
    for (let i = 0; i < p.perColumn; i++) {
      const idx = this._placeOne(p, cfg.pool, x, y, z, top, i);
      if (idx !== null) indices.push(idx);
      else break; // pool exhausted mid-cluster — keep whatever placed so far rather than discard it
    }
    if (indices.length) this.columns.set(key, { pool: cfg.pool, indices });
  }

  // Full rescan — called once per map load/rotation, after buildAll() so
  // the final terrain shape is known. Reused across rotations rather than
  // recreated (the InstancedMesh objects and materials persist), so
  // everything is explicitly cleared first: leftover placements from the
  // previous map's terrain shape must not survive into the new one.
  build(world) {
    for (const [, e] of this.columns) this._releaseAll(e.pool, e.indices);
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
