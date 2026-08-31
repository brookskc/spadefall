// tests/suite.mjs — assertions over the modules that do not touch the DOM:
// world.js (storage, meshing, raycast, carve), mapgen.js, entities.js (Body).
//
// Browser/DOM orchestration in Player and main.js is covered by browser smoke
// tests. Pure multiplayer authority rules are kept in multiplayer.js so this
// suite can exercise them headlessly.
import * as THREE from 'three';
import crypto from 'node:crypto';
import { VoxelWorld, SX, SY, SZ, SEA, PALETTE, BLOCK } from '../src/world.js';
import { generateMap, MAPS, BASE, mapAtmosphere, mapsForMode,
  PINEFALL_RAVINE_HALF_WIDTH, pinefallRavineCenter,
  pinefallRavineHeight } from '../src/mapgen.js';
import { Body, CROUCH_HEIGHT, EYE_INSET, STAND_HEIGHT,
  animateSoldier, disposeObject, makeMq9Drone, makeSoldier,
  setCrouch, setSoldierTool } from '../src/entities.js';
import { airstrikeDronePose, mergeSnapshot, qx, qy, qa, relativeBearing,
  unsupportedCollapseCells } from '../src/game.js';
import { Avatar } from '../src/avatar.js';
import { placedBlockColor, TOOLS } from '../src/player.js';
import { chooseTeam, combatDamageAllowed, migrationSurvivors, normalizeDirection,
  parseSpawnRow, protectedBuildReason, spawnRow, teamSizeForMode,
  validateMovementReport } from '../src/multiplayer.js';
import { PROTOCOL_VERSION, validClientMessage, validPong, validServerMessage } from '../src/protocol.js';
import { allowInbound, Net, shouldSend, wireBytes } from '../src/net.js';
import { WORLD_HASH_SEED, advanceWorldHash, impairPackets, snapshotDisposition,
  worldEventDisposition, worldLogHash } from '../src/network-sync.js';
import { actionSequenceDisposition, aimYawDelta, authorizeReload,
  authorizeWeaponFire, recordIntegrityViolation, settleReload } from '../src/security.js';
import { RuntimeHealth, evaluateReleaseBudgets, percentile,
  resourceDrift } from '../src/runtime-health.js';
import { reloadPitch, sfx, voxelSurface } from '../src/audio.js';
import { BREATH_MAX, DROWN_DAMAGE, fallDamageForImpact,
  impactSpeedForFallDistance, stepBreath } from '../src/environment.js';
import { BOT_DIFFICULTY, assignBotRoles, botDifficulty, botSeparation,
  botsForSquadOrder, botTargetScore, botTelemetrySummary, chooseLocalRoute,
  hillPost, rememberedEnemyPosition, scheduleBotBrains } from '../src/bot-rules.js';
import { modeMatchSeconds, regulationDecision, respawnWaveDelay,
  tacticalSpawnScore } from '../src/pacing.js';
import { assistCreditors, CONTRIBUTION, rankContributionRows } from '../src/scoring.js';
import { HILL_ACTIVE_TIME, HILL_MOVE_WARNING, nextHillIndex,
  occupiedScoringTeam, stepHillCapture, stepHillRotation } from '../src/koth.js';
import { AIRSTRIKE_COST, OVERCHARGE_COST, OVERCHARGE_DURATION,
  OVERCHARGE_WINDUP, availableStreakAbility, balancedMomentumGain,
  dominantStreakTeam, gainStreak, overchargeDamage, retainedMomentum,
  spendStreak, stepOvercharge } from '../src/streaks.js';
import { FIELD_STATION_BLOCK_CAP, FIELD_STATION_CAPTURE_TIME,
  FIELD_STATION_COOLDOWN, applyFieldSupply, nearestFieldStation,
  stationCanSupply, stepFieldStation } from '../src/field-stations.js';
import { buildMatchReport, medalAwards, updatePersonalBests } from '../src/match-report.js';
import { masteryProgress } from '../src/mastery.js';
import { rematchVotesNeeded, staySquadGroups, staySquadState,
  validPingDirection } from '../src/social.js';
import { EngagementTracker, parseEngagementFeatures,
  sanitizeEngagementEvent } from '../src/engagement.js';
import { OPERATION_PLANS, advanceOperation, createOperation, flipOperationColors,
  operationComplete, operationFromRow, operationLeg, operationRow,
  operationSideForColor, operationWinner, recordOperationResult,
  validOperationRow } from '../src/operations.js';
import { balanceHumanTeams, TEAM_REASSIGNMENT_COST } from '../src/team-balance.js';
import { FirstMinuteGuide, firstMinuteObjective } from '../src/first-minute.js';
import { VoxelStoryTracker, normalizeVoxelStoryMetrics, validVoxelStoryMetrics,
  voxelBattleStory } from '../src/voxel-stories.js';
