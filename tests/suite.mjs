// tests/suite.mjs — assertions over the modules that do not touch the DOM:
// world.js (storage, meshing, raycast, carve), mapgen.js, entities.js (Body).
//
// Browser/DOM orchestration in Player and main.js is covered by browser smoke
// tests. Pure multiplayer authority rules are kept in multiplayer.js so this
// suite can exercise them headlessly.
import * as THREE from 'three';
import crypto from 'node:crypto';
import { VoxelWorld, SX, SY, SZ, SEA, PALETTE, BLOCK } from '../src/world.js';
import { generateMap, MAPS, BASE, mapsForMode } from '../src/mapgen.js';
import { Body, CROUCH_HEIGHT, EYE_INSET, STAND_HEIGHT,
  animateSoldier, disposeObject, makeMq9Drone, makeSoldier,
  setCrouch, setSoldierTool } from '../src/entities.js';
import { airstrikeDronePose, mergeSnapshot, qx, qy, qa, relativeBearing } from '../src/game.js';
import { Avatar } from '../src/avatar.js';
import { placedBlockColor } from '../src/player.js';
import { chooseTeam, combatDamageAllowed, migrationSurvivors, normalizeDirection,
  parseSpawnRow, protectedBuildReason, spawnRow, validateMovementReport } from '../src/multiplayer.js';
import { validClientMessage, validPong, validServerMessage } from '../src/protocol.js';
import { allowInbound, shouldSend } from '../src/net.js';
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
  OVERCHARGE_WINDUP, availableStreakAbility, gainStreak, overchargeDamage,
  spendStreak, stepOvercharge } from '../src/streaks.js';
import { FIELD_STATION_BLOCK_CAP, FIELD_STATION_CAPTURE_TIME,
  FIELD_STATION_COOLDOWN, applyFieldSupply, nearestFieldStation,
  stationCanSupply, stepFieldStation } from '../src/field-stations.js';
import { buildMatchReport, medalAwards, updatePersonalBests } from '../src/match-report.js';
import { masteryProgress } from '../src/mastery.js';
import { rematchVotesNeeded, validPingDirection } from '../src/social.js';

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
    validClientMessage({ t: 'hi', name: 'Ada', team: null }));
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
  const migratedWelcome = { t: 'w', id: 'peer', team: 'green', seed: 1, map: 0,
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
  group('phase ten: squad signals, rematches, and cosmetic mastery');
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
  ok('mastery tier boundaries award only cosmetic band counts',
    masteryProgress(999).tier.bands === 0
      && masteryProgress(1000).tier.bands === 1
      && masteryProgress(40000).tier.bands === 4);
  ok('mastery reports progress to the next tier',
    masteryProgress(4900).remaining === 100 && masteryProgress(5000).tier.name === 'VETERAN');
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
    validClientMessage({ t: 'a', k: 'strike', x: 100, z: 120, yaw: 0 })
      && !validClientMessage({ t: 'a', k: 'strike', x: 100, z: 120 }));
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

  ok('ordinary jumps and short drops remain safe', fallDamageForImpact(13) === 0);
  ok('medium falls cause non-lethal damage', fallDamageForImpact(24) > 0
    && fallDamageForImpact(24) < 100);
  ok('a fatal-speed impact reaches full health', fallDamageForImpact(33) === 100);
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
// Grounding check for structural collapse, isolated from Game (which needs a
// DOM). Mirrors _collapseFrom's BFS so the shipped algorithm can be fuzzed
// against a straightforward per-component reference.
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
// The shipped algorithm: verdict map, early exit on reaching bedrock.
function collapseShipped(solid, holes, CAP = 4000) {
  const verdict = new Map(), doomed = new Set();
  for (const s of seedsFor(solid, holes)) {
    const sk = ckey(s.x, s.y, s.z);
    if (verdict.has(sk)) continue;
    const comp = new Set([sk]), q = [s];
    let grounded = false, settled = false;
    for (let i = 0; i < q.length && !settled; i++) {
      const c = q[i];
      if (c.y === 0 || comp.size > CAP) { grounded = true; break; }
      for (const d of DIRS6) {
        const x = c.x + d[0], y = c.y + d[1], z = c.z + d[2], k = ckey(x, y, z);
        if (comp.has(k) || !solid(x, y, z)) continue;
        const known = verdict.get(k);
        if (known !== undefined) { grounded = known; settled = true; break; }
        comp.add(k); q.push({ x, y, z });
      }
    }
    for (const k of comp) verdict.set(k, grounded);
    if (!grounded) for (const k of comp) doomed.add(k);
  }
  return doomed;
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

export async function run() {
  collapseTests();
  wireTests();
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
