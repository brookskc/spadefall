// mapgen.js — procedural terrain with two team bases, in eight themed maps.
// MAPS order is the rotation order; generateMap(world, seed, mapIndex) fills
// world.data, re-anchors BASE, and meshes everything via world.buildAll().
import { SX, SY, SZ, SEA, BLOCK, PALETTE, DEFAULT_PALETTE_COLORS, setVoxelLight } from './world.js';
import { teamHex } from './settings.js';
import { contentAvailable } from './content-gating.js';

// Deterministic value noise — smooth, seedable, dependency-free.
function makeNoise(seed) {
  const rand = mulberry32(seed);
  const grid = new Float32Array(64 * 64);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const at = (x, y) => grid[((y & 63) << 6) | (x & 63)];
  const smooth = t => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
}
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// modes: which game modes the map supports. DUNES and CROWN remain private
// development maps; their existing modes are intentionally preserved here.
// hills: rotating king-of-the-hill zones. Every point stays on the midfield
// axis, so both bases travel the same distance even when the fight moves.
// atmosphere: optional sky/fog/cloud/water tint for this map (see
// applyAtmosphere below and Game#_applyMapAtmosphere) — every field is
// optional and falls back to the neutral default (GREENBELT's own look,
// which is the baseline every other map used to be stuck with regardless
// of theme). paletteOverrides: optional per-block-name color overrides,
// reset to DEFAULT_PALETTE_COLORS before each map's own overrides apply
// (see applyPaletteOverrides), so a map with no override never inherits
// whatever the PREVIOUS map tinted. First-pass color choices — the whole
// point of this being data instead of hardcoded is that retuning any of
// these later is just changing a hex value here, nothing structural.
export const MAPS = [
  { key: 'island',  name: 'GREENBELT', modes: ['ctf', 'tdm'],        gen: null,
    landmarks: [{ key: 'north-watch', x: SX / 2, z: 76 },
      { key: 'center-gate', x: SX / 2, z: SZ / 2 },
      { key: 'south-yard', x: SX / 2, z: 180 }],
    envelope: { minX: 16, maxX: 240, minZ: 48, maxZ: 208, shape: 'rect', kind: 'shore' },
    atmosphere: { sky: ['#5eafe0', '#a6d3e2', '#e3ead5'], fog: 0xcadcc9, cloud: 0xf5f1dc, water: 0x347ba7,
      sun: [0.45, 1, 0.25], sunTint: [1.06, 1.01, 0.90] },
    paletteOverrides: { grass: 0x5f9f45, dirt: 0x75563a, sand: 0xc4ad73, stone: 0x70796f, moss: 0x3d7545 } },
  { key: 'beach',   name: 'BEACHHEAD', modes: ['ctf', 'tdm'],        gen: null,
    landmarks: [{ key: 'north-ramp', x: 112, z: SZ / 2 - 42 },
      { key: 'covered-trench', x: 128, z: SZ / 2 + 26 },
      { key: 'south-ramp', x: 112, z: SZ / 2 + 42 }],
    envelope: { minX: 16, maxX: 240, minZ: 48, maxZ: 208, shape: 'rect', kind: 'shore' },
    atmosphere: { sky: ['#4d9fc9', '#9bcbd8', '#e8eee4'], fog: 0xd3e3dc, cloud: 0xf8f4e8, water: 0x248fa4,
      sun: [-0.25, 1, 0.45], sunTint: [1.08, 1.02, 0.88] },
    paletteOverrides: { grass: 0x6f9f55, dirt: 0x89684d, sand: 0xd2b977, stone: 0x737b80, moss: 0x4d7459 } },
  { key: 'forest',  name: 'PINEFALL',  modes: ['ctf', 'tdm'],        gen: null,
    envelope: { minX: 16, maxX: 240, minZ: 48, maxZ: 208, shape: 'rect', kind: 'shore' },
    atmosphere: { sky: ['#aaa3d2', '#c8c0dc', '#e4ddea'], fog: 0xc9c1d6, cloud: 0xf1edf4, water: 0x3c6967,
      sun: [0.55, 1, -0.35], sunTint: [1.02, 1.00, 1.06] },
    paletteOverrides: { grass: 0x4f824c, dirt: 0x685344, sand: 0xb0a683, stone: 0x72757f, moss: 0x315d3f } },
  { key: 'desert',  name: 'DUNES',     modes: ['tdm', 'koth'],       gen: null,
    envelope: { minX: 32, maxX: 224, minZ: 32, maxZ: 224, shape: 'ellipse', kind: 'escarpment' },
    hills: [
      { x: SX / 2, z: SZ / 2, r: 8, label: 'CENTER' },
      { x: SX / 2, z: SZ / 2 - 40, r: 8, label: 'NORTH' },
      { x: SX / 2, z: SZ / 2 + 40, r: 8, label: 'SOUTH' },
    ],
    atmosphere: { sky: ['#a78492', '#d8ad8d', '#f0d6ae'], fog: 0xd7bd9f, cloud: 0xeee5dc, water: 0x397f96,
      sun: [-0.55, 0.8, -0.25], sunTint: [1.12, 1.02, 0.82] },
    paletteOverrides: { grass: 0x8c8b55, dirt: 0x895d49, sand: 0xcaa461, stone: 0x846f72, moss: 0x74694f } },
  { key: 'crown',   name: 'CROWN',     modes: ['koth', 'tdm'],       gen: null,
    envelope: { minX: 32, maxX: 224, minZ: 32, maxZ: 224, shape: 'ellipse', kind: 'shore' },
    hills: [
      { x: SX / 2, z: SZ / 2, r: 8, label: 'CROWN' },
      { x: SX / 2, z: SZ / 2 - 40, r: 8, label: 'NORTH GATE' },
      { x: SX / 2, z: SZ / 2 + 40, r: 8, label: 'SOUTH GATE' },
    ],
    atmosphere: { sky: ['#365b91', '#7899bf', '#c9d7df'], fog: 0xa6b4bf, cloud: 0xe7edf0, water: 0x2f5e78,
      sun: [0.35, 1, -0.55], sunTint: [1.08, 1.04, 0.94] },
    paletteOverrides: { grass: 0x567447, dirt: 0x604636, sand: 0xb29a68, stone: 0x515d69, moss: 0x334f3c } },
  { key: 'caldera', name: 'CALDERA',   modes: ['koth'],              gen: null,
    stagingPockets: 2,
    envelope: { minX: 32, maxX: 224, minZ: 32, maxZ: 224, shape: 'ellipse', kind: 'rim' },
    hills: [
      { x: SX / 2, z: SZ / 2, r: 10, label: 'KNOLL' },
      { x: SX / 2, z: SZ / 2 - 28, r: 10, label: 'NORTH BOWL' },
      { x: SX / 2, z: SZ / 2 + 28, r: 10, label: 'SOUTH BOWL' },
    ],
    // Bright volcanic daylight rather than purple twilight: the bowl walls
    // and soldiers must stay readable from its low central objective.
    atmosphere: { sky: ['#755b73', '#b98278', '#f0bd8d'], fog: 0xc49a88, cloud: 0xead2c4, water: 0x657080,
      sun: [-0.6, 0.78, 0.28], sunTint: [1.16, 1.07, 0.94] },
    paletteOverrides: { grass: 0x8b785f, dirt: 0x9b604f, sand: 0xd09a71, stone: 0x776d73, moss: 0x6c755f } },
  { key: 'foundry', name: 'FOUNDRY',   modes: ['tdm'],               gen: null,
    envelope: { minX: 32, maxX: 224, minZ: 32, maxZ: 224, shape: 'ellipse', kind: 'rim' },
    // Cool steel, pale overcast, and rust make the industrial TDM floor read
    // nothing like Faultline's sun-baked rock while keeping cover high-value.
    atmosphere: { sky: ['#4c606d', '#96aab1', '#e1ddd4'], fog: 0xb0b9b9, cloud: 0xe8eceb, water: 0x3b6671,
      sun: [-0.35, 0.88, 0.18], sunTint: [1.02, 1.04, 1.06] },
    paletteOverrides: { grass: 0x52686a, dirt: 0x8b513a, sand: 0xbc784a, stone: 0x687781, moss: 0x41645e } },
  { key: 'faultline', name: 'FAULTLINE', modes: ['koth'],            gen: null,
    envelope: { minX: 32, maxX: 224, minZ: 32, maxZ: 224, shape: 'ellipse', kind: 'rim' },
    hills: [
      { x: SX / 2, z: SZ / 2 - 32, r: 8, label: 'NORTH' },
      { x: SX / 2 - 32, z: SZ / 2, r: 8, label: 'WEST' },
      { x: SX / 2, z: SZ / 2 + 32, r: 8, label: 'SOUTH' },
      { x: SX / 2 + 32, z: SZ / 2, r: 8, label: 'EAST' },
    ],
    // A warm, high-desert geological identity: sandstone ground, sage seams,
    // and a clear cyan sky separate the rotating KOTH loop from Foundry.
    atmosphere: { sky: ['#5895ad', '#a6c9c5', '#efd5a5'], fog: 0xcdbda4, cloud: 0xf4ead8, water: 0x397684,
      sun: [0.25, 0.92, -0.42], sunTint: [1.12, 1.05, 0.91] },
    paletteOverrides: { grass: 0x7d8a6d, dirt: 0x9d6049, sand: 0xd6a464, stone: 0x806b5d, moss: 0x5f755b } },
];

// The voxel world remains 256×256; an envelope is the authored combat space
// inside it.  It is deliberately data, rather than a collision rule: maps use
// shorelines, escarpments, and volcanic shelves to make leaving that space a
// bad route while game systems use it to avoid dead outer wilderness.
export function mapEnvelope(mapIndex = 0) {
  return MAPS[((mapIndex % MAPS.length) + MAPS.length) % MAPS.length].envelope;
}
export function envelopeContains(envelope, x, z, inset = 0) {
  const minX = envelope.minX + inset, maxX = envelope.maxX - inset;
  const minZ = envelope.minZ + inset, maxZ = envelope.maxZ - inset;
  if (x < minX || x > maxX || z < minZ || z > maxZ) return false;
  if (envelope.shape !== 'ellipse') return true;
  const rx = (maxX - minX) / 2, rz = (maxZ - minZ) / 2;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  return ((x - cx) / rx) ** 2 + ((z - cz) / rz) ** 2 <= 1;
}
export function clampToEnvelope(envelope, x, z, inset = 0) {
  const minX = envelope.minX + inset, maxX = envelope.maxX - inset;
  const minZ = envelope.minZ + inset, maxZ = envelope.maxZ - inset;
  let px = Math.max(minX, Math.min(maxX, x));
  let pz = Math.max(minZ, Math.min(maxZ, z));
  if (envelope.shape === 'ellipse') {
    const rx = (maxX - minX) / 2, rz = (maxZ - minZ) / 2;
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const nx = (px - cx) / rx, nz = (pz - cz) / rz;
    const d = Math.hypot(nx, nz);
    if (d > 1) { px = cx + nx / d * rx; pz = cz + nz / d * rz; }
  }
  return { x: px, z: pz };
}

