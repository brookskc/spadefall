// mapgen.js — procedural terrain with two team bases, in six themed maps.
// MAPS order is the rotation order; generateMap(world, seed, mapIndex) fills
// world.data, re-anchors BASE, and meshes everything via world.buildAll().
import { SX, SY, SZ, SEA, BLOCK, PALETTE, DEFAULT_PALETTE_COLORS, setVoxelLight } from './world.js';
import { teamHex } from './settings.js';

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

// modes: which game modes the map supports. DUNES retired from the CTF
// rotation (its long sniper lanes punish flag runs) but kept for deathmatch
// and king of the hill, mirrored about midfield so the hill fight is fair.
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
    stations: [
      { x: 127.5, z: 86, label: 'NORTH WALL' },
      { x: 127.5, z: 170, label: 'SOUTH SHELF' },
    ],
    atmosphere: { sky: ['#5eafe0', '#a6d3e2', '#e3ead5'], fog: 0xcadcc9, cloud: 0xf5f1dc, water: 0x347ba7,
      sun: [0.45, 1, 0.25], sunTint: [1.06, 1.01, 0.90] },
    paletteOverrides: { grass: 0x5f9f45, dirt: 0x75563a, sand: 0xc4ad73, stone: 0x70796f, moss: 0x3d7545 } },
  { key: 'beach',   name: 'BEACHHEAD', modes: ['ctf', 'tdm'],        gen: null,
    stations: [
      { x: 127.5, z: 82, label: 'NORTH DUGOUT' },
      { x: 127.5, z: 174, label: 'SOUTH DUGOUT' },
    ],
    atmosphere: { sky: ['#4d9fc9', '#9bcbd8', '#e8eee4'], fog: 0xd3e3dc, cloud: 0xf8f4e8, water: 0x248fa4,
      sun: [-0.25, 1, 0.45], sunTint: [1.08, 1.02, 0.88] },
    paletteOverrides: { grass: 0x689c52, dirt: 0x79563c, sand: 0xd0b97d, stone: 0x7f8584, moss: 0x55745d } },
  { key: 'forest',  name: 'PINEFALL',  modes: ['ctf', 'tdm'],        gen: null,
    stations: [
      { x: 127.5, z: 82, label: 'NORTH FORD' },
      { x: 127.5, z: 174, label: 'SOUTH FORD' },
    ],
    atmosphere: { sky: ['#aaa3d2', '#c8c0dc', '#e4ddea'], fog: 0xc9c1d6, cloud: 0xf1edf4, water: 0x3c6967,
      sun: [0.55, 1, -0.35], sunTint: [1.02, 1.00, 1.06] },
    paletteOverrides: { grass: 0x4f824c, dirt: 0x685344, sand: 0xb0a683, stone: 0x72757f, moss: 0x315d3f } },
  { key: 'desert',  name: 'DUNES',     modes: ['tdm', 'koth'],       gen: null,
    stations: [
      { x: 99, z: 127.5, label: 'WEST RUINS' },
      { x: 156, z: 127.5, label: 'EAST RUINS' },
    ],
    hills: [
      { x: SX / 2, z: SZ / 2, r: 8, label: 'CENTER' },
      { x: SX / 2, z: SZ / 2 - 40, r: 8, label: 'NORTH' },
      { x: SX / 2, z: SZ / 2 + 40, r: 8, label: 'SOUTH' },
    ],
    atmosphere: { sky: ['#a78492', '#d8ad8d', '#f0d6ae'], fog: 0xd7bd9f, cloud: 0xeee5dc, water: 0x397f96,
      sun: [-0.55, 0.8, -0.25], sunTint: [1.12, 1.02, 0.82] },
    paletteOverrides: { grass: 0x8c8b55, dirt: 0x895d49, sand: 0xcaa461, stone: 0x846f72, moss: 0x74694f } },
  { key: 'crown',   name: 'CROWN',     modes: ['koth', 'tdm'],       gen: null,
    stations: [
      { x: 127.5, z: 110, label: 'NORTH CAUSEWAY' },
      { x: 127.5, z: 145, label: 'SOUTH CAUSEWAY' },
    ],
    hills: [
      { x: SX / 2, z: SZ / 2, r: 8, label: 'CROWN' },
      { x: SX / 2, z: SZ / 2 - 40, r: 8, label: 'NORTH GATE' },
      { x: SX / 2, z: SZ / 2 + 40, r: 8, label: 'SOUTH GATE' },
    ],
    atmosphere: { sky: ['#365b91', '#7899bf', '#c9d7df'], fog: 0xa6b4bf, cloud: 0xe7edf0, water: 0x2f5e78,
      sun: [0.35, 1, -0.55], sunTint: [1.08, 1.04, 0.94] },
    paletteOverrides: { grass: 0x567447, dirt: 0x604636, sand: 0xb29a68, stone: 0x515d69, moss: 0x334f3c } },
  { key: 'caldera', name: 'CALDERA',   modes: ['koth', 'tdm'],       gen: null,
    stations: [
      { x: 104, z: 127.5, label: 'WEST SADDLE' },
      { x: 151, z: 127.5, label: 'EAST SADDLE' },
    ],
    hills: [
      { x: SX / 2, z: SZ / 2, r: 8, label: 'KNOLL' },
      { x: SX / 2, z: SZ / 2 - 28, r: 8, label: 'NORTH BOWL' },
      { x: SX / 2, z: SZ / 2 + 28, r: 8, label: 'SOUTH BOWL' },
    ],
    atmosphere: { sky: ['#40334f', '#76556a', '#c38a73'], fog: 0xa47770, cloud: 0xc7b1ae, water: 0x595866,
      sun: [-0.6, 0.72, 0.28], sunTint: [1.14, 0.98, 0.78] },
    paletteOverrides: { grass: 0x74654d, dirt: 0x7b5047, sand: 0xb58568, stone: 0x4e4b52, moss: 0x53594c } },
];

