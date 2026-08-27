// foliage.js — small decorative detail scattered across the ground: a
// canvas-drawn, alpha-cutout crossed-quad texture for grass (the same
// "draw it on a canvas at runtime, no external asset, no build step"
// trick this codebase's sky gradient already uses), and small instanced
// boxes for pebbles (dirt/sand) and rubble (stone) — those were never
// part of the complaint that grass read as cactus spikes, and a squat
// box already reads fine as "a small rock." BLUE/GREEN (the placed,
// team-colored block types) are deliberately excluded everywhere —
// scattering detail on a wall a player just built would read as a bug.
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

// Draws a small cluster of tapering blade shapes onto a 2D context —
// factored out from texture creation so it can be exercised directly
// against a plain CanvasRenderingContext2D in tests, without needing a
// browser DOM. Drawn in grayscale (not green): color comes entirely from
// PALETTE at placement time via setColorAt (map * vertexColor in the
// shader), the same way the box version's color already worked — this
// keeps grass automatically matching the palette (including any future
// per-map override) rather than baking a fixed hue into the texture.
// The gradient (darker near the base, near-white near the tip) still
// comes through after that multiply, giving each blade a bit of built-in
// shading at zero runtime cost — it's baked once, not computed per frame.
export function drawGrassBlades(g, w, h) {
  g.clearRect(0, 0, w, h);
  const grad = g.createLinearGradient(0, h, 0, 0); // bottom (base) -> top (tip)
  grad.addColorStop(0, 'rgba(185,185,185,1)');
  grad.addColorStop(1, 'rgba(255,255,255,1)');
  g.fillStyle = grad;

  const baseY = h - 3;
  const blades = [
    { x: w * 0.22, h: h * 0.82, w: w * 0.24, curve: 7 },
    { x: w * 0.42, h: h * 0.94, w: w * 0.18, curve: -9 },
    { x: w * 0.60, h: h * 0.72, w: w * 0.20, curve: 6 },
    { x: w * 0.78, h: h * 0.88, w: w * 0.20, curve: -7 },
  ];
  for (const b of blades) {
    g.beginPath();
    g.moveTo(b.x - b.w / 2, baseY);
    g.quadraticCurveTo(b.x + b.curve, baseY - b.h * 0.55, b.x, baseY - b.h);
    g.quadraticCurveTo(b.x + b.curve * 0.4, baseY - b.h * 0.55, b.x + b.w / 2, baseY);
    g.closePath();
    g.fill();
  }
}

const GRASS_TEX_W = 64, GRASS_TEX_H = 96;

function makeGrassTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = GRASS_TEX_W;
  canvas.height = GRASS_TEX_H;
  drawGrassBlades(canvas.getContext('2d'), GRASS_TEX_W, GRASS_TEX_H);
  const tex = new THREE.CanvasTexture(canvas);
  return tex;
}

// Two vertical planes crossed at 90 degrees through their shared vertical
// axis — the classic cutout-foliage cross, deliberately NOT a full
// camera-facing billboard: these instances are placed once at map load
// and only re-touched on a dig, so anything requiring a per-frame
// rotation update (to keep facing a moving camera) would mean recomputing
// thousands of instance matrices every frame instead of zero. A fixed
// cross needs no such update and still reads correctly from any angle.
// Built by hand rather than via a merge-geometries helper: this project
// only vendors core three.js (see index.html's import map), no addons.
function makeCrossGeometry(w, h) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array([
    -w / 2, 0, 0, w / 2, 0, 0, w / 2, h, 0, -w / 2, h, 0, // plane 1: X-Y, Z=0
    0, 0, -w / 2, 0, 0, w / 2, 0, h, w / 2, 0, h, -w / 2, // plane 2: Z-Y, X=0 (90° from plane 1)
  ]);
  const uvs = new Float32Array([
    0, 0, 1, 0, 1, 1, 0, 1,
    0, 0, 1, 0, 1, 1, 0, 1,
  ]);
  const indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

// grass: one crossed-quad cluster per winning column (the texture already
// draws 4 blade shapes, so a single instance already reads as a clump —
// no need to place 3 separate ones the way the box version had to).
// pebble/rubble: unchanged simple boxes, one per column — never part of
// the complaint, a squat box already reads fine as a small rock.
// Capacities sized to the true theoretical maximum for a 256x256 map at
// each type's density below, not to whatever a handful of sample maps
// happened to need — confirmed necessary last round, when two real maps
// silently hit an undersized cap and would have shown decoration piled
// into one half of the map and missing from the rest.
const POOL_SPEC = {
  grass:  { geo: () => makeCrossGeometry(0.5, 0.34), mat: () => new THREE.MeshBasicMaterial({ map: makeGrassTexture(), vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide }), cap: 11000, baseH: 0 },
  pebble: { geo: () => new THREE.BoxGeometry(0.16, 0.10, 0.16), mat: () => new THREE.MeshBasicMaterial({ vertexColors: true }), cap: 7000, baseH: 0.05 },
  rubble: { geo: () => new THREE.BoxGeometry(0.22, 0.15, 0.18), mat: () => new THREE.MeshBasicMaterial({ vertexColors: true }), cap: 5500, baseH: 0.075 },
};

// Which block type decorates which pool, what fraction of its eligible
// columns actually gets one, and (grass only) whether it's excluded
// underwater — a swaying blade below the sea plane would read as a
// visual bug; a pebble or rubble sitting on a submerged floor doesn't,
// so only grass carries the flag. Deliberately just data, matching the
// per-map atmosphere table's own philosophy: retuning any of this later
// is changing a number here, nothing structural.
const CONFIG = {
  [BLOCK.GRASS]: { pool: 'grass',  density: 0.15, noUnderwater: true },
  [BLOCK.DIRT]:  { pool: 'pebble', density: 0.10 },
  [BLOCK.SAND]:  { pool: 'pebble', density: 0.10 },
  [BLOCK.STONE]: { pool: 'rubble', density: 0.08 },
};

export class Foliage {
  constructor(scene) {
    this.pools = {};
    for (const [name, spec] of Object.entries(POOL_SPEC)) {
      const mesh = new THREE.InstancedMesh(spec.geo(), spec.mat(), spec.cap);
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