// Mutated by each generator; game.js reads spawn points and flag stands here.
export const BASE = {
  green: { x: 36,     z: SZ / 2, flag: null, plateau: 16 },
  blue:  { x: SX - 36, z: SZ / 2, flag: null, plateau: 16 },
};

// Signature mechanics are deliberately data-first: map generation and the
// edit-protection path share the same small list of fallback/anchor cells.
// Destructible-looking geometry is still written as ordinary palette voxels;
// only these compact fallback foundations are protected.
export const SIGNATURE_MECHANICS = Object.freeze({
  greenbelt: Object.freeze({ id: 'greenbelt', mapIndex: 0,
    fallbacks: Object.freeze(['north-flank', 'south-flank']) }),
  beachhead: Object.freeze({ id: 'beachhead', mapIndex: 1,
    fallbacks: Object.freeze(['covered-trench', 'north-ramp', 'south-ramp']) }),
  pinefall: Object.freeze({ id: 'pinefall', mapIndex: 2,
    fallbacks: Object.freeze(['ford', 'shoulder']) }),
  dunes: Object.freeze({ id: 'dunes', mapIndex: 3,
    fallbacks: Object.freeze(['north-wash', 'south-wash']) }),
  crown: Object.freeze({ id: 'crown', mapIndex: 4,
    fallbacks: Object.freeze(['east-causeway', 'west-causeway']) }),
  caldera: Object.freeze({ id: 'caldera', mapIndex: 5,
    fallbacks: Object.freeze(['east-saddle', 'west-saddle']) }),
  foundry: Object.freeze({ id: 'foundry', mapIndex: 6,
    fallbacks: Object.freeze(['north-catwalk', 'south-catwalk']) }),
  faultline: Object.freeze({ id: 'faultline', mapIndex: 7,
    fallbacks: Object.freeze(['north-loop', 'south-loop', 'east-loop', 'west-loop']) }),
});

export function signatureMechanic(mapIndex = 0) {
  const index = ((mapIndex % MAPS.length) + MAPS.length) % MAPS.length;
  return Object.values(SIGNATURE_MECHANICS).find(m => m.mapIndex === index) ?? null;
}

// Compact protected cylinders are consumed by Game's existing build/dig/
// explosion guards. Pinefall's ford position follows its seeded ravine; all
// other anchors sit on fixed symmetric map landmarks.
export function signatureProtectedAreas(mapIndex = 0, seed = 1979) {
  const cx = SX / 2, cz = SZ / 2;
  if (mapIndex === 1) return [
    { x: 112, y: SEA + 8, z: cz - 42, r: 3, below: 3, above: 3, kind: 'north-ramp' },
    { x: 112, y: SEA + 8, z: cz + 42, r: 3, below: 3, above: 3, kind: 'south-ramp' },
  ];
  if (mapIndex === 3) return [
    { x: cx - 28, y: SEA + 7, z: cz - 48, r: 3, below: 3, above: 3, kind: 'north-wash' },
    { x: cx + 28, y: SEA + 7, z: cz + 48, r: 3, below: 3, above: 3, kind: 'south-wash' },
  ];
  if (mapIndex === 2) {
    const fordZ = pinefallRavineCenter(seed, 128) + 8;
    return [
      { x: 128, y: SEA, z: fordZ, r: 5, below: 2, above: 4, kind: 'ford' },
      { x: 121, y: SEA + 1, z: pinefallRavineCenter(seed, 128), r: 2,
        below: 2, above: 3, kind: 'bridge-abutment' },
      { x: 135, y: SEA + 1, z: pinefallRavineCenter(seed, 128), r: 2,
        below: 2, above: 3, kind: 'bridge-abutment' },
    ];
  }
  if (mapIndex === 4) return [
    { x: cx - 32, y: SEA + 8, z: cz, r: 4, below: 4, above: 4, kind: 'fallback' },
    { x: cx + 32, y: SEA + 8, z: cz, r: 4, below: 4, above: 4, kind: 'fallback' },
    { x: cx, y: SEA + 8, z: cz - 40, r: 3, below: 3, above: 3, kind: 'abutment' },
    { x: cx, y: SEA + 8, z: cz - 24, r: 3, below: 3, above: 3, kind: 'abutment' },
    { x: cx, y: SEA + 8, z: cz + 24, r: 3, below: 3, above: 3, kind: 'abutment' },
    { x: cx, y: SEA + 8, z: cz + 40, r: 3, below: 3, above: 3, kind: 'abutment' },
  ];
  if (mapIndex === 5) {
    const fallbacks = [
      { x: cx - 64, y: SEA + 9, z: cz, r: 6, below: 3, above: 4, kind: 'fallback' },
      { x: cx + 64, y: SEA + 9, z: cz, r: 6, below: 3, above: 4, kind: 'fallback' },
    ];
    // Two small staging pockets per rotating hill are protected at their
    // authored shoulder, so a stray edit cannot erase the guaranteed cover
    // that makes each objective approachable from both directions.
    const pockets = MAPS[5].hills.flatMap(hill => {
      const y = hill.z === cz ? SEA + 11 : SEA + 5;
      return [-1, 1].map(side => ({ x: hill.x + side * 17, y, z: hill.z,
        r: 2, below: 2, above: 3, kind: 'staging-pocket' }));
    });
    return [...fallbacks, ...pockets];
  }
  if (mapIndex === 6) return [
    { x: cx, y: SEA + 9, z: cz - 48, r: 4, below: 3, above: 4, kind: 'north-catwalk' },
    { x: cx, y: SEA + 9, z: cz + 48, r: 4, below: 3, above: 4, kind: 'south-catwalk' },
  ];
  if (mapIndex === 7) return [
    { x: cx, y: SEA + 9, z: cz - 24, r: 4, below: 3, above: 4, kind: 'north-loop' },
    { x: cx - 24, y: SEA + 9, z: cz, r: 4, below: 3, above: 4, kind: 'west-loop' },
    { x: cx, y: SEA + 9, z: cz + 24, r: 4, below: 3, above: 4, kind: 'south-loop' },
    { x: cx + 24, y: SEA + 9, z: cz, r: 4, below: 3, above: 4, kind: 'east-loop' },
  ];
  return [];
}
const BASE_H = SEA + 7; // plateau height above the sea

const at = (x, z) => (z * SX + x);
const put = (world, x, y, z, block) => {
  x = Math.round(x); y = Math.round(y); z = Math.round(z);
  if (x < 0 || x >= SX || y < 0 || y >= SY || z < 0 || z >= SZ) return;
  world.data[(y * SZ + z) * SX + x] = block;
};
const terrainY = (height, x, z) => Math.floor(height[at(Math.round(x), Math.round(z))]);

// Deterministic, unseeded 3D noise for moss placement within the deep
// stone layer below — same summed-low-frequency-sines style as
// world.js's own patchNoise, just extended to 3D since moss needs to
// vary through the whole stone volume (any y), not across one flat
// surface the way patchNoise's 2D (x,z) does. Doesn't need a per-map
// seed the way terrain shape does (makeNoise, above) — this is meant
// as a subtle, local texture accent, not a terrain-shaping feature, so
// staying identical across maps (like patchNoise/jitter already do) is
// the right call, not a limitation to fix later.
function mossNoise(x, y, z) {
  const s = Math.sin(x * 0.09 + y * 0.13 + 1.1)
          + Math.sin(z * 0.08 - y * 0.11 + 2.3)
          + Math.sin(x * 0.05 + z * 0.07 + 4.7);
  return (s / 3 + 1) / 2;
}
const MOSS_THRESHOLD = 0.66; // roughly the upper accent fraction, not a dominant presence

// Fill every column up to its height: cap block on top, dirt, then
// stone — moss-flecked via mossNoise rather than uniformly bare, the
// one part of this that used to be completely monotonic regardless of
// position (grass/dirt/sand already vary by cap() and height; the deep
// stone layer never varied by anything at all before this).
function fillColumns(world, height, cap, dirt = BLOCK.DIRT) {
  for (let z = 0; z < SZ; z++)
    for (let x = 0; x < SX; x++) {
      const h = Math.floor(height[at(x, z)]);
      for (let y = 0; y <= h; y++) {
        let v;
        if (y === h) v = cap(x, z, h);
        else if (y > h - 4) v = dirt;
        else v = mossNoise(x, y, z) > MOSS_THRESHOLD ? BLOCK.MOSS : BLOCK.STONE;
        world.data[(y * SZ + z) * SX + x] = v;
      }
    }
}

// Flatten both base plateaus into the height field.
function flattenBases(height) {
  for (const team of ['green', 'blue']) {
    const b = BASE[team];
    for (let z = 0; z < SZ; z++)
      for (let x = 0; x < SX; x++) {
        const d = Math.hypot(x - b.x, z - b.z);
        if (d < b.plateau + 10) {
          const t = Math.min(1, Math.max(0, (d - b.plateau) / 10));
          const i = at(x, z);
          height[i] = height[i] * t + BASE_H * (1 - t);
        }
      }
  }
}

// Team-colored bunker: ring wall with two gates, corner towers, flag plinth.
function buildBase(world, height, team) {
  const b = BASE[team];
  const block = team === 'green' ? BLOCK.GREEN : BLOCK.BLUE;
  const fx = b.x, fz = b.z, fy = Math.floor(height[at(fx, fz)]);
  b.flag = { x: fx, y: fy + 1, z: fz };

  const R = 9;
  for (let a = 0; a < Math.PI * 2; a += 0.02) {
    const wx = Math.round(fx + Math.cos(a) * R), wz = Math.round(fz + Math.sin(a) * R);
    if (Math.abs(wz - fz) < 2 && Math.abs(wx - fx) > R - 2) continue; // gates face east/west
    const wy = Math.floor(height[at(wx, wz)]);
    for (let y = wy + 1; y <= wy + 3; y++) world.data[(y * SZ + wz) * SX + wx] = block;
  }
  for (const [tx, tz] of [[-R, -R], [R, -R], [-R, R], [R, R]]) {
    const px = fx + tx, pz = fz + tz;
    const py = Math.floor(height[at(px, pz)]);
    for (let y = py + 1; y <= py + 6; y++)
      for (let ox = -1; ox <= 1; ox++)
        for (let oz = -1; oz <= 1; oz++)
          world.data[((y) * SZ + (pz + oz)) * SX + (px + ox)] = block;
  }
  for (let ox = -1; ox <= 1; ox++)
    for (let oz = -1; oz <= 1; oz++)
      world.data[(fy * SZ + fz + oz) * SX + fx + ox] = block;
}