// Mutated by each generator; game.js reads spawn points and flag stands here.
export const BASE = {
  green: { x: 36,     z: SZ / 2, flag: null, plateau: 16 },
  blue:  { x: SX - 36, z: SZ / 2, flag: null, plateau: 16 },
};
const BASE_H = SEA + 7; // plateau height above the sea

const at = (x, z) => (z * SX + x);
const put = (world, x, y, z, block) => {
  x = Math.round(x); y = Math.round(y); z = Math.round(z);
  if (x < 0 || x >= SX || y < 0 || y >= SY || z < 0 || z >= SZ) return;
  world.data[(y * SZ + z) * SX + x] = block;
};
const terrainY = (height, x, z) => Math.floor(height[at(Math.round(x), Math.round(z))]);

// Every battlefield gets two authored neutral field caches. The same chunky
// silhouette — stone pad, pallet boxes, four bollards, signal pylons — makes
// their function readable across themes without a texture, glowing pickup,
// or prop mesh. They are ordinary terrain voxels, so a fight can chew the
// shelter apart and players can rebuild cover around the still-marked site.
function buildFieldStations(world, mapIndex) {
  for (const station of MAPS[mapIndex % MAPS.length].stations ?? []) {
    const cx = Math.floor(station.x), cz = Math.floor(station.z);
    const y = world.surface(cx, cz);
    station.y = y + 1;
    // Level a compact pad and guarantee standing headroom. Fill only the
    // three voxels immediately below it, enough to avoid a visibly floating
    // slab without turning a small landmark into a buried retaining wall.
    for (let dx = -3; dx <= 3; dx++)
      for (let dz = -3; dz <= 3; dz++) {
        for (let fy = Math.max(0, y - 3); fy <= y; fy++)
          if (!world.get(cx + dx, fy, cz + dz)) put(world, cx + dx, fy, cz + dz, BLOCK.STONE);
        put(world, cx + dx, y, cz + dz, BLOCK.STONE);
        for (let fy = y + 1; fy <= y + 5; fy++) put(world, cx + dx, fy, cz + dz, 0);
      }
    // Corner bollards frame the capture footprint without walling it off.
    for (const [dx, dz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) {
      put(world, cx + dx, y + 1, cz + dz, BLOCK.STONE);
      put(world, cx + dx, y + 2, cz + dz, BLOCK.STONE);
    }
    // Low supply pallets: readable as crates, usable as crouch cover.
    for (const dx of [-1, 0, 1]) put(world, cx + dx, y + 1, cz + 2, BLOCK.DIRT);
    put(world, cx - 1, y + 2, cz + 2, BLOCK.DIRT);
    // Three separated rising pylons read as signal-strength bars from a
    // distance. The old single mast plus crossbar unintentionally resembled
    // a Christian cross; this industrial silhouette is deliberately neutral.
    for (const [dx, height] of [[-2, 2], [0, 3], [2, 4]])
      for (let h = 1; h <= height; h++)
        put(world, cx + dx, y + h, cz - 3, BLOCK.STONE);
  }
}

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

  flattenBases(height);
  fillColumns(world, height, (x, z, h) => h <= SEA + 5 ? BLOCK.SAND : BLOCK.GRASS);

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

  buildBase(world, height, 'green');
  buildBase(world, height, 'blue');
}