import { deathRecapCopy, makeDeathRecap, validDeathRecap } from '../src/death-recap.js';
import { SELECTED_GOALS, SelectedGoalTracker,
  validSelectedGoal } from '../src/selected-goals.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  <- ' + extra : ''}`); }
};
const note = s => console.log(`        ${s}`);
const group = s => console.log(`\n== ${s} ==`);
const scene = () => new THREE.Scene();
const dataHash = w => crypto.createHash('sha1')
  .update(Buffer.from(w.data.buffer, w.data.byteOffset, w.data.byteLength))
  .digest('hex').slice(0, 12);
const colorHash = m => m
  ? crypto.createHash('sha1')
      .update(Buffer.from(Float32Array.from(m.geometry.attributes.color.array).buffer))
      .digest('hex').slice(0, 8)
  : 'MISSING';
const meshHash = w => [...w.chunks.keys()].sort()
  .map(k => k + ':' + colorHash(w.chunks.get(k))).join('|');
const lcg = seed => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// ---------------------------------------------------------------------------
function mapgenTests() {
  group('mapgen: determinism, bounds, spawn sanity');
  const hashes = [];
  for (let m = 0; m < MAPS.length; m++) {
    const name = MAPS[m].name;
    const a = new VoxelWorld(scene());
    generateMap(a, 12345, m);
    const baseA = JSON.stringify(BASE);
    const b = new VoxelWorld(scene());
    generateMap(b, 12345, m);
    ok(`${name}: seed 12345 is reproducible`, dataHash(a) === dataHash(b));
    ok(`${name}: BASE anchoring is reproducible`, baseA === JSON.stringify(BASE));
    const c = new VoxelWorld(scene());
    generateMap(c, 999, m);
    ok(`${name}: a different seed gives different terrain`, dataHash(c) !== dataHash(a));
    generateMap(a, 12345, m); // restore BASE for this map before reading it
    hashes.push(dataHash(a));

    for (const team of ['green', 'blue']) {
      const f = BASE[team].flag;
      ok(`${name}: ${team} stand inside the world`,
        !!f && f.x > 1 && f.x < SX - 2 && f.z > 1 && f.z < SZ - 2 && f.y > 0 && f.y < SY - 1,
        JSON.stringify(f));
      ok(`${name}: ${team} stand above the waterline`, f.y >= SEA, `y=${f.y}`);
      ok(`${name}: ${team} stand has headroom`, a.get(f.x, f.y + 1, f.z) === 0);
    }
    for (const [i, h] of (MAPS[m].hills ?? []).entries()) {
      const surface = a.surface(h.x, h.z);
      ok(`${name}: hill ${i + 1} is on dry land`, a.surface(h.x, h.z) >= SEA,
        `surface=${surface}`);
      ok(`${name}: hill ${i + 1} has playable headroom`,
        a.get(h.x, surface + 1, h.z) === 0 && a.get(h.x, surface + 2, h.z) === 0);
    }
    ok(`${name}: has two named tactical field caches`,
      MAPS[m].stations?.length === 2 && MAPS[m].stations.every(s => s.label));
    for (const [i, s] of MAPS[m].stations.entries()) {
      const x = Math.floor(s.x), z = Math.floor(s.z), surface = a.surface(x, z);
      ok(`${name}: cache ${i + 1} has a dry stone pad and headroom`,
        surface >= SEA && a.get(x, surface, z) === BLOCK.STONE
          && a.get(x, surface + 1, z) === 0 && a.get(x, surface + 2, z) === 0,
        `surface=${surface}`);
      ok(`${name}: cache ${i + 1} uses separated signal pylons without a crossbar`,
        a.get(x - 2, s.y + 1, z - 3) === BLOCK.STONE
          && a.get(x, s.y + 2, z - 3) === BLOCK.STONE
          && a.get(x + 2, s.y + 3, z - 3) === BLOCK.STONE
          && a.get(x - 1, s.y + 2, z - 3) === 0
          && a.get(x + 1, s.y + 2, z - 3) === 0);
    }
    let bad = 0;
    for (let i = 0; i < a.data.length; i++) if (a.data[i] >= PALETTE.length) bad++;
    ok(`${name}: every voxel indexes PALETTE`, bad === 0, `${bad} out of range`);
  }
  ok('all six maps are distinct', new Set(hashes).size === MAPS.length);
  ok('mapsForMode(ctf) = [0,1,2]', JSON.stringify(mapsForMode('ctf')) === '[0,1,2]');
  ok('mapsForMode(koth) = [3,4,5]', JSON.stringify(mapsForMode('koth')) === '[3,4,5]');
  ok('mapsForMode(tdm) covers every map',
    mapsForMode('tdm').length === MAPS.length, JSON.stringify(mapsForMode('tdm')));
  ok('every map has a complete authored flat-color terrain palette',
    MAPS.every(m => ['grass', 'dirt', 'sand', 'stone', 'moss']
      .every(material => Number.isInteger(m.paletteOverrides?.[material]))));
  ok('all six map atmospheres have distinct sky gradients',
    new Set(MAPS.map((_, i) => mapAtmosphere(i).sky.join(','))).size === MAPS.length);
  ok('PINEFALL uses a warm lavender sky that preserves blue-team contrast',
    mapAtmosphere(2).sky[0] === '#aaa3d2' && mapAtmosphere(2).fog === 0xc9c1d6);
  ok('CROWN uses a stronger blue atmosphere and separated terrain values',
    mapAtmosphere(4).sky[0] === '#365b91'
      && MAPS[4].paletteOverrides.grass === 0x567447
      && MAPS[4].paletteOverrides.stone === 0x515d69);
  ok('CALDERA uses a contrasting volcanic-twilight sky',
    mapAtmosphere(5).sky[0] === '#40334f'
      && mapAtmosphere(5).sky[1] === '#76556a'
      && mapAtmosphere(5).fog === 0xa47770);
  const ravineOriginal = SEA + 14;
  const ravineSamples = Array.from({ length: PINEFALL_RAVINE_HALF_WIDTH + 1 }, (_, d) =>
    pinefallRavineHeight(ravineOriginal, d));
  ok('PINEFALL ravine is broad, shallow, and smoothly walkable',
    PINEFALL_RAVINE_HALF_WIDTH === 13
      && ravineSamples[0] > SEA - 1 && ravineSamples[0] < SEA
      && ravineSamples.every((h, i) => i === 0 || h >= ravineSamples[i - 1])
      && ravineSamples.slice(1).every((h, i) => h - ravineSamples[i] < 2));
  const seededFord = SX / 2 + ((4242 % 5) - 2) * 6;
  ok('PINEFALL ravine still crosses midfield at its seeded ford',
    pinefallRavineCenter(4242, seededFord) === SZ / 2);

  const greenPlaced = PALETTE[BLOCK.GREEN].color, bluePlaced = PALETTE[BLOCK.BLUE].color;
  PALETTE[BLOCK.GREEN].color = 0x123456;
  PALETTE[BLOCK.BLUE].color = 0xabcdef;
  ok('held green block reads the placed-block palette', placedBlockColor('green') === 0x123456);
  ok('held blue block reads the placed-block palette', placedBlockColor('blue') === 0xabcdef);
  PALETTE[BLOCK.GREEN].color = greenPlaced;
  PALETTE[BLOCK.BLUE].color = bluePlaced;
}

// ---------------------------------------------------------------------------
function raycastTests() {
  group('world.raycast: DDA against a fine-step reference');
  const w = new VoxelWorld(scene());
  generateMap(w, 4242, 2); // PINEFALL: canopy, creek, overhangs
  // Reference march. The step has to be fine enough not to skip a grazing
  // corner: 0.002 produced four false mismatches against a correct DDA.
  const reference = (o, d, maxD, step = 0.0002) => {
    let last = null;
    for (let t = 0; t <= maxD; t += step) {
      const x = Math.floor(o.x + d.x * t), y = Math.floor(o.y + d.y * t), z = Math.floor(o.z + d.z * t);
      const key = x + ',' + y + ',' + z;
      if (key === last) continue;
      last = key;
      if (w.solid(x, y, z)) return { x, y, z, t };
    }
    return null;
  };
  const rnd = lcg(7);
  let checked = 0, mismatch = 0, maxDistErr = 0;
  for (let i = 0; i < 1200; i++) {
    const o = new THREE.Vector3(20 + rnd() * 216, 18 + rnd() * 30, 20 + rnd() * 216);
    if (w.solid(o.x, o.y, o.z)) continue;
    const d = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
    if (d.lengthSq() < 1e-6) continue;
    d.normalize();
    checked++;
    const got = w.raycast(o, d, 60), want = reference(o, d, 60);
    if (!got !== !want || (got && want && (got.x !== want.x || got.y !== want.y || got.z !== want.z))) {
      mismatch++;
      if (mismatch <= 3) note(`mismatch o=${o.toArray()} d=${d.toArray()}`);
      continue;
    }
    if (got) maxDistErr = Math.max(maxDistErr, Math.abs(got.dist - want.t));
  }
  ok(`DDA agrees with the reference on ${checked} random rays`, mismatch === 0, `${mismatch} bad`);
  note(`max |dist - reference t| = ${maxDistErr.toFixed(5)}`);

  const flat = new VoxelWorld(scene());
  for (let x = 0; x < SX; x++) for (let z = 0; z < SZ; z++) flat.data[(10 * SZ + z) * SX + x] = BLOCK.STONE;
  flat.data[(20 * SZ + 100) * SX + 100] = BLOCK.STONE;
  const down = flat.raycast(new THREE.Vector3(50.5, 30, 50.5), new THREE.Vector3(0, -1, 0), 50);
  ok('straight down finds the floor with a +y normal', !!down && down.y === 10 && down.ny === 1, JSON.stringify(down));
  const level = flat.raycast(new THREE.Vector3(90.5, 20.5, 100.5), new THREE.Vector3(1, 0, 0), 50);
  ok('a level ray finds the pillar with a -x normal', !!level && level.x === 100 && level.nx === -1, JSON.stringify(level));
  ok('maxDist is honoured', flat.raycast(new THREE.Vector3(50.5, 30, 50.5), new THREE.Vector3(0, -1, 0), 5) === null);

  const inside = flat.raycast(new THREE.Vector3(100.5, 20.5, 100.5), new THREE.Vector3(1, 0, 0), 10);
  ok('an origin inside a solid returns dist 0 and a zero normal', !!inside && inside.dist === 0
    && inside.nx === 0 && inside.ny === 0 && inside.nz === 0, JSON.stringify(inside));
  note('playerPlace adds that zero normal to the hit cell, so it targets the occupied cell and silently fails');

  ok('maxDist is measured in |dir| units, not blocks (callers must normalise)',
    flat.raycast(new THREE.Vector3(50.5, 30, 50.5), new THREE.Vector3(0, -0.5, 0), 20) === null);
}

// ---------------------------------------------------------------------------
function meshingTests() {
  group('meshing: incremental edits vs a from-scratch buildAll');
  const slab = () => {
    const w = new VoxelWorld(scene());
    for (let x = 60; x < 120; x++) for (let z = 60; z < 120; z++)
      for (let y = 20; y <= 24; y++) w.data[(y * SZ + z) * SX + x] = BLOCK.STONE;
    w.buildAll();
    return w;
  };
  const parity = (label, edits) => {
    const inc = slab();
    for (const [x, y, z, v] of edits) inc.set(x, y, z, v);
    inc.flushDirty();
    const full = slab();
    for (const [x, y, z, v] of edits) full.data[(y * SZ + z) * SX + x] = v;
    full.buildAll();
    ok(label, meshHash(inc) === meshHash(full));
  };
  // 16-voxel chunks: (96,96) is the corner of chunk 6,6; chunk 5,5 is its
  // diagonal neighbour, and baked AO reads diagonally across that corner.
  parity('edit in the middle of a chunk', [[103, 25, 103, BLOCK.BLUE]]);
  parity('edit on an x seam only', [[96, 25, 103, BLOCK.BLUE]]);
  parity('edit on a z seam only', [[103, 25, 96, BLOCK.BLUE]]);
  parity('edit on a chunk corner rebuilds the diagonal AO neighbour', [[96, 25, 96, BLOCK.BLUE]]);
  parity('edit on the opposite corner cell rebuilds diagonal AO', [[95, 25, 95, BLOCK.BLUE]]);
  note('dirty propagation includes diagonal neighbours because baked AO probes diagonally');

  group('meshing: chunk lifecycle');
  const w = slab();
  const before = w.chunks.size;
  for (let x = 96; x < 112; x++) for (let z = 96; z < 112; z++)
    for (let y = 20; y <= 24; y++) w.set(x, y, z, 0);
  w.flushDirty();
  ok('a fully emptied chunk drops its mesh', w.chunks.size === before - 1,
    `${before} -> ${w.chunks.size}`);
  w.set(100, 22, 100, BLOCK.BLUE);
  w.flushDirty();
  ok('and comes back when refilled', w.chunks.size === before);
}

// ---------------------------------------------------------------------------
function hostileInputTests() {
  group('malformed input reaching world.set / world.carve');
  const w = new VoxelWorld(scene());
  generateMap(w, 1, 0);
  let threw = null;
  try { w.set(100, 25, 100, PALETTE.length); } catch (e) { threw = e; }
  ok('set() rejects an out-of-palette value without throwing',
    threw === null, String(threw).slice(0, 70));
  note('world.set is the final defensive boundary for wire-driven edits');

  const w2 = new VoxelWorld(scene());
  generateMap(w2, 1, 0);
  const h = dataHash(w2);
  w2.set(NaN, NaN, NaN, BLOCK.BLUE);
  ok('set() with NaN coordinates is rejected by the bounds check', dataHash(w2) === h);

  const w3 = new VoxelWorld(scene());
  generateMap(w3, 1, 0);
  let carveThrew = null, removed = null;
  try { removed = w3.carve(100, 25, 100, NaN); } catch (e) { carveThrew = e; }
  ok('carve() with a NaN radius is a no-op rather than a throw', !carveThrew && removed?.length === 0);

  const w4 = new VoxelWorld(scene());
  generateMap(w4, 1, 0);
  const t0 = Date.now();
  const big = w4.carve(128, 30, 128, 40);
  const ms = Date.now() - t0;
  ok('carve() clamps an oversized radius', big.length < 5000, `${big.length} voxels`);
  note(`carve(r=40) was clamped and removed ${big.length} voxels in ${ms}ms`);
}

// ---------------------------------------------------------------------------
function audioPaletteTests() {
  group('audio: voxel palette and gameplay coverage');
  const required = ['rifle', 'smg', 'sniper', 'reloadStart', 'reloadEject',
    'reloadInsert', 'reloadChamber', 'swing', 'dig', 'spadeHit', 'step',
    'drone', 'missileLaunch', 'missile', 'explosion', 'airstrikeImpact'];
  ok('every gameplay sound entry is callable', required.every(k => typeof sfx[k] === 'function'));
  ok('terrain IDs resolve to distinct soft/earth/sand/stone/built voices',
    JSON.stringify([1, 2, 3, 4, 5, 6, 7].map(voxelSurface)) ===
      '["soft","earth","sand","stone","built","built","soft"]');
  ok('air swings and voxel impacts are separate cues', sfx.swing !== sfx.dig);
  ok('grenades and predator missiles have separate impact cues',
    sfx.explosion !== sfx.airstrikeImpact);
  ok('reload mechanics stay below the old piercing pitch range',
    Math.max(...['rifle', 'smg', 'sniper'].map(reloadPitch)) <= 330);
  ok('reload weight remains class-specific after the lower retune',
    reloadPitch('sniper') < reloadPitch('rifle') && reloadPitch('rifle') < reloadPitch('smg'));
}

// ---------------------------------------------------------------------------
function multiplayerRuleTests() {
  group('multiplayer authority rules');
  ok('preferred team is honored while it has capacity',
    chooseTeam('blue', { green: 3, blue: 4 }) === 'blue');
  ok('a full preferred team falls back to the open side',
    chooseTeam('blue', { green: 3, blue: 5 }) === 'green');
  ok('a full 5v5 room has no assignable team',
    chooseTeam('green', { green: 5, blue: 5 }) === null);
  ok('KOTH targets 4v4 while CTF and TDM retain 5v5',
    teamSizeForMode('koth') === 4
      && teamSizeForMode('ctf') === 5 && teamSizeForMode('tdm') === 5);
  ok('KOTH team assignment enforces the four-player side cap',
    chooseTeam('green', { green: 4, blue: 3 }, teamSizeForMode('koth')) === 'blue'
      && chooseTeam('blue', { green: 4, blue: 4 }, teamSizeForMode('koth')) === null);

  const body = { pos: { x: 12, y: 30, z: 42 } };
  const row = spawnRow(body, Math.PI);
  const spawn = parseSpawnRow(row);
  ok('welcome spawn rows round-trip exactly',
    spawn?.x === 12 && spawn?.y === 30 && spawn?.z === 42 && spawn?.yaw === Math.PI);
  ok('malformed welcome spawn rows are rejected', parseSpawnRow([1, 2, NaN, 0]) === null);

  const roster = new Map([
    [0, { name: 'Old host', team: 'green', pid: 'HOST' }],
    [2, { name: 'Visible', team: 'blue', pid: 'peer-visible' }],
    [7, { name: 'Hidden', team: 'green', pid: 'peer-hidden' }],
    [9, { name: 'Us', team: 'blue', pid: 'peer-us' }],
  ]);
  const replicated = new Map([[2, [1, 2, 3]], [9, [4, 5, 6]]]);
  const survivors = migrationSurvivors(roster, 9, replicated);
  ok('host migration keeps out-of-sight roster members eligible to rejoin',
    survivors.size === 2 && survivors.get('peer-hidden')?.row === null);
  ok('host migration retains exact state for visible survivors',
    survivors.get('peer-visible')?.row === replicated.get(2));

  const open = bufferedAmount => ({ open: true, dataChannel: { bufferedAmount } });
  ok('uplink backpressure drops only superseded state reports',
    !shouldSend(open(70000), { t: 's' }) && shouldSend(open(70000), { t: 'a', k: 'shoot' }));
  ok('state reports resume when the reliable channel drains', shouldSend(open(1000), { t: 's' }));
  const floodConn = {};
  let allowed = 0;
  for (let i = 0; i < 200; i++) if (allowInbound(floodConn, 1000, 120, 180)) allowed++;
  ok('host packet budget bounds a same-instant client flood', allowed === 180, `${allowed} accepted`);
  ok('host packet budget refills after legitimate elapsed time',
    allowInbound(floodConn, 2000, 120, 180));

  ok('public combat blocks teammate damage but preserves self-damage',
    !combatDamageAllowed('green', 'green', false)
      && combatDamageAllowed('green', 'green', true));
  ok('enemy, unattributed, and private-room friendly-fire damage remain available',
    combatDamageAllowed('green', 'blue') && combatDamageAllowed('green', null)
      && combatDamageAllowed('green', 'green', false, true));

  const protectedAreas = {
    flags: [{ x: 36.5, y: 20, z: 128.5, r: 2.25, below: 1, above: 4 }],
    spawns: [{ x: 48, y: 20, z: 128, r: 3.5, below: 1, above: 4 }],
    hill: { x: 128.5, y: 18, z: 128.5, r: 2.5, below: 2, above: 4 },
  };
  ok('flag stands, fallback spawn pads, and the hill core reject building',
    protectedBuildReason(36, 20, 128, protectedAreas) === 'flag'
      && protectedBuildReason(48, 20, 128, protectedAreas) === 'spawn'
      && protectedBuildReason(128, 18, 128, protectedAreas) === 'hill');
  ok('objective protection leaves surrounding tactical construction available',
    protectedBuildReason(40, 20, 128, protectedAreas) === null
      && protectedBuildReason(132, 18, 128, protectedAreas) === null);
  ok('objective protection is height-bounded so tunnels remain buildable',
    protectedBuildReason(128, 10, 128, protectedAreas) === null);

  const prev = { x: 10, y: 20, z: 10 };
  ok('ordinary movement passes host displacement rules',
    validateMovementReport(prev, { x: 10.2, y: 20.2, z: 10.1, yaw: 0 }, 1 / 30).ok);
  ok('horizontal teleport is rejected',
    validateMovementReport(prev, { x: 40, y: 20, z: 10, yaw: 0 }, 1 / 30).reason === 'horizontal-speed');
  ok('vertical teleport is rejected',
    validateMovementReport(prev, { x: 10, y: 40, z: 10, yaw: 0 }, 1 / 30).reason === 'vertical-rise');
  ok('zero-length action direction is rejected', normalizeDirection([0, 0, 0]) === null);
  const dir = normalizeDirection([3, 0, 4]);
  ok('action direction is normalized at the trust boundary',
    Math.abs(dir[0] - 0.6) < 1e-9 && Math.abs(dir[2] - 0.8) < 1e-9);
  ok('transported AUTO team preferences are accepted',
    validClientMessage({ t: 'hi', v: PROTOCOL_VERSION, name: 'Ada', team: null }));
  ok('null client messages are rejected without dispatch', !validClientMessage(null));
  ok('malformed state reports are rejected', !validClientMessage({ t: 's', x: NaN }));
  ok('oversized collapse events are rejected', !validServerMessage({
    t: 'e', k: 'col', cells: Array(12003).fill(0),
  }));
  ok('bounded environmental damage feedback passes the server trust boundary',
    validServerMessage({ t: 'e', k: 'envdmg', cause: 'drowned' })
      && !validServerMessage({ t: 'e', k: 'envdmg', cause: 'laser' }));
  ok('authoritative wave countdowns pass the death-event boundary',
    validServerMessage({ t: 'e', k: 'died', rt: 6.4 })
      && !validServerMessage({ t: 'e', k: 'died', rt: 90 }));
  ok('expanded contribution scoreboard rows pass the trust boundary',
    validServerMessage({ t: 'e', k: 'kd',
      rows: [['p0', 'Player', 'green', 2, 1, 325, 1, 4]] })
      && !validServerMessage({ t: 'e', k: 'kd',
        rows: [['p0', 'Player', 'green', 2, 1, 'lots', 1, 4]] }));
  const migratedWelcome = { t: 'w', id: 'peer', team: 'green', seed: 1, map: 0, mode: 'ctf',
    me: 2, migrated: 1, reset: 1, spawn: [10, 20, 30, 0], log: [],
    r: { p: [], b: [] } };
  ok('migration reset welcomes require a valid authoritative spawn',
    validServerMessage(migratedWelcome)
      && !validServerMessage({ ...migratedWelcome, spawn: [10, NaN, 30, 0] }));
  ok('room browser rejects malformed names payloads', !validPong({
    t: 'pong', humans: 1, max: 10, map: 0, mode: 'ctf', g: 0, b: 0, names: 'oops',
  }));
}

// ---------------------------------------------------------------------------
function botRuleTests() {
  group('bot tactics: objectives, targeting, and squad spacing');
  const hill = { x: 128.5, z: 128.5, r: 8 };
  const greenPosts = Array.from({ length: 5 }, (_, id) => hillPost(hill, id, 'green'));
  ok('KOTH bots occupy five stable posts inside the capture radius',
    new Set(greenPosts.map(p => `${p.x.toFixed(3)},${p.z.toFixed(3)}`)).size === 5
      && greenPosts.every(p => Math.hypot(p.x - hill.x, p.z - hill.z) < hill.r));
  const bluePost = hillPost(hill, 0, 'blue');
  ok('opposing KOTH formations are interleaved instead of stacked',
    Math.hypot(bluePost.x - greenPosts[0].x, bluePost.z - greenPosts[0].z) > 1);

  ok('current-target hysteresis prevents trivial target churn',
    botTargetScore(20, 100, false, true) < botTargetScore(18, 100, false, false));
  ok('an enemy flag carrier can still override target stickiness',
    botTargetScore(28, 100, true, false) < botTargetScore(20, 100, false, true));

  const sep = botSeparation({ x: 10, z: 10 }, [
    { id: 2, x: 11, z: 10, alive: true },
    { id: 3, x: 20, z: 10, alive: true },
  ], 1);
  ok('nearby squadmates produce a normalized separation steer',
    sep.x < -0.99 && Math.abs(sep.z) < 1e-9);
  ok('distant or dead squadmates do not perturb movement',
    botSeparation({ x: 10, z: 10 }, [
      { id: 2, x: 20, z: 10, alive: true }, { id: 3, x: 10.2, z: 10, alive: false },
    ], 1).x === 0);

  ok('difficulty scales cognition rather than health or damage',
    BOT_DIFFICULTY.easy.reaction > BOT_DIFFICULTY.normal.reaction
      && BOT_DIFFICULTY.hard.reaction < BOT_DIFFICULTY.normal.reaction
      && BOT_DIFFICULTY.easy.aimError > BOT_DIFFICULTY.hard.aimError
      && !Object.values(BOT_DIFFICULTY).some(d => 'health' in d || 'damage' in d || 'vision' in d));
  ok('unknown bot difficulty safely resolves to normal',
    botDifficulty('nightmare') === BOT_DIFFICULTY.normal);

  const sighting = { x: 40, y: 20, z: 50, t: 10 };
  const remembered = rememberedEnemyPosition(sighting, 11, 3, 7);
  ok('lost targets use a deterministic uncertain last-known position',
    remembered && remembered.confidence > 0 && remembered.confidence < 1
      && rememberedEnemyPosition(sighting, 11, 3, 7).x === remembered.x);
  ok('target memory expires instead of tracking a live entity indefinitely',
    rememberedEnemyPosition(sighting, 14, 3, 7) === null);

  const squad = Array.from({ length: 5 }, (_, id) => ({
    id, x: 20 + id * 10, z: 40 + id, alive: true, carrier: false,
  }));
  const ctfRoles = assignBotRoles('ctf', squad, {
    ownFlagEmergency: true, ownFlag: { x: 70, z: 45 },
    friendlyCarrier: { x: 32, z: 40 }, ownStand: { x: 10, z: 40 },
    midfield: { x: 128, z: 128 },
  });
  ok('CTF director reserves recovery, escort, and defense jobs',
    Object.values(ctfRoles).filter(r => r === 'recover').length === 2
      && Object.values(ctfRoles).includes('escort')
      && Object.values(ctfRoles).includes('defend'));
  const kothRoles = assignBotRoles('koth', squad, { hill: { x: 60, z: 45 } });
  ok('KOTH director creates an anchor, contesters, and flanking pressure',
    Object.values(kothRoles).filter(r => r === 'anchor').length === 1
      && Object.values(kothRoles).filter(r => r === 'contest').length === 2
      && Object.values(kothRoles).some(r => r.startsWith('flank-')));
  const tdmRoles = assignBotRoles('tdm', squad);
  ok('TDM director keeps support, pressure, and flank roles distinct',
    Object.values(tdmRoles).includes('support')
      && Object.values(tdmRoles).some(r => r === 'pressure')
      && Object.values(tdmRoles).some(r => r.startsWith('flank-')));

  const orderSquad = squad.map((b, i) => ({ ...b,
    role: i === 0 ? 'recover' : i === 1 ? 'escort' : 'attack', carrier: i === 2 }));
  const responders = botsForSquadOrder(orderSquad, { x: 50, z: 44 }, 2);
  ok('squad pings peel off bounded responders without overriding critical jobs',
    responders.length === 2 && responders.every(id => id >= 3));

  const due = squad.map(b => ({ ...b, nextThink: 0 }));
  const scheduledA = scheduleBotBrains(due, 1, 0, 3);
  const scheduledB = scheduleBotBrains(due, 1, scheduledA.cursor, 3);
  ok('brain scheduler enforces its per-frame CPU budget',
    scheduledA.ids.length === 3 && scheduledB.ids.length <= 3);
  ok('round-robin brain scheduling reaches every due bot',
    new Set([...scheduledA.ids, ...scheduledB.ids]).size === due.length);

  const route = chooseLocalRoute([
    { angle: 0, x: 1, z: 0, clear: 1, progress: 1, maxStep: 0, maxDrop: 0 },
    { angle: Math.PI / 6, x: 0.86, z: 0.5, clear: 4, progress: 3.46, maxStep: 1, maxDrop: 0 },
    { angle: -Math.PI / 3, x: 0.5, z: -0.86, clear: 4, progress: 2, maxStep: 0, maxDrop: 3 },
  ]);
  ok('local route scoring walks around walls but rejects dangerous drops',
    route?.angle === Math.PI / 6);

  const telemetry = botTelemetrySummary([
    { thinkMs: 0.4, stuckRecoveries: 2, objectiveSeconds: 8 },
    { thinkMs: 0.8, stuckRecoveries: 1, objectiveSeconds: 12 },
  ]);
  ok('bot telemetry aggregates decision cost, recovery, and objective time',
    telemetry.samples === 2 && Math.abs(telemetry.averageThinkMs - 0.6) < 1e-9
      && telemetry.maxThinkMs === 0.8 && telemetry.stuckRecoveries === 3
      && telemetry.objectiveSeconds === 20);

  let scenarioRolesValid = true;
  for (let map = 0; map < MAPS.length; map++) for (const mode of ['ctf', 'tdm', 'koth']) {
    const spot = MAPS[map].hills?.[0] ?? { x: SX / 2, z: SZ / 2 };
    const roles = assignBotRoles(mode, squad, {
      ownStand: { x: 16, z: SZ / 2 }, midfield: { x: SX / 2, z: SZ / 2 }, hill: spot,
    });
    scenarioRolesValid &&= Object.keys(roles).length === squad.length
      && Object.values(roles).every(Boolean);
  }
  ok('deterministic role harness covers every map and game mode', scenarioRolesValid);
}

// ---------------------------------------------------------------------------
function pacingRuleTests() {
  group('match pacing: waves, tactical spawns, regulation, and overtime');
  ok('mode-specific regulation clocks match the pacing plan',
    modeMatchSeconds('ctf') === 720 && modeMatchSeconds('tdm') === 540
      && modeMatchSeconds('koth') === 600);
  ok('deaths in one TDM wave share its six-second boundary',
    Math.abs(respawnWaveDelay('tdm', 12.2) - 5.8) < 1e-9
      && Math.abs(respawnWaveDelay('tdm', 14.5) - 3.5) < 1e-9);
  ok('CTF and KOTH use distinct eight- and seven-second waves',
    respawnWaveDelay('ctf', 8) === 8 && respawnWaveDelay('koth', 7) === 7);

  const safe = tacticalSpawnScore({ x: 30, z: 0 }, {
    enemies: [{ x: 70, z: 0 }], allies: [{ x: 18, z: 0 }],
    objective: { x: 64, z: 0 }, visibleEnemies: 0,
  });
  const exposed = tacticalSpawnScore({ x: 30, z: 0 }, {
    enemies: [{ x: 70, z: 0 }], allies: [{ x: 18, z: 0 }],
    objective: { x: 64, z: 0 }, visibleEnemies: 1,
  });
  ok('spawn scoring strongly prefers covered approaches', safe > exposed + 40);
  ok('spawn scoring rejects immediate enemy proximity',
    tacticalSpawnScore({ x: 0, z: 0 }, { enemies: [{ x: 8, z: 0 }] }) === -Infinity);

  ok('a regulation CTF lead waits for a live flag play to resolve',
    regulationDecision('ctf', { green: 2, blue: 1 }, { flagsLive: true }).overtime);
  ok('a settled CTF lead ends at regulation',
    regulationDecision('ctf', { green: 2, blue: 1 }).winner === 'green');
  ok('tied TDM enters sudden-death overtime',
    regulationDecision('tdm', { green: 14, blue: 14 }).overtime);
  ok('the trailing KOTH side extends regulation while on the point',
    regulationDecision('koth', { green: 70, blue: 65 },
      { losingTeamOnHill: true }).overtime);
  ok('KOTH regulation ends when the trailing side is off the point',
    regulationDecision('koth', { green: 70, blue: 65 }).winner === 'green');
}

// ---------------------------------------------------------------------------
function contributionRuleTests() {
  group('contribution scoring: assists, objectives, and ranking');
  const killer = { name: 'Killer' }, recent = { name: 'Recent' };
  const chip = { name: 'Chip' }, stale = { name: 'Stale' };
  const ledger = new Map([
    [killer, { damage: 60, at: 20 }],
    [recent, { damage: 35, at: 18 }],
    [chip, { damage: 5, at: 19 }],
    [stale, { damage: 80, at: 5 }],
  ]);
  const assists = assistCreditors(ledger, killer, 21);
  ok('assist attribution keeps recent meaningful contributors only',
    assists.length === 1 && assists[0] === recent);
  ok('the credited killer can never also receive an assist', !assists.includes(killer));
  ok('objective actions outweigh incidental chip damage',
    CONTRIBUTION.flagCapture > CONTRIBUTION.kill
      && CONTRIBUTION.flagReturn > CONTRIBUTION.assist);
  ok('a terrain-collapse takedown earns a skill bonus',
    CONTRIBUTION.collapseKill > 0 && CONTRIBUTION.kill + CONTRIBUTION.collapseKill
      < CONTRIBUTION.flagCapture);

  const ranked = rankContributionRows([
    ['fragger', { name: 'Fragger', score: 300, k: 3, d: 0, a: 0, objective: 0 }],
    ['runner', { name: 'Runner', score: 425, k: 1, d: 2, a: 1, objective: 3 }],
  ]);
  ok('scoreboard ranking puts total contribution ahead of raw kills', ranked[0][0] === 'runner');
}

// ---------------------------------------------------------------------------
function kothRuleTests() {
  group('KOTH redesign: occupied scoring and rotating hills');
  ok('an uncontested owner scores while physically on the hill',
    occupiedScoringTeam('green', { green: 2, blue: 0 }) === 'green');
  ok('an abandoned hill produces no hold score',
    occupiedScoringTeam('green', { green: 0, blue: 0 }) === null);
  ok('a contested hill produces no hold score',
    occupiedScoringTeam('green', { green: 2, blue: 1 }) === null);
  ok('an attacker cannot score the previous owner clock while flipping',
    occupiedScoringTeam('green', { green: 0, blue: 2 }) === null);
  const stolen = stepHillCapture({ owner: null, capTeam: 'green', progress: 5.9 },
    'blue', false, 0.2);
  ok('capture progress cannot transfer between opposing teams',
    stolen.owner === null && stolen.capTeam === 'blue' && stolen.progress === 0.2);
  const captured = stepHillCapture({ owner: null, capTeam: 'green', progress: 5.9 },
    'green', false, 0.2);
  ok('a team captures after completing its own uninterrupted bar',
    captured.owner === 'green' && captured.captured === 'green' && captured.progress === 0);
  ok('hill indices wrap through the full map rotation',
    nextHillIndex(0, 3) === 1 && nextHillIndex(2, 3) === 0);

  const warning = stepHillRotation(HILL_MOVE_WARNING + 0.1, 0.2);
  ok('the relocation warning fires once when its threshold is crossed',
    warning.warn && !warning.rotate && warning.remaining < HILL_MOVE_WARNING);
  const moved = stepHillRotation(0.05, 0.1);
  ok('an expired hill clock requests a move and starts a fresh cycle',
    moved.rotate && moved.remaining === HILL_ACTIVE_TIME);
  const frozen = stepHillRotation(3, 1, true);
  ok('overtime freezes relocation on the deciding hill',
    !frozen.rotate && !frozen.warn && frozen.remaining === 3);
}

// ---------------------------------------------------------------------------
function streakRuleTests() {
  group('scorestreak redesign: contribution economy and Overcharge');
  ok('kills, assists, and objective score share one capped streak meter',
    gainStreak(0, CONTRIBUTION.kill) === 100
      && gainStreak(450, CONTRIBUTION.assist) === OVERCHARGE_COST
      && gainStreak(990, 50) === AIRSTRIKE_COST);
  ok('Overcharge unlocks before the airstrike and the stronger reward wins',
    availableStreakAbility(OVERCHARGE_COST) === 'overcharge'
      && availableStreakAbility(AIRSTRIKE_COST) === 'airstrike');
  ok('an active or charging Overcharge prevents reward stacking',
    availableStreakAbility(AIRSTRIKE_COST, 0.5, 0) === null
      && availableStreakAbility(AIRSTRIKE_COST, 0, 5) === null);
  ok('rewards spend a fixed cost and preserve legitimate overflow',
    spendStreak(650, OVERCHARGE_COST) === 150
      && spendStreak(AIRSTRIKE_COST, AIRSTRIKE_COST) === 0
      && spendStreak(400, OVERCHARGE_COST) === null);

  const charging = stepOvercharge(OVERCHARGE_WINDUP, 0, 0.5);
  ok('Overcharge has a visible windup before damage changes',
    charging.charging > 0 && charging.active === 0 && !charging.started);
  const live = stepOvercharge(0.1, 0, 0.2);
  ok('finishing the windup starts the bounded active window',
    live.started && live.charging === 0 && live.active < OVERCHARGE_DURATION);
  const expired = stepOvercharge(0, 0.1, 0.2);
  ok('the active window reports its expiry', expired.ended && expired.active === 0);
  ok('Overcharge is a readable advantage with retained incoming risk',
    overchargeDamage(100, true, false) === 135
      && overchargeDamage(100, false, true) === 125
      && overchargeDamage(100, true, true) === 168.75);
  const snapshot = { t: 's', p: [], b: [], c: [0, 0], g: [],
    u: [[0, 650, 12, 0], [2, 0, 0, 120]] };
  ok('momentum and Overcharge timers pass the snapshot trust boundary',
    validServerMessage(snapshot)
      && !validServerMessage({ ...snapshot, u: [[0, 1500, 0, 0]] })
      && !validServerMessage({ ...snapshot, u: [[0, 500, 0, 999]] }));
  ok('Overcharge phase telegraphs are bounded and attributable',
    validServerMessage({ t: 'e', k: 'overcharge', owner: 2,
      phase: 'windup', remaining: OVERCHARGE_WINDUP })
      && !validServerMessage({ t: 'e', k: 'overcharge', owner: 2,
        phase: 'forever', remaining: 99 }));
  const avatar = new Avatar(scene(), 'green', 'Tester');
  avatar.setOvercharge(true, false);
  ok('the voxel soldier exposes a visible windup telegraph',
    avatar.overchargeFx.visible && avatar.overchargeFx.children.length === 8);
  avatar.setOvercharge(false, true);
  ok('the same warning assembly carries into the active state',
    avatar.overchargeFx.visible && avatar._overchargePhase === 2);
  avatar.dispose();

  group('phase seven: momentum balance without runaway streaks');
  ok('death banks thirty-five percent only when momentum balance is enabled',
    retainedMomentum(AIRSTRIKE_COST, true) === 350
      && retainedMomentum(500, true) === 175
      && retainedMomentum(AIRSTRIKE_COST, false) === 0);
  ok('objectives and assists earn a teamplay premium without inflating kill momentum',
    balancedMomentumGain(100, { objective: 1 }, true) === 125
      && balancedMomentumGain(100, { assists: 1 }, true) === 125
      && balancedMomentumGain(100, {}, true) === 100
      && balancedMomentumGain(100, { objective: 1 }, false) === 100);
  ok('a lopsided leader is held only after using more rewards than the trailing team',
    dominantStreakTeam('ctf', { green: 2, blue: 0 }, { green: 1, blue: 0 }) === 'green'
      && dominantStreakTeam('tdm', { green: 8, blue: 0 }, { green: 1, blue: 0 }) === 'green'
      && dominantStreakTeam('koth', { green: 35, blue: 0 }, { green: 1, blue: 0 }) === 'green'
      && dominantStreakTeam('ctf', { green: 2, blue: 0 }, { green: 0, blue: 0 }) === null);
  ok('the streak hold lifts when the score tightens or reward use equalizes',
    dominantStreakTeam('tdm', { green: 7, blue: 0 }, { green: 2, blue: 0 }) === null
      && dominantStreakTeam('koth', { green: 60, blue: 10 }, { green: 2, blue: 2 }) === null);
  const balancedSnapshot = { ...snapshot, mb: [1, 2, 1] };
  ok('the host momentum policy and team reward counts cross a bounded trust boundary',
    validServerMessage(balancedSnapshot)
      && !validServerMessage({ ...balancedSnapshot, mb: [2, 0, 0] })
      && !validServerMessage({ ...balancedSnapshot, mb: [1, -1, 0] }));
}

// ---------------------------------------------------------------------------
function fieldStationTests() {
  group('voxel field stations: contest, resupply, and anti-farming');
  const green = { alive: true, team: 'green', carrier: false, blocks: 4, grenades: 0 };
  const blue = { alive: true, team: 'blue', carrier: false, blocks: 4, grenades: 0 };
  const full = { alive: true, team: 'green', carrier: false,
    blocks: FIELD_STATION_BLOCK_CAP, grenades: 3 };
  ok('only a living, non-carrier soldier missing supplies can activate a cache',
    stationCanSupply(green) && !stationCanSupply(full)
      && !stationCanSupply({ ...green, carrier: true }));

  const partial = stepFieldStation({}, [green], FIELD_STATION_CAPTURE_TIME - 0.1);
  ok('an uncontested under-supplied team builds capture progress',
    partial.team === 'green' && partial.progress > 0 && !partial.activated);
  const contested = stepFieldStation(partial, [green, blue], 0.2);
  ok('enemy presence contests and clears stockpiled capture progress',
    contested.contested && contested.progress === 0 && contested.team === null);
  const activated = stepFieldStation({}, [green], FIELD_STATION_CAPTURE_TIME);
  ok('a completed hold starts one shared thirty-second cooldown',
    activated.activated === 'green' && activated.cooldown === FIELD_STATION_COOLDOWN);
  const cooling = stepFieldStation(activated, [blue], 1);
  ok('the cooldown cannot be bypassed by changing teams',
    !cooling.activated && cooling.cooldown === FIELD_STATION_COOLDOWN - 1);

  const grant = applyFieldSupply(green);
  ok('a cache grants bounded building stock and one grenade',
    grant.blocks === 20 && grant.nades === 1 && green.blocks === 24 && green.grenades === 1);
  const capped = { alive: true, team: 'green', blocks: 49, nades: 3 };
  applyFieldSupply(capped);
  ok('field supplies respect the shared player and bot caps',
    capped.blocks === FIELD_STATION_BLOCK_CAP && capped.nades === 3);
  const near = nearestFieldStation([{ index: 0, x: 10, z: 10 },
    { index: 1, x: 30, z: 30 }], { x: 12, z: 11 }, 10);
  ok('nearest-cache lookup is range-bounded and stable', near?.station.index === 0
    && nearestFieldStation([{ x: 30, z: 30 }], { x: 0, z: 0 }, 10) === null);

  const snap = { t: 's', p: [], b: [], c: [0, 0], g: [],
    l: [[0, 300, 0, 0, 0], [1, 0, 12, 2, 1]] };
  ok('cache state and personal supply notices pass bounded protocol validation',
    validServerMessage(snap)
      && validServerMessage({ t: 'e', k: 'supply', blocks: 20, nades: 1 })
      && !validServerMessage({ ...snap, l: [[0, 9999, 0, 0, 0]] })
      && !validServerMessage({ t: 'e', k: 'supply', blocks: 200, nades: 4 }));
}

// ---------------------------------------------------------------------------
function matchReportTests() {
  group('post-match report: ranks, medals, and personal bests');
  const entries = [
    ['me', { name: 'Me', team: 'green', score: 820, k: 6, d: 0, a: 3, objective: 7 }],
    ['ally', { name: 'Ally', team: 'green', score: 450, k: 3, d: 2, a: 1, objective: 2 }],
    ['foe', { name: 'Foe', team: 'blue', score: 600, k: 5, d: 3, a: 2, objective: 4 }],
  ];
  const report = buildMatchReport('me', entries);
  ok('the report resolves overall and team placement from contribution order',
    report.overallRank === 1 && report.overallSize === 3
      && report.teamRank === 1 && report.teamSize === 2);
  ok('the local report preserves the full authoritative K/D/A/OBJ row',
    report.local.score === 820 && report.local.k === 6 && report.local.d === 0
      && report.local.a === 3 && report.local.objective === 7);
  ok('medals are thresholded, ordered, and capped at three',
    report.medals.length === 3
      && JSON.stringify(report.medals.map(m => m.id)) === '["mvp","objective","kills"]');
  ok('a low-activity round earns no participation medals',
    medalAwards({ team: 'green', score: 100, k: 1, d: 4, a: 0, objective: 0 }, [
      ['low', { team: 'green', score: 100, k: 1, d: 4, a: 0, objective: 0 }],
    ]).length === 0);

  const first = updatePersonalBests({}, 'ctf', report.local);
  ok('the first positive mode result establishes four personal records',
    first.newBests.length === 4 && first.records.ctf.score === 820
      && first.records.ctf.objective === 7);
  const equal = updatePersonalBests(first.records, 'ctf', report.local);
  ok('equal results do not masquerade as new personal bests', equal.newBests.length === 0);
  const mixed = updatePersonalBests(first.records, 'ctf',
    { score: 700, k: 8, a: 1, objective: 10 });
  ok('a later round updates only records it actually beats',
    JSON.stringify(mixed.newBests.map(b => b.field)) === '["k","objective"]'
      && mixed.records.ctf.score === 820 && mixed.records.ctf.k === 8);
  const otherMode = updatePersonalBests(mixed.records, 'koth',
    { score: 500, k: 2, a: 4, objective: 30 });
  ok('personal records remain separate between game modes',
    otherMode.records.ctf.k === 8 && otherMode.records.koth.a === 4);
}

function socialProgressionTests() {
  group('phase ten: squad signals, rematches, and mastery ranks');
  ok('a solo rematch needs one vote', rematchVotesNeeded(1) === 1);
  ok('two players must both agree to a rematch', rematchVotesNeeded(2) === 2);
  ok('larger rooms use a strict majority', rematchVotesNeeded(3) === 2
    && rematchVotesNeeded(10) === 6);
  ok('unit-like tactical directions pass validation', validPingDirection([1, 0, 0]));
  ok('zero and oversized tactical directions are rejected',
    !validPingDirection([0, 0, 0]) && !validPingDirection([9, 0, 0]));
  ok('tactical ping actions pass the client trust boundary',
    validClientMessage({ t: 'a', k: 'mark', d: [0, 0, -1] })
      && !validClientMessage({ t: 'a', k: 'mark', d: [0, 0, 0] }));
  ok('team marks pass the server trust boundary with bounded kinds',
    validServerMessage({ t: 'e', k: 'mark', id: 7, name: 'Scout', team: 'green',
      x: 20, y: 12, z: 30, kind: 'ATTACK' })
      && !validServerMessage({ t: 'e', k: 'mark', id: 7, name: 'Scout', team: 'green',
        x: 20, y: 12, z: 30, kind: 'ENEMY_THROUGH_WALL' }));
  ok('rematch votes are bounded on both sides of the wire',
    validClientMessage({ t: 'a', k: 'rematch' })
      && validServerMessage({ t: 'e', k: 'rematch', voters: ['p0', 'p2'], needed: 2 })
      && !validServerMessage({ t: 'e', k: 'rematch', voters: ['p0'], needed: 0 }));
  ok('mastery tier boundaries advance rank without weapon decoration',
    masteryProgress(999).tier.name === 'RECRUIT'
      && masteryProgress(1000).tier.name === 'FIELD'
      && masteryProgress(40000).tier.name === 'LEGEND'
      && !('bands' in masteryProgress(40000).tier));
  ok('mastery reports progress to the next tier',
    masteryProgress(4900).remaining === 100 && masteryProgress(5000).tier.name === 'VETERAN');
}

function engagementFoundationTests() {
  group('phase zero: bounded local engagement diagnostics and dormant feature flags');
  const defaults = parseEngagementFeatures('');
  const selected = parseEngagementFeatures(
    '?features=FIRSTMINUTE,deathRecap&features=operations,notAFeature');
  ok('engagement features default off and only known query flags opt in',
    Object.values(defaults).every(value => value === false)
      && selected.firstMinute && selected.deathRecap && selected.operations
      && !('notAFeature' in selected));

  const clean = sanitizeEngagementEvent('match_start', {
    mode: 'ctf', map: 2, network: 'host', source: 'quick', humans: 4, bots: 6,
    round: 3, name: 'private callsign', chat: 'private chat', roomCode: 'ABCD',
    x: 42, z: 19,
  });
  ok('event sanitizer drops identity, chat, room, and position fields',
    clean.mode === 'ctf' && clean.map === 2 && clean.humans === 4
      && !('name' in clean) && !('chat' in clean) && !('roomCode' in clean)
      && !('x' in clean) && !('z' in clean));
  ok('unknown event types are refused instead of accepting free-form data',
    sanitizeEngagementEvent('custom_event', { anything: 'goes' }) === null);

  let now = 0;
  const tracker = new EngagementTracker({ now: () => now,
    eventCapacity: 16, matchCapacity: 4 });
  const context = { mode: 'koth', map: 1, network: 'client', source: 'browse',
    humans: 8, bots: 0, round: 7 };
  ok('one round start is counted once across duplicate play-state updates',
    tracker.beginMatch(context) && !tracker.beginMatch(context)
      && tracker.snapshot().counts.match_start === 1);
  now = 1000;
  tracker.action('shoot', 2.5);
  tracker.action('dig', 3);
  tracker.contribution({ points: 100, objective: 1, assists: 1 });
  tracker.combat('kill', 'weapon');
  tracker.combat('death', 'grenade');
  tracker.pauseMatch('menu');
  now = 1500;
  tracker.beginMatch(context);
  const live = tracker.snapshot();
  ok('first meaningful action is immutable while aggregate actions continue',
    live.active.firstAction.action === 'shoot'
      && live.active.firstAction.matchSecond === 2.5
      && live.active.actions.shoot === 1 && live.active.actions.dig === 1
      && live.active.actions.objective === 1);
  ok('pause and resume stay within one match record',
    live.counts.match_pause === 1 && live.counts.match_resume === 1
      && live.counts.match_start === 1);
  const finished = tracker.finishMatch({ outcome: 'complete', won: true,
    duration: 90, overtime: true, scoreMargin: 4,
    points: 250, objective: 4, assists: 2 });
  ok('authoritative finish totals replace partial local contribution observations',
    finished.contribution.points === 250 && finished.contribution.objective === 4
      && finished.contribution.assists === 2 && finished.kills === 1
      && finished.deaths === 1 && finished.duration === 90);

  const bounded = new EngagementTracker({ now: () => now,
    eventCapacity: 16, matchCapacity: 4 });
  for (let i = 0; i < 24; i++) bounded.record('page_ready', { protocol: i });
  for (let round = 0; round < 6; round++) {
    bounded.beginMatch({ ...context, round });
    bounded.finishMatch({ duration: round + 1 });
  }
  const boundedSnapshot = bounded.snapshot();
  ok('recent event and match histories stay at their fixed memory bounds',
    boundedSnapshot.events.length === 16 && boundedSnapshot.matches.length === 4
      && boundedSnapshot.counts.page_ready === 24);
  boundedSnapshot.matches[0].actions.injected = 1;
  ok('diagnostic snapshots are defensive copies',
    bounded.snapshot().matches[0].actions.injected === undefined);
}

function firstMinuteTests() {
  group('phase one: optional first-minute field orientation');
  ok('each mode receives a direct objective briefing',
    firstMinuteObjective('ctf').includes('FLAG')
      && firstMinuteObjective('tdm').includes('OUTSCORE')
      && firstMinuteObjective('koth').includes('HILL'));

  const guide = new FirstMinuteGuide();
  ok('orientation starts once per page and never restarts on another round',
    guide.start({ mode: 'ctf', matchSecond: 100, x: 10, z: 10 })
      && !guide.start({ mode: 'tdm', matchSecond: 0, x: 0, z: 0 }));
  guide.mark('shoot'); // natural play can satisfy steps before their cue appears
  let view = guide.update({ matchSecond: 101, x: 11, z: 10 });
  ok('sub-threshold movement keeps the first actionable cue visible',
    view.visible && view.prompt === 'MOVE TO CONTACT' && !view.progress.move
      && view.progress.fire);
  view = guide.update({ matchSecond: 102, x: 13, z: 10 });
  ok('completed actions are skipped rather than forcing a rigid tutorial order',
    view.progress.move && view.progress.fire && view.prompt === 'RESHAPE THE FIGHT');
  guide.mark('place');
  view = guide.update({ matchSecond: 103, x: 13, z: 10 });
  ok('either digging or building satisfies the signature voxel interaction',
    view.progress.terrain && view.prompt === 'MARK FOR YOUR SQUAD');
  ok('unknown inputs cannot advance the guide', !guide.mark('open-menu'));
  guide.mark('ping');
  view = guide.update({ matchSecond: 104, x: 13, z: 10 });
  ok('all fundamentals produce a short field-ready confirmation',
    view.complete && view.prompt === 'FIELD READY');
  view = guide.update({ matchSecond: 108, x: 13, z: 10 });
  ok('the completed card clears itself after four seconds', !view.visible && !guide.active);

  const joinedLate = new FirstMinuteGuide();
  joinedLate.start({ mode: 'koth', matchSecond: 300, x: 0, z: 0 });
  const hiddenWhileDead = joinedLate.update({ matchSecond: 320, x: 0, z: 0, alive: false });
  const backAfterSpawn = joinedLate.update({ matchSecond: 321, x: 0, z: 0, alive: true });
  ok('death hides orientation without discarding remaining first-minute guidance',
    !hiddenWhileDead.visible && backAfterSpawn.visible);
  ok('the timeout is measured from deployment, even in a match joined late',
    joinedLate.update({ matchSecond: 359, x: 0, z: 0 }).visible
      && !joinedLate.update({ matchSecond: 360, x: 0, z: 0 }).visible);
}

function voxelStoryTests() {
  group('phase two: factual voxel battlefield stories');
  const tracker = new VoxelStoryTracker();
  ok('an unchanged or barely touched map does not manufacture a battle story',
    tracker.story() === null && voxelBattleStory({ built: 2, removed: 3 }) === null);
  ok('successful edit observations distinguish construction, removal, and no-ops',
    tracker.recordEdit(0, BLOCK.GREEN) && tracker.recordEdit(BLOCK.DIRT, 0)
      && !tracker.recordEdit(BLOCK.STONE, BLOCK.STONE)
      && tracker.metrics().built === 1 && tracker.metrics().removed === 1);
  tracker.recordBlast(9, { airstrike: true });
  ok('blast metrics count actual removed voxels and airstrikes without free-form data',
    tracker.metrics().blasts === 1 && tracker.metrics().blastRemoved === 9
      && tracker.metrics().airstrikes === 1 && tracker.metrics().removed === 10);
  const airstrike = tracker.story();
  ok('a terrain-changing airstrike earns a specific fixed-copy highlight',
    airstrike.kind === 'airstrike' && airstrike.title === 'AIRSTRIKE SCAR'
      && airstrike.detail.includes('9 VOXELS'));
  tracker.recordCollapse(24);
  const collapse = tracker.story();
  ok('a major structural collapse outranks a generic crater story',
    collapse.kind === 'collapse' && collapse.detail.includes('24 VOXELS'));
  tracker.recordCollapseKill();
  const terrainKill = tracker.story();
  ok('a collapse kill is the highest-priority terrain-authored memory',
    terrainKill.kind === 'collapse-kill' && terrainKill.detail.includes('1 SOLDIER'));

  const rewritten = voxelBattleStory({ built: 22, removed: 31 });
  ok('balanced construction and destruction produce a battlefield rewrite story',
    rewritten.kind === 'rewritten' && rewritten.detail === '22 BUILT · 31 REMOVED');
  const metrics = tracker.metrics();
  ok('wire metrics are complete bounded integers and pass the end-event trust boundary',
    validVoxelStoryMetrics(metrics)
      && validServerMessage({ t: 'e', k: 'end', winner: 'green', story: metrics }));
  ok('malformed or oversized story payloads are rejected at the trust boundary',
    !validVoxelStoryMetrics({ built: 1 })
      && !validServerMessage({ t: 'e', k: 'end', winner: 'green',
        story: { ...metrics, removed: -1 } })
      && !validServerMessage({ t: 'e', k: 'end', winner: 'green',
        story: { ...metrics, built: 1_000_001 } }));
  ok('normalization clamps untrusted counters before fixed-copy selection',
    normalizeVoxelStoryMetrics({ built: -8, removed: 2e9 }).built === 0
      && normalizeVoxelStoryMetrics({ built: -8, removed: 2e9 }).removed === 1_000_000);
  tracker.reset();
  ok('round reset clears every story counter',
    Object.values(tracker.metrics()).every(value => value === 0));
}

function deathRecapTests() {
  group('phase three: optional authoritative death recap');
  const rifle = makeDeathRecap({ cause: 'rifle', attacker: 'Birch', team: 'blue',
    distance: 37.6, health: 18.4, headshot: true });
  ok('combat facts are normalized into one bounded recap record',
    validDeathRecap(rifle) && rifle.distance === 38 && rifle.health === 18
      && rifle.headshot && rifle.attacker === 'Birch');
  const rifleCopy = deathRecapCopy(rifle);
  ok('fixed local copy identifies attacker, weapon, range, health, and headshot',
    rifleCopy.label === 'KILLED BY' && rifleCopy.title === 'Birch'
      && rifleCopy.team === 'blue'
      && rifleCopy.detail === 'RIFLE · HEADSHOT · 38m · 18 HP LEFT');

  const fall = makeDeathRecap({ cause: 'fell' });
  const drowned = makeDeathRecap({ cause: 'drowned' });
  ok('environmental deaths produce concise actionable fixed wording',
    deathRecapCopy(fall).title === 'FALL DAMAGE'
      && deathRecapCopy(drowned).detail.includes('SURFACE'));

  const self = makeDeathRecap({ cause: 'grenade', attacker: 'Ignored', team: 'green',
    distance: 1.2, health: 100, self: true });
  ok('self damage cannot masquerade as another attacker',
    self.attacker === null && self.team === null && self.health === null
      && deathRecapCopy(self).title === 'SELF-INFLICTED');

  const collapse = makeDeathRecap({ cause: 'collapse', attacker: 'Digger',
    team: 'green', distance: 7, health: 64, headshot: true });
  ok('non-firearm causes cannot claim a headshot',
    !collapse.headshot && deathRecapCopy(collapse).detail.startsWith('FALLING VOXELS'));

  ok('valid recaps pass as an optional died-event field',
    validServerMessage({ t: 'e', k: 'died', rt: 5.2, recap: rifle })
      && validServerMessage({ t: 'e', k: 'died', rt: 5.2 }));
  ok('malformed recap names, teams, health, and headshots fail the trust boundary',
    !validServerMessage({ t: 'e', k: 'died', rt: 5.2,
      recap: { ...rifle, attacker: 'X'.repeat(25) } })
      && !validServerMessage({ t: 'e', k: 'died', rt: 5.2,
        recap: { ...rifle, team: 'red' } })
      && !validServerMessage({ t: 'e', k: 'died', rt: 5.2,
        recap: { ...rifle, health: 101 } })
      && !validServerMessage({ t: 'e', k: 'died', rt: 5.2,
        recap: { ...collapse, headshot: true } }));

  const clamped = makeDeathRecap({ cause: 'laser', attacker: '\u0000Long Name',
    team: 'blue', distance: 900, health: -40 });
  ok('construction strips controls, clamps numbers, and falls back unknown causes',
    clamped.cause === 'unknown' && clamped.attacker === 'Long Name'
      && clamped.distance === 256 && clamped.health === 0);
  ok('invalid objects never produce display copy',
    deathRecapCopy({ cause: 'rifle', attacker: '<b>Injected</b>' }) === null);
}

function selectedGoalTests() {
  group('phase four: player-selected match goals without reward pressure');
  ok('the three choices cover combat, voxel fieldwork, and team impact',
    validSelectedGoal('vanguard') && validSelectedGoal('sapper')
      && validSelectedGoal('wingman') && !validSelectedGoal('daily_grind')
      && new Set(Object.values(SELECTED_GOALS).map(goal => goal.metric)).size === 3);
  ok('goal definitions contain no reward, currency, expiry, or streak fields',
    Object.values(SELECTED_GOALS).every(goal =>
      !['reward', 'xp', 'currency', 'expires', 'streak'].some(key => key in goal)));

  const combat = new SelectedGoalTracker('vanguard');
  ok('a match baseline prevents prior-round contribution from counting',
    combat.start({ kills: 8, terrain: 20, teamplay: 4 }, 10)
      && !combat.observe({ kills: 10, terrain: 200, teamplay: 40 }, 20)
      && combat.progress === 2);
  ok('authoritative totals cannot roll progress backward',
    !combat.observe({ kills: 9, terrain: 0, teamplay: 0 }, 21)
      && combat.progress === 2);
  ok('completion fires once at the exact target',
    combat.observe({ kills: 11 }, 22) && combat.completed
      && !combat.observe({ kills: 20 }, 23));
  ok('a completed HUD badge clears after five seconds but the result remains',
    combat.view(27, { alive: true })?.complete
      && combat.view(28, { alive: true }) === null
      && combat.result().complete && combat.result().progress === 3);

  combat.reset();
  ok('round reset keeps the chosen style but clears all progress',
    combat.selection === 'vanguard' && !combat.active && combat.progress === 0);
  ok('selection can change before a round but not during one',
    combat.select('sapper') && combat.start({}, 0) && !combat.select('wingman'));
  for (let i = 0; i < 11; i++) combat.record('terrain', 1, i);
  ok('direct voxel edits advance only the fieldwork goal',
    combat.progress === 11 && combat.record('terrain', 1, 12) && combat.completed);

  const wingman = new SelectedGoalTracker('wingman');
  wingman.start({ teamplay: 6 }, 0);
  wingman.observe({ teamplay: 8.9 }, 2);
  ok('team progress combines bounded authoritative credit without rounding up',
    wingman.progress === 2 && wingman.record('teamplay', 1, 3) && wingman.completed);
  ok('death and post-match states suppress the live card without losing the result',
    wingman.view(3, { alive: false }) === null
      && wingman.view(3, { over: true }) === null && wingman.result().complete);
  ok('terrain progress signals are bounded at the server trust boundary',
    validServerMessage({ t: 'e', k: 'goal', metric: 'terrain', amount: 1 })
      && !validServerMessage({ t: 'e', k: 'goal', metric: 'kills', amount: 1 })
      && !validServerMessage({ t: 'e', k: 'goal', metric: 'terrain', amount: 1000 }));
}

function stayAsSquadTests() {
  group('phase five: explicit same-team continuation signals');
  const roster = [['p0', 'green'], ['p1', 'green'], ['p2', 'green'],
    ['p3', 'blue'], ['p4', 'blue']];
  const empty = staySquadState(roster, [], 'p0');
  ok('a multiplayer teammate group is available without implying a vote',
    empty.available && !empty.voted && !empty.formed
      && empty.teammates === 3 && empty.ready === 0);
  const waiting = staySquadState(roster, ['p0', 'p3', 'missing'], 'p0');
  ok('opponents and unknown ids never inflate local squad readiness',
    waiting.voted && !waiting.formed && waiting.ready === 1);
  const formed = staySquadState(roster, ['p0', 'p1', 'p3', 'p4'], 'p0');
  ok('two mutual same-team signals form a squad without requiring opponents',
    formed.formed && formed.ready === 2 && formed.teammates === 3);
  ok('a viewer who did not opt in is not silently drafted into a squad',
    !staySquadState(roster, ['p1', 'p2'], 'p0').formed);
  ok('solo and missing viewers never expose the continuation control',
    !staySquadState([['p0', 'green']], ['p0'], 'p0').available
      && !staySquadState(roster, ['p0'], 'missing').available);

  const groups = staySquadGroups(roster, ['p4', 'p1', 'p0', 'p3', 'p3', 'missing']);
  ok('host handoff produces stable same-team atomic groups only',
    groups.length === 2 && groups[0].join(',') === 'p0,p1'
      && groups[1].join(',') === 'p3,p4');
  ok('a lone readiness signal does not create a one-person squad',
    staySquadGroups(roster, ['p0', 'p3', 'missing']).length === 0);
  ok('squad signals are bounded and deduplicated at both trust boundaries',
    validClientMessage({ t: 'a', k: 'squad' })
      && validServerMessage({ t: 'e', k: 'squad', voters: ['p0', 'p1'] })
      && !validServerMessage({ t: 'e', k: 'squad', voters: ['p0', 'p0'] })
      && !validServerMessage({ t: 'e', k: 'squad', voters: Array(11).fill(0).map((_, i) => `p${i}`) }));
}

function teamBalanceTests() {
  group('phase eight: transparent between-round team balance');
  ok('balanced live joins cannot grow the already larger human side',
    chooseTeam('green', { green: 3, blue: 1 }, 5, true) === 'blue'
      && chooseTeam('green', { green: 2, blue: 2 }, 5, true) === 'green');

  const fair = balanceHumanTeams([
    { key: 'p0', team: 'green', rating: 900 },
    { key: 'p1', team: 'green', rating: 100 },
    { key: 'p2', team: 'blue', rating: 800 },
    { key: 'p3', team: 'blue', rating: 200 },
  ], [], 5, 300);
  ok('already fair compositions simply rotate map sides',
    fair.moved === 0 && fair.sizeGap === 0 && fair.ratingGap === 0
      && fair.assignments.p0 === 'blue' && fair.assignments.p2 === 'green');

  const stacked = balanceHumanTeams([
    { key: 'p0', team: 'green', rating: 1000 },
    { key: 'p1', team: 'green', rating: 900 },
    { key: 'p2', team: 'blue', rating: 100 },
    { key: 'p3', team: 'blue', rating: 50 },
  ], [], 2);
  ok('a clear prior-round stack is split into equal, closely rated sides',
    stacked.sizeGap === 0 && stacked.ratingGap === 50 && stacked.moved === 2);

  const squad = balanceHumanTeams([
    { key: 'p0', team: 'green', rating: 1000 },
    { key: 'p1', team: 'green', rating: 900 },
    { key: 'p2', team: 'blue', rating: 100 },
    { key: 'p3', team: 'blue', rating: 50 },
  ], [['p0', 'p1']], 2);
  ok('a mutually confirmed squad is never split to manufacture a closer result',
    squad.assignments.p0 === squad.assignments.p1 && squad.groups === 1);

  const close = balanceHumanTeams([
    { key: 'p0', team: 'green', rating: 550 },
    { key: 'p1', team: 'green', rating: 450 },
    { key: 'p2', team: 'blue', rating: 500 },
    { key: 'p3', team: 'blue', rating: 400 },
  ], [], 2);
  ok('small projected gains do not justify disruptive roster churn',
    close.moved === 0 && close.cost <= close.ratingGap + TEAM_REASSIGNMENT_COST);

  const phaseEightSnapshot = { t: 's', p: [], b: [], c: [0, 0], g: [], tb: 1 };
  ok('the host balance policy survives bounded snapshot synchronization',
    validServerMessage(phaseEightSnapshot)
      && !validServerMessage({ ...phaseEightSnapshot, tb: 2 }));
}

function operationTests() {
  group('phase six: optional three-match operations');
  ok('every operation is a mode-compatible KOTH → CTF → TDM arc',
    OPERATION_PLANS.length >= 3 && OPERATION_PLANS.every(plan =>
      plan.legs.map(leg => leg.mode).join(',') === 'koth,ctf,tdm'
        && plan.legs.every(leg => MAPS[leg.map]?.modes.includes(leg.mode))));

  let op = createOperation(0);
  ok('a new operation starts at leg one with a clean Alpha/Bravo score',
    operationLeg(op) === OPERATION_PLANS[0].legs[0]
      && op.leg === 0 && op.wins.join(',') === '0,0' && op.results.length === 0
      && operationSideForColor(op, 'green') === 'alpha');
  op = recordOperationResult(op, 'green');
  const settled = op;
  ok('one authoritative result settles a leg exactly once',
    op.wins.join(',') === '1,0' && op.results.join(',') === '0'
      && recordOperationResult(op, 'blue') === settled);
  op = flipOperationColors(advanceOperation(op));
  ok('side flips preserve Alpha/Bravo identity between different map colors',
    op.leg === 1 && op.greenSide === 1
      && operationSideForColor(op, 'blue') === 'alpha');
  op = recordOperationResult(op, 'blue');
  op = flipOperationColors(advanceOperation(op));
  op = recordOperationResult(op, 'blue');
  ok('three legs produce a bounded final operation winner and report score',
    operationComplete(op) && operationWinner(op) === 'alpha'
      && op.wins.join(',') === '2,1' && op.results.join(',') === '0,0,1');

  const row = operationRow(op);
  ok('operation state round-trips through its compact migration-safe row',
    validOperationRow(row) && JSON.stringify(operationRow(operationFromRow(row))) === JSON.stringify(row));
  ok('malformed or internally inconsistent operation rows are rejected',
    !validOperationRow([0, 2, 3, 0, 0, 0])
      && !validOperationRow([99, 0, 0, 0, 0])
      && !validOperationRow([0, 0, 0, 0, 2]));
  ok('operation end and mode-changing restart packets pass the trust boundary',
    validServerMessage({ t: 'e', k: 'end', winner: 'blue', op: row })
      && validServerMessage({ t: 'e', k: 'restart', seed: 42, map: 2,
        mode: 'ctf', op: operationRow(createOperation(0)) })
      && !validServerMessage({ t: 'e', k: 'restart', seed: 42, map: 2,
        op: operationRow(createOperation(0)) })
      && !validServerMessage({ t: 'e', k: 'end', winner: 'blue', op: [0, 9, 0, 0, 0] }));
}

// ---------------------------------------------------------------------------
function damageDirectionTests() {
  group('damage direction: source bearing to screen edge');
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  ok('source ahead maps to the top edge', close(relativeBearing(0, 10, 10, 20, 10), 0));
  ok('source on the right maps clockwise to the right edge',
    close(relativeBearing(0, 10, 10, 10, 20), Math.PI / 2));
  ok('source on the left maps counter-clockwise to the left edge',
    close(relativeBearing(0, 10, 10, 10, 0), -Math.PI / 2));
  ok('source behind maps to the bottom edge',
    close(Math.abs(relativeBearing(0, 10, 10, 0, 10)), Math.PI));
  ok('bearing follows a rotated player view',
    close(relativeBearing(Math.PI / 2, 10, 10, 10, 0), 0));
}

// ---------------------------------------------------------------------------
function airstrikeDroneTests() {
  group('airstrike MQ-9: model and flight path');
  const startEast = airstrikeDronePose(100, 20, 120, 0, 3);
  const endEast = airstrikeDronePose(100, 20, 120, 0, 0);
  ok('yaw 0 approaches from west and exits east',
    startEast.x === 22 && startEast.z === 120 && endEast.x === 110 && endEast.z === 120);
  const startNorth = airstrikeDronePose(100, 20, 120, Math.PI / 2, 3);
  const endNorth = airstrikeDronePose(100, 20, 120, Math.PI / 2, 0);
  ok('yaw PI/2 follows player north along -Z',
    Math.abs(startNorth.z - 198) < 1e-9 && Math.abs(endNorth.z - 110) < 1e-9);
  ok('aircraft holds a terrain-relative overhead altitude', startEast.y === 43);
  const overTarget = airstrikeDronePose(100, 20, 120, 0, 3 * (1 - 78 / 88));
  ok('aircraft crosses the live target shortly before impact', Math.abs(overTarget.x - 100) < 1e-9);

  const mq9 = makeMq9Drone();
  let meshes = 0;
  mq9.group.traverse(o => { if (o.isMesh) meshes++; });
  ok('MQ-9 is a detailed voxel assembly', meshes >= 25, `${meshes} box meshes`);
  ok('MQ-9 exposes its animated pusher propeller', mq9.propeller.parent === mq9.group);
  disposeObject(mq9.group);

  ok('strike requests require a finite captured yaw',
    validClientMessage({ t: 'a', k: 'strike', n: 1, x: 100, z: 120, yaw: 0 })
      && !validClientMessage({ t: 'a', k: 'strike', n: 2, x: 100, z: 120 }));
  ok('airstrike telegraph metadata passes the server trust boundary', validServerMessage({
    t: 'e', k: 'telegraph', id: 7, x: 100, y: 20, z: 120,
    yaw: 0, remaining: 3, owner: 2,
  }));
  const strikeSnapshot = { t: 's', p: [], b: [], c: [0, 0], g: [],
    a: [[7, qx(100), qy(20), qx(120), qa(0), 2500, 2]] };
  ok('active-strike snapshot rows pass validation', validServerMessage(strikeSnapshot));
  ok('invalid active-strike timers are rejected', !validServerMessage({
    ...strikeSnapshot, a: [[7, qx(100), qy(20), qx(120), qa(0), 9000, 2]],
  }));
  ok('match clock and overtime snapshot state are bounded',
    validServerMessage({ ...strikeSnapshot, m: [5399, 0, 1], w: null })
      && validServerMessage({ ...strikeSnapshot, m: [0, 1, 5400], w: 'blue' })
      && !validServerMessage({ ...strikeSnapshot, m: [-1, 0, 1] }));
  ok('rotating-hill state and occupied presence pass validation',
    validServerMessage({ ...strikeSnapshot,
      h: ['green', 2.5, 0, 'blue', 2, 17.4, 1, 0] })
      && !validServerMessage({ ...strikeSnapshot,
        h: ['green', 2.5, 0, 'blue', 12, 17.4, 1, 0] })
      && !validServerMessage({ ...strikeSnapshot,
        h: ['green', 2.5, 0, 'blue', 2, 17.4, 99, 0] }));
}

// ---------------------------------------------------------------------------
function soldierModelTests() {
  group('voxel soldier: articulated model and class silhouettes');
  const p = makeSoldier(0x4e8b57);
  let meshes = 0, visibleMeshes = 0;
  p.group.traverse(o => {
    if (!o.isMesh) return;
    meshes++;
    if (o.visible && o.parent?.visible !== false) visibleMeshes++;
  });
  ok('soldier is a detailed articulated assembly', meshes >= 55, `${meshes} box meshes`);
  ok('rifle is the default world-model weapon and equipment kit', p.gun.visible && p.rifle.visible
    && !p.smg.visible && !p.sniper.visible && p.rifleKit.visible
    && !p.smgKit.visible && !p.sniperKit.visible);
  setSoldierTool(p, 1);
  ok('SMG swaps to its own compact model', p.gun.visible && p.smg.visible
    && !p.rifle.visible && !p.sniper.visible && p.smgKit.visible
    && !p.rifleKit.visible && !p.sniperKit.visible);
  setSoldierTool(p, 5);
  ok('sniper swaps to its own long model', p.gun.visible && p.sniper.visible
    && !p.rifle.visible && !p.smg.visible && p.sniperKit.visible
    && !p.rifleKit.visible && !p.smgKit.visible);
  setSoldierTool(p, 3);
  ok('block tool replaces the firearm in-hand', !p.gun.visible && p.block.visible
    && !p.grenade.visible && !p.spade.visible);
  ok('class equipment remains while a utility tool is held', p.sniperKit.visible
    && !p.rifleKit.visible && !p.smgKit.visible);
  setSoldierTool(p, 4);
  ok('grenade tool has a dedicated carried model', !p.gun.visible && p.grenade.visible
    && !p.block.visible);
  setSoldierTool(p, 0);
  animateSoldier(p, 5, 0.7);
  ok('armed gait keeps both arms pitched toward the weapon',
    p.armL.rotation.x > 0.3 && p.armR.rotation.x > 0.3);
  setCrouch(p, true);
  ok('crouch aligns the head assembly with the gameplay eye height',
    p.head.position.y === CROUCH_HEIGHT - EYE_INSET);
  const crouchBounds = new THREE.Box3().setFromObject(p.group);
  ok('crouched model stays inside the gameplay head hitbox',
    crouchBounds.min.y >= -0.01 && crouchBounds.max.y <= CROUCH_HEIGHT - EYE_INSET + 0.34,
    `y=${crouchBounds.min.y.toFixed(2)}..${crouchBounds.max.y.toFixed(2)}`);
  setCrouch(p, false);
  const bounds = new THREE.Box3().setFromObject(p.group);
  ok('standing model stays aligned to the gameplay body height',
    bounds.min.y >= -0.01 && bounds.max.y <= 1.8,
    `y=${bounds.min.y.toFixed(2)}..${bounds.max.y.toFixed(2)}`);
  ok('default visible complexity remains bounded', visibleMeshes < 45,
    `${visibleMeshes} visible box meshes`);
  disposeObject(p.group);

  const hadStorage = 'localStorage' in globalThis;
  const priorStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => key === 'tos.gfx' ? 'low' : null };
  const low = makeSoldier(0x4e8b57);
  let lowVisible = 0;
  low.group.traverse(o => {
    if (o.isMesh && o.visible && o.parent?.visible !== false) lowVisible++;
  });
  ok('low graphics removes only nonessential soldier detail',
    lowVisible <= visibleMeshes - 8, `${visibleMeshes} -> ${lowVisible} visible meshes`);
  disposeObject(low.group);
  if (hadStorage) globalThis.localStorage = priorStorage;
  else delete globalThis.localStorage;
}

// ---------------------------------------------------------------------------
function bodyTests() {
  group('Body: gravity, collision, ledge guard');
  const floorAt = y0 => {
    const w = new VoxelWorld(scene());
    for (let x = 0; x < SX; x++) for (let z = 0; z < SZ; z++) w.data[(y0 * SZ + z) * SX + x] = BLOCK.STONE;
    return w;
  };
  const drop = (w, fromY, dt, steps) => {
    const b = new Body(w, 50.5, fromY, 50.5);
    for (let i = 0; i < steps; i++) b.move(dt);
    return b;
  };
  const w = floorAt(30);
  ok('lands on top of the floor at 60fps', Math.abs(drop(w, 45, 1 / 60, 200).pos.y - 31) < 1e-6);
  ok('no tunnelling at the main loop dt cap (0.05s)', Math.abs(drop(w, 60, 0.05, 200).pos.y - 31) < 1e-6);
  ok('onGround is set once resting', drop(w, 45, 1 / 60, 200).onGround);

  const ceiling = new VoxelWorld(scene());
  for (let x = 40; x < 60; x++) for (let z = 40; z < 60; z++) {
    ceiling.data[(30 * SZ + z) * SX + x] = BLOCK.STONE;
    ceiling.data[(34 * SZ + z) * SX + x] = BLOCK.STONE;
  }
  const b2 = new Body(ceiling, 50.5, 31, 50.5);
  b2.half.h = CROUCH_HEIGHT;
  for (let i = 0; i < 30; i++) b2.move(1 / 60);
  b2.half.h = STAND_HEIGHT;
  for (let i = 0; i < 30; i++) b2.move(1 / 60);
  ok('standing up under a 3-block ceiling does not wedge', b2.pos.y >= 31 - 1e-6 && b2.pos.y < 32, `y=${b2.pos.y}`);

  const cliff = new VoxelWorld(scene());
  for (let x = 0; x < 50; x++) for (let z = 0; z < SZ; z++) cliff.data[(30 * SZ + z) * SX + x] = BLOCK.STONE;
  const walkEast = guard => {
    const b = new Body(cliff, 48.5, 31, 50.5);
    b.guard = guard;
    for (let i = 0; i < 120; i++) { b.vel.x = 5; b.move(1 / 60); }
    return b.pos.x;
  };
  const guarded = walkEast(true);
  ok('the crouch guard stops at the rim', guarded < 50.6, `x=${guarded}`);
  ok('without the guard you walk off the cliff', walkEast(false) > 50);
  note(`guarded body parks at x=${guarded.toFixed(2)}; the last solid column ends at 50, so the centre `
    + 'overhangs by ~0.25 (the guard only requires SOME of the footprint to have footing)');

  const step = new VoxelWorld(scene());
  for (let x = 0; x < SX; x++) for (let z = 0; z < SZ; z++) {
    step.data[(30 * SZ + z) * SX + x] = BLOCK.STONE;
    if (x >= 50) step.data[(29 * SZ + z) * SX + x] = BLOCK.STONE;
  }
  const b4 = new Body(step, 48.5, 31, 50.5);
  b4.guard = true;
  for (let i = 0; i < 180; i++) { b4.vel.x = 5; b4.move(1 / 60); }
  ok('a guarded body still takes a one-block step down', b4.pos.x > 50, `x=${b4.pos.x}`);

  const shore = new VoxelWorld(scene());
  for (let x = 50; x < SX; x++) for (let z = 49; z <= 51; z++)
    shore.data[((SEA - 1) * SZ + z) * SX + x] = BLOCK.STONE;
  const swimmer = new Body(shore, 49.5, SEA - 0.35, 50.5);
  swimmer.move(0); // classify the starting body as swimming before advancing
  for (let i = 0; i < 30; i++) { swimmer.vel.x = 3.2; swimmer.move(1 / 60); }
  ok('a swimmer can mantle onto a water-level block',
    swimmer.pos.x > 50 && swimmer.pos.y >= SEA - 0.01,
    `x=${swimmer.pos.x.toFixed(2)} y=${swimmer.pos.y.toFixed(2)}`);

  const tallBank = new VoxelWorld(scene());
  for (let x = 50; x < SX; x++) for (let z = 49; z <= 51; z++)
    for (let y = SEA - 1; y <= SEA; y++)
      tallBank.data[(y * SZ + z) * SX + x] = BLOCK.STONE;
  const blockedSwimmer = new Body(tallBank, 49.5, SEA - 0.35, 50.5);
  blockedSwimmer.move(0);
  for (let i = 0; i < 30; i++) { blockedSwimmer.vel.x = 3.2; blockedSwimmer.move(1 / 60); }
  ok('a swimmer cannot mantle through an occupied body space',
    blockedSwimmer.pos.x < 50, `x=${blockedSwimmer.pos.x.toFixed(2)}`);

  const voidWorld = new VoxelWorld(scene());
  const b5 = new Body(voidWorld, 50.5, 5, 50.5);
  for (let i = 0; i < 300; i++) b5.move(1 / 60);
  ok('a void fall is caught by the safety net', b5.pos.y > -8, `y=${b5.pos.y}`);
  note(`the Body raises voidFall after parking at y=${b5.pos.y.toFixed(2)}; Game converts it into a normal death`);

  ok('surface() of an empty column reads as ground at y=0', voidWorld.surface(10, 10) === 0);
}

// ---------------------------------------------------------------------------
function environmentalDamageTests() {
  group('environmental damage: falls, water entry, and breath');

  ok('ordinary traversal and roughly five-block drops remain safe',
    fallDamageForImpact(18) === 0);
  ok('medium falls ramp in gently without becoming lethal',
    fallDamageForImpact(24) > 0 && fallDamageForImpact(24) <= 12);
  ok('a fatal-speed impact reaches full health', fallDamageForImpact(36) === 100);
  ok('host-observed fall distance reconstructs physical impact speed',
    Math.abs(impactSpeedForFallDistance(15) - 30) < 1e-9);

  const floor = new VoxelWorld(scene());
  const floorY = SEA + 5;
  for (let x = 48; x <= 52; x++) for (let z = 48; z <= 52; z++)
    floor.data[(floorY * SZ + z) * SX + x] = BLOCK.STONE;
  const faller = new Body(floor, 50.5, floorY + 20, 50.5);
  let impact = 0;
  for (let i = 0; i < 240 && !faller.onGround; i++) {
    faller.move(1 / 60);
    impact = Math.max(impact, faller.landedSpeed);
  }
  ok('Body preserves downward speed on the landing frame', impact > 30,
    `impact=${impact.toFixed(2)}`);

  const sea = new VoxelWorld(scene());
  const diver = new Body(sea, 50.5, SEA + 8, 50.5);
  let entered = false;
  for (let i = 0; i < 240 && !entered; i++) {
    diver.move(1 / 60);
    entered = diver.inWater;
  }
  ok('entering water breaks retained fall velocity', entered && diver.vel.y >= -6,
    `vy=${diver.vel.y.toFixed(2)}`);

  let state = stepBreath(BREATH_MAX, 1, true, BREATH_MAX);
  ok('twelve submerged seconds consume air without premature damage',
    state.breath === 0 && state.damage === 0);
  state = stepBreath(state.breath, state.drownClock, true, 1);
  ok('drowning begins one second after air empties', state.damage === DROWN_DAMAGE);
  state = stepBreath(state.breath, state.drownClock, false, 1);
  ok('surfacing recovers air gradually and stops damage', state.breath === 4 && state.damage === 0);
}

// ---------------------------------------------------------------------------
function timings() {
  group('timings (node, no GPU upload — treat as relative, not absolute)');
  const w = new VoxelWorld(scene());
  let t = Date.now();
  generateMap(w, 5, 0);
  note(`generateMap + buildAll (256 chunks): ${Date.now() - t}ms`);
  t = Date.now();
  for (let i = 0; i < 100; i++) w.set(100 + (i % 7), 25, 100, i % 2 ? 0 : BLOCK.BLUE);
  note(`set() mid-chunk: ${((Date.now() - t) / 100).toFixed(2)}ms per single-voxel edit`);
  t = Date.now();
  for (let i = 0; i < 50; i++) w.set(96, 25, 100 + (i % 3), i % 2 ? 0 : BLOCK.BLUE);
  note(`set() on a chunk seam: ${((Date.now() - t) / 50).toFixed(2)}ms per edit (rebuilds 2 chunks)`);
  t = Date.now();
  w.set(130, 25, 130, 0); w.set(130, 26, 130, 0); w.set(130, 27, 130, 0); w.set(131, 26, 131, 0); w.flushDirty();
  note(`one bot uphill dig swing (4 x set()): ${Date.now() - t}ms`);
  t = Date.now();
  w.carve(120, 26, 120, 2.4);
  note(`one grenade carve(r=2.4), batched dirty set: ${Date.now() - t}ms`);
}

// ---------------------------------------------------------------------------
// Grounding checks for the pure structural solver exported by game.js. The
// shipped algorithm is fuzzed against a straightforward component reference,
// then exercised against a bridge larger than the natural-terrain budget.
const DIRS6 = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
const ckey = (x, y, z) => x + ',' + y + ',' + z;
function seedsFor(solid, holes) {
  const seeded = new Set(), seeds = [];
  for (const h of holes) for (const d of DIRS6) {
    const x = h.x + d[0], y = h.y + d[1], z = h.z + d[2], k = ckey(x, y, z);
    if (!seeded.has(k) && solid(x, y, z)) { seeded.add(k); seeds.push({ x, y, z }); }
  }
  return seeds;
}
// The shipped algorithm itself, with every fuzz voxel treated as natural
// terrain so the original conservative proof budget remains under test.
function collapseShipped(solid, holes, CAP = 4000) {
  return unsupportedCollapseCells((x, y, z) => solid(x, y, z) ? BLOCK.STONE : 0,
    holes, { terrainCap: CAP });
}
// Reference: flood each component to completion with its own visited set.
function collapseReference(solid, holes, CAP = 4000) {
  const doomed = new Set(), resolved = new Map();
  for (const s of seedsFor(solid, holes)) {
    const sk = ckey(s.x, s.y, s.z);
    if (resolved.has(sk)) continue;
    const comp = new Set([sk]), q = [s];
    let grounded = false;
    for (let i = 0; i < q.length; i++) {
      const c = q[i];
      if (c.y === 0) grounded = true;
      if (comp.size > CAP) { grounded = true; break; }
      for (const d of DIRS6) {
        const x = c.x + d[0], y = c.y + d[1], z = c.z + d[2], k = ckey(x, y, z);
        if (comp.has(k) || !solid(x, y, z)) continue;
        comp.add(k); q.push({ x, y, z });
      }
    }
    for (const k of comp) resolved.set(k, grounded);
    if (!grounded) for (const k of comp) doomed.add(k);
  }
  return doomed;
}

function collapseTests() {
  group('structural collapse: grounding');
  const rnd = lcg(12345);
  const N = 14, H = 10;
  let checked = 0, disagreements = 0, extraN = 0, missN = 0;
  for (let trial = 0; trial < 3000; trial++) {
    const cells = new Set();
    for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) if (rnd() < 0.5) cells.add(ckey(x, 0, z));
    const n = 8 + Math.floor(rnd() * 60);
    for (let i = 0; i < n; i++) {
      const x = Math.floor(rnd() * N), z = Math.floor(rnd() * N), y = 1 + Math.floor(rnd() * (H - 1));
      cells.add(ckey(x, y, z));
      if (rnd() < 0.6) for (let yy = 1; yy < y; yy++) cells.add(ckey(x, yy, z));
    }
    const solid = (x, y, z) => cells.has(ckey(x, y, z));
    const list = [...cells].map(k => k.split(',').map(Number)).filter(c => c[1] > 0);
    if (!list.length) continue;
    const h = list[Math.floor(rnd() * list.length)];
    cells.delete(ckey(h[0], h[1], h[2]));
    checked++;
    const got = collapseShipped(solid, [{ x: h[0], y: h[1], z: h[2] }]);
    const want = collapseReference(solid, [{ x: h[0], y: h[1], z: h[2] }]);
    const extra = [...got].filter(k => !want.has(k)).length;
    const miss = [...want].filter(k => !got.has(k)).length;
    if (extra || miss) { disagreements++; extraN += extra; missN += miss; }
  }
  ok(`grounding matches the reference on ${checked} random structures`,
    disagreements === 0, `${disagreements} bad (extra ${extraN}, missing ${missN})`);
  note('the shared-visited-set version failed 94/3000 here, always by collapsing supported blocks');

  // A severed L-beam must still come down: the fix must not make collapse timid.
  const cells = new Set();
  cells.add(ckey(0, 0, 0));
  for (let y = 1; y <= 3; y++) cells.add(ckey(0, y, 0));
  for (let x = 1; x <= 3; x++) cells.add(ckey(x, 3, 0));
  for (let z = 1; z <= 3; z++) cells.add(ckey(0, 3, z));
  const solid = (x, y, z) => cells.has(ckey(x, y, z));
  cells.delete(ckey(0, 3, 0));
  const doomed = collapseShipped(solid, [{ x: 0, y: 3, z: 0 }]);
  ok('a severed L-beam still collapses (6 cells)', doomed.size === 6, `${doomed.size}`);

  // Regression: a broad constructed bridge crosses the natural-terrain
  // safety threshold. One anchor must hold it; removing the second must drop
  // the full deck instead of misclassifying size alone as structural support.
  const bridge = new Map(), WIDTH = 18, LENGTH = 230, DECK_Y = 4;
  for (let z = 0; z < WIDTH; z++) {
    for (let x = 0; x <= LENGTH + 1; x++)
      bridge.set(ckey(x, DECK_Y, z), BLOCK.GREEN);
    for (let y = 0; y < DECK_Y; y++) {
      bridge.set(ckey(0, y, z), BLOCK.GREEN);
      bridge.set(ckey(LENGTH + 1, y, z), BLOCK.GREEN);
    }
  }
  const left = [], right = [];
  for (let z = 0; z < WIDTH; z++) {
    bridge.delete(ckey(0, DECK_Y, z)); left.push({ x: 0, y: DECK_Y, z });
  }
  const blockAt = (x, y, z) => bridge.get(ckey(x, y, z)) ?? 0;
  ok('one surviving bridge anchor still carries a deck wider than the terrain cap',
    unsupportedCollapseCells(blockAt, left).size === 0);
  for (let z = 0; z < WIDTH; z++) {
    bridge.delete(ckey(LENGTH + 1, DECK_Y, z));
    right.push({ x: LENGTH + 1, y: DECK_Y, z });
  }
  const fallenBridge = unsupportedCollapseCells(blockAt, right);
  ok('destroying both ends collapses the entire wide constructed bridge',
    fallenBridge.size === WIDTH * LENGTH,
    `${fallenBridge.size}/${WIDTH * LENGTH} deck cells`);
}

// ---------------------------------------------------------------------------
function wireTests() {
  group('snapshot omission: host sent-map vs client reconstruction');
  // Model the host side of _broadcastSnapshot and the client side of
  // mergeSnapshot, and assert they stay in agreement across random churn.
  const rowsEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const rnd = lcg(4242);
  const sentP = new Map(), sentB = new Map();
  const fullP = new Map(), fullB = new Map();
  let truthP = new Map(), truthB = new Map();
  const mkP = idx => [idx, qx(rnd() * 250), qy(rnd() * 60), qx(rnd() * 250),
    qa(rnd() * 6), Math.round(rnd() * 100), 1, 0, (rnd() * 5) | 0, (rnd() * 50) | 0, 0, 3];
  const mkB = idx => [idx, qx(rnd() * 250), qy(rnd() * 60), qx(rnd() * 250),
    qa(rnd() * 6), Math.round(rnd() * 100), 1, 0, 0];
  for (let idx = 0; idx < 6; idx++) truthP.set(idx, mkP(idx));
  for (let idx = 0; idx < 7; idx++) truthB.set(idx, mkB(idx));
  let drift = 0, skipped = 0;
  for (let tick = 0; tick < 400; tick++) {
    // churn: move some, occasionally add or remove
    for (const [idx] of truthP) if (rnd() < 0.5) truthP.set(idx, mkP(idx));
    for (const [idx] of truthB) if (rnd() < 0.4) truthB.set(idx, mkB(idx));
    if (rnd() < 0.05 && truthP.size > 2) truthP.delete([...truthP.keys()][0]);
    if (rnd() < 0.05) { const i = 20 + tick; truthP.set(i, mkP(i)); }
    if (rnd() < 0.05 && truthB.size > 2) truthB.delete([...truthB.keys()][0]);

    const congested = rnd() < 0.15; // a tick the host skips for this connection
    const out = { t: 's', p: [], b: [] };
    if (!congested) {
      for (const [key, truth, sent] of [['p', truthP, sentP], ['b', truthB, sentB]]) {
        const cur = new Set();
        for (const row of truth.values()) {
          cur.add(row[0]);
          const prev = sent.get(row[0]);
          if (!prev || !rowsEq(prev, row)) { out[key].push(row); sent.set(row[0], row); }
        }
        const rm = [];
        for (const idx of sent.keys()) if (!cur.has(idx)) { rm.push(idx); sent.delete(idx); }
        if (rm.length) (out.rm ??= {})[key] = rm;
      }
      mergeSnapshot(fullP, fullB, out);
    } else skipped++;
    // after any delivered tick the reconstruction must equal the truth
    if (!congested) {
      if (fullP.size !== truthP.size || fullB.size !== truthB.size) drift++;
      else for (const [idx, row] of truthP) {
        const got = fullP.get(idx);
        if (!got || Math.abs(got[0] - row[1] / 256) > 1e-9) { drift++; break; }
      }
    }
  }
  ok('reconstruction tracks the host across 400 ticks of churn', drift === 0, `${drift} divergences`);
  note(`${skipped} ticks were skipped for backpressure and resent intact`);
  ok('a skipped tick leaves nothing stranded', fullP.size === truthP.size && fullB.size === truthB.size,
    `${fullP.size}/${truthP.size} players, ${fullB.size}/${truthB.size} bots`);
}

function networkSyncTests() {
  group('phase twelve: ordered snapshots, terrain repair, and packet budgets');
  ok('a client starts only from a self-contained checkpoint',
    snapshotDisposition(null, 1, false).resync === true
      && snapshotDisposition(null, 1, true).accept === true);
  ok('duplicate and out-of-order state cannot roll a replica backward',
    snapshotDisposition(8, 8, false).reason === 'stale'
      && snapshotDisposition(8, 7, true).reason === 'stale');
  ok('a missing delta requests repair while a later full packet heals it',
    snapshotDisposition(8, 10, false).resync === true
      && snapshotDisposition(8, 10, true).accept === true);

  const log = [[10, 11, 12, 0], ['b', 20.5, 7, 9.25, 2.4], [1, 2, 3, 4]];
  let rolling = WORLD_HASH_SEED;
  for (const e of log) rolling = advanceWorldHash(rolling, e);
  ok('incremental and from-scratch terrain digests agree', rolling === worldLogHash(log));
  ok('terrain digest changes when an edit changes',
    worldLogHash(log) !== worldLogHash([[10, 11, 12, 1], ...log.slice(1)]));
  ok('world-event revisions accept exact appends and detect gaps',
    worldEventDisposition(4, 7, 3).accept
      && worldEventDisposition(4, 8, 3).resync);
  ok('duplicate world edits are idempotently rejected',
    worldEventDisposition(7, 7, 1).reason === 'stale');

  const packets = Array.from({ length: 20 }, (_, q) => ({ q: q + 1 }));
  const impairedA = impairPackets(packets,
    { seed: 99, dropRate: 0.2, duplicateRate: 0.25, reorderWindow: 4 });
  const impairedB = impairPackets(packets,
    { seed: 99, dropRate: 0.2, duplicateRate: 0.25, reorderWindow: 4 });
  ok('packet impairment is deterministic for reproducible soak failures',
    JSON.stringify(impairedA) === JSON.stringify(impairedB));
  ok('the impairment harness exercises loss, duplication, or reordering',
    JSON.stringify(impairedA) !== JSON.stringify(packets));

  // Two independent client replicas: B receives every delta; A loses q2,
  // refuses unsafe q3, then converges through q4's full checkpoint.
  const full = row => ({ t: 's', p: [row], b: [], c: [0, 0], g: [],
    q: 1, full: 1, wr: 0, wh: WORLD_HASH_SEED });
  const row1 = [0, qx(10), qy(4), qx(10), qa(0), 100, 1, 0, 0, 50, 0, 3];
  const row2 = [0, qx(12), qy(4), qx(10), qa(0), 100, 1, 0, 0, 50, 0, 3];
  const row3 = [0, qx(14), qy(4), qx(10), qa(0), 95, 1, 0, 0, 50, 0, 3];
  const aP = new Map(), aB = new Map(), bP = new Map(), bB = new Map();
  mergeSnapshot(aP, aB, full(row1)); mergeSnapshot(bP, bB, full(row1));
  mergeSnapshot(bP, bB, { ...full(row2), q: 2, full: 0 });
  const lost = snapshotDisposition(1, 3, false);
  if (snapshotDisposition(2, 3, false).accept)
    mergeSnapshot(bP, bB, { ...full(row3), q: 3, full: 0 });
  if (lost.accept) mergeSnapshot(aP, aB, { ...full(row3), q: 3, full: 0 });
  if (snapshotDisposition(1, 4, true).accept) {
    aP.clear(); aB.clear(); mergeSnapshot(aP, aB, { ...full(row3), q: 4 });
  }
  ok('two-client loss harness converges through a full checkpoint',
    aP.get(0)[0] === bP.get(0)[0] && aP.get(0)[4] === bP.get(0)[4]);

  ok('wire-byte accounting measures UTF-8 payloads',
    wireBytes({ t: 'e', text: 'voxel ★' }) > 20);
  const net = new Net();
  let sent = 0;
  net.conns = new Map([['p', { open: true, dataChannel: { bufferedAmount: 32 }, send: () => sent++ }]]);
  net.sendTo('p', { t: 'e', k: 'hit' });
  const stats = net.stats(net.telemetry.startedAt + 1000);
  ok('network telemetry records packets, bytes, rate, and queue depth',
    sent === 1 && stats.sentPackets === 1 && stats.sentBytes > 0
      && Math.abs(stats.sentBytesPerSecond - stats.sentBytes) < 0.001
      && stats.peakBuffered === 32);
  ok('bounded world-sync payload passes the server trust boundary',
    validServerMessage({ t: 'sync', seed: 1, map: 0, log, wr: log.length,
      wh: worldLogHash(log) }));
  ok('world-sync revision must match its payload exactly',
    !validServerMessage({ t: 'sync', seed: 1, map: 0, log, wr: log.length + 1,
      wh: worldLogHash(log) }));
}

function securityPhaseTests() {
  group('phase thirteen: host authority and measured anti-cheat');
  ok('combat action sequences accept monotonic input and reject replay',
    actionSequenceDisposition(4, 5).accept
      && actionSequenceDisposition(5, 5).reason === 'replay'
      && actionSequenceDisposition(5, 4).reason === 'replay');
  ok('sequence gaps remain recoverable without accepting an old action',
    actionSequenceDisposition(5, 8).accept
      && actionSequenceDisposition(5, 8).reason === 'gap');
  ok('secured actions require a bounded sequence number at the protocol edge',
    validClientMessage({ t: 'a', k: 'reload', n: 1 })
      && !validClientMessage({ t: 'a', k: 'reload' })
      && !validClientMessage({ t: 'a', k: 'shoot', n: 0, d: [1, 0, 0] }));
  ok('room handshakes require the current protocol generation',
    validClientMessage({ t: 'hi', v: PROTOCOL_VERSION, name: 'Ada' })
      && !validClientMessage({ t: 'hi', v: PROTOCOL_VERSION - 1, name: 'Ada' })
      && validServerMessage({ t: 'version', v: PROTOCOL_VERSION }));

  const rifle = TOOLS[0];
  let weapon = { ammo: 2, reloadUntil: 0, lastShotAt: -Infinity };
  const first = authorizeWeaponFire(weapon, rifle, 1);
  const tooFast = authorizeWeaponFire(first.state, rifle, 1.05);
  const second = authorizeWeaponFire(first.state, rifle, 2);
  ok('host weapon authority consumes ammunition and enforces cadence',
    first.ok && first.state.ammo === 1 && tooFast.reason === 'cadence'
      && second.ok && second.state.ammo === 0);
  ok('an empty authoritative magazine cannot create damage',
    authorizeWeaponFire(second.state, rifle, 3).reason === 'empty');
  const loading = authorizeReload(second.state, rifle, 3);
  ok('reload completion is host-timed rather than client-declared', loading.ok
    && settleReload(loading.state, rifle, 3.5).ammo === 0
    && settleReload(loading.state, rifle, 3 + rifle.reload).ammo === rifle.mag);

  ok('body-facing validation permits real aim and catches a backwards first shot',
    aimYawDelta(-Math.PI / 2, [1, 0, 0]) < 1e-9
      && aimYawDelta(-Math.PI / 2, [-1, 0, 0]) > 3);
  let integrity = null;
  integrity = recordIntegrityViolation(integrity, 'lag-spike', 2, 0);
  const cooled = recordIntegrityViolation(integrity, 'late-packet', 0.5, 10);
  ok('isolated violations decay and never cause a false-positive disconnect',
    integrity.action !== 'disconnect' && cooled.score < integrity.score);
  let sustained = null;
  for (let i = 0; i < 12; i++)
    sustained = recordIntegrityViolation(sustained, 'impossible-move', 2, i * 0.01);
  ok('sustained impossible input reaches the disconnect threshold',
    sustained.action === 'disconnect' && sustained.total === 12);

  const securedRow = [0, qx(10), qy(4), qx(10), qa(0), 100, 1, 0, 0, 50, 0, 3, 7, 900, 5];
  const p = new Map(), b = new Map();
  mergeSnapshot(p, b, { p: [securedRow], b: [] });
  ok('authoritative ammo, reload time, and class survive snapshot reconstruction',
    p.get(0)[11] === 7 && p.get(0)[12] === 900 && p.get(0)[13] === 5);
}

function releasePhaseTests() {
  group('phase fourteen: release budgets, lifecycle, and ten-client soak');
  ok('runtime percentiles are stable and ignore non-finite samples',
    percentile([5, 10, 15, NaN, 20], 0.95) === 15);
  const healthy = evaluateReleaseBudgets({ frameP95Ms: 16, longFrameRate: 0.01,
    drawCalls: 300, triangles: 300000, particles: 100, networkBytesPerSecond: 12000 });
  const overloaded = evaluateReleaseBudgets({ frameP95Ms: 60, longFrameRate: 0.2,
    drawCalls: 1200, triangles: 2e6, particles: 2200, networkBytesPerSecond: 200000 });
  ok('release budgets distinguish healthy and overloaded frames', healthy.pass && !overloaded.pass);
  const monitor = new RuntimeHealth(60);
  for (let i = 0; i < 60; i++) monitor.frame(i < 58 ? 16 : 70);
  const report = monitor.snapshot({ drawCalls: 200, triangles: 200000,
    particles: 50, networkBytesPerSecond: 8000 });
  ok('rolling diagnostics expose p95, long-frame rate, and budget status',
    report.sampledFrames === 60 && report.frameP95Ms === 16
      && report.longFrameRate > 0 && report.budget.pass);
  const drift = resourceDrift({ geometries: 300, textures: 2 },
    { geometries: 304, textures: 2 });
  ok('resource lifecycle drift identifies growth by category',
    drift.geometries === 4 && drift.textures === 0);

  // Ten replicas run through deterministic loss/reordering pressure. Any
  // unsafe delta is refused; a periodic full checkpoint repairs it. The last
  // full packet must leave every client on identical authoritative state.
  const clients = Array.from({ length: 10 }, () => ({ last: null, p: new Map(), b: new Map() }));
  let truth = null;
  for (let q = 1; q <= 600; q++) {
    const row = [0, qx(q / 10), qy(4), qx(20), qa(q / 50), 100 - (q % 20),
      1, 0, 0, 50, 0, 3, 10 - (q % 10), 0];
    truth = row;
    const full = q === 1 || q % 30 === 0 || q === 600;
    for (let i = 0; i < clients.length; i++) {
      if (!full && ((q * 17 + i * 31) % 97 < 4)) continue; // deterministic 4% loss
      const c = clients[i], order = snapshotDisposition(c.last, q, full);
      if (!order.accept) continue;
      if (full) { c.p.clear(); c.b.clear(); }
      mergeSnapshot(c.p, c.b, { p: [row], b: [] });
      c.last = q;
    }
  }
  ok('ten-client impairment soak converges at the final checkpoint', clients.every(c =>
    c.last === 600 && c.p.get(0)?.[0] === truth[1] / 256
      && c.p.get(0)?.[4] === truth[5]));
  ok('a worst-case ten-player snapshot stays inside the wire budget',
    wireBytes({ t: 's', q: 1, full: 1, wr: 0, wh: WORLD_HASH_SEED,
      p: Array.from({ length: 10 }, (_, i) => [i, ...truth.slice(1)]),
      b: Array.from({ length: 10 }, (_, i) => [i, 0, 0, 0, 0, 100, 1, 0, 0]),
      c: [0, 0], g: [] }) < 16 * 1024);

  const lifecycleScene = scene();
  const baselineChildren = lifecycleScene.children.length;
  for (let i = 0; i < 3; i++) {
    const world = new VoxelWorld(lifecycleScene);
    generateMap(world, 1400 + i, i);
    world.configureAtmosphere(i);
    world.dispose();
  }
  ok('three full map lifecycles release every scene attachment',
    lifecycleScene.children.length === baselineChildren,
    `${lifecycleScene.children.length - baselineChildren} leaked scene nodes`);
}

export async function run() {
  collapseTests();
  wireTests();
  networkSyncTests();
  securityPhaseTests();
  releasePhaseTests();
  audioPaletteTests();
  mapgenTests();
  raycastTests();
  meshingTests();
  hostileInputTests();
  multiplayerRuleTests();
  botRuleTests();
  pacingRuleTests();
  contributionRuleTests();
  kothRuleTests();
  streakRuleTests();
  fieldStationTests();
  matchReportTests();
  socialProgressionTests();
  engagementFoundationTests();
  firstMinuteTests();
  voxelStoryTests();
  deathRecapTests();
  selectedGoalTests();
  stayAsSquadTests();
  teamBalanceTests();
  operationTests();
  damageDirectionTests();
  airstrikeDroneTests();
  soldierModelTests();
  bodyTests();
  environmentalDamageTests();
  timings();
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(fail ? '\nRegression failures remain.\n' : '\nAll green.\n');
  return fail ? 1 : 0;
}