// ---------------------------------------------------------------- island
function genIsland(world, seed) {
  const noise = makeNoise(seed);
  const height = new Float32Array(SX * SZ);

  for (let z = 0; z < SZ; z++)
    for (let x = 0; x < SX; x++) {
      // Island falloff so the map is ringed by sea.
      const dx = (x - SX / 2) / (SX / 2), dz = (z - SZ / 2) / (SZ / 2);
      const island = Math.max(0, 1 - (dx * dx + dz * dz) * 1.05);
      let h = SEA + 2
        + island * 26 * (0.55 * noise(x * 0.012, z * 0.012)
                       + 0.30 * noise(x * 0.04,  z * 0.04)
                       + 0.15 * noise(x * 0.11,  z * 0.11));
      // Rolling central ridge gives the midfield some cover.
      h += island * 5 * noise(x * 0.008 + 40, z * 0.008 + 9);
      // Clean shorelines: steepen the waterline crossing so few columns
      // straddle the sea plane (kills the speckled-shallows moiré).
      if (h > SEA - 2 && h < SEA + 2) {
        const t = (h - (SEA - 2)) / 4;
        h = SEA - 2 + 4 * t * t * (3 - 2 * t);
      }
      height[at(x, z)] = Math.min(SY - 8, h);
    }

  flattenBases(height);
  applyShoreEnvelope(height, mapEnvelope(0));

  // A gentle road between the bases — pulled toward its target height in both
  // directions: causeway over water, soft valley through hills, wide smooth
  // shoulders. (Hard clamping used to leave picket-fence cliffs along the edge.)
  for (let x = BASE.green.x; x <= BASE.blue.x; x++) {
    const rz = SZ / 2 + 8 * Math.sin(x * 0.05);
    const target = SEA + 3 + 3 * noise(x * 0.02, 7);
    for (let z = Math.floor(rz - 12); z <= Math.ceil(rz + 12); z++) {
      if (z < 1 || z >= SZ - 1) continue;
      const t = Math.min(1, Math.max(0, (Math.abs(z - rz) - 4) / 8)); // 0 roadbed → 1 off-road
      const i = at(x, z);
      height[i] = height[i] * t + target * (1 - t);
    }
  }

  // Broad meadow bands give the rolling field readable color landmarks
  // without noisy per-voxel fleck: damp hollows run fern-green, occasional
  // exposed ridges turn to earth, and meadow grass remains the main surface.
  fillColumns(world, height, (x, z, h) => {
    if (h <= SEA + 1) return BLOCK.SAND;
    const band = 0.65 * noise(x * 0.018 + 21, z * 0.018 + 8)
      + 0.35 * noise(x * 0.045 + 5, z * 0.045 + 31);
    if (h <= SEA + 10 && band > 0.56) return BLOCK.MOSS;
    if (h >= SEA + 15 && band < 0.24) return BLOCK.DIRT;
    return BLOCK.GRASS;
  });

  // GREENBELT needs authored landmarks as well as good noise. Broken field
  // walls provide a readable middle distance without becoming continuous
  // cover, while paired stone shelves make each flank recognizable from its
  // silhouette alone. Everything is ordinary destructible terrain geometry.
  const wallRuns = [
    [74, 108, SZ / 2 - 27], [SX - 109, SX - 75, SZ / 2 + 27],
  ];
  for (const [x0, x1, z] of wallRuns)
    for (let x = x0; x <= x1; x++) {
      if ((x - x0) % 13 < 3) continue; // collapsed gates and shell gaps
      const y = terrainY(height, x, z);
      put(world, x, y + 1, z, BLOCK.STONE);
      if ((x + z) % 5) put(world, x, y + 2, z, BLOCK.STONE);
    }

  // Two staggered, cross-route belts make the first terrain decision legible:
  // the long center sections stop a casual hop, while the thin cut points are
  // quick spade/grenade breaches. The north/south gates are intentionally
  // absent, preserving permanently open outer flanks on both sides.
  const hedgerowBelt = (x0, thinZ) => {
    for (let z = 72; z <= 184; z++) {
      if (z < 88 || z > 168) continue; // open flank gates
      const thin = Math.abs(z - thinZ) <= 5;
      const depth = thin ? 1 : 4;
      const wallH = thin ? 2 : 3;
      for (let dx = 0; dx < depth; dx++) {
        const x = x0 + dx, y = terrainY(height, x, z);
        for (let wy = 1; wy <= wallH; wy++) {
          const material = (dx === 0 && wy === 1 && (z + x0) % 3 === 0)
            ? BLOCK.DIRT : BLOCK.STONE;
          put(world, x, y + wy, z, material);
        }
      }
    }
  };
  hedgerowBelt(103, SZ / 2 - 12);
  hedgerowBelt(SX - 1 - 106, SZ / 2 + 12);

  const outcrop = (cx, cz, flip = 1) => {
    for (let dx = -5; dx <= 5; dx++)
      for (let dz = -3; dz <= 3; dz++) {
        const edge = Math.abs(dx) / 5 + Math.abs(dz) / 3;
        if (edge > 1.25 || (dx * flip + dz) % 7 === 0) continue;
        const x = cx + dx, z = cz + dz, y = terrainY(height, x, z);
        put(world, x, y + 1, z, BLOCK.STONE);
        if (edge < 0.7 && dx * flip < 3) put(world, x, y + 2, z, BLOCK.STONE);
        if (edge < 0.35 && dx * flip < 0) put(world, x, y + 3, z, BLOCK.STONE);
      }
  };
  outcrop(92, 73, 1);
  outcrop(SX - 1 - 92, SZ - 1 - 73, -1);
  outcrop(112, 188, -1);
  outcrop(SX - 1 - 112, SZ - 1 - 188, 1);

  // Three small, deliberately different silhouettes make the GREENBELT
  // north/center/south lanes legible at a glance. They are landmarks, not
  // hard cover: the center gate has a doorway and the two outer markers are
  // compact enough to route around without sealing the permanent flanks.
  const landmark = (cx, cz, kind) => {
    const blockAt = (x, z, h = 1) => {
      const y = terrainY(height, x, z);
      for (let dy = 1; dy <= h; dy++) put(world, x, y + dy, z, BLOCK.STONE);
    };
    if (kind === 'north') {
      landmark(cx - 3, cz, 'south');
      landmark(cx + 3, cz, 'south');
      landmark(cx, cz, 'tower');
    } else if (kind === 'tower') {
      blockAt(cx, cz, 4);
      for (let dx = -1; dx <= 1; dx++) blockAt(cx + dx, cz, 1);
    } else if (kind === 'center') {
      for (const dx of [-3, 3]) blockAt(cx + dx, cz, 3);
      for (let dx = -3; dx <= 3; dx++) blockAt(cx + dx, cz, 1);
    } else {
      for (let dx = -4; dx <= 4; dx++) {
        const h = Math.max(1, 3 - Math.floor(Math.abs(dx) / 2));
        blockAt(cx + dx, cz, h);
      }
    }
  };
  landmark(SX / 2, 76, 'north');
  landmark(SX / 2, SZ / 2, 'center');
  landmark(SX / 2, 180, 'south');
  buildBase(world, height, 'green');
  buildBase(world, height, 'blue');
}