// ---------------------------------------------------------------- desert
// Sweeping dunes, flat-topped mesas for snipers, a ruined sandstone village
// at midfield. Long sightlines — move dune-to-dune or get picked off.
function genDesert(world, seed) {
  const noise = makeNoise(seed);
  const height = new Float32Array(SX * SZ);
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
    const rx = SX / 2 - 14, rz = SZ / 2 - 10, cols = [];
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
      if (perp < 3.5 && along > 4 && along < 44) {
        const t = clamp01((along - 16) / 24);
        const target = TOP * (1 - t) + Math.max(field, SEA + 1.5) * t;
        const b = clamp01((3.5 - perp) / 1.5);           // 1 centerline → 0 edge
        h = h * (1 - b) + target * b;
      }
      height[at(x, z)] = Math.min(SY - 8, h);
    }

  flattenBases(height);
  fillColumns(world, height, (x, z, h) => h <= SEA + 1 ? BLOCK.SAND : BLOCK.GRASS);

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
      // Saddle gaps facing the bases (east/west): passable at a climb.
      if (Math.abs(z - CZ) < 8 && d > 36 && d < 80) {
        const saddle = SEA + 9 + 2 * noise(x * 0.08, z * 0.08);
        const b = clamp01((8 - Math.abs(z - CZ)) / 4);
        h = h * (1 - b) + Math.min(h, saddle) * b;
      }
      // The knoll: a flat rocky rise at the very bottom — the hill.
      if (d < 7) h = SEA + 10;
      else if (d < 14) h = (SEA + 10) + (h - (SEA + 10)) * ss((d - 7) / 7);
      height[at(x, z)] = Math.min(SY - 8, h);
    }

  flattenBases(height);
  // Scorched ground: stone outcrops breaking through packed ash.
  fillColumns(world, height,
    (x, z) => noise(x * 0.11 + 3, z * 0.11 + 3) > 0.62 ? BLOCK.STONE : BLOCK.DIRT);

  // Basalt formations scattered across the bowl—single columns, paired
  // fins, and broken clusters rather than fourteen copies of one pillar.
  // They remain chewable cover and stay outside the central objective.
  const rnd = mulberry32(seed ^ 0xca1de);
  for (let i = 0; i < 14; i++) {
    const a = rnd() * Math.PI * 2, d = 15 + rnd() * 20;
    const px = Math.round(CX + Math.cos(a) * d), pz = Math.round(CZ + Math.sin(a) * d);
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

  buildBase(world, height, 'green');
  buildBase(world, height, 'blue');
}

MAPS[0].gen = genIsland;
MAPS[1].gen = genBeach;
MAPS[2].gen = genForest;
MAPS[3].gen = genDesert;
MAPS[4].gen = genCrown;
MAPS[5].gen = genCaldera;

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

export function generateMap(world, seed = 1979, mapIndex = 0) {
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
  buildFieldStations(world, mapIndex);
  world.buildAll();
  return mapIndex % MAPS.length;
}

// Map indices supporting a mode, in rotation order.
export function mapsForMode(mode) {
  return MAPS.map((m, i) => i).filter(i => MAPS[i].modes.includes(mode));
}