// ---------------------------------------------------------------- beach
// D-day: green storms out of the western surf, across open sand studded with
// landing craft and tank traps, up a fortified bluff, and into blue's ridge.
function genBeach(world, seed) {
  const noise = makeNoise(seed);
  const height = new Float32Array(SX * SZ);
  BASE.green.x = 40; BASE.blue.x = SX - 40;

  for (let z = 0; z < SZ; z++)
    for (let x = 0; x < SX; x++) {
      let h;
      if (x < 34)       h = SEA - 3.5 + noise(x * 0.05, z * 0.05) * 1.5;   // sea floor
      else if (x < 58)  h = SEA - 3.5 + ((x - 34) / 24) * 5.5;             // surf slope
      else if (x < 100) h = SEA + 2 + ((x - 58) / 42) * 2.5                // the long sand
                        + noise(x * 0.06, z * 0.06) * 1.1;
      else if (x < 158) {                                                   // the bluff
        const b = (x - 100) / 58;
        h = SEA + 4.5 + b * b * 13 + noise(x * 0.08, z * 0.08) * 2.2 * b;
      } else h = SEA + 17.5 + noise(x * 0.03, z * 0.03) * 3;               // blue's ridge
      // Coastline falloff at the z edges, so the map reads as a peninsula.
      const ez = Math.min(z, SZ - 1 - z);
      if (ez < 26) h = Math.min(h, SEA - 2 + (ez / 26) * (h - SEA + 2 + 6) - 6 * (1 - ez / 26));
      height[at(x, z)] = Math.min(SY - 8, h);
    }

  // A covered lane up the bluff for the landing team: a trench cut two
  // blocks deep through the kill zone and up the slope, so green can reach
  // the ridge with its head down instead of crossing open sand the whole way.
  const trenchZ = SZ / 2 + 20 + Math.floor(noise(7, seed % 13) * 12);
  for (let x = 92; x <= 166; x++)
    for (let dz = -3; dz <= 3; dz++) {
      const z = trenchZ + dz;
      if (z < 2 || z >= SZ - 2) continue;
      height[at(x, z)] -= 2.2 * (1 - Math.abs(dz) / 3.5);
    }

  // A second, protected counter-route follows the north/south shoulders of
  // the bluff. It is a deterministic three-wide ramp (not a teleport lane):
  // landing players can choose this collision path when the central trench
  // is contested, while both ramps remain outside the fortified centerline.
  const counterRoutes = [SZ / 2 - 42, SZ / 2 + 42];
  for (const routeZ of counterRoutes)
    for (let x = 100; x <= 158; x++) {
      const target = SEA + 5 + (x - 100) / 58 * 13;
      for (let dz = -2; dz <= 2; dz++) {
        const z = routeZ + dz;
        if (z < 2 || z >= SZ - 2) continue;
        const edge = Math.abs(dz) / 2;
        height[at(x, z)] = target + edge * 0.7;
      }
    }

  flattenBases(height);
  applyShoreEnvelope(height, mapEnvelope(1));
  // Broad coastal material zones replace the old hard sand/grass split.
  // The bands are deliberately low-frequency: they read as damp shoreline,
  // churned bluff earth, meadow, scrub, and exposed ridge rock—not as a
  // texture sprayed across individual cubes.
  fillColumns(world, height, (x, z, h) => {
    const broad = 0.72 * noise(x * 0.016 + 19, z * 0.016 + 7)
      + 0.28 * noise(x * 0.038 + 43, z * 0.038 + 29);
    if (h <= SEA + 5) {
      // Darker damp-sand shelves follow long, irregular tide bands. The dry
      // upper beach stays predominantly gold so the coastline remains clear.
      const damp = noise(x * 0.012 + 4, z * 0.012 + 51);
      if ((x < 72 && h <= SEA + 2 && damp > 0.48)
          || (x >= 84 && broad < 0.27)) return BLOCK.DIRT;
      return BLOCK.SAND;
    }
    // Scrub settles in the lower bluff hollows; bare earth interrupts the
    // climb; the highest ridge sheds soil and exposes broad slate caps.
    if (h >= SEA + 17 && broad < 0.38) return BLOCK.STONE;
    if (h <= SEA + 12 && broad > 0.67) return BLOCK.MOSS;
    if (broad < 0.3) return BLOCK.DIRT;
    return BLOCK.GRASS;
  });

  // Landing craft in the surf — U-shaped stone hulls with the bow ramp open
  // toward the beach. Hard cover the moment you wade ashore.
  for (const bz of [SZ / 2 - 38, SZ / 2 + 36, SZ / 2 + 56]) {
    const bx = 22 + Math.floor(noise(bz, 3) * 8); // in the surf, clear of the LZ
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = 0; dx < 9; dx++) {
        const x = bx + dx, z = bz + dz;
        world.data[(SEA * SZ + z) * SX + x] = BLOCK.STONE;          // dry deck
        const wall = Math.abs(dz) === 2 || dx === 0;                 // sides + stern
        if (wall) for (let y = SEA + 1; y <= SEA + 2; y++)
          world.data[(y * SZ + z) * SX + x] = BLOCK.STONE;
      }
    // Lowered three-step bow ramp: the open end now reads as landing craft,
    // not just a roofless stone rectangle viewed from shore.
    for (let dx = 8; dx <= 10; dx++)
      for (let dz = -1; dz <= 1; dz++)
        put(world, bx + dx, SEA - Math.floor((dx - 8) / 2), bz + dz, BLOCK.STONE);
    put(world, bx + 1, SEA + 3, bz - 2, BLOCK.STONE);
    put(world, bx + 1, SEA + 3, bz + 2, BLOCK.STONE);
  }
  // Czech hedgehogs scattered across the sand. A six-axis jack silhouette is
  // recognizable from any approach, unlike the former three-block L that
  // mostly read as random gray debris.
  const rnd = mulberry32(seed ^ 0xBEAC);
  for (let i = 0; i < 55; i++) {
    const x = 60 + Math.floor(rnd() * 40), z = 24 + Math.floor(rnd() * (SZ - 48));
    const y = Math.floor(height[at(x, z)]);
    put(world, x, y + 1, z, BLOCK.STONE);
    put(world, x, y + 2, z, BLOCK.STONE);
    put(world, x, y + 3, z, BLOCK.STONE);
    put(world, x - 1, y + 2, z, BLOCK.STONE);
    put(world, x + 1, y + 2, z, BLOCK.STONE);
    put(world, x, y + 2, z - 1, BLOCK.STONE);
    put(world, x, y + 2, z + 1, BLOCK.STONE);
  }
  // MG pillbox: recessed slit, wide rear door, corner buttresses, and a
  // one-block roof overhang. The stronger silhouette remains a small,
  // destructible structure rather than a detailed prop mesh.
  const pillbox = (px, pz, face) => {
    const py = Math.floor(height[at(px, pz)]);
    for (let dx = -2; dx <= 2; dx++)
      for (let dz = -2; dz <= 2; dz++) {
        const x = px + dx, z = pz + dz;
        const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2;
        if (!edge) continue;
        if (dx === -face && Math.abs(dz) <= 1) continue;                    // rear door
        for (let y = py + 1; y <= py + 3; y++) {
          if (dx === face && Math.abs(dz) <= 1 && y === py + 2) continue;   // firing slit
          world.data[(y * SZ + z) * SX + x] = BLOCK.STONE;
        }
      }
    for (let dx = -3; dx <= 3; dx++)                                        // overhanging slab roof
      for (let dz = -3; dz <= 3; dz++)
        put(world, px + dx, py + 4, pz + dz, BLOCK.STONE);
    for (const [dx, dz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) {          // stepped buttresses
      put(world, px + dx, py + 1, pz + dz, BLOCK.STONE);
      put(world, px + dx, py + 2, pz + dz, BLOCK.STONE);
    }
    // Broken low apron on the firing side gives the bunker a front/back read
    // even when the slit itself is too small to resolve.
    for (let dz = -4; dz <= 4; dz++) {
      if (Math.abs(dz) === 1 || Math.abs(dz) === 4) continue;
      const x = px + face * 4, z = pz + dz, y = terrainY(height, x, z);
      put(world, x, y + 1, z, BLOCK.STONE);
    }
  };
  // Three pillboxes dug into the bluff top, guns slitted toward the beach —
  // and one green bunker at the beach head answering back, so the landing
  // team has a forward strongpoint to rally on.
  for (const pz of [SZ / 2 - 48, SZ / 2, SZ / 2 + 48])
    pillbox(150 + Math.floor(noise(pz, 11) * 6), pz, -2);
  pillbox(72, SZ / 2, 2);

  // One continuous but deliberately damaged fortified line makes the three
  // pillboxes read as a shared defense. Thin sections are only two voxels
  // wide: a spade or grenade opens them, while the offset gaps retain the
  // covered trench and both flank ramps as ordinary always-usable routes.
  for (const [from, to] of [[SZ / 2 - 43, SZ / 2 - 7], [SZ / 2 + 7, SZ / 2 + 43]])
    for (let z = from; z <= to; z++) {
      if ((z - from) % 15 < 4 || Math.abs(z - trenchZ) < 5
          || counterRoutes.some(route => Math.abs(z - route) < 5)) continue;
      const x = 142 + Math.floor(noise(z, 19) * 4), y = terrainY(height, x, z);
      put(world, x, y + 1, z, BLOCK.STONE);
      if ((z - from) % 8 !== 0) put(world, x, y + 2, z, BLOCK.STONE);
    }

  // The high ridge is intentionally broken into short, destructible sightline
  // interrupts. Gaps stay wider than the cover so the ridge never becomes a
  // second continuous wall or a mandatory choke after the landing ramps.
  for (const [x0, z0] of [[174, SZ / 2 - 30], [190, SZ / 2 + 24],
    [208, SZ / 2 - 38], [222, SZ / 2 + 34]]) {
    for (let dx = 0; dx < 3; dx++) {
      const x = x0 + dx, z = z0 + (dx === 1 ? 1 : 0);
      const y = terrainY(height, x, z);
      put(world, x, y + 1, z, BLOCK.STONE);
      if (dx !== 1) put(world, x, y + 2, z, BLOCK.STONE);
    }
  }

  buildBase(world, height, 'green');
  buildBase(world, height, 'blue');
}

// ---------------------------------------------------------------- forest
// Rolling inland hills under a dense voxel canopy, a creek cutting the
// midfield — short sightlines, ambushes, and trees you can fell for cover.
export const PINEFALL_RAVINE_HALF_WIDTH = 13;
export function pinefallRavineCenter(seed, x) {
  const ford = SX / 2 + ((seed % 5) - 2) * 6;
  return SZ / 2 + 58 * Math.sin((x - ford) * 0.022);
}

const smooth01 = t => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

function envelopeEdgeDistance(envelope, x, z) {
  if (envelope.shape !== 'ellipse')
    return Math.min(x - envelope.minX, envelope.maxX - x,
      z - envelope.minZ, envelope.maxZ - z);
  const cx = (envelope.minX + envelope.maxX) / 2;
  const cz = (envelope.minZ + envelope.maxZ) / 2;
  const rx = (envelope.maxX - envelope.minX) / 2;
  const rz = (envelope.maxZ - envelope.minZ) / 2;
  const radial = Math.hypot((x - cx) / rx, (z - cz) / rz);
  return (1 - radial) * Math.min(rx, rz);
}

// Pull a rectangular combat space down into water over a broad shore.  The
// transition happens inside the declared envelope, so the edge reads as a
// shoreline/bank and never as a hard gameplay boundary.
function applyShoreEnvelope(height, envelope, depth = 14) {
  for (let z = 0; z < SZ; z++) for (let x = 0; x < SX; x++) {
    const edge = envelopeEdgeDistance(envelope, x, z);
    if (edge >= depth) continue;
    const i = at(x, z);
    if (edge <= 0) height[i] = Math.min(height[i], SEA - 3);
    else {
      const t = smooth01(edge / depth);
      height[i] = (SEA - 3) * (1 - t) + height[i] * t;
    }
  }
}

// Arena maps retain dry natural containment. The boundary is a rounded ridge,
// not a square stadium wall: original terrain contributes to its silhouette,
// then the exterior falls away so climbing over it never unlocks a safe flat
// highway around the fight. It remains ordinary destructible terrain.
function applyArenaRim(height, envelope, floor = SEA + 8, rim = SEA + 24) {
  for (let z = 0; z < SZ; z++) for (let x = 0; x < SX; x++) {
    const edge = envelopeEdgeDistance(envelope, x, z);
    if (edge >= 18) continue;
    const i = at(x, z), original = height[i];
    // The exterior is a lower wasteland behind a sheer voxel escarpment.
    // Dropping out is possible but dangerous; walking a safe perimeter and
    // stepping back into the arena is not.
    if (edge < 0) {
      height[i] = Math.max(SEA + 2, original - 7);
      continue;
    }
    const ridge = 1 - smooth01(edge / 18);
    const irregularRim = rim + (original - floor) * 0.28;
    const shaped = original * (1 - ridge) + irregularRim * ridge;
    height[i] = Math.max(original, shaped);
  }
}
export function pinefallRavineHeight(originalHeight, distance) {
  if (distance >= PINEFALL_RAVINE_HALF_WIDTH) return originalHeight;
  // Smoothly blend the original hillside into a one-block-deep creek bed.
  // This produces broad, walkable banks instead of a narrow vertical cut.
  const t = Math.max(0, distance) / PINEFALL_RAVINE_HALF_WIDTH;
  const edge = t * t * (3 - 2 * t);
  return (SEA - 0.25) * (1 - edge) + originalHeight * edge;
}

function genForest(world, seed) {
  const noise = makeNoise(seed);
  const height = new Float32Array(SX * SZ);

  for (let z = 0; z < SZ; z++)
    for (let x = 0; x < SX; x++) {
      const dx = (x - SX / 2) / (SX / 2), dz = (z - SZ / 2) / (SZ / 2);
      const rim = Math.max(0, 1 - (dx * dx + dz * dz) * 1.35); // gentler than island
      let h = SEA + 4
        + rim * 18 * (0.6 * noise(x * 0.016, z * 0.016)
                    + 0.4 * noise(x * 0.05,  z * 0.05));
      // A broad, shallow ravine with a narrow creek bed. Its sloped banks are
      // a traversable low route and natural firing edge, rather than the old
      // eleven-block-wide hard cut players could mostly ignore. The meander is
      // pinned to ford midfield: the old phase (seed % 7 in absolute x)
      // could push every zero crossing outside the creek's x-range, so the
      // base-to-base path never got wet. Now it always fords near x=128.
      const ravineZ = pinefallRavineCenter(seed, x);
      const distance = Math.abs(z - ravineZ);
      if (x > 50 && x < SX - 50)
        h = Math.min(h, pinefallRavineHeight(h, distance));
      height[at(x, z)] = Math.min(SY - 8, h);
    }

  flattenBases(height);
  applyShoreEnvelope(height, mapEnvelope(2));
  fillColumns(world, height, (x, z, h) => h < SEA ? BLOCK.DIRT : BLOCK.GRASS);

  // Four tree silhouettes instead of one cloned trunk-plus-cube. Foliage is
  // the existing moss block (still flat-color and textureless), which keeps
  // crowns distinct from the grass floor. Every archetype remains ordinary
  // destructible voxels, and the total block budget stays close to the old
  // two-layer 3x3 canopy.
  const rnd = mulberry32(seed ^ 0xf0e57);
  for (let i = 0; i < 260; i++) {
    const x = 6 + Math.floor(rnd() * (SX - 12)), z = 6 + Math.floor(rnd() * (SZ - 12));
    if (Math.hypot(x - BASE.green.x, z - BASE.green.z) < 26) continue;
    if (Math.hypot(x - BASE.blue.x, z - BASE.blue.z) < 26) continue;
    const y = Math.floor(height[at(x, z)]);
    if (y < SEA + 1) continue; // no trees in the creek or the sea
    const kind = Math.floor(rnd() * 4);
    const trunk = kind === 0 ? 5 + Math.floor(rnd() * 2)
      : kind === 1 ? 3 + Math.floor(rnd() * 2) : 4 + Math.floor(rnd() * 2);
    for (let t = 1; t <= trunk; t++) put(world, x, y + t, z, BLOCK.DIRT);
    const crown = (cy, radius, ox = 0, oz = 0, corners = true) => {
      for (let dx = -radius; dx <= radius; dx++)
        for (let dz = -radius; dz <= radius; dz++) {
          if (!corners && Math.abs(dx) === radius && Math.abs(dz) === radius) continue;
          put(world, x + ox + dx, y + cy, z + oz + dz, BLOCK.MOSS);
        }
    };
    if (kind === 0) { // tall stepped pine
      crown(trunk - 1, 1); crown(trunk, 2, 0, 0, false);
      crown(trunk + 1, 1); put(world, x, y + trunk + 2, z, BLOCK.MOSS);
    } else if (kind === 1) { // short, dense field pine
      crown(trunk, 2, 0, 0, false); crown(trunk + 1, 1);
      put(world, x, y + trunk + 2, z, BLOCK.MOSS);
    } else if (kind === 2) { // wind-shaped offset crown
      const ox = rnd() < 0.5 ? -1 : 1, oz = rnd() < 0.5 ? -1 : 1;
      crown(trunk, 2, ox, 0, false); crown(trunk + 1, 1, ox, oz);
      put(world, x + ox, y + trunk + 2, z + oz, BLOCK.MOSS);
    } else { // damaged pine: exposed trunk and a deliberately broken crown
      const side = rnd() < 0.5 ? -1 : 1;
      crown(trunk, 1, side, 0, false);
      put(world, x + side * 2, y + trunk, z, BLOCK.MOSS);
      put(world, x, y + trunk + 1, z, BLOCK.MOSS);
    }
  }

  // Keep the seeded canopy expressive in the wilderness, but guarantee a
  // small, deterministic headroom envelope on each primary base exit. The
  // clearance starts beyond the bunker footprint and follows the shared
  // midfield approach, so no random tree can roof the first engagement.
  const clearBaseExit = (x0, x1) => {
    for (let x = x0; x <= x1; x++) for (let z = SZ / 2 - 4; z <= SZ / 2 + 4; z++) {
      const floor = Math.floor(height[at(x, z)]);
      for (let y = floor + 1; y < SY; y++)
        world.data[(y * SZ + z) * SX + x] = 0;
    }
  };
  clearBaseExit(BASE.green.x + 8, BASE.green.x + 46);
  clearBaseExit(BASE.blue.x - 46, BASE.blue.x - 8);

  // The ravine now offers three unmistakable choices. A low stone ford is
  // permanent and protected; a higher dirt bridge has a real four-block gap
  // between ordinary voxel abutments; a short shoulder lip is intentionally
  // thin enough to cut with the spade. Nothing relies on falling-tree physics.
  const bridgeZ = Math.round(pinefallRavineCenter(seed, 128));
  const bridgeY = SEA + 1;
  for (let x = 120; x <= 136; x++) {
    if (x >= 126 && x <= 129) continue; // the visible 4-block breach
    for (let dz = -2; dz <= 2; dz++) put(world, x, bridgeY, bridgeZ + dz,
      (x + dz) % 3 ? BLOCK.DIRT : BLOCK.STONE);
  }
  for (const x of [121, 135]) for (let y = SEA + 1; y <= bridgeY; y++)
    for (let dz = -1; dz <= 1; dz++) put(world, x, y, bridgeZ + dz, BLOCK.STONE);

  const fordX = 128, fordZ = bridgeZ + 8;
  // Clear the seeded canopy/shoulder from this low crossing first; otherwise
  // a random tree can turn a water-level ford into a roofed obstacle.
  for (let x = fordX - 6; x <= fordX + 6; x++)
    for (let dz = -3; dz <= 3; dz++)
      for (let y = SEA + 1; y < SY; y++) world.data[(y * SZ + fordZ + dz) * SX + x] = 0;
  for (let x = fordX - 6; x <= fordX + 6; x++)
    for (let dz = -3; dz <= 3; dz++) put(world, x, SEA, fordZ + dz, BLOCK.STONE);

  for (let x = 136; x <= 146; x++) {
    const bankZ = Math.round(pinefallRavineCenter(seed, x)) + PINEFALL_RAVINE_HALF_WIDTH - 2;
    const y = terrainY(height, x, bankZ);
    put(world, x, y + 1, bankZ, BLOCK.DIRT);
    if (x % 3 !== 0) put(world, x, y + 2, bankZ, BLOCK.DIRT);
  }

  buildBase(world, height, 'green');
  buildBase(world, height, 'blue');
}

// ---------------------------------------------------------------- desert
// Sweeping dunes, flat-topped mesas for snipers, a ruined sandstone village
// at midfield. Long sightlines — move dune-to-dune or get picked off.
function genDesert(world, seed) {
  const noise = makeNoise(seed);
  const height = new Float32Array(SX * SZ);
  BASE.green.x = 52; BASE.blue.x = SX - 52;
  const CX = SX / 2, CZ = SZ / 2; // the hill sits at dead center
  // Everything west of the midfield axis is mirrored east (x -> SX-1-x), so
  // both teams walk identical approaches, perches, and cover. The bases sit
  // at matching z, which makes the mirror line the fair line.
  const rnd0 = mulberry32(seed ^ 0xde5e37);
  const mesas = [];
  while (mesas.length < 4) {
    const mx = 44 + rnd0() * 62, mz = 40 + rnd0() * (SZ - 80); // west half only
    if (Math.hypot(mx - CX, mz - CZ) < 34) continue;      // no perch on the point
    if (Math.hypot(mx - BASE.green.x, mz - BASE.green.z) < 40) continue;
    mesas.push([mx, mz], [SX - 1 - mx, mz]);              // every mesa has a twin
  }

  for (let z = 0; z < SZ; z++)
    for (let x = 0; x < SX; x++) {
      const fx = Math.min(x, SX - 1 - x); // folded west: the east is a mirror
      // Ridged dune field marching diagonally across the map.
      const dune = Math.abs(Math.sin((fx + z) * 0.045 + noise(fx * 0.01, z * 0.01) * 3));
      let h = SEA + 6 + dune * 7 + noise(fx * 0.03, z * 0.03) * 2.5;
      // Mirrored dry washes interrupt the otherwise continuous contour
      // stripes. They are broad, shallow navigation landmarks—not noisy
      // per-block scars—and preserve both teams' matching approaches.
      const washZ = 45 + noise(fx * 0.026 + 17, 8) * 29;
      const washD = Math.min(Math.abs(z - washZ), Math.abs(z - (SZ - 1 - washZ)));
      if (washD < 5) h -= (1 - washD / 5) * 3.2;
      for (const [mx, mz] of mesas) {
        const d = Math.hypot(x - mx, z - mz);
        if (d < 12) { // flat top, sheer sides
          const t = Math.min(1, Math.max(0, (d - 7) / 5));
          h = h * t + (SEA + 22) * (1 - t);
        }
      }
      height[at(x, z)] = Math.min(SY - 8, Math.max(SEA + 3, h)); // no sea here
    }

  // The hill pad: a flat, stone-capped disc at dead center, so the point
  // fights the same from every approach. Blends back into the dunes outside.
  // Centered on the 127.5 mirror axis exactly, or the blend ring would break
  // the symmetry it flattens.
  const PAD = SEA + 9, AX = (SX - 1) / 2;
  for (let z = 0; z < SZ; z++)
    for (let x = 0; x < SX; x++) {
      const d = Math.hypot(x - AX, z - CZ);
      if (d < 20) {
        const t = ss((d - 9) / 11);
        const i = at(x, z);
        height[i] = height[i] * t + PAD * (1 - t);
      }
    }

  flattenBases(height);
  applyArenaRim(height, mapEnvelope(3), SEA + 10, SEA + 26);
  fillColumns(world, height,
    (x, z) => {
      if (Math.hypot(x - AX, z - CZ) < 9) return BLOCK.STONE;
      // Wide mineral bands add ochre/umber rhythm to the dunes; the low
      // frequency keeps them geological rather than texture-like.
      return noise(x * 0.025 + 17, z * 0.025 + 41) > 0.73 ? BLOCK.DIRT : BLOCK.SAND;
    }, BLOCK.SAND);

  // Mesas cap in stone — the perch reads as rock and tunnels stay sandy.
  for (const [mx, mz] of mesas)
    for (let dx = -7; dx <= 7; dx++)
      for (let dz = -7; dz <= 7; dz++) {
        if (Math.hypot(dx, dz) > 7) continue;
        const x = Math.round(mx + dx), z = Math.round(mz + dz);
        const y = Math.floor(height[at(x, z)]);
        world.data[(y * SZ + z) * SX + x] = BLOCK.STONE;
      }

  // Midfield ruins: one broken sandstone rectangle north of the point, placed
  // twice — itself and its mirror twin. Same walls, same gaps, same fight.
  const rnd = mulberry32(seed ^ 0x2015);
  {
    const rx = SX / 2 - 14, rz = SZ / 2 - 10;
    /** @type {Array<[number, number, boolean, number]>} */
    const cols = [];
    for (let per = 0; per < 22; per++) {
      const side = per % 4, step = Math.floor(per / 4);
      const x = rx + (side === 0 ? step * 2 : side === 1 ? 8 : side === 2 ? step * 2 : 0);
      const z = rz + (side === 0 ? 0 : side === 1 ? step * 2 : side === 2 ? 8 : step * 2);
      cols.push([x, z, rnd() < 0.3, 2 + Math.floor(rnd() * 3)]);
    }
    for (const [x, z, gone, wallH] of cols) {
      if (gone) continue; // collapsed gaps
      for (const px of [x, SX - 1 - x]) {
        const y = Math.floor(height[at(px, z)]);
        for (let wy = 1; wy <= wallH; wy++)
          world.data[((y + wy) * SZ + z) * SX + px] = BLOCK.STONE;
      }
    }
  }
  // A paired broken gate gives the village a vertical read from across the
  // dunes. The opening is real (and destructible), so it doubles as useful
  // movement geometry rather than decorative clutter.
  const ruinGate = (px, pz) => {
    const y = terrainY(height, px, pz);
    for (let wy = 1; wy <= 5; wy++) {
      put(world, px - 2, y + wy, pz, BLOCK.STONE);
      put(world, px + 2, y + wy, pz, BLOCK.STONE);
    }
    for (let dx = -2; dx <= 2; dx++) put(world, px + dx, y + 5, pz, BLOCK.STONE);
    for (let dz = 1; dz <= 4; dz++) {
      if (dz === 3) continue;
      put(world, px - 2, y + 1, pz + dz, BLOCK.STONE);
      if (dz < 3) put(world, px - 2, y + 2, pz + dz, BLOCK.STONE);
    }
  };
  ruinGate(SX / 2 - 12, SZ / 2 - 14);
  ruinGate(SX / 2 + 11, SZ / 2 - 14);
  // Paired skeletal arch courts frame the rotating hill approaches. Their
  // narrow, exposed stone legs are normal voxels: removing one lets the
  // existing unsupported-structure pass turn the high perch into rubble.
  // The courts sit outside the pad and the broad dry washes, so neither a
  // collapse nor a rebuild can close the objective's permanent routes.
  const archCourt = (px, pz) => {
    const footingY = (x, z) => {
      let y = 0;
      for (let dx = -1; dx <= 1; dx++)
        for (let dz = -1; dz <= 1; dz++)
          y = Math.max(y, terrainY(height, x + dx, z + dz));
      return y;
    };
    for (const dz of [-3, 3]) {
      for (const side of [-5, 5]) {
        const x = px + side, z = pz + dz, y = footingY(x, z);
        for (let dy = 1; dy <= 8; dy++) put(world, x, y + dy, z, BLOCK.STONE);
        // A high brace strengthens the silhouette without touching terrain;
        // the exposed bottom cell remains the half-arch's only ground path.
        const inward = side < 0 ? 1 : -1;
        put(world, x + inward, y + 4, z, BLOCK.STONE);
        // A one-voxel crown crack separates the two cantilevers. That keeps
        // the ruin reading as an arch while each leg remains independently
        // severable by one bottom-cell breach.
        for (let step = 0; step < 5; step++)
          put(world, x + inward * step, y + 8, z, BLOCK.STONE);
        put(world, x + inward * 2, y + 9, z, BLOCK.STONE);
      }
    }
    // Broken cross pieces sell the court silhouette without joining its two
    // arch frames or creating a solid roof.
    for (const side of [-5, 5])
      for (const dz of [-2, -1, 1, 2]) {
        const frameZ = pz + (dz < 0 ? -3 : 3);
        put(world, px + side, footingY(px + side, frameZ) + 6,
          pz + dz, BLOCK.STONE);
      }
  };
  archCourt(101, CZ - 20);
  archCourt(SX - 1 - 101, CZ - 20);
  // Cacti, mirrored like everything else.
  for (let i = 0; i < 21; i++) {
    const x = 6 + Math.floor(rnd() * (CX - 12)), z = 6 + Math.floor(rnd() * (SZ - 12));
    if (Math.hypot(x - CX, z - CZ) < 14) continue; // the arena stays clear
    if (Math.hypot(x - BASE.green.x, z - BASE.green.z) < 24) continue;
    const cactusH = 2 + Math.floor(rnd() * 2);
    for (const px of [x, SX - 1 - x]) {
      const y = Math.floor(height[at(px, z)]);
      for (let cy = 1; cy <= cactusH; cy++)
        world.data[((y + cy) * SZ + z) * SX + px] = BLOCK.GREEN;
    }
  }

  buildBase(world, height, 'green');
  buildBase(world, height, 'blue');
}

const clamp01 = t => Math.min(1, Math.max(0, t));
const ss = t => { t = clamp01(t); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- crown
// Purpose-built king of the hill: a sheer-sided central plateau ringed by a
// water moat, crossed by four causeways, crowned with a broken ring fort.
// The plateau top is the hill. Symmetric, short sightlines up the ramps,
// and the fort is stone you will absolutely crater by minute three.
function genCrown(world, seed) {
  const noise = makeNoise(seed);
  const height = new Float32Array(SX * SZ);
  BASE.green.x = 52; BASE.blue.x = SX - 52;
  const CX = SX / 2, CZ = SZ / 2, TOP = SEA + 20;

  for (let z = 0; z < SZ; z++)
    for (let x = 0; x < SX; x++) {
      const dx = (x - CX) / (SX / 2), dz = (z - CZ) / (SZ / 2);
      const island = Math.max(0, 1 - (dx * dx + dz * dz) * 1.05);
      // Gentle lowlands — the crown has to dominate, so the field stays low.
      const field = SEA + 2
        + island * 8 * (0.6 * noise(x * 0.014, z * 0.014)
                      + 0.4 * noise(x * 0.045, z * 0.045));
      const d = Math.hypot(x - CX, z - CZ);
      let h = field;
      if (d < 16) h = TOP;                               // flat crown
      else if (d < 24) h = TOP + (field - TOP) * ss((d - 16) / 8); // sheer skirt
      if (d > 29 && d < 37) h = Math.min(h, SEA - 1);    // the moat
      // Four causeways: ramp up the skirt, bridge over the moat.
      const along = Math.max(Math.abs(x - CX), Math.abs(z - CZ));
      const perp = Math.min(Math.abs(x - CX), Math.abs(z - CZ));
      if (perp < 5.5 && along > 4 && along < 44) {
        const t = clamp01((along - 16) / 24);
        const target = TOP * (1 - t) + Math.max(field, SEA + 1.5) * t;
        const b = clamp01((5.5 - perp) / 2.5);           // 1 centerline → 0 edge
        h = h * (1 - b) + target * b;
      }
      // North/south causeways have a short raised bridge span over the moat.
      // Leave the span's footprint low here, then lay ordinary stone voxels
      // after fillColumns so destroying them exposes a real, rebuildable gap.
      const span = (Math.abs(z - (CZ - 32)) <= 4 || Math.abs(z - (CZ + 32)) <= 4)
        && Math.abs(x - CX) <= 4;
      if (span) h = Math.min(h, SEA - 1);
      height[at(x, z)] = Math.min(SY - 8, h);
    }

  flattenBases(height);
  applyShoreEnvelope(height, mapEnvelope(4), 16);
  fillColumns(world, height, (x, z, h) => h <= SEA + 1 ? BLOCK.SAND : BLOCK.GRASS);

  // Two short, symmetric center spans are destructible and rebuildable;
  // their abutments and the east/west causeway fallbacks stay permanent.
  for (const spanZ of [CZ - 32, CZ + 32])
    for (let z = spanZ - 4; z <= spanZ + 4; z++)
      for (let x = CX - 4; x <= CX + 4; x++)
        put(world, x, SEA + 8, z, BLOCK.STONE);

  // The ring fort: a broken stone circle on the crown, gates on the four
  // causeway mouths, stub towers on the diagonals.
  const rnd = mulberry32(seed ^ 0xc20);
  for (let a = 0; a < Math.PI * 2; a += 0.025) {
    if (rnd() < 0.3) continue; // collapsed arcs
    const wx = Math.round(CX + Math.cos(a) * 10), wz = Math.round(CZ + Math.sin(a) * 10);
    if (Math.min(Math.abs(wx - CX), Math.abs(wz - CZ)) <= 1) continue; // gates
    const wy = Math.floor(height[at(wx, wz)]);
    const wallH = 3 + Math.floor(rnd() * 3);
    for (let y = wy + 1; y <= wy + wallH; y++) world.data[(y * SZ + wz) * SX + wx] = BLOCK.STONE;
  }
  for (const [tx, tz] of [[-7, -7], [7, -7], [-7, 7], [7, 7]]) {
    const px = CX + tx, pz = CZ + tz;
    const py = Math.floor(height[at(px, pz)]);
    for (let y = py + 1; y <= py + 6; y++)
      for (let ox = -1; ox <= 1; ox++)
        for (let oz = -1; oz <= 1; oz++)
          if (rnd() > 0.15) world.data[(y * SZ + pz + oz) * SX + px + ox] = BLOCK.STONE;
  }

  // Four matching gate-outworks punctuate the otherwise empty approaches.
  // The three-block center opening preserves the direct route to each
  // causeway; low broken wings provide landmark-scale cover without turning
  // the field into another fort.
  const outwork = (dx, dz) => {
    const cx = Math.round(CX + dx * 46), cz = Math.round(CZ + dz * 46);
    const tx = -dz, tz = dx, ix = -dx, iz = -dz;
    for (let u = -5; u <= 5; u++) {
      if (Math.abs(u) <= 1) continue;
      const x = cx + tx * u, z = cz + tz * u, y = terrainY(height, x, z);
      put(world, x, y + 1, z, BLOCK.STONE);
      if (Math.abs(u) !== 3) put(world, x, y + 2, z, BLOCK.STONE);
    }
    for (const u of [-5, 5])
      for (let v = 1; v <= 3; v++) {
        const x = cx + tx * u + ix * v, z = cz + tz * u + iz * v;
        const y = terrainY(height, x, z);
        put(world, x, y + 1, z, BLOCK.STONE);
        if (v < 3) put(world, x, y + 2, z, BLOCK.STONE);
      }
  };
  outwork(1, 0); outwork(-1, 0); outwork(0, 1); outwork(0, -1);

  buildBase(world, height, 'green');
  buildBase(world, height, 'blue');
}

// ---------------------------------------------------------------- caldera
// A volcanic crater: high rim all around, an ash bowl inside, and a rocky
// knoll at the bottom — the hill. Two saddle gaps in the rim face the bases;
// everywhere else you dig through or climb over. Snipers own the rim,
// brawlers own the bowl.
function genCaldera(world, seed) {
  const noise = makeNoise(seed);
  const height = new Float32Array(SX * SZ);
  BASE.green.x = 52; BASE.blue.x = SX - 52;
  const CX = SX / 2, CZ = SZ / 2;

  for (let z = 0; z < SZ; z++)
    for (let x = 0; x < SX; x++) {
      const plain = SEA + 6 + 6 * noise(x * 0.02, z * 0.02) + 3 * noise(x * 0.07, z * 0.07);
      const bowl = SEA + 3 + 1.5 * noise(x * 0.09 + 9, z * 0.09 + 9);
      // Angular height bands fracture the rim's formerly near-perfect ring.
      // Folding x keeps the two base-facing halves equivalent while letting
      // north and south develop memorable, irregular skylines.
      const angle = Math.atan2(z - CZ, Math.abs(x - CX) + 0.001);
      const rimBreak = 2.2 * Math.sin(angle * 7 + seed * 0.0007)
        + 1.1 * Math.sin(angle * 13 - seed * 0.0003);
      const rimH = SEA + 22 + 4 * noise(x * 0.05 + 4, z * 0.05 + 4) + rimBreak;
      const d = Math.hypot(x - CX, z - CZ);
      let h;
      if (d < 38) h = bowl;
      else if (d < 50) h = bowl + (rimH - bowl) * ss((d - 38) / 12);   // inner wall
      else if (d < 64) h = rimH;                                       // the rim
      else if (d < 78) h = rimH + (plain - rimH) * ss((d - 64) / 14);  // outer falloff
      else h = plain;
      // Three mirrored, base-facing ramp cuts connect the rotating points to
      // both sides of the crater. They only soften a narrow slice of the
      // inner rim: the volcanic bowl and its editable fault gates remain.
      // The central cut is deliberately broader, preserving the saddle as
      // Caldera's most legible direct route rather than a one-body choke.
      const routeZ = [CZ - 28, CZ, CZ + 28];
      for (const rz of routeZ) {
        const halfWidth = rz === CZ ? 11 : 7;
        const offset = Math.abs(z - rz);
        if (offset >= halfWidth || d <= 30 || d >= 72) continue;
        const ramp = SEA + 5 + Math.min(9, Math.max(0, d - 30) * 0.22);
        const blend = clamp01((halfWidth - offset) / 3);
        h = h * (1 - blend) + Math.min(h, ramp) * blend;
      }
      // North/south fault gates are shallow cuts through the rim, not solid
      // mountain walls. Their ordinary stone fins below are quick to breach;
      // the east/west saddles above remain the permanent fallback routes.
      const fault = (Math.abs(z - (CZ - 64)) <= 1 || Math.abs(z - (CZ + 64)) <= 1)
        && Math.abs(x - CX) <= 24;
      if (fault) h = Math.min(h, SEA + 10);
      height[at(x, z)] = Math.min(SY - 8, h);
    }

  // Each rotating hill receives a level, walkable footprint plus a gentle
  // apron. The center remains a raised knoll; the north/south bowls stay low
  // ground, so relocating the point changes the fight without making bodies
  // climb a random radial wall just to stand together.
  for (const { z: hz } of MAPS[5].hills) {
    const padY = hz === CZ ? SEA + 10 : SEA + 4;
    for (let z = Math.floor(hz - 15); z <= Math.ceil(hz + 15); z++)
      for (let x = CX - 15; x <= CX + 15; x++) {
        const d = Math.hypot(x - CX, z - hz);
        if (d <= 11) height[at(x, z)] = padY;
        else if (d <= 15) height[at(x, z)] = padY
          + (height[at(x, z)] - padY) * ss((d - 11) / 4);
      }
  }

  flattenBases(height);
  applyArenaRim(height, mapEnvelope(5), SEA + 12, SEA + 28);
  // Scorched ground: stone outcrops breaking through packed ash.
  fillColumns(world, height,
    (x, z) => noise(x * 0.11 + 3, z * 0.11 + 3) > 0.62 ? BLOCK.STONE : BLOCK.DIRT);

  // Thin, symmetric basalt fault gates: one voxel deep across the approach,
  // short enough for a spade/grenade opening, and outside the protected hill.
  for (const gateZ of [CZ - 64, CZ + 64])
    for (let x = CX - 24; x <= CX + 24; x++)
      for (let y = SEA + 11; y <= SEA + 16; y++)
        put(world, x, y, gateZ, BLOCK.STONE);

  // Basalt formations scattered across the bowl—single columns, paired
  // fins, and broken clusters rather than fourteen copies of one pillar.
  // They remain chewable cover, but cannot obstruct a hill footprint or its
  // immediate apron after a rotation.
  const rnd = mulberry32(seed ^ 0xca1de);
  for (let i = 0; i < 14; i++) {
    const a = rnd() * Math.PI * 2, d = 15 + rnd() * 20;
    const px = Math.round(CX + Math.cos(a) * d), pz = Math.round(CZ + Math.sin(a) * d);
    if (MAPS[5].hills.some(h => Math.hypot(px - h.x, pz - h.z) < h.r + 5)) continue;
    const py = Math.floor(height[at(px, pz)]);
    const ph = 3 + Math.floor(rnd() * 4);
    for (let y = py + 1; y <= py + ph; y++) put(world, px, y, pz, BLOCK.STONE);
    const kind = i % 3;
    if (kind === 0) {
      for (let y = py + 1; y <= py + ph - 1; y++) put(world, px + 1, y, pz + 1, BLOCK.STONE);
    } else if (kind === 1) {
      for (let y = py + 1; y <= py + Math.max(2, ph - 2); y++) {
        put(world, px - 1, y, pz, BLOCK.STONE);
        put(world, px + 1, y, pz + 1, BLOCK.STONE);
      }
      put(world, px + 2, py + 1, pz + 1, BLOCK.STONE);
    } else {
      for (let s = 1; s <= 3; s++) {
        put(world, px + s, py + 1, pz, BLOCK.STONE);
        if (s < 3) put(world, px + s, py + 2, pz, BLOCK.STONE);
      }
      put(world, px, py + ph, pz + 1, BLOCK.STONE);
    }
  }

  // Low, separated fins interrupt the otherwise dominant rim sightlines.
  // Their fixed gaps preserve the broad saddle choices and ordinary voxel
  // edits can remove them; they are intentionally shorter than the rim.
  const rimInterruptions = [
    [CX - 53, CZ - 16], [CX - 48, CZ + 20],
    [CX + 53, CZ + 16], [CX + 48, CZ - 20],
    [CX - 18, CZ - 53], [CX + 20, CZ + 53],
  ];
  for (const [px, pz] of rimInterruptions) {
    const py = Math.floor(height[at(px, pz)]);
    for (let dz = -1; dz <= 1; dz++) {
      const x = px + (Math.abs(dz) === 1 ? 1 : 0), z = pz + dz;
      put(world, x, py + 1, z, BLOCK.STONE);
      if (dz !== 0) put(world, x, py + 2, z, BLOCK.STONE);
    }
  }

  // Two compact, protected staging pockets sit just beyond every hill apron.
  // The inward-facing side stays open, preserving capture approach space while
  // the short outer wall gives a squad a fair first foothold.
  for (const h of MAPS[5].hills)
    for (const side of [-1, 1]) {
      const px = h.x + side * 17, pz = h.z, py = Math.floor(height[at(px, pz)]);
      for (let dz = -2; dz <= 2; dz++) {
        const x = px + side * 2, z = pz + dz;
        put(world, x, py + 1, z, BLOCK.STONE);
        if (Math.abs(dz) <= 1) put(world, x, py + 2, z, BLOCK.STONE);
      }
    }

  buildBase(world, height, 'green');
  buildBase(world, height, 'blue');
}

// ---------------------------------------------------------------- foundry
// A compact industrial TDM arena. The authored floor is deliberately level:
// the three combat zones are separated by readable, destructible cover rather
// than terrain cliffs, while the outer ring and paired bases provide the
// silhouette. All seeded dressing is mirrored through the 180-degree center
// transform so competitive geometry never changes with the seed.
function genFoundry(world, seed) {
  const noise = makeNoise(seed);
  const height = new Float32Array(SX * SZ);
  const CX = SX / 2, CZ = SZ / 2, FLOOR = SEA + 8;
  BASE.green.x = 68; BASE.blue.x = SX - 1 - 68;

  for (let z = 0; z < SZ; z++) for (let x = 0; x < SX; x++) {
    // Keep the authored combat core exactly level so walls and stairs are
    // grounded consistently. Seeded grade only roughens the outer rim.
    const edge = envelopeEdgeDistance(mapEnvelope(6), x, z);
    const variation = (noise(x * 0.025, z * 0.025)
      + noise((SX - 1 - x) * 0.025, (SZ - 1 - z) * 0.025)) * 0.35 - 0.35;
    height[at(x, z)] = FLOOR + (edge < 28 ? variation : 0);
  }
  flattenBases(height);
  applyArenaRim(height, mapEnvelope(6), FLOOR, SEA + 25);
  fillColumns(world, height, (x, z) => {
    const band = noise(x * 0.018 + 8, z * 0.018 + 17);
    return band > 0.67 ? BLOCK.STONE : band < 0.28 ? BLOCK.DIRT : BLOCK.GRASS;
  });

  const wall = (x, z, w, d, h = 3, gap = -1) => {
    const y = FLOOR;
    for (let dx = 0; dx < w; dx++) for (let dz = 0; dz < d; dz++) {
      if (gap >= 0 && dx === gap) continue;
      for (let dy = 1; dy <= h; dy++) put(world, x + dx, y + dy, z + dz, BLOCK.STONE);
    }
  };
  // Central foundry floor: offset cover blocks leave several cross-links.
  wall(CX - 25, CZ - 5, 18, 3, 2, 8);
  wall(CX + 7, CZ + 2, 18, 3, 2, 9);
  // North conveyor/trench: low walls flank a permanently open catwalk.
  wall(CX - 53, CZ - 47, 34, 3, 3, 14);
  wall(CX + 19, CZ - 47, 34, 3, 3, 18);
  for (const rowZ of [CZ - 34, CZ + 34]) for (let x = CX - 44; x <= CX + 44; x += 4) {
    const y = FLOOR;
    put(world, x, y + 1, rowZ, BLOCK.STONE);
    if (Math.abs(x - CX) % 8 >= 4) put(world, x, y + 2, rowZ, BLOCK.STONE);
  }
  // South slag yard: paired berms and two useful, counterable high positions.
  wall(CX - 53, CZ + 44, 34, 3, 3, 14);
  wall(CX + 19, CZ + 44, 34, 3, 3, 18);
  const highPositions = [[CX - 35, CZ + 18],
    [SX - 1 - (CX - 35), SZ - 1 - (CZ + 18)]];
  for (const [px, pz] of highPositions) {
    for (let dx = -5; dx <= 5; dx++) for (let dz = -4; dz <= 4; dz++)
      for (let dy = 1; dy <= 3; dy++) put(world, px + dx, FLOOR + dy, pz + dz, BLOCK.STONE);
    // Stair-like access on both sides keeps the perch counterable.
    for (let step = 1; step <= 3; step++) {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = 1; dy <= step; dy++) {
          put(world, px + dx, FLOOR + dy, pz - 5 - step, BLOCK.STONE);
          put(world, px + dx, FLOOR + dy, pz + 5 + step, BLOCK.STONE);
        }
      }
    }
  }
  // Two symmetric weak walls are obvious local shortcuts; permanent north
  // and south catwalk endpoints remain on the flat floor if they collapse.
  for (const z of [CZ - 17, SZ - 1 - (CZ - 17)]) {
    for (let x = CX - 9; x <= CX + 9; x++)
      for (let dy = 1; dy <= 3; dy++) put(world, x, FLOOR + dy, z, dy === 3 ? BLOCK.DIRT : BLOCK.STONE);
    for (const x of [CX - 9, CX + 9]) put(world, x, FLOOR + 1, z, BLOCK.STONE);
  }
  buildBase(world, height, 'green');
  buildBase(world, height, 'blue');
}

// ---------------------------------------------------------------- faultline
// Four level objectives form a non-collinear N→W→S→E loop. The central
// survey tower orients the squad but is intentionally low enough that every
// hill remains its own fight. Permanent floor routes circle the landmark;
// matching weak barriers make each hill's local shortcut readable.
function genFaultline(world, seed) {
  const noise = makeNoise(seed);
  const height = new Float32Array(SX * SZ);
  const CX = SX / 2, CZ = SZ / 2, FLOOR = SEA + 8;
  // Keep the standard arena base setback so deployment clears the bunker
  // towers before the east/west loop begins.
  BASE.green.x = 52; BASE.blue.x = SX - 1 - 52;
  for (let z = 0; z < SZ; z++) for (let x = 0; x < SX; x++) {
    const edge = envelopeEdgeDistance(mapEnvelope(7), x, z);
    const variation = (noise(x * 0.021 + 3, z * 0.021 + 7)
      + noise((SX - 1 - x) * 0.021 + 3, (SZ - 1 - z) * 0.021 + 7)) * 0.3 - 0.3;
    height[at(x, z)] = FLOOR + (edge < 28 ? variation : 0);
  }
  // Force every hill footprint and its clear apron to the same level before
  // filling columns. The small blend ring avoids a step at the hill edge.
  for (const hill of MAPS[7].hills) for (let z = hill.z - 15; z <= hill.z + 15; z++)
    for (let x = hill.x - 15; x <= hill.x + 15; x++) {
      const d = Math.hypot(x - hill.x, z - hill.z);
      if (d <= 11) height[at(x, z)] = FLOOR;
      else if (d <= 15) height[at(x, z)] = FLOOR + (height[at(x, z)] - FLOOR) * ss((d - 11) / 4);
  }
  flattenBases(height);
  // Base plateau blending reaches the west/east hill aprons on the compact
  // loop. Reassert the authored capture footprints after that shared pass so
  // every objective remains level and clear at every seed.
  for (const hill of MAPS[7].hills)
    for (let z = hill.z - hill.r; z <= hill.z + hill.r; z++)
      for (let x = hill.x - hill.r; x <= hill.x + hill.r; x++)
        if (Math.hypot(x - hill.x, z - hill.z) <= hill.r) height[at(x, z)] = FLOOR;
  applyArenaRim(height, mapEnvelope(7), FLOOR, SEA + 25);
  fillColumns(world, height, (x, z) => {
    const band = noise(x * 0.02 + 31, z * 0.02 + 5);
    // Sandstone dominates the arena floor. Sage and red-earth seams still
    // expose its large-scale strata, but the material read is geological,
    // not the green-grey factory floor used by Foundry.
    return band > 0.72 ? BLOCK.STONE : band < 0.3 ? BLOCK.DIRT : BLOCK.SAND;
  });

  // A solid, low survey foundation breaks the four cross-map sniper lanes.
  // It forces a readable clockwise/counter-clockwise choice without becoming
  // a perch that can see every hill.
  for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) {
    if (Math.hypot(dx, dz) > 5.5) continue;
    for (let dy = 1; dy <= 4; dy++) put(world, CX + dx, FLOOR + dy, CZ + dz, BLOCK.STONE);
  }
  const line = (x, z, dx, dz, from, to, wallH = 3, block = BLOCK.STONE) => {
    for (let i = from; i <= to; i++) for (let dy = 1; dy <= wallH; dy++)
      put(world, x + dx * i, FLOOR + dy, z + dz * i, block);
  };
  // Each hill gets two substantial inner staging shoulders with a broad
  // permanent radial entrance between them. Routes around both ends provide
  // the two flanks, so the objective has three durable approaches.
  for (const hill of MAPS[7].hills) {
    const rx = Math.sign(hill.x - CX), rz = Math.sign(hill.z - CZ);
    const tx = -rz, tz = rx;
    const sx = hill.x - rx * 17, sz = hill.z - rz * 17;
    line(sx, sz, tx, tz, -12, -7, 3);
    line(sx, sz, tx, tz, 7, 12, 3);

    // Short outer shoulders let a retaking squad stage without enclosing the
    // capture footprint or deleting the outer-loop approach.
    const ox = hill.x + rx * 14, oz = hill.z + rz * 14;
    line(ox, oz, tx, tz, -8, -5, 2);
    line(ox, oz, tx, tz, 5, 8, 2);

    // A two-high dirt seam closes one lateral micro-route beside the point.
    // Players may breach it; both ends and the radial lane remain permanent.
    const bx = hill.x + tx * 16, bz = hill.z + tz * 16;
    line(bx, bz, rx, rz, -4, 4, 2, BLOCK.DIRT);
  }

  // Seeded rubble changes the visual read only. It is paired by the 180°
  // transform and kept outside every hill's clear footprint and route core.
  const rnd = mulberry32(seed ^ 0xfa0171);
  for (let i = 0; i < 18; i++) {
    const x = 62 + Math.floor(rnd() * 52), z = 62 + Math.floor(rnd() * 52);
    if (MAPS[7].hills.some(h => Math.hypot(x - h.x, z - h.z) < 18)) continue;
    const y = FLOOR;
    put(world, x, y + 1, z, BLOCK.STONE);
    put(world, SX - 1 - x, y + 1, SZ - 1 - z, BLOCK.STONE);
  }
  buildBase(world, height, 'green');
  buildBase(world, height, 'blue');
  // The shared bunker template has a deliberately narrow two-block gate.
  // Faultline's close west/east hills need a little more deployment clearance
  // so a bot cannot park against a tower while choosing its first objective.
  for (const team of ['green', 'blue']) {
    const b = BASE[team], dir = team === 'green' ? 1 : -1;
    const fy = Math.floor(height[at(b.x, b.z)]);
    for (let z = b.z - 6; z <= b.z + 6; z++)
      for (let x = b.x + dir * 5; x !== b.x + dir * 13; x += dir)
        for (let y = fy + 1; y <= fy + 3; y++) put(world, x, y, z, 0);
  }
}

MAPS[0].gen = genIsland;
MAPS[1].gen = genBeach;
MAPS[2].gen = genForest;
MAPS[3].gen = genDesert;
MAPS[4].gen = genCrown;
MAPS[5].gen = genCaldera;
MAPS[6].gen = genFoundry;
MAPS[7].gen = genFaultline;

// ---------------------------------------------------------------- entry
// Resets every named palette entry to its true default, then applies
// whatever this map wants different — so a map with no paletteOverrides
// at all always sees the real original colors, never a leftover tint
// from whichever map generated right before it (PALETTE is one shared,
// mutable array read at mesh-build time, not something copied per map).
function applyPaletteOverrides(mapIndex) {
  const overrides = MAPS[mapIndex % MAPS.length].paletteOverrides ?? {};
  for (let i = 1; i < PALETTE.length; i++)
    PALETTE[i].color = overrides[PALETTE[i].name] ?? DEFAULT_PALETTE_COLORS[i];
  PALETTE[BLOCK.GREEN].color = teamHex('green');
  PALETTE[BLOCK.BLUE].color = teamHex('blue');
}

// GREENBELT's own look (no atmosphere entry) is the neutral baseline every
// other map's fields fall back to individually — a map can override just
// its fog, say, and still inherit the default sky/cloud/water untouched.
const DEFAULT_ATMOSPHERE = { sky: ['#4f9be8', '#9ecdf3', '#dceefc'], fog: 0xcfe4f7,
  cloud: 0xffffff, water: 0x2f6fb8, sun: [0.45, 1, 0.25], sunTint: [1.06, 1.01, 0.90] };
export function mapAtmosphere(mapIndex) {
  const a = MAPS[mapIndex % MAPS.length].atmosphere ?? {};
  return { ...DEFAULT_ATMOSPHERE, ...a };
}

export function generateMap(world, seed = 1979, mapIndex = 0, { buildMeshes = true } = {}) {
  // Re-anchor the bases to this map's defaults before the generator runs.
  BASE.green.x = 36; BASE.green.z = SZ / 2; BASE.green.plateau = 16;
  BASE.blue.x = SX - 36; BASE.blue.z = SZ / 2; BASE.blue.plateau = 16;
  // Must land before buildAll() below — chunk colors are baked into
  // vertex data once at mesh-build time, not read live per frame, so the
  // override has to be in place before generation, not after.
  applyPaletteOverrides(mapIndex);
  const atmosphere = mapAtmosphere(mapIndex);
  setVoxelLight(atmosphere.sun, atmosphere.sunTint);
  world.data.fill(0);
  MAPS[mapIndex % MAPS.length].gen(world, seed);
  if (buildMeshes) world.buildAll();
  return mapIndex % MAPS.length;
}

// Map indices supporting a mode, in rotation order.
export function mapsForMode(mode, options = {}) {
  return MAPS.map((m, i) => i).filter((i) => MAPS[i].modes.includes(mode)
    && contentAvailable(mode, i, options));
}
