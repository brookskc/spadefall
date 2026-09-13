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
  clampToEnvelope, envelopeContains, mapEnvelope,
  PINEFALL_RAVINE_HALF_WIDTH, pinefallRavineCenter,
  pinefallRavineHeight, signatureMechanic, signatureProtectedAreas } from '../src/mapgen.js';
import { Body, CROUCH_HEIGHT, EYE_INSET, STAND_HEIGHT,
  animateSoldier, applySoldierGraphics, disposeObject, makeMq9Drone, makeSoldier,
  placeShadow, setCrouch, setSoldierTool, triggerSoldierFire,
  triggerSoldierHit } from '../src/entities.js';
import { Game, airstrikeDronePose, combatHistoryDue, hostHeartbeatMessage, mergeSnapshot, qx, qy, qa, relativeBearing,
  unsupportedCollapseCells } from '../src/game.js';
import { placedBlockColor, TOOLS } from '../src/player.js';
import { chooseTeam, combatDamageAllowed, migrationSurvivors, normalizeDirection,
  createMovementBudget, parseSpawnRow, protectedBuildReason, spawnRow, teamSizeForMode,
  validateMovementReport } from '../src/multiplayer.js';
import { PROTOCOL_VERSION, validClientMessage, validPong, validServerMessage } from '../src/protocol.js';
import { allowInbound, claimErrorKind, claimPeerChannel, ICE_FAILURE_CACHE_MS, Net, peerOptions, primeIce,
  probeErrorKind, PUBLIC_PAGES, PUBLIC_ROOMS, PUBLIC_SLOTS, publicPageSlots, resetIce,
  shouldSend, slotCode, usableIceServers, wireBytes, withinWireBudget } from '../src/net.js';
import turnWorker, { handleRequest as handleTurnRequest, originAllowed,
  validDiagnosticsEnvelope } from '../worker/src/index.js';
import { WORLD_HASH_SEED, advanceWorldHash, impairPackets, snapshotDisposition,
  worldEventDisposition, worldLogHash } from '../src/network-sync.js';
import { actionSequenceDisposition, aimYawDelta, authorizeReload,
  authorizeWeaponFire, recordIntegrityViolation, settleReload } from '../src/security.js';
import { RuntimeHealth, evaluateReleaseBudgets, percentile,
  resourceDrift } from '../src/runtime-health.js';
import { modeScoreLimit } from '../src/match-modes.js';
import { nextBattleChoices, resolveBattleVote, validBattleChoice,
  validBattleChoices } from '../src/next-battle.js';
import { PresentationSchedule } from '../src/presentation.js';
import { AUDIO_QA_CONTRACT, SOUND_META, reloadPitch, sfx, spatialAudioMix, spatialVerticality,
  voxelSurface } from '../src/audio.js';
import { DEFAULT_BINDINGS, bindingConflicts, normalizeBindings } from '../src/controls.js';
import { captionFromMix } from '../src/captions.js';
import { nextReloadCue } from '../src/reload-timeline.js';
import { BREATH_MAX, DROWN_DAMAGE, fallDamageForImpact,
  impactSpeedForFallDistance, stepBreath } from '../src/environment.js';
import { BOT_DIFFICULTY, assignBotRoles, botDifficulty,
  botSeparation, botsForSquadOrder, botTargetScore,
  botTelemetrySummary, botTerrainEditAllowed, BOT_LIFE_EDIT_BUDGET,
  chooseLocalRoute, ctfFinalApproachPolicy, hillPost, rememberedEnemyPosition,
  smgClosingIntent,
  scheduleBotBrains } from '../src/bot-rules.js';
import { authoredRouteGoal, crownRouteWaypoint, ctfApproachSupportDistance,
  ctfCarrierWaypoint, greenbeltOpeningRally, laned, pinefallCarrierFordCommitted } from '../src/bot-navigation.js';
import { Bot } from '../src/bots.js';
import { acquireTarget, heardFoe } from '../src/bot-combat.js';
import { CTF_SPAWN, FLAG_RETURN_TIME, KOTH_SPAWN, TDM_SPAWN, ctfAnchorAllowed,
  ctfFrontlineAllowed, ctfMedianForwardProgress, ctfObjectiveKind, ctfWaveProgress,
  kothAnchorAllowed, kothApproachDepth, kothCandidateDirectionalAllowed,
  kothMedianApproachDepth, kothWaveApproachDepth, modeMatchSeconds,
  regulationDecision, respawnWaveDelay, tacticalSpawnScore, tdmAnchorAllowed,
  tdmForwardProgress, tdmMedianForwardProgress, tdmTerritoryAllowed,
  tdmWaveProgress } from '../src/pacing.js';
import { assistCreditors, CONTRIBUTION, contributionRow, rankContributionRows } from '../src/scoring.js';
import { HILL_ACTIVE_TIME, HILL_MOVE_WARNING, nextHillIndex,
  occupiedScoringTeam, stepHillCapture, stepHillRotation } from '../src/koth.js';
import { AIRSTRIKE_COST, availableStreakAbility, gainStreak,
  spendStreak, chooseBotAirstrikeTarget, predictBotAirstrikePoint,
  steerBotAirstrike } from '../src/streaks.js';
import { buildMatchReport, medalAwards, updatePersonalBests } from '../src/match-report.js';
import { masteryProgress } from '../src/mastery.js';
import { staySquadGroups, staySquadState, voteKickVotesNeeded,
  validPingDirection } from '../src/social.js';
import { callsignHasProfanity, callsignIssue, normalizeCallsign,
  sanitizeCallsign, sanitizeDisplayName } from '../src/callsign.js';
import { DEFAULT_ENGAGEMENT_FEATURES, EngagementTracker, parseEngagementFeatures,
  sanitizeEngagementEvent } from '../src/engagement.js';
import { balanceHumanTeams, TEAM_REASSIGNMENT_COST } from '../src/team-balance.js';
import { FirstMinuteGuide, firstMinuteObjective,
  firstMinuteTerrainCue, firstMinuteMoveHint, consumeTerrainAck,
  clearAckedTerrainActions } from '../src/first-minute.js';
import { keyboardMouseUnsupported } from '../src/device-support.js';
import { VoxelStoryTracker, normalizeVoxelStoryMetrics, validVoxelStoryMetrics,
  voxelBattleStory } from '../src/voxel-stories.js';
import { deathRecapCopy, makeDeathRecap, validDeathRecap } from '../src/death-recap.js';
import { autoSprint, contactCue, ctfEscalation, intensityCue, nextBotDifficulty,
  normalizeSpecialties, topSpecialty, usefulVoxelAction } from '../src/combat-flow.js';
import { MAX_REWIND_SECONDS, observeSnapshotRtt, recordPose,
  rewindSecondsForRtt, samplePose } from '../src/lag-compensation.js';
import { createResumeToken, reservationMatches, validResumeToken } from '../src/reconnect.js';
import { FirstSessionGraphicsBenchmark, automaticGraphicsLevel } from '../src/performance-auto.js';
import { atmosphereCadence } from '../src/settings.js';
import { ProductionTelemetry, errorFingerprint, sanitizeTelemetryEvent,
  telemetryEnvelope } from '../src/telemetry.js';
import { chooseSpawn } from '../src/spawn-controller.js';
import { ctfFlagInteraction } from '../src/objectives.js';
import { advanceMatchClock } from '../src/match-lifecycle.js';
import { contentAvailable, publicContentAvailable } from '../src/content-gating.js';
import { TERRAIN_CONTRACTS, applyTerrainAction, contractSnapshot,
  decorateCallsign, normalizeBadges, normalizeContractProgress,
  normalizeSelectedBadge } from '../src/contracts.js';

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

function combatFlowTests() {
  group('combat flow: bounded pressure, escalation, and recognition');
  ok('auto sprint requires a grounded forward commitment and preserves controlled strafing',
    autoSprint({ forward: true, grounded: true, held: .25 })
      && !autoSprint({ forward: true, grounded: true, held: .24 })
      && !autoSprint({ forward: true, grounded: true, held: 1, strafe: true })
      && autoSprint({ forward: true, grounded: true, shift: true, strafe: true }));
  ok('contact cue only uses already credible public candidates and has cooldown-safe state',
    contactCue({ alive: true, lastAction: 0 }, 12, [{ kind: 'intel', x: 4, z: 8 }])?.label === 'CONTACT REPORTED'
      && contactCue({ alive: true, lastAction: 0, lastCue: 5 }, 12, [{ kind: 'intel', x: 4, z: 8 }]) === null);
  ok('CTF escalation is symmetric, bounded, and reverts to ordinary return timing',
    ctfEscalation({ progressAt: 0 }, 82).returnTime === 12
      && ctfEscalation({ active: true, progressAt: 80 }, 81).frontlineBonus === 8
      && !ctfEscalation({ active: true, progressAt: 0 }, 90, true).active
      && ctfEscalation({}, 0).returnTime === 15);
  ok('voxel recognition rejects meaningless edits and classifies only useful work',
    usefulVoxelAction({ type: 'dig', changedPassability: true }) === 'PATH CLEARED'
      && usefulVoxelAction({ type: 'build', bridgedGap: true }) === 'ROUTE BUILT'
      && usefulVoxelAction({ type: 'build' }) === null);
  const specialties = normalizeSpecialties({ smg: 12, terrain: -9, objective: 4e9 });
  ok('sideways specialties migrate with finite bounds and expose one concise best discipline',
    specialties.terrain === 0 && specialties.objective === 999999 && topSpecialty(specialties) === 'objective');
  ok('intensity cues are one-shot thresholds rather than a permanent HUD layer',
    intensityCue({ mode: 'tdm', green: 40, blue: 35 })?.id === 'final-ten'
      && intensityCue({ mode: 'tdm', green: 40, blue: 35, fired: ['final-ten'] }) === null
      && intensityCue({ mode: 'koth', remaining: 30 })?.id === 'last-thirty');
  ok('between-round bot cognition moves at most one authored profile',
    nextBotDifficulty('normal', { margin: 500, humanScore: 900, medianScore: 400 }) === 'hard'
      && nextBotDifficulty('hard', { margin: 500, humanScore: 900, medianScore: 400 }) === 'hard'
      && nextBotDifficulty('normal', { margin: -500, humanScore: 100, medianScore: 400 }) === 'easy');
  ok('footstep verticality stays subtle and directionally distinct',
    spatialVerticality(8, 10).vertical === 'above'
      && spatialVerticality(-8, 10).vertical === 'below'
      && spatialVerticality(0, 10).pitch === 1);
  const row = contributionRow({ specialties: { sniper: 3, terrain: 2 } });
  ok('authoritative contribution rows retain sideways specialty counts',
    row.specialties.sniper === 3 && row.specialties.terrain === 2);
}
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
  let beachSurfaceCounts = null;
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
    const envelope = mapEnvelope(m);
    const width = envelope.maxX - envelope.minX;
    const depth = envelope.maxZ - envelope.minZ;
    const ctfFamily = MAPS[m].modes.includes('ctf');
    ok(`${name}: exposes a valid combat envelope`,
      envelopeContains(envelope, SX / 2, SZ / 2)
        && envelope.minX >= 0 && envelope.minZ >= 0
        && envelope.maxX <= SX && envelope.maxZ <= SZ,
      JSON.stringify(envelope));
    ok(`${name}: has the expected authored combat dimensions`,
      ctfFamily
        ? width === 224 && depth === 160 && envelope.shape === 'rect'
        : width === 192 && depth === 192 && envelope.shape === 'ellipse',
      `${width}x${depth}`);
    for (const team of ['green', 'blue'])
      ok(`${name}: ${team} base stays inside its combat envelope`,
        envelopeContains(envelope, BASE[team].x, BASE[team].z, 2));
    if (envelope.kind === 'shore') {
      ok(`${name}: outer band resolves to a natural water boundary`,
        a.surface(envelope.minX - 6, SZ / 2) < SEA
          && a.surface(SX / 2, envelope.minZ - 6) < SEA);
    } else {
      const westRidge = a.surface(envelope.minX + 1, SZ / 2);
      const westOutside = a.surface(envelope.minX - 2, SZ / 2);
      const northRidge = a.surface(SX / 2, envelope.minZ + 1);
      const northOutside = a.surface(SX / 2, envelope.minZ - 2);
      ok(`${name}: rounded rim rises above its exterior rather than opening a perimeter lane`,
        westRidge >= SEA + 20 && northRidge >= SEA + 20
          && westRidge - westOutside >= 5 && northRidge - northOutside >= 5,
        `west=${westRidge}/${westOutside}, north=${northRidge}/${northOutside}`);
    }
    if (ctfFamily) {
      const flankNorth = a.surface(SX / 2, 76);
      const flankSouth = a.surface(SX / 2, 180);
      const central = a.surface(SX / 2, SZ / 2);
      ok(`${name}: center and both flank approach samples remain traversable`,
        central >= SEA - 1 && flankNorth >= SEA && flankSouth >= SEA,
        `center=${central}, north=${flankNorth}, south=${flankSouth}`);
    }
    if (m === 1) {
      beachSurfaceCounts = new Map();
      for (let z = 24; z < SZ - 24; z++)
        for (let x = 48; x < SX - 24; x++) {
          const block = a.get(x, a.surface(x, z), z);
          beachSurfaceCounts.set(block, (beachSurfaceCounts.get(block) ?? 0) + 1);
        }
    }

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
    if (m === 5) {
      const hills = MAPS[m].hills;
      const clear = hills.every(h => {
        const footprint = [];
        for (let z = h.z - 14; z <= h.z + 14; z++)
          for (let x = h.x - 14; x <= h.x + 14; x++) {
            if (Math.hypot(x - h.x, z - h.z) > 14) continue;
            const y = a.surface(x, z);
            if (Math.hypot(x - h.x, z - h.z) <= h.r) footprint.push(y);
            if (a.get(x, y + 1, z) !== 0 || a.get(x, y + 2, z) !== 0) return false;
          }
        return Math.max(...footprint) === Math.min(...footprint);
      });
      ok('CALDERA rotating objectives retain clear, gently level 10-block footprints and aprons', clear);
      const mirroredRoutes = hills.every(h => {
        const west = a.surface(76, h.z), east = a.surface(180, h.z);
        return Math.abs(west - east) <= 1 && west <= SEA + 15 && east <= SEA + 15;
      });
      ok('CALDERA has mirrored, walkable base-facing ramp cuts for every rotating hill', mirroredRoutes);
    }
    if (m === 6) {
      const samples = [[64, 92], [92, 128], [128, 64], [160, 96]];
      const highPair = [[93, 146], [162, 109]];
      const pairOccupancy = highPair.every(([x, z], i) => {
        const mirror = highPair[1 - i];
        return [1, 2, 3].every(y => (a.get(x, SEA + 8 + y, z) !== 0)
          === (a.get(mirror[0], SEA + 8 + y, mirror[1]) !== 0));
      });
      const weakWallPair = [111, 144].every(z =>
        [120, 128, 136].every(x => a.get(x, SEA + 9, z) !== 0));
      ok('FOUNDRY keeps seeded terrain rotationally symmetric at route samples',
        samples.every(([x, z]) => a.surface(x, z) === a.surface(SX - 1 - x, SZ - 1 - z))
          && pairOccupancy && weakWallPair);
    }
    if (m === 7) {
      const labels = MAPS[m].hills.map(h => h.label);
      const level = MAPS[m].hills.every(h => {
        const values = [];
        for (let z = h.z - h.r; z <= h.z + h.r; z++)
          for (let x = h.x - h.r; x <= h.x + h.r; x++)
            if (Math.hypot(x - h.x, z - h.z) <= h.r) values.push(a.surface(x, z));
        return values.length > 0 && new Set(values).size === 1;
      });
      ok('FAULTLINE orders four clear level hills north/west/south/east',
        JSON.stringify(labels) === '["NORTH","WEST","SOUTH","EAST"]' && level);
    }
    let bad = 0;
    for (let i = 0; i < a.data.length; i++) if (a.data[i] >= PALETTE.length) bad++;
    ok(`${name}: every voxel indexes PALETTE`, bad === 0, `${bad} out of range`);
  }
  ok('all eight maps are distinct', new Set(hashes).size === MAPS.length);
  const bounded = clampToEnvelope(mapEnvelope(0), -50, SZ + 50, 5);
  ok('combat-envelope clamp keeps bot/spawn samples inside the requested inset',
    envelopeContains(mapEnvelope(0), bounded.x, bounded.z, 5), JSON.stringify(bounded));
  const arenaBounded = clampToEnvelope(mapEnvelope(3), -50, SZ + 50, 5);
  ok('rounded-arena clamp projects corner samples onto the playable ellipse',
    envelopeContains(mapEnvelope(3), arenaBounded.x, arenaBounded.z, 5),
    JSON.stringify(arenaBounded));
  ok('BEACHHEAD exposes broad sand, earth, grass, scrub, and rock surface zones',
    [BLOCK.SAND, BLOCK.DIRT, BLOCK.GRASS, BLOCK.MOSS, BLOCK.STONE]
      .every(block => (beachSurfaceCounts?.get(block) ?? 0) >= 100),
    JSON.stringify(Object.fromEntries(beachSurfaceCounts ?? [])));
  ok('mapsForMode(ctf) = [0,1,2]', JSON.stringify(mapsForMode('ctf')) === '[0,1,2]');
  ok('mapsForMode(koth) retains private DUNES/CROWN and public CALDERA/FAULTLINE',
    JSON.stringify(mapsForMode('koth')) === '[3,4,5,7]');
  ok('CALDERA is KOTH-only while TDM retains its other maps',
    JSON.stringify(MAPS[5].modes) === '["koth"]'
      && JSON.stringify(mapsForMode('tdm')) === '[0,1,2,3,4,6]',
    JSON.stringify(mapsForMode('tdm')));
  ok('public rotation excludes CTF and private DUNES/CROWN',
    JSON.stringify(mapsForMode('ctf', { publicOnly: true })) === '[]'
      && JSON.stringify(mapsForMode('koth', { publicOnly: true })) === '[5,7]'
      && JSON.stringify(mapsForMode('tdm', { publicOnly: true })) === '[0,1,2,6]'
      && !mapsForMode('tdm', { publicOnly: true }).includes(3)
      && !mapsForMode('tdm', { publicOnly: true }).includes(4));
  ok('private content requires its explicit feature outside public paths',
    !publicContentAvailable('ctf', 0) && !publicContentAvailable('tdm', 4)
      && !contentAvailable('ctf', 0, { privateContent: false })
      && contentAvailable('ctf', 0, { privateContent: true })
      && !contentAvailable('ctf', 0, { publicOnly: true, privateContent: true }));
  const legacyPublicRoom = {
    publicRoom: true, gameMode: 'ctf', mapIndex: 0, privateContent: false,
    _nextMap: Game.prototype._nextMap,
    _restartRound: (map) => { legacyPublicRoom.rotatedTo = map; },
  };
  const legacyNextMap = legacyPublicRoom._nextMap();
  Game.prototype._rotate.call(legacyPublicRoom);
  ok('legacy public CTF has a safe next-map preview and rotates to public TDM',
    legacyNextMap === 0 && legacyPublicRoom.gameMode === 'tdm'
      && legacyPublicRoom.rotatedTo === 1);
  const rejectedWelcomes = [];
  const guardedPublicClient = Object.assign(Object.create(Game.prototype), {
    publicRoom: true, gameMode: 'tdm', mapIndex: 0,
    onPublicContentRejected: welcome => rejectedWelcomes.push(welcome),
  });
  Game.prototype.clientOnData.call(guardedPublicClient, {
    t: 'w', id: 'peer', team: 'green', seed: 1, map: 0, mode: 'ctf', me: 0,
    life: 1, spawn: [10, 20, 30, 0], log: [], r: { p: [], b: [] },
  });
  ok('public clients reject a stale private-content welcome before state mutation',
    rejectedWelcomes.length === 1 && guardedPublicClient.gameMode === 'tdm'
      && guardedPublicClient.mapIndex === 0 && guardedPublicClient.myId === undefined);
  ok('every map has a complete authored flat-color terrain palette',
    MAPS.every(m => ['grass', 'dirt', 'sand', 'stone', 'moss']
      .every(material => Number.isInteger(m.paletteOverrides?.[material]))));
  ok('all eight map atmospheres have distinct sky gradients',
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

  ok('signature metadata ships all eight active mechanics with fallbacks',
    ['greenbelt', 'beachhead', 'pinefall', 'dunes', 'crown', 'caldera', 'foundry', 'faultline'].every((key, i) => {
      const mechanic = signatureMechanic(i);
      return mechanic?.id === key && mechanic.fallbacks.length >= 2;
    }));

  const greenSignature = new VoxelWorld(scene());
  generateMap(greenSignature, 12345, 0);
  ok('GREENBELT has staggered thick belts, thin cut points, and open flanks',
    greenSignature.get(103, 31, 128) === BLOCK.STONE
      && greenSignature.get(103, 26, 116) === BLOCK.STONE
      && greenSignature.get(103, 27, 116) === 0
      && greenSignature.get(103, 32, 80) === 0);

  const pineSignature = new VoxelWorld(scene());
  generateMap(pineSignature, 12345, 2);
  const pineBridgeZ = Math.round(pinefallRavineCenter(12345, 128));
  ok('PINEFALL has a real bridge gap, protected ford, and clear headroom',
    pineSignature.get(120, SEA + 1, pineBridgeZ) !== 0
      && [126, 127, 128, 129].every(x => pineSignature.get(x, SEA + 1, pineBridgeZ) === 0)
      && pineSignature.get(128, SEA, pineBridgeZ + 8) === BLOCK.STONE
      && pineSignature.get(128, SEA + 1, pineBridgeZ + 8) === 0);

  const beachSignature = new VoxelWorld(scene());
  generateMap(beachSignature, 12345, 1);
  let beachWallColumns = 0;
  for (let z = 85; z <= 171; z++) {
    const raisedStone = [142, 143, 144, 145].some(x => {
      const top = beachSignature.surface(x, z);
      const shoulder = Math.max(beachSignature.surface(x - 2, z),
        beachSignature.surface(x + 2, z));
      return beachSignature.get(x, top, z) === BLOCK.STONE && top > shoulder;
    });
    if (raisedStone) beachWallColumns++;
  }
  const beachFallbacks = signatureProtectedAreas(1, 12345);
  ok('BEACHHEAD has three ordinary strongpoints and a damaged fortified line',
    signatureMechanic(1)?.id === 'beachhead'
      && beachFallbacks.length === 2
      // Enough connected silhouette to read as a line, enough missing
      // columns to expose several ordinary breach/fallback lanes.
      && beachWallColumns >= 30 && beachWallColumns <= 60
      && beachFallbacks.every(area => {
        const top = beachSignature.surface(area.x, area.z);
        return !beachSignature.get(area.x, top + 1, area.z)
          && !beachSignature.get(area.x, top + 2, area.z);
      }));
  const dunesSignature = new VoxelWorld(scene());
  generateMap(dunesSignature, 12345, 3);
  let mirroredCourt = true;
  for (let x = 94; x <= 108 && mirroredCourt; x++)
    for (let z = 103; z <= 113 && mirroredCourt; z++)
      // Compare the authored silhouette above the dune cap. Deep moss uses
      // world-space noise and is intentionally not mirror-painted.
      for (let y = SEA + 12; y < SY && mirroredCourt; y++)
        mirroredCourt = dunesSignature.get(x, y, z)
          === dunesSignature.get(SX - 1 - x, y, z);
  const supportZ = 105;
  const supportBase = supportX => {
    for (let y = 1; y < SY; y++)
      if (dunesSignature.get(supportX, y, supportZ) === BLOCK.STONE
          && dunesSignature.get(supportX, y - 1, supportZ) !== BLOCK.STONE
          && dunesSignature.get(supportX, y - 1, supportZ) !== 0) return y;
    return 0;
  };
  const supportX = 96, supportY = supportBase(supportX);
  const hole = { x: supportX, y: supportY, z: supportZ };
  const archCollapse = unsupportedCollapseCells((x, y, z) =>
    x === hole.x && y === hole.y && z === hole.z ? 0 : dunesSignature.get(x, y, z),
  [hole]);
  const mirrorX = SX - 1 - supportX, mirrorY = supportBase(mirrorX);
  const mirrorHole = { x: mirrorX, y: mirrorY, z: supportZ };
  const mirrorCollapse = unsupportedCollapseCells((x, y, z) =>
    x === mirrorHole.x && y === mirrorHole.y && z === mirrorHole.z
      ? 0 : dunesSignature.get(x, y, z), [mirrorHole]);
  const dunesFallbacks = signatureProtectedAreas(3, 12345);
  ok('DUNES courts are mirrored and one exposed footing drops a bounded half-arch',
    mirroredCourt && supportY > SEA && mirrorY === supportY
      && archCollapse.size >= 8 && archCollapse.size <= 32
      && mirrorCollapse.size === archCollapse.size
      && [...archCollapse].every(key => {
        const [x, , z] = key.split(',').map(Number);
        return Math.hypot(x - SX / 2, z - SZ / 2) > 9;
      })
      && dunesFallbacks.every(area => {
        const top = dunesSignature.surface(area.x, area.z);
        return !dunesSignature.get(area.x, top + 1, area.z)
          && !dunesSignature.get(area.x, top + 2, area.z);
      }), `${supportY}/${archCollapse.size}`);

  const crownSignature = new VoxelWorld(scene());
  generateMap(crownSignature, 12345, 4);
  ok('CROWN keeps east/west fallbacks and symmetric editable north/south spans',
    crownSignature.get(128, SEA + 8, 96) === BLOCK.STONE
      && crownSignature.get(124, SEA + 8, 96) === BLOCK.STONE
      && crownSignature.get(132, SEA + 8, 160) === BLOCK.STONE
      && crownSignature.get(128, SEA + 8, 160) === BLOCK.STONE
      && crownSignature.surface(96, 128) >= SEA
      && crownSignature.surface(160, 128) >= SEA);
  const crownSpanX = 128, crownSpanZ = 96, crownSpanY = SEA + 8;
  const spanBefore = crownSignature.get(crownSpanX, crownSpanY, crownSpanZ);
  crownSignature.set(crownSpanX, crownSpanY, crownSpanZ, 0);
  const spanBreached = crownSignature.get(crownSpanX, crownSpanY, crownSpanZ) === 0;
  crownSignature.set(crownSpanX, crownSpanY, crownSpanZ, BLOCK.STONE);
  ok('CROWN center span changes route occupancy and can be rebuilt',
    spanBefore === BLOCK.STONE && spanBreached
      && crownSignature.get(crownSpanX, crownSpanY, crownSpanZ) === BLOCK.STONE);

  const calderaSignature = new VoxelWorld(scene());
  generateMap(calderaSignature, 12345, 5);
  ok('CALDERA has thin north/south gates and open east/west saddles',
    calderaSignature.get(128, SEA + 16, 64) === BLOCK.STONE
      && calderaSignature.get(128, SEA + 16, 63) === 0
      && calderaSignature.get(128, SEA + 16, 192) === BLOCK.STONE
      && calderaSignature.get(128, SEA + 16, 191) === 0
      && calderaSignature.surface(64, 128) >= SEA
      && calderaSignature.surface(192, 128) >= SEA);

  const crownProtected = signatureProtectedAreas(4, 12345);
  ok('signature fallback foundations are protected while spans remain editable',
    protectedBuildReason(96, SEA + 8, 128, { signature: crownProtected }) === 'signature'
      && protectedBuildReason(128, SEA + 8, 96, { signature: crownProtected }) === null);
  const navProbe = {
    navRevision: 0, blockHits: new Map(), mode: 'solo', voxelStory: null,
    _protectedVoxelReason: () => null, _collapseFrom: () => {},
    world: { get: () => BLOCK.STONE, set: () => true },
  };
  Game.prototype.applyEdit.call(navProbe, 128, SEA + 8, 96, 0);
  ok('representative signature edits invalidate bot route caches', navProbe.navRevision === 1);

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

  const blast = slab();
  let rebuilds = 0;
  const originalBuildChunk = blast.buildChunk.bind(blast);
  blast.buildChunk = (...args) => { rebuilds++; return originalBuildChunk(...args); };
  blast.carve(96, 22, 96, 3);
  ok('explosions defer all remeshing to the shared dirty flush', rebuilds === 0);
  blast.flushDirty();
  ok('one explosion rebuilds each dirty chunk at most once', rebuilds > 0
    && rebuilds <= 9, `${rebuilds} chunks rebuilt`);

  const notifications = [];
  blast.onEdit = (x, z) => notifications.push(x + ',' + z);
  blast.batchEdits(() => {
    blast.set(80, 20, 80, 0);
    blast.set(80, 21, 80, 0);
    blast.set(80, 22, 80, 0);
  });
  ok('batched edits invalidate each minimap column once', notifications.length === 1);
}

// ---------------------------------------------------------------------------
function hostileInputTests() {
  group('malformed input reaching world.set / world.carve');
  const revisionWorld = new VoxelWorld(scene());
  const revisionStart = revisionWorld.revision;
  revisionWorld.set(10, 10, 10, BLOCK.STONE);
  const changedRevision = revisionWorld.revision;
  revisionWorld.set(10, 10, 10, BLOCK.STONE);
  ok('world revision advances only when voxel state changes',
    changedRevision === revisionStart + 1 && revisionWorld.revision === changedRevision);
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
  const carveRevision = w3.revision;
  try { removed = w3.carve(100, 25, 100, NaN); } catch (e) { carveThrew = e; }
  ok('carve() with a NaN radius is a no-op rather than a throw',
    !carveThrew && removed?.length === 0 && w3.revision === carveRevision);

  const w4 = new VoxelWorld(scene());
  generateMap(w4, 1, 0);
  const t0 = Date.now();
  const big = w4.carve(128, 30, 128, 40);
  const ms = Date.now() - t0;
  ok('carve() clamps an oversized radius', big.length < 5000, `${big.length} voxels`);
  note(`carve(r=40) was clamped and removed ${big.length} voxels in ${ms}ms`);

  const guarded = new VoxelWorld(scene());
  for (let x = 8; x <= 12; x++) guarded.data[(10 * SZ + 10) * SX + x] = BLOCK.STONE;
  const guardedRemoved = guarded.carve(10.5, 10.5, 10.5, 3,
    x => x !== 10);
  ok('carve() preserves protected route foundations while removing neighboring voxels',
    guarded.get(10, 10, 10) === BLOCK.STONE
      && guardedRemoved.length > 0
      && guardedRemoved.every(cell => cell.x !== 10));
}

// ---------------------------------------------------------------------------
function audioPaletteTests() {
  group('input, captions, and voxel audio');
  const defaults = normalizeBindings();
  ok('controls preserve default crouch bindings', defaults.crouch.includes('ControlLeft'));
  ok('controls normalize malformed binding storage', normalizeBindings({ aim: ['Mouse2', 9] }).aim.length === 1);
  ok('controls report binding conflicts', bindingConflicts(DEFAULT_BINDINGS, 'aim', 'KeyR').includes('reload'));
  const audible = spatialAudioMix('rifle', { x: 8, y: 1, z: 0 }, { x: 0, y: 1, z: 0, rx: 1, rz: 0 });
  ok('caption uses an audible final mix', captionFromMix('rifle', audible, 'full', 100)?.text.includes('RIGHT'));
  ok('caption suppresses unaudible and duplicate events', !captionFromMix('rifle', null, 'full', 100)
    && !captionFromMix('rifle', audible, 'full', 200, { name: 'rifle', at: 0 }));
  ok('reload timeline advances shared authored cue stages', nextReloadCue(1, .24)?.name === 'reloadEject'
    && nextReloadCue(2, .62)?.name === 'reloadInsert' && nextReloadCue(3, .86)?.name === 'reloadChamber');
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
  ok('audio QA contract protects staged reloads and critical-feedback priority',
    AUDIO_QA_CONTRACT.reloadStages.join(',') === '0.24,0.62,0.86'
      && AUDIO_QA_CONTRACT.reloadPitchCeiling === 330
      && SOUND_META.rifle.priority > SOUND_META.reloadStart.priority
      && SOUND_META.hit.priority === AUDIO_QA_CONTRACT.criticalPriority);
  const ear = { x: 0, y: 2, z: 0, rx: 1, rz: 0 };
  const clearShot = spatialAudioMix('rifle', { x: 12, y: 2, z: 0 }, ear);
  const blockedShot = spatialAudioMix('rifle', { x: 12, y: 2, z: 0 }, ear, true);
  const blockedBlast = spatialAudioMix('explosion', { x: 12, y: 2, z: 0 }, ear, true);
  ok('terrain occlusion softens positional sound without erasing combat information',
    clearShot.pan > 0.8 && blockedShot.scale < clearShot.scale
      && blockedShot.occlusionHz > 0 && blockedBlast.scale > blockedShot.scale);
  ok('quiet movement cues have a deliberately shorter readable range',
    spatialAudioMix('step', { x: 23, y: 2, z: 0 }, ear) !== null
      && spatialAudioMix('step', { x: 25, y: 2, z: 0 }, ear) === null
      && spatialAudioMix('rifle', { x: 25, y: 2, z: 0 }, ear) !== null);
  ok('combat confirmations and objectives use the UI bus and survive voice pressure',
    ['hit', 'headshot', 'kill', 'capture', 'danger'].every(name =>
      SOUND_META[name].category === 'ui' && SOUND_META[name].priority === 3));
}

// ---------------------------------------------------------------------------
function multiplayerRuleTests() {
  group('multiplayer authority rules');
  ok('public matchmaking exposes sixty-four rooms in eight-room probe pages',
    PUBLIC_SLOTS === 8 && PUBLIC_PAGES === 8 && PUBLIC_ROOMS === 64);
  const publicSlots = Array.from({ length: PUBLIC_PAGES }, (_, page) =>
    publicPageSlots(page)).flat();
  ok('public room pages cover every slot exactly once',
    publicSlots.length === PUBLIC_ROOMS
      && new Set(publicSlots).size === PUBLIC_ROOMS
      && publicSlots[0] === 0 && publicSlots.at(-1) === 63
      && slotCode(publicSlots.at(-1)) === 'PUB63');
  ok('invalid public room pages cannot fan out probes',
    publicPageSlots(-1).length === 0 && publicPageSlots(PUBLIC_PAGES).length === 0);
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
  const moveBudget = createMovementBudget();
  let budgetPos = prev;
  let burstAccepted = 0;
  for (let i = 0; i < 20; i++) {
    const next = { x: budgetPos.x + 0.3, y: 20, z: 10, yaw: 0 };
    const result = validateMovementReport(budgetPos, next, 0, undefined, moveBudget);
    if (!result.ok) break;
    budgetPos = next;
    burstAccepted++;
  }
  ok('same-frame reports share one capped movement budget', burstAccepted === 4,
    `${burstAccepted} burst reports accepted`);
  ok('movement credit refills from real elapsed time',
    validateMovementReport(budgetPos,
      { x: budgetPos.x + 0.9, y: 20, z: 10, yaw: 0 }, 0.1, undefined, moveBudget).ok);
  const stepBudget = createMovementBudget();
  ok('one voxel step-up fits the burst while a multi-block rise does not',
    validateMovementReport(prev, { x: 10, y: 21, z: 10, yaw: 0 }, 0,
      undefined, stepBudget).ok
      && validateMovementReport({ x: 10, y: 21, z: 10 },
        { x: 10, y: 23, z: 10, yaw: 0 }, 0, undefined, stepBudget).reason === 'vertical-rise');
  ok('zero-length action direction is rejected', normalizeDirection([0, 0, 0]) === null);
  const dir = normalizeDirection([3, 0, 4]);
  ok('action direction is normalized at the trust boundary',
    Math.abs(dir[0] - 0.6) < 1e-9 && Math.abs(dir[2] - 0.8) < 1e-9);
  ok('transported AUTO team preferences are accepted',
    validClientMessage({ t: 'hi', v: PROTOCOL_VERSION, name: 'Ada', team: null }));
  ok('null client messages are rejected without dispatch', !validClientMessage(null));
  ok('malformed state reports are rejected', !validClientMessage({ t: 's', x: NaN }));
  ok('protocol objects reject undeclared fields instead of silently carrying them',
    !validClientMessage({ t: 'ping', hidden: 'payload' })
      && !validServerMessage({ t: 'e', k: 'hit', kill: false, tier: null, hidden: 1 }));
  ok('wire budgets accept normal actions and reject oversized client payloads',
    withinWireBudget({ t: 'a', k: 'chat', text: 'hello', scope: 'all' })
      && !withinWireBudget({ t: 'a', k: 'chat', text: 'x'.repeat(3000), scope: 'all' }));
  const channels = new Map();
  const oldChannel = { peer: 'peer-1', open: true, closed: false,
    close() { this.closed = true; } };
  const newChannel = { peer: 'peer-1', open: true, close() {} };
  claimPeerChannel(channels, oldChannel);
  claimPeerChannel(channels, newChannel);
  ok('a peer id owns exactly one live channel', channels.get('peer-1') === newChannel
    && oldChannel.closed);
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
      rows: [['p0', 'Player', 'green', 2, 1, 325, 1, 4, 2, 0, 0, 4, 1]] })
      && !validServerMessage({ t: 'e', k: 'kd',
        rows: [['p0', 'Player', 'green', 2, 1, 'lots', 1, 4, 2, 0, 0, 4, 1]] }));
  ok('respawn preferences and intermission readiness are strict bounded actions',
    validClientMessage({ t: 'a', k: 'spawnpref', pref: 'base' })
      && validClientMessage({ t: 'a', k: 'ready' })
      && validClientMessage({ t: 'a', k: 'vote', choice: 2 })
      && validClientMessage({ t: 'a', k: 'done' })
      && !validClientMessage({ t: 'a', k: 'spawnpref', pref: 'enemy' })
      && !validClientMessage({ t: 'a', k: 'ready', fast: true })
      && !validClientMessage({ t: 'a', k: 'vote', choice: 3 })
      && !validClientMessage({ t: 'a', k: 'done', extra: true }));
  ok('ready rosters and headshot feedback are bounded server events',
    validServerMessage({ t: 'e', k: 'ready', voters: ['p0', 'p2'] })
      && validServerMessage({ t: 'e', k: 'choices',
        choices: [['tdm', 1], ['koth', 3], ['tdm', 2]], votes: [1, 0, 2], ready: ['p0'] })
      && !validServerMessage({ t: 'e', k: 'choices',
        choices: [['tdm', 1]], votes: [1], ready: [] })
      && validServerMessage({ t: 'e', k: 'hit', kill: true, head: 1 })
      && !validServerMessage({ t: 'e', k: 'hit', kill: true, head: 2 }));
  const migratedWelcome = { t: 'w', id: 'peer', team: 'green', seed: 1, map: 0, mode: 'ctf',
    me: 2, life: 1, migrated: 1, reset: 1, spawn: [10, 20, 30, 0], log: [],
    r: { p: [], b: [] } };
  ok('migration reset welcomes require a valid authoritative spawn',
    validServerMessage(migratedWelcome)
      && !validServerMessage({ ...migratedWelcome, spawn: [10, NaN, 30, 0] }));
  ok('room browser rejects malformed names payloads', !validPong({
    t: 'pong', humans: 1, max: 10, map: 0, mode: 'ctf', g: 0, b: 0, names: 'oops',
  }));
  ok('extracted match-mode limits retain their mode mapping',
    modeScoreLimit('ctf') === 3 && modeScoreLimit('tdm') >= 2
      && modeScoreLimit('koth') >= 10);
  const schedule = new PresentationSchedule();
  const firstPresentation = schedule.step(0);
  const quietPresentation = schedule.step(0.01);
  ok('presentation cadence keeps noncritical work off every frame',
    firstPresentation.fast && firstPresentation.slow && firstPresentation.network
      && !quietPresentation.fast && !quietPresentation.slow && !quietPresentation.network);
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

  const openingLanes = [0, 1, 2].map(id => greenbeltOpeningRally({
    mapIndex: 0, gameMode: 'tdm', time: 8, team: 'green', id,
  }));
  const mirroredOpening = greenbeltOpeningRally({ mapIndex: 0, gameMode: 'tdm',
    time: 8, team: 'blue', tacticalRole: 'flank-left', id: 4 });
  ok('Greenbelt opening rally is scoped to early TDM without credible enemy intel',
    !!openingLanes[0] && greenbeltOpeningRally({ mapIndex: 1, gameMode: 'tdm', time: 8,
      team: 'green', id: 0 }) === null
      && greenbeltOpeningRally({ mapIndex: 0, gameMode: 'ctf', time: 8,
        team: 'green', id: 0 }) === null
      && greenbeltOpeningRally({ mapIndex: 0, gameMode: 'tdm', time: 8,
        hasIntel: true, team: 'green', id: 0 }) === null);
  ok('Greenbelt opening rally distributes stable north/center/south lanes symmetrically',
    new Set(openingLanes.map(p => p.lane)).size === 3
      && openingLanes.every(p => p.x < SX / 2)
      && mirroredOpening.x > SX / 2 && mirroredOpening.z === openingLanes[0].z);
  ok('Greenbelt opening rally releases patrol policy after its bounded window',
    greenbeltOpeningRally({ mapIndex: 0, gameMode: 'tdm', time: 24,
      team: 'green', id: 0 }) === null);

  ok('current-target hysteresis prevents trivial target churn',
    botTargetScore(20, 100, false, true) < botTargetScore(18, 100, false, false));
  ok('an enemy flag carrier can still override target stickiness',
    botTargetScore(28, 100, true, false) < botTargetScore(20, 100, false, true));

  const targetDir = new THREE.Vector3();
  const botEye = new THREE.Vector3();
  const targetEye = new THREE.Vector3();
  const botEyeArgs = [], foeEyeArgs = [];
  const makeTargetBody = (x, z, eyeArgs) => ({
    pos: new THREE.Vector3(x, 0, z),
    eye(out) { eyeArgs.push(out); return out.set(this.pos.x, 1.6, this.pos.z); },
  });
  const farFoe = { alive: true, health: 100, carrier: false,
    body: makeTargetBody(12, 0, foeEyeArgs) };
  const nearFoe = { alive: true, health: 100, carrier: false,
    body: makeTargetBody(8, 0, foeEyeArgs) };
  const targetBot = {
    team: 'green', carrier: false, target: null,
    face: new THREE.Vector3(1, 0, 0),
    _targetDir: targetDir, _eye: botEye, _targetEye: targetEye,
    body: {
      pos: new THREE.Vector3(0, 0, 0),
      eye(out) { botEyeArgs.push(out); return out.set(0, 1.6, 0); },
    },
    game: {
      foesOf() { return [farFoe, nearFoe]; },
      losClear() { return true; },
    },
  };
  const acquired = acquireTarget(targetBot, { vision: 40 });
  ok('target acquisition reuses owned eye outputs and keeps nearest selection',
    acquired === nearFoe
      && botEyeArgs.length === 2 && botEyeArgs.every(out => out === botEye)
      && foeEyeArgs.length === 2 && foeEyeArgs.every(out => out === targetEye)
      && targetDir.x === 1 && targetDir.y === 0 && targetDir.z === 0);

  const makeBehindBody = (x, z) => ({
    pos: new THREE.Vector3(x, 0, z),
    eye(out) { return out.set(x, 1.6, z); },
  });
  const behindFoe = { alive: true, health: 100, carrier: false, body: makeBehindBody(-15, 0) };
  const distantFoe = { alive: true, health: 100, carrier: false, body: makeBehindBody(-50, 0) };
  const hearingGame = (spot, foes, los) => ({
    time: 100,
    foesOf: () => foes,
    losClear: los ?? (() => true),
    huntSpot: () => spot,
  });
  const hearingBot = game => ({
    team: 'green', carrier: false, target: null,
    face: new THREE.Vector3(1, 0, 0),
    _eye: new THREE.Vector3(), _targetEye: new THREE.Vector3(),
    difficulty: { hearing: 38 },
    body: { pos: new THREE.Vector3(0, 0, 0),
      eye(out) { return out.set(0, 1.6, 0); } },
    game,
  });
  const freshSound = { x: -15, z: 0, team: 'blue', t: 100, kind: 'sound' };
  ok('hearing acquires a close foe behind the face cone on a fresh sound',
    heardFoe(hearingBot(hearingGame(freshSound, [behindFoe]))) === behindFoe);
  ok('hearing ignores stale sounds, sightings, walls, and distant foes',
    heardFoe(hearingBot(hearingGame({ ...freshSound, t: 90 }, [behindFoe]))) === null
      && heardFoe(hearingBot(hearingGame({ ...freshSound, kind: 'sight' }, [behindFoe]))) === null
      && heardFoe(hearingBot(hearingGame(freshSound, [behindFoe], () => false))) === null
      && heardFoe(hearingBot(hearingGame({ ...freshSound, x: -50 }, [distantFoe]))) === null);

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
  const separationOut = { x: 9, z: 9 };
  const separationActual = botSeparation({ x: 10, z: 10 }, [
    { id: 2, alive: true, body: { pos: { x: 11, z: 10 } } },
  ], 1, 2.4, separationOut);
  ok('bot separation accepts live entities and reuses an output object',
    separationActual === separationOut && separationOut.x < -0.99 && separationOut.z === 0);

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
  const carrierRoles = assignBotRoles('ctf', squad, {
    friendlyCarrier: { x: 32, z: 40 }, ownStand: { x: 10, z: 40 },
    midfield: { x: 128, z: 128 },
  });
  ok('a full CTF squad assigns at most two escorts to a carrier run',
    Object.values(carrierRoles).filter(r => r === 'escort').length === 2);
  const editBot = { _editTokens: 0, _editBudget: BOT_LIFE_EDIT_BUDGET };
  ok('bot terrain edits require a tactical gate and respect the burst bucket',
    !botTerrainEditAllowed({ _editTokens: BOT_LIFE_EDIT_BUDGET })
      && botTerrainEditAllowed({ _editTokens: 1 }, { stuck: 2 })
      && !botTerrainEditAllowed(editBot, { water: true }));
  ok('SMG closing intent activates only for visible out-of-range targets',
    smgClosingIntent(1, 24, true) && !smgClosingIntent(1, 10, true)
      && !smgClosingIntent(0, 24, true));
  ok('CTF final approach stages a lone bot until close support arrives',
    ctfFinalApproachPolicy({ distanceToFlag: 12, nearestSupportDistance: 30,
      stagedSeconds: 3 }) === 'stage');
  ok('CTF final approach advances with a genuinely close escort',
    ctfFinalApproachPolicy({ distanceToFlag: 12, nearestSupportDistance: 10,
      stagedSeconds: 0 }) === 'advance');
  ok('CTF final approach has an escalation-safe bounded fallback',
    ctfFinalApproachPolicy({ distanceToFlag: 12, nearestSupportDistance: 30,
      stagedSeconds: 12 }) === 'advance'
      && ctfFinalApproachPolicy({ distanceToFlag: 12, nearestSupportDistance: 30,
        stagedSeconds: 0, escalation: true }) === 'advance');
  ok('a staged runner with no support anywhere advances early instead of waiting out the full fallback',
    ctfFinalApproachPolicy({ distanceToFlag: 12, nearestSupportDistance: Infinity,
      stagedSeconds: 6 }) === 'advance'
      && ctfFinalApproachPolicy({ distanceToFlag: 12, nearestSupportDistance: Infinity,
        stagedSeconds: 3 }) === 'stage');
  const stagedRoles = assignBotRoles('ctf', squad, {
    friendlyCarrier: { x: squad[4].x, z: squad[4].z }, friendlyCarrierId: squad[4].id,
    ownStand: { x: 10, z: 40 }, midfield: { x: 128, z: 128 },
  });
  ok('a staged CTF runner cannot consume its own escort slot',
    stagedRoles[squad[4].id] === 'attack'
      && Object.values(stagedRoles).filter(role => role === 'escort').length === 2);
  const runner = { alive: true, body: { pos: new THREE.Vector3(100, 0, 100) } };
  const passingBot = { alive: true, tacticalRole: 'attack',
    body: { pos: new THREE.Vector3(102, 0, 100) } };
  const assignedEscort = { alive: true, tacticalRole: 'escort',
    body: { pos: new THREE.Vector3(110, 0, 100) } };
  const humanSupport = { alive: true, body: { pos: new THREE.Vector3(106, 0, 100) } };
  ok('CTF staging ignores passing bots but accepts assigned escorts',
    ctfApproachSupportDistance(runner, [runner, passingBot, assignedEscort],
      [runner, passingBot, assignedEscort]) === 10);
  ok('nearby human teammates still count as final-approach support',
    ctfApproachSupportDistance(runner, [runner, passingBot, assignedEscort, humanSupport],
      [runner, passingBot, assignedEscort]) === 6);
  const ctfLaneBot = { lane: 44, tacticalRole: 'flank-right',
    body: { pos: new THREE.Vector3(210, 0, 84) }, game: { gameMode: 'ctf' } };
  const convergedLane = laned(ctfLaneBot, new THREE.Vector3(220, 0, 128), { THREE });
  ok('CTF lateral lanes converge by forward distance at the enemy flag gate',
    convergedLane.z === 128);
  const broadLane = laned({ ...ctfLaneBot, body: { pos: new THREE.Vector3(160, 0, 128) } },
    new THREE.Vector3(220, 0, 128), { THREE });
  ok('CTF flanks remain inside the broad authored approach before convergence',
    broadLane.z === 160);
  const openCtfRoles = assignBotRoles('ctf', squad, {
    ownStand: { x: 10, z: 128 }, midfield: { x: 128, z: 128 },
  });
  ok('a full CTF squad sends attackers through both authored flank lanes',
    Object.values(openCtfRoles).includes('flank-left')
      && Object.values(openCtfRoles).includes('flank-right')
      && Object.values(openCtfRoles).includes('attack'));
  ok('CROWN routes an outside approach onto its nearest causeway',
    JSON.stringify(crownRouteWaypoint({ x: 52, z: 176 }, { x: 128, z: 128 }, 4))
      === JSON.stringify({ x: 88, z: 128 })
      && JSON.stringify(crownRouteWaypoint({ x: 204, z: 96 }, { x: 128, z: 128 }, 4))
        === JSON.stringify({ x: 168, z: 128 }));
  ok('CROWN advances from the outer causeway to the open ring gate',
    JSON.stringify(crownRouteWaypoint({ x: 89, z: 128 }, { x: 128, z: 128 }, 4))
      === JSON.stringify({ x: 116, z: 128 }));
  ok('CROWN crosses its interior before using the target-side causeway',
    JSON.stringify(crownRouteWaypoint({ x: 128, z: 128 }, { x: 128, z: 88 }, 4))
      === JSON.stringify({ x: 128, z: 116 })
      && JSON.stringify(crownRouteWaypoint({ x: 128, z: 117 }, { x: 128, z: 60 }, 4))
        === JSON.stringify({ x: 128, z: 88 }));
  ok('CROWN leaves same-side field travel and other maps untouched',
    crownRouteWaypoint({ x: 52, z: 128 }, { x: 80, z: 160 }, 4) === null
      && crownRouteWaypoint({ x: 52, z: 128 }, { x: 128, z: 128 }, 3) === null);
  const ctfRouteSeed = 0x1a2b3c4d;
  const ctfRouteProgress = (mapIndex, team) => {
    const home = team === 'green' ? { x: 36, z: 128 } : { x: 220, z: 128 };
    let position = team === 'green' ? { x: 220, z: 128 } : { x: 36, z: 128 };
    const points = [];
    for (let i = 0; i < 8; i++) {
      const point = ctfCarrierWaypoint(position, home, mapIndex, team, ctfRouteSeed);
      if (!point) break;
      points.push(point);
      position = { x: point.x + (team === 'green' ? 1 : -1), z: point.z };
    }
    return points;
  };
  ok('CTF carrier routes cover both teams on every authored CTF map',
    [0, 1, 2].every(mapIndex => ['green', 'blue'].every(team => {
      const points = ctfRouteProgress(mapIndex, team);
      const westbound = team === 'green';
      return points.length >= 3 && points.every((point, i) => Number.isFinite(point.x)
        && Number.isFinite(point.z) && (i === 0 || (westbound
          ? point.x < points[i - 1].x : point.x > points[i - 1].x)));
    })));
  ok('CTF carrier routes use authored crossing lanes and release after the obstacle',
    ctfRouteProgress(0, 'green').every(point => point.z < 88 || point.z > 168)
      && ctfCarrierWaypoint({ x: 70, z: 80 }, { x: 36, z: 128 }, 0, 'green', ctfRouteSeed) === null
      && ctfCarrierWaypoint({ x: 70, z: 128 }, { x: 36, z: 128 }, 1, 'green', ctfRouteSeed) === null);
  const pineFordSeed = 439041101;
  const pineFordZ = pinefallRavineCenter(pineFordSeed, 128) + 8;
  const pineGreenHome = { x: 36, z: 128 };
  ok('Pinefall carriers stay committed through the authored ford checkpoints',
    pineFordZ > 143.5 && pineFordZ < 143.7
      && [140, 134, 122].every(x => pinefallCarrierFordCommitted(
        { x, z: pineFordZ }, 2, pineFordSeed, true, 'ctf'))
      && [122, 134].every(x => pinefallCarrierFordCommitted({ x, z: pineFordZ },
        2, pineFordSeed, true, 'ctf'))
      && pinefallCarrierFordCommitted({ x: 116, z: pineFordZ },
        2, pineFordSeed, true, 'ctf'));
  ok('Pinefall ford commitment is bounded to the route corridor',
    !pinefallCarrierFordCommitted({ x: 115.9, z: pineFordZ },
      2, pineFordSeed, true, 'ctf')
      && !pinefallCarrierFordCommitted({ x: 144.1, z: pineFordZ },
        2, pineFordSeed, true, 'ctf')
      && !pinefallCarrierFordCommitted({ x: 134, z: pineFordZ + 10.1 },
        2, pineFordSeed, true, 'ctf'));
  ok('Pinefall carrier route releases toward home after the west ford bank',
    ctfCarrierWaypoint({ x: 126.1, z: pineFordZ }, pineGreenHome,
      2, 'green', pineFordSeed)?.x === 122
      && ctfCarrierWaypoint({ x: 126, z: pineFordZ }, pineGreenHome,
        2, 'green', pineFordSeed) === null);
  ok('Pinefall ford commitment stays isolated from carriers and modes outside it',
    !pinefallCarrierFordCommitted({ x: 134, z: pineFordZ },
      2, pineFordSeed, false, 'ctf')
      && !pinefallCarrierFordCommitted({ x: 134, z: pineFordZ },
        1, pineFordSeed, true, 'ctf')
      && !pinefallCarrierFordCommitted({ x: 134, z: pineFordZ },
        2, pineFordSeed, true, 'tdm')
      && !pinefallCarrierFordCommitted({ x: 134, z: pineFordZ + 24 },
        2, pineFordSeed, true, 'ctf'));
  ok('CTF authored routing stays isolated from non-carriers and other modes',
    ctfCarrierWaypoint({ x: 220, z: 128 }, { x: 36, z: 128 }, 4, 'green', ctfRouteSeed) === null
      && authoredRouteGoal({ carrier: false, body: { pos: { x: 220, z: 128 } },
        game: { gameMode: 'ctf', mapIndex: 0 } }, new THREE.Vector3(36, 0, 128), { THREE })
        .equals(new THREE.Vector3(36, 0, 128))
      && authoredRouteGoal({ carrier: true, body: { pos: { x: 220, z: 128 } },
        game: { gameMode: 'tdm', mapIndex: 0 } }, new THREE.Vector3(36, 0, 128), { THREE })
        .equals(new THREE.Vector3(36, 0, 128)));
  const transitionBot = Object.create(Bot.prototype);
  transitionBot.carrier = false;
  transitionBot._carrierState = false;
  transitionBot.alive = false;
  transitionBot.deadT = -1;
  transitionBot.cachedGoal = new THREE.Vector3(220, 20, 128);
  transitionBot.route = new THREE.Vector3(1, 0, 0);
  transitionBot.routeT = 0.8;
  transitionBot.patrol = new THREE.Vector3(220, 20, 128);
  transitionBot.patrolT = 12;
  transitionBot.wander = new THREE.Vector3(8, 0, 0);
  transitionBot.wanderT = 2;
  transitionBot.responding = true;
  transitionBot.ctfStageAt = 10;
  transitionBot.carrier = true;
  transitionBot.update(1 / 60);
  transitionBot.game = {
    gameMode: 'ctf', mapIndex: 0, seed: ctfRouteSeed,
    standOf: () => new THREE.Vector3(36, 20, 128),
    world: { surface: () => 20 },
  };
  transitionBot.team = 'green';
  transitionBot.body = { pos: new THREE.Vector3(220, 20, 128) };
  const firstCarrierGoal = authoredRouteGoal(transitionBot, transitionBot.goal(), { THREE });
  ok('CTF carrier transition invalidates stale navigation before the first carrier update',
    transitionBot.cachedGoal === null && transitionBot.routeT === 0
      && transitionBot.route.lengthSq() === 0 && transitionBot.patrol === null
      && transitionBot.wander.lengthSq() === 0 && !transitionBot.responding
      && transitionBot.ctfStageAt === -Infinity
      && firstCarrierGoal.x < transitionBot.body.pos.x && firstCarrierGoal.z !== 128);
  transitionBot.cachedGoal = new THREE.Vector3(36, 20, 128);
  transitionBot.route.set(1, 0, 0);
  transitionBot.routeT = 0.5;
  transitionBot.carrier = false;
  transitionBot.update(1 / 60);
  ok('CTF carrier drop/capture transition also invalidates the homeward route',
    transitionBot._carrierState === false && transitionBot.cachedGoal === null
      && transitionBot.routeT === 0 && transitionBot.route.lengthSq() === 0);
  const ordinaryGoal = new THREE.Vector3(80, 20, 128);
  transitionBot.cachedGoal = ordinaryGoal;
  transitionBot.route.set(0, 0, 1);
  transitionBot.routeT = 0.5;
  transitionBot.update(1 / 60);
  ok('unchanged carrier state does not invalidate ordinary bot navigation',
    transitionBot.cachedGoal === ordinaryGoal && transitionBot.routeT === 0.5
      && transitionBot.route.z === 1);
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

  // Retreat-while-firing latches on contact, not on settled aim: a wounded
  // bot with a FRESH target (aimT ~ 0) must still fall back. The old trigger
  // gated on the aim-settled vector, so a fresh ambush on a wounded bot
  // never retreated at all.
  const retreatWorld = new VoxelWorld(scene());
  generateMap(retreatWorld, 12345, 0);
  const retreatGame = {
    time: 100, mapIndex: 0, seed: 12345, gameMode: 'tdm',
    world: retreatWorld, scene: scene(), player: null,
    hill: null, flags: null, navRevision: 0,
    _botThinkSet: new Set(),
    spawnPoint: () => ({ x: 60.5, y: retreatWorld.surface(60, 128) + 1, z: 128.5 }),
    losClear: () => true,
    teamOf: () => [],
    huntSpot: () => null,
  };
  const freshFoe = (bot, dist) => ({ alive: true, team: 'blue',
    body: { pos: new THREE.Vector3(bot.body.pos.x + dist, bot.body.pos.y, bot.body.pos.z),
      half: { h: 1.8 } } });
  const woundBot = (gunClass, health, foeDist) => {
    const bot = new Bot(retreatGame, 'green', `retreattest${gunClass}`, 'normal');
    bot.gunClass = gunClass;
    bot.health = health;
    bot.aimT = 0; // fresh contact: eyes just landed, aim unsettled
    bot.retreatT = 0;
    bot.retreatCd = 0;
    bot.blocks = 0; // skip cover construction; the trigger is under test
    bot.nades = 0;
    bot.target = freshFoe(bot, foeDist);
    bot.targetVisible = true;
    bot.update(1 / 60);
    return bot;
  };
  const woundedRifle = woundBot(0, 10, 20); // rifle retreatHealth 35
  ok('a wounded bot retreats on fresh contact even before aim settles',
    woundedRifle.retreatT > 0 && woundedRifle.retreatCd > 0);
  woundedRifle.health = 100;
  woundedRifle.retreatT = 0;
  woundedRifle.retreatCd = 0;
  woundedRifle.update(1 / 60);
  ok('a healthy rifle holds its ground on fresh contact instead of retreating',
    woundedRifle.retreatT <= 0);
  const crowdedSniper = woundBot(5, 100, 10); // sniper closeRetreat 14
  ok('a healthy sniper still disengages when a fresh target closes inside its comfort range',
    crowdedSniper.retreatT > 0);

  // Open-fire envelope: the rifle spots to 60 but only shoots to 45, and
  // never plants outside its envelope — it keeps moving (closing) instead
  // of crawling silent toward the objective while aimed at nothing shootable.
  let gunneryShots = 0;
  const gunneryGame = { ...retreatGame, fireHitscan: () => { gunneryShots++; } };
  const gunneryBot = foeDist => {
    const bot = new Bot(gunneryGame, 'green', 'gunnerytest', 'normal');
    bot.gunClass = 0; // rifle: vision 60, fireRange 45
    bot.health = 100;
    bot.aimT = 10; // settled aim: any held fire is a policy choice, not reaction
    bot.cooldown = 0;
    bot.ammo = TOOLS[0].mag;
    bot.blocks = 0;
    bot.nades = 0;
    bot.retreatCd = 9; // healthy anyway; keep the trigger out of the picture
    bot.target = { alive: true, team: 'blue',
      body: { pos: new THREE.Vector3(bot.body.pos.x + foeDist, bot.body.pos.y, bot.body.pos.z),
        half: { h: 1.8 } } };
    bot.targetVisible = true;
    bot.face.set(1, 0, 0); // staring straight down +x at the foe
    return bot;
  };
  gunneryShots = 0;
  const farBot = gunneryBot(55);
  farBot.update(1 / 60);
  ok('a rifle holds fire beyond its open-fire envelope instead of plinking',
    gunneryShots === 0 && farBot.ammo === TOOLS[0].mag);
  gunneryShots = 0;
  const nearBot = gunneryBot(40);
  nearBot.update(1 / 60);
  ok('a rifle engages inside its envelope with settled aim',
    gunneryShots > 0 && nearBot.ammo < TOOLS[0].mag);
  const advancingBot = gunneryBot(55);
  for (let i = 0; i < 30; i++) advancingBot.update(1 / 60);
  ok('a rifle beyond its envelope keeps moving instead of planting',
    Math.hypot(advancingBot.body.vel.x, advancingBot.body.vel.z) > 2);

  // Ears before eyes: a close gunshot behind the face cone is acquired as a
  // heard (not visible) contact, turns the head, and never reaches the
  // squad radio disguised as a 'sight' intel report.
  const heardKinds = [];
  let loudSpot = null;
  let loudFoes = [];
  const thinkGame = { ...retreatGame,
    _botThinkSet: new Set(),
    fireHitscan: () => {},
    foesOf: () => loudFoes,
    pingIntel: (pos, team, kind) => { heardKinds.push(kind); },
    huntSpot: () => loudSpot,
  };
  const listener = new Bot(thinkGame, 'green', 'listenertest', 'normal');
  thinkGame._botThinkSet.add(listener.id);
  listener.gunClass = 0;
  listener.health = 100;
  listener.aimT = 5;
  listener.blocks = 0;
  listener.nades = 0;
  listener.face.set(1, 0, 0);
  const loudFoe = { alive: true, team: 'blue', health: 100, carrier: false,
    // Behind the face cone but slightly off-axis: exact opposition would pin
    // the presentation lerp (lerping (1,0,0) toward (-1,0,0) renormalizes
    // back to itself), a measure-zero degeneracy real positions never hit.
    body: { pos: new THREE.Vector3(listener.body.pos.x - 15, listener.body.pos.y, listener.body.pos.z + 2),
      half: { h: 1.8 },
      eye(out) { return out.set(this.pos.x, this.pos.y + 1.6, this.pos.z); } } };
  loudSpot = { x: loudFoe.body.pos.x, z: loudFoe.body.pos.z, team: 'blue', t: thinkGame.time, kind: 'sound' };
  listener.target = null;
  listener.targetVisible = false;
  // Sneak the foe into the think path: vision must NOT see it (it starts
  // behind the face cone), so whatever acquires it is hearing.
  loudFoes = [loudFoe];
  listener.update(1 / 60);
  ok('a close gunshot behind the face cone is acquired as heard contact',
    listener.target === loudFoe && listener.targetVisible === false
      && heardKinds.length === 0 && listener.aimT < 1);
  for (let i = 0; i < 120; i++) listener.update(1 / 60);
  ok('heard contact turns the head without ever faking a radio sighting',
    listener.target === loudFoe && listener.face.x < -0.3 && heardKinds.length === 0);

  // Staging dug-in: a lone attacker holding outside the enemy flag throws a
  // knee wall toward the stand instead of loitering in the open. A bot far
  // from any flag (ordinary advance, nothing staged) builds nothing.
  const ctfGame = { ...retreatGame, gameMode: 'ctf',
    bots: [],
    teamOf: () => [],
    huntSpot: () => null,
    tryBuild: () => true,
    enemyOf: team => (team === 'green' ? 'blue' : 'green'),
    standOf: team => (team === 'blue'
      ? new THREE.Vector3(220, 20, 128) : new THREE.Vector3(36, 20, 128)),
    flags: { blue: { state: 'home', home: new THREE.Vector3(220, 20, 128) } },
    spawnPoint: () => ({ x: 200.5, y: retreatGame.world.surface(200, 128) + 1, z: 128.5 }),
  };
  const stager = new Bot(ctfGame, 'green', 'stagertest', 'normal');
  stager.gunClass = 0;
  stager.health = 100;
  stager.nades = 0;
  stager.ctfStageAt = ctfGame.time - 3; // already waiting, support nowhere
  // A clean staging lane: foot-level obstructions toward the stand read as
  // existing cover and would gate the build on mapgen luck. Clear the probe
  // reaches (mirroring hasCover) so the decision under test is deterministic.
  {
    const dx = 220 - stager.body.pos.x, dz = 128 - stager.body.pos.z;
    const len = Math.hypot(dx, dz);
    const fy = Math.floor(stager.body.pos.y);
    for (const reach of [1.2, 2.2, 3.2]) {
      ctfGame.world.set(Math.floor(stager.body.pos.x + dx / len * reach), fy,
        Math.floor(stager.body.pos.z + dz / len * reach), 0);
    }
  }
  for (let i = 0; i < 60 && stager.coverT <= 0; i++) stager.update(1 / 60);
  ok('a staged attacker builds cover toward the enemy stand while waiting',
    stager.coverT > 0 && stager.buildT > 0);
  const passerby = new Bot(ctfGame, 'green', 'passerbytest', 'normal');
  passerby.gunClass = 0;
  passerby.health = 100;
  passerby.nades = 0;
  passerby.body.pos.set(60.5, retreatGame.world.surface(60, 128) + 1, 128.5);
  passerby.lastPos.copy(passerby.body.pos);
  for (let i = 0; i < 60; i++) passerby.update(1 / 60);
  ok('an advancing bot far from the flag does not throw staging cover',
    passerby.coverT <= 0);
}

// ---------------------------------------------------------------------------
function pacingRuleTests() {
  group('match pacing: waves, tactical spawns, regulation, and overtime');
  ok('mode-specific regulation clocks match the pacing plan',
    modeMatchSeconds('ctf') === 720 && modeMatchSeconds('tdm') === 540
      && modeMatchSeconds('koth') === 600);
  ok('public quick-play uses compact TDM/KOTH clocks and score caps',
    modeMatchSeconds('tdm', { publicRoom: true }) === 330
      && modeMatchSeconds('koth', { publicRoom: true }) === 360
      && modeScoreLimit('tdm', { publicRoom: true }) === 35
      && modeScoreLimit('koth', { publicRoom: true }) === 90);
  ok('private defaults, CTF, and explicit clock overrides stay compatible',
    modeMatchSeconds('tdm', { publicRoom: false }) === 540
      && modeMatchSeconds('koth', { publicRoom: false }) === 600
      && modeMatchSeconds('ctf', { publicRoom: true }) === 720
      && modeMatchSeconds('tdm', { publicRoom: true, override: 17 }) === 17
      && modeScoreLimit('ctf', { publicRoom: true }) === 3);
  const publicChoices = nextBattleChoices({ maps: MAPS, mode: 'tdm', mapIndex: 0,
    publicRoom: true, seed: 77 });
  ok('public next-battle choices are three unique valid cards with a mode switch',
    publicChoices.length === 3
      && new Set(publicChoices.map(choice => `${choice.mode}:${choice.map}`)).size === 3
      && publicChoices.every(choice => validBattleChoice(choice, MAPS, { publicRoom: true }))
      && validBattleChoices(publicChoices, MAPS, { publicRoom: true })
      && new Set(publicChoices.map(choice => choice.mode)).size === 2);
  ok('duplicate or single-mode public battle slates fail the catalogue boundary',
    !validBattleChoices([publicChoices[0], publicChoices[0], publicChoices[1]], MAPS,
      { publicRoom: true })
      && !validBattleChoices(publicChoices.map((choice, index) => ({
        ...choice, mode: 'tdm', map: [0, 1, 2][index],
      })), MAPS, { publicRoom: true }));
  const resolved = resolveBattleVote(publicChoices,
    [{ actor: 'p0', choice: 1 }, { actor: 'p1', choice: 1 }, { actor: 'p2', choice: 0 }],
    ['p0', 'p1', 'p2']);
  ok('next-battle tally resolves highest count with deterministic lowest-index ties',
    resolved.index === 1 && resolveBattleVote(publicChoices,
      [{ actor: 'p0', choice: 0 }, { actor: 'p1', choice: 1 }], ['p0', 'p1']).index === 0);
  ok('deaths in one TDM wave share its six-second boundary',
    Math.abs(respawnWaveDelay('tdm', 12.2) - 5.8) < 1e-9
      && Math.abs(respawnWaveDelay('tdm', 14.5) - 3.5) < 1e-9);
  ok('CTF now matches KOTH at a brisk seven-second team wave',
    respawnWaveDelay('ctf', 7) === 7 && respawnWaveDelay('koth', 7) === 7);

  const ctfCandidate = { x: 96, z: 128 };
  ok('CTF permits a clear frontline spawn inside the team half',
    ctfFrontlineAllowed(ctfCandidate, { ownX: 36, enemyX: 220 })
      && ctfFrontlineAllowed({ x: 160, z: 128 }, { ownX: 220, enemyX: 36 }));
  ok('CTF frontline spawning never crosses the buffered midfield line',
    !ctfFrontlineAllowed({ x: 124, z: 128 }, { ownX: 36, enemyX: 220 })
      && !ctfFrontlineAllowed({ x: 132, z: 128 }, { ownX: 220, enemyX: 36 }));
  ok('CTF rejects exposed, enemy-adjacent, and active-flag-adjacent spawns',
    !ctfFrontlineAllowed(ctfCandidate, { ownX: 36, enemyX: 220, visibleEnemies: 1 })
      && !ctfFrontlineAllowed(ctfCandidate, { ownX: 36, enemyX: 220,
        enemies: [{ x: 96 + CTF_SPAWN.enemyClearance - 0.1, z: 128 }] })
      && !ctfFrontlineAllowed(ctfCandidate, { ownX: 36, enemyX: 220,
        activeFlags: [{ x: 96, z: 128 + CTF_SPAWN.activeFlagClearance - 0.1 }] }));
  const ctfField = { ownX: 0, enemyX: 200 };
  const ctfQuiet = { alive: true, carrier: false, _spawnedAt: 0, _combatAt: 0,
    body: { pos: { x: 70, z: 0 } } };
  const ctfSupport = { alive: true, _spawnedAt: 0, _combatAt: 0,
    body: { pos: { x: 82, z: 3 } } };
  ok('CTF anchors are symmetric, quiet, unseen, enemy-clear, and supported',
    ctfAnchorAllowed(ctfQuiet, { ...ctfField, now: 10,
      nearbyAllies: [ctfQuiet, ctfSupport] })
      && ctfAnchorAllowed({ ...ctfQuiet,
        body: { pos: { x: 130, z: 0 } } },
        { ownX: 200, enemyX: 0, now: 10,
          nearbyAllies: [{ ...ctfQuiet, body: { pos: { x: 130, z: 0 } } },
            { ...ctfSupport, body: { pos: { x: 118, z: 3 } } }] })
      && !ctfAnchorAllowed(ctfQuiet, { ...ctfField, now: 10 })
      && !ctfAnchorAllowed({ ...ctfQuiet, _combatAt: 8 }, { ...ctfField, now: 10,
        nearbyAllies: [ctfQuiet, ctfSupport] })
      && !ctfAnchorAllowed(ctfQuiet, { ...ctfField, now: 10,
        nearbyAllies: [ctfQuiet, ctfSupport], visibleEnemies: 1 })
      && !ctfAnchorAllowed(ctfQuiet, { ...ctfField, now: 10,
        nearbyAllies: [ctfQuiet, ctfSupport], enemies: [{ x: 82, z: 0 }] }));
  ok('CTF waves use a median front and materially pull home for flag defense',
    Math.abs(ctfMedianForwardProgress([{ x: 40, z: 0 }, { x: 60, z: 0 },
      { x: 80, z: 0 }, { x: 190, z: 0 }], ctfField) - 0.3) < 1e-9
      && ctfWaveProgress(0.3, { ...ctfField, behind: 12 })
        - ctfWaveProgress(0.3, { ...ctfField, behind: 12, defending: true })
        >= 20
      && ctfWaveProgress(0.3, { ...ctfField, behind: 12 }) <= 90);
  ok('TDM territorial constants and rules remain unchanged',
    TDM_SPAWN.minProgress === 0.25 && TDM_SPAWN.maxProgress === 0.49
      && TDM_SPAWN.midfieldBuffer === 4 && TDM_SPAWN.behindFrontMin === 10
      && TDM_SPAWN.behindFrontMax === 20 && TDM_SPAWN.anchorGrace === 5
      && TDM_SPAWN.anchorSupportRadius === 22 && TDM_SPAWN.anchorEnemyClearance === 20);
  const kothHill = { x: 128, z: 128, r: 8 };
  const greenHome = { x: 36, z: 128 }, blueHome = { x: 220, z: 128 };
  ok('KOTH directional candidates stay home-side and clear of the active point',
    kothCandidateDirectionalAllowed({ x: 100, z: 128 }, { home: greenHome, hill: kothHill })
      && kothCandidateDirectionalAllowed({ x: 156, z: 128 }, { home: blueHome, hill: kothHill })
      && !kothCandidateDirectionalAllowed({ x: 156, z: 128 }, { home: greenHome, hill: kothHill })
      && !kothCandidateDirectionalAllowed({ x: 120, z: 128 }, { home: greenHome, hill: kothHill })
      && !kothCandidateDirectionalAllowed({ x: 111, z: 128 }, {
        home: greenHome, hill: { pos: kothHill, r: kothHill.r },
      }));
  const kothQuiet = { alive: true, _spawnedAt: 0, _combatAt: 0,
    body: { pos: { x: 92, z: 128 } } };
  const kothSupport = { alive: true, _spawnedAt: 0, _combatAt: 0,
    body: { pos: { x: 104, z: 130 } } };
  ok('KOTH anchors and approach depth reject far-side or unsupported bodies',
    kothAnchorAllowed(kothQuiet, { home: greenHome, hill: kothHill, now: 10,
      nearbyAllies: [kothQuiet, kothSupport] })
      && !kothAnchorAllowed(kothQuiet, { home: greenHome, hill: kothHill, now: 10 })
      && !kothAnchorAllowed({ ...kothQuiet, body: { pos: { x: 164, z: 128 } } },
        { home: greenHome, hill: kothHill, now: 10,
          nearbyAllies: [kothQuiet, kothSupport] })
      && Math.abs(kothApproachDepth({ x: 92, z: 128 },
        { home: greenHome, hill: kothHill }) - 36) < 1e-9
      && kothMedianApproachDepth([kothQuiet, kothSupport],
        { home: greenHome, hill: kothHill }) === 30
      && kothWaveApproachDepth(30, { behind: 12 }) === 42);
  ok('CTF objective guidance prioritizes return, recovery, escort, and re-grab',
    ctfObjectiveKind({ carrier: true, ownState: 'carried' }) === 'return'
      && ctfObjectiveKind({ ownState: 'carried', enemyState: 'home' }) === 'recover'
      && ctfObjectiveKind({ ownState: 'home', enemyState: 'carried' }) === 'escort'
      && ctfObjectiveKind({ ownState: 'home', enemyState: 'dropped' }) === 'secure'
      && ctfObjectiveKind({ ownState: 'home', enemyState: 'home' }) === 'attack');
  ok('dropped CTF flags reset quickly enough to prevent long dead plays',
    FLAG_RETURN_TIME === 15);

  const anchor = { team: 'green', alive: true, carrier: false,
    _spawnedAt: 0, _combatAt: 0,
    body: { pos: new THREE.Vector3(90, 20, 128) } };
  const anchorSupport = { team: 'green', alive: true, carrier: false,
    _spawnedAt: 0, _combatAt: 0,
    body: { pos: new THREE.Vector3(102, 20, 128) } };
  const fakeCtf = {
    _openingDeployment: false, time: 10,
    flags: {
      green: { state: 'home', pos: new THREE.Vector3(36, 20, 128),
        home: new THREE.Vector3(36, 20, 128) },
      blue: { state: 'home', pos: new THREE.Vector3(220, 20, 128),
        home: new THREE.Vector3(220, 20, 128) },
    },
    entities: () => [anchor, anchorSupport],
    enemyOf: Game.prototype.enemyOf,
    _spawnSurface: (x, z) => ({ x, y: 20, z }),
    losClear: () => true,
  };
  const savedRandom = Math.random;
  Math.random = () => 0.5;
  let frontline;
  try { frontline = Game.prototype._ctfSpawnPoint.call(fakeCtf, 'green'); }
  finally { Math.random = savedRandom; }
  ok('a surviving safe teammate enables a terrain-valid own-half CTF redeploy',
    frontline && frontline.x >= 54 && frontline.x <= 118);
  fakeCtf.entities = () => [];
  ok('a full CTF team wipe falls back to authored base deployment',
    Game.prototype._ctfSpawnPoint.call(fakeCtf, 'green') === null);
  fakeCtf.entities = () => [anchor, anchorSupport];
  fakeCtf._openingDeployment = true;
  ok('opening CTF deployments remain at the authored team bases',
    Game.prototype._ctfSpawnPoint.call(fakeCtf, 'green') === null);

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
  ok('spawn scoring rejects a recent-death long-range lane hotspot',
    tacticalSpawnScore({ x: 30, z: 30 }, {
      enemies: [{ x: 100, z: 30 }], recentDeaths: [{ x: 34, z: 30 }],
    }) === -Infinity);

  ok('a regulation CTF lead waits for a live flag play to resolve',
    regulationDecision('ctf', { green: 2, blue: 1 }, { flagsLive: true }).overtime);

  const tdmField = { ownX: 0, enemyX: 200 };
  ok('TDM territorial rules keep waves in the 25%-49% own-side band',
    tdmTerritoryAllowed({ x: 50, z: 0 }, tdmField)
      && tdmTerritoryAllowed({ x: 96, z: 0 }, tdmField)
      && !tdmTerritoryAllowed({ x: 49, z: 0 }, tdmField)
      && !tdmTerritoryAllowed({ x: 97, z: 0 }, tdmField)
      && !tdmTerritoryAllowed({ x: 110, z: 0 }, tdmField)
      && tdmForwardProgress({ x: 50, z: 0 }, tdmField) === 0.25);
  ok('TDM wave projection uses a median front and clamps behind it',
    Math.abs(tdmMedianForwardProgress([{ x: 40, z: 0 }, { x: 120, z: 0 },
      { x: 190, z: 0 }], tdmField) - 0.6) < 1e-9
      && tdmWaveProgress(0.6, { ...tdmField, behind: 12 }) === 96
      && tdmWaveProgress(0.95, { ...tdmField, behind: 10 }) === 96
      && tdmWaveProgress(0.05, { ...tdmField, behind: 10 }) === 50);
  const ownSideFront = tdmMedianForwardProgress(
    [{ x: 60, z: 0 }, { x: 70, z: 0 }, { x: 180, z: 0 }]
      .filter(point => tdmForwardProgress(point, tdmField) < 0.5), tdmField);
  ok('TDM median front can exclude an enemy-half flanker',
    Math.abs(ownSideFront - 0.325) < 1e-9);
  const quietAnchor = { x: 80, z: 0, _combatAt: 0 };
  ok('TDM anchors require own-side safety, combat grace, and squad support',
    tdmAnchorAllowed(quietAnchor, { ...tdmField, now: 10,
      nearbyAllies: [{ x: 92, z: 4 }] })
      && !tdmAnchorAllowed(quietAnchor, { ...tdmField, now: 10 })
      && !tdmAnchorAllowed({ ...quietAnchor, _combatAt: 8 }, { ...tdmField,
        now: 10, nearbyAllies: [{ x: 92, z: 4 }] })
      && !tdmAnchorAllowed(quietAnchor, { ...tdmField, now: 10,
        nearbyAllies: [{ x: 92, z: 4 }], visibleEnemies: 1 })
      && !tdmAnchorAllowed(quietAnchor, { ...tdmField, now: 10,
        nearbyAllies: [{ x: 92, z: 4 }], enemies: [{ x: 85, z: 0 }] })
      && !tdmAnchorAllowed({ ...quietAnchor, x: 180 }, { ...tdmField,
        now: 10, nearbyAllies: [{ x: 192, z: 4 }] }));
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
  group('airstrike contribution reward');
  ok('kills, assists, and objective score share one capped streak meter',
    gainStreak(0, CONTRIBUTION.kill) === 100
      && gainStreak(AIRSTRIKE_COST - 10, 50) === AIRSTRIKE_COST);
  ok('the airstrike is the only reward and unlocks at 700 points',
    availableStreakAbility(AIRSTRIKE_COST - 1) === null
      && availableStreakAbility(AIRSTRIKE_COST) === 'airstrike');
  const cluster = chooseBotAirstrikeTarget([
    { x: 90, z: 100 }, { x: 96, z: 102 }, { x: 180, z: 180 },
  ], [{ x: 92, z: 100 }]);
  const guided = steerBotAirstrike({ x: 60, z: 100 }, { x: 96, z: 100 }, 12);
  ok('bot airstrikes choose enemy clusters and obey bounded guidance',
    cluster?.x === 90 && guided?.x === 72 && guided.z === 100
      && chooseBotAirstrikeTarget([{ x: 40, z: 40 }], []) === null
      && chooseBotAirstrikeTarget([{ x: 90, z: 100 }, { x: 96, z: 102 }], [],
        [{ x: 92, z: 101 }]) === null
      && predictBotAirstrikePoint({ x: 250, z: 2 }, { x: 20, z: -20 }, 0.75, 256, 256)?.x === 256);
  ok('spending the reward preserves legitimate overflow and rejects short meters',
    spendStreak(AIRSTRIKE_COST + 50, AIRSTRIKE_COST) === 50
      && spendStreak(AIRSTRIKE_COST, AIRSTRIKE_COST) === 0
      && spendStreak(AIRSTRIKE_COST - 1, AIRSTRIKE_COST) === null);
  const snapshot = { t: 's', p: [], b: [], c: [0, 0], g: [],
    u: [[0, 650], [2, 0]] };
  ok('contribution meter rows pass the snapshot trust boundary',
    validServerMessage(snapshot)
      && !validServerMessage({ ...snapshot, u: [[0, 701]] })
      && !validServerMessage({ ...snapshot, u: [[0, 500, 0, 0]] }));
  ok('CTF pressure survives migration without accepting forged timer state',
    validServerMessage({ ...snapshot, ct: [1, 820] })
      && validServerMessage({ ...snapshot, ct: null })
      && !validServerMessage({ ...snapshot, ct: [1, 821] })
      && !validServerMessage({ ...snapshot, ct: [2, 10] }));
  ok('retired reward actions and events are rejected at the wire boundary',
    !validClientMessage({ t: 'a', k: 'overcharge', n: 1 })
      && !validServerMessage({ t: 'e', k: 'overcharge', owner: 2,
        phase: 'windup', remaining: 1 }));
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
  group('squad signals, safety, and mastery ranks');
  ok('unit-like tactical directions pass validation', validPingDirection([1, 0, 0]));
  ok('zero and oversized tactical directions are rejected',
    !validPingDirection([0, 0, 0]) && !validPingDirection([9, 0, 0]));
  ok('tactical ping actions pass the client trust boundary',
    validClientMessage({ t: 'a', k: 'mark', d: [0, 0, -1] })
      && !validClientMessage({ t: 'a', k: 'mark', d: [0, 0, 0] }));
  ok('team marks pass the server trust boundary with bounded kinds',
    validServerMessage({ t: 'e', k: 'mark', id: 7, name: 'Scout', team: 'green',
      x: 20, y: 12, z: 30, kind: 'ATTACK' })
      && !validServerMessage({ t: 'e', k: 'mark', id: 8, name: 'SQUAD', team: 'green',
        x: 20, y: 12, z: 30, kind: 'BREACH' })
      && !validServerMessage({ t: 'e', k: 'mark', id: 7, name: 'Scout', team: 'green',
        x: 20, y: 12, z: 30, kind: 'ENEMY_THROUGH_WALL' }));
  ok('retired rematch packets are rejected on both sides of the wire',
    !validClientMessage({ t: 'a', k: 'rematch' })
      && !validServerMessage({ t: 'e', k: 'rematch', voters: ['p0', 'p2'], needed: 2 }));
  ok('vote-kick needs three humans and a strict eligible-voter majority',
    voteKickVotesNeeded(2) === 0 && voteKickVotesNeeded(3) === 2
      && voteKickVotesNeeded(4) === 2 && voteKickVotesNeeded(10) === 5);
  ok('vote-kick requests and live ballots are strictly bounded',
    validClientMessage({ t: 'a', k: 'votekick', target: 3 })
      && !validClientMessage({ t: 'a', k: 'votekick', target: -1 })
      && validServerMessage({ t: 'e', k: 'votekick', active: true, target: 3,
        name: 'Griefer', voters: ['p0', 'p2'], needed: 3, remaining: 24 })
      && validServerMessage({ t: 'e', k: 'votekick', active: false })
      && !validServerMessage({ t: 'e', k: 'votekick', active: false, target: 3 }));
  ok('vote removals use a bounded explicit reason',
    validServerMessage({ t: 'e', k: 'kick', reason: 'vote' })
      && validServerMessage({ t: 'e', k: 'kick', reason: 'resumed' })
      && !validServerMessage({ t: 'e', k: 'kick', reason: 'host-dislikes-you' }));
  ok('callsigns normalize consistently and reject obvious decorated profanity',
    normalizeCallsign('  Àce!!  Unit  ') === 'Ace Unit'
      && callsignIssue('') === 'empty'
      && callsignHasProfanity('sh1t') && callsignHasProfanity('f-u-c-k')
      && callsignHasProfanity('bad-f4gg0t-name') && callsignHasProfanity('fuckyou')
      && !callsignHasProfanity('Scunthorpe')
      && sanitizeCallsign('sh1t', 'Player') === 'Player');
  ok('mastery tier boundaries advance rank without weapon decoration',
    masteryProgress(999).tier.name === 'RECRUIT'
      && masteryProgress(1000).tier.name === 'FIELD'
      && masteryProgress(40000).tier.name === 'LEGEND'
      && !('bands' in masteryProgress(40000).tier));
  ok('mastery reports progress to the next tier',
    masteryProgress(4900).remaining === 100 && masteryProgress(5000).tier.name === 'VETERAN');
}

function engagementFoundationTests() {
  group('phase zero: bounded diagnostics and production feature rollout');
  const defaults = parseEngagementFeatures('');
  const selected = parseEngagementFeatures(
    '?features=FIRSTMINUTE,deathRecap&features=publicChat,notAFeature');
  ok('completed engagement features default on while experiments remain opt-in',
    DEFAULT_ENGAGEMENT_FEATURES.every(name => defaults[name] === true)
      && !defaults.publicChat && !defaults.privateContent
      && !('selectedGoals' in defaults)
      && selected.firstMinute && selected.deathRecap && selected.publicChat && !selected.privateContent
      && !('notAFeature' in selected));
  ok('private content is an explicit URL feature flag',
    parseEngagementFeatures('?features=privateContent').privateContent);
  ok('retired field-goal events are rejected at the protocol boundary',
    !validServerMessage({ t: 'e', k: 'goal', metric: 'fieldwork', amount: 1,
      kind: 'built', voxels: 1 }));
  const baseSnapshot = { t: 's', p: [], b: [], c: [0, 0], g: [] };
  ok('retired feature channels cannot re-enter authoritative snapshots',
    !validServerMessage({ ...baseSnapshot, op: null })
      && !validServerMessage({ ...baseSnapshot, mb: [1, 0, 0] })
      && !validServerMessage({ ...baseSnapshot, bd: [1, 1, 1] })
      && !validServerMessage({ ...baseSnapshot, l: [] })
      && !validServerMessage({ t: 'e', k: 'supply', blocks: 20, nades: 1 }));

  const clean = sanitizeEngagementEvent('match_start', {
    mode: 'ctf', map: 2, network: 'host', source: 'quick', humans: 4, bots: 6,
    round: 3, name: 'private callsign', chat: 'private chat', roomCode: 'ABCD',
    x: 42, z: 19,
  });
  ok('event sanitizer drops identity, chat, room, and position fields',
    clean.mode === 'ctf' && clean.map === 2 && clean.humans === 4
      && !('name' in clean) && !('chat' in clean) && !('roomCode' in clean)
      && !('x' in clean) && !('z' in clean));
  ok('post-match continuation records intent without identity or room data',
    JSON.stringify(sanitizeEngagementEvent('continuation', {
      action: 'ready', name: 'Ada', roomCode: 'TEST', x: 20,
    })) === JSON.stringify({ action: 'ready' }));
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
  ok('TDM orientation sends players to teammates instead of a missing arrow',
    firstMinuteMoveHint('tdm').includes('MIDFIELD')
      && !firstMinuteMoveHint('tdm').includes('GOLD ARROW')
      && firstMinuteMoveHint('ctf').includes('GOLD OBJECTIVE ARROW'));
  ok('signature maps teach their authored voxel decision in one line',
    firstMinuteTerrainCue(0).includes('MIDFIELD BELT')
      && firstMinuteTerrainCue(1).includes('SEAWALL')
      && firstMinuteTerrainCue(2).includes('BROKEN BRIDGE')
      && firstMinuteTerrainCue(3).includes('ARCH')
      && firstMinuteTerrainCue(4).includes('NORTH/SOUTH SPANS')
      && firstMinuteTerrainCue(5).includes('BASALT GATE'));

  const guide = new FirstMinuteGuide();
  ok('orientation starts once per page and never restarts on another round',
    guide.start({ mode: 'ctf', matchSecond: 100, x: 10, z: 10 })
      && !guide.start({ mode: 'tdm', matchSecond: 0, x: 0, z: 0 }));
  guide.mark('shoot'); // natural play can satisfy steps before their cue appears
  let view = guide.update({ matchSecond: 101, x: 11, z: 10 });
  ok('sub-threshold movement keeps the first actionable cue visible',
    view.visible && view.prompt === 'MOVE AND FIRE' && !view.progress.move
      && view.progress.fire);
  view = guide.update({ matchSecond: 102, x: 13, z: 10 });
  ok('completed actions are skipped rather than forcing a rigid tutorial order',
    view.progress.move && view.progress.fire && view.prompt === 'OPEN A ROUTE'
      && view.hint.includes('2 / SPADE'));
  guide.mark('dig');
  view = guide.update({ matchSecond: 103, x: 13, z: 10 });
  ok('successful digging advances to the explicit build lesson',
    view.progress.dig && !view.progress.place && view.prompt === 'BUILD YOUR COVER'
      && view.hint.includes('3 / BLOCKS') && !view.complete);
  guide.mark('place');
  view = guide.update({ matchSecond: 104, x: 13, z: 10 });
  ok('only successful digging and building complete the terrain lesson',
    view.progress.dig && view.progress.place && view.progress.terrain
      && view.prompt === 'FIELD READY' && view.complete);
  ok('unknown inputs cannot advance the guide', !guide.mark('open-menu'));
  view = guide.update({ matchSecond: 105, x: 13, z: 10 });
  ok('all fundamentals produce a short field-ready confirmation',
    view.complete && view.prompt === 'FIELD READY');
  view = guide.update({ matchSecond: 109, x: 13, z: 10 });
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

function terrainContractTests() {
  group('terrain contracts: bounded cosmetic progression');
  ok('exactly three terrain contracts expose session-scale targets',
    TERRAIN_CONTRACTS.length === 3
      && TERRAIN_CONTRACTS.map(c => c.target).join(',') === '10,10,30');
  const clamped = normalizeContractProgress({ dig: -4, place: 99, terrain: 1e9 });
  ok('contract migration clamps malformed and oversized progress',
    clamped.dig === 0 && clamped.place === 10 && clamped.terrain === 30);
  let progress = normalizeContractProgress({});
  for (let i = 0; i < 10; i++) progress = applyTerrainAction(progress, 'dig').progress;
  ok('successful dig progress unlocks the route badge at ten',
    contractSnapshot(progress).find(c => c.id === 'route')?.complete
      && normalizeBadges([], progress).includes('[BR]'));
  const rejected = applyTerrainAction(progress, 'air');
  ok('unknown intent cannot advance a contract',
    JSON.stringify(rejected.progress) === JSON.stringify(progress) && !rejected.completed.length);
  ok('selected badge accepts only an unlocked fixed choice',
    normalizeSelectedBadge('[BR]', ['[BR]']) === '[BR]'
      && normalizeSelectedBadge('[VX]', ['[BR]']) === null);
  ok('callsign decoration preserves the twelve-character raw input',
    decorateCallsign('abcdefghijkl', '[VX]') === '[VX] abcdefghijkl'
      && sanitizeDisplayName('[VX] abcdefghijkl') === '[VX] abcdefghijkl'
      && decorateCallsign('abcdefghijkl', '[VX]').length < 64);
}

function deviceSupportTests() {
  group('device support gating');
  const nav = { maxTouchPoints: 5 };
  ok('touch-only coarse devices are warned before quick match',
    keyboardMouseUnsupported({ navigatorLike: nav,
      matchMediaLike: q => ({ matches: q === '(pointer: coarse)' }) }));
  ok('touch laptops with a fine pointer remain usable',
    !keyboardMouseUnsupported({ navigatorLike: nav,
      matchMediaLike: q => ({ matches: q === '(pointer: coarse)' || q === '(pointer: fine)' }) }));
  ok('ordinary mouse devices are not blocked',
    !keyboardMouseUnsupported({ navigatorLike: { maxTouchPoints: 0 },
      matchMediaLike: () => ({ matches: true }) }));
  const pending = new Map([[4, 'dig'], [5, 'place']]);
  ok('terrain acknowledgements are scoped to the acting roster member',
    consumeTerrainAck(pending, { aid: 4, actor: 8, v: 0 }, 9) === null
      && pending.has(4)
      && consumeTerrainAck(pending, { aid: 4, actor: 9, v: 0 }, 9) === 'dig');
  ok('authoritative action ack clears denied terrain attempts without leaking state',
    clearAckedTerrainActions(pending, 5) === 1 && pending.size === 0);
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

// ---------------------------------------------------------------------------
function damageDirectionTests() {
  group('damage direction: source-facing indicator around the reticle');
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
function snapshotInterestTests() {
  group('snapshot interest filtering: allocation-safe visibility');
  const game = Object.create(Game.prototype);
  game._interestTarget = new THREE.Vector3();
  game._losDirection = new THREE.Vector3();
  let blocked = false, raycasts = 0;
  game.world = {
    raycast() {
      raycasts++;
      return blocked ? { x: 0, y: 0, z: 0 } : null;
    },
  };
  const eye = new THREE.Vector3(4, 6, 8);
  const eyeBefore = eye.clone();
  const nearby = { pos: new THREE.Vector3(5, 5, 8) };
  const nearbyBefore = nearby.pos.clone();
  ok('close-range perception remains true without a terrain raycast',
    game._perceives(eye, nearby) && raycasts === 0);
  ok('interest checks do not mutate the viewer eye or target body position',
    eye.equals(eyeBefore) && nearby.pos.equals(nearbyBefore));

  const distant = { pos: new THREE.Vector3(100, 5, 8) };
  const distantBefore = distant.pos.clone();
  ok('a distant clear sightline remains perceptible', game._perceives(eye, distant));
  blocked = true;
  ok('a distant blocked sightline remains hidden', !game._perceives(eye, distant));
  ok('long-range visibility uses terrain LOS and preserves its inputs',
    raycasts === 2 && eye.equals(eyeBefore) && distant.pos.equals(distantBefore));
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
    validClientMessage({ t: 'a', k: 'strike', n: 1, life: 1, x: 100, z: 120, yaw: 0 })
      && !validClientMessage({ t: 'a', k: 'strike', n: 2, life: 1, x: 100, z: 120 }));
  ok('airstrike telegraph metadata passes the server trust boundary', validServerMessage({
    t: 'e', k: 'telegraph', id: 7, x: 100, y: 20, z: 120,
    yaw: 0, remaining: 3, owner: 2,
  }));
  ok('a non-roster bot owner ID remains a strict valid strike identity', validServerMessage({
    t: 'e', k: 'telegraph', id: 8, x: 100, y: 20, z: 120,
    yaw: 0, remaining: 3, owner: 1000007,
  }));
  const strikeSnapshot = { t: 's', p: [], b: [], c: [0, 0], g: [],
    a: [[7, qx(100), qy(20), qx(120), qa(0), 2500, 2]] };
  ok('active-strike snapshot rows pass validation', validServerMessage(strikeSnapshot));
  ok('bot-owner active-strike rows pass the same strict protocol boundary', validServerMessage({
    ...strikeSnapshot, a: [[8, qx(100), qy(20), qx(120), qa(0), 2500, 1000007]],
  }));
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
  const visibleInTree = object => {
    for (let node = object; node; node = node.parent) if (!node.visible) return false;
    return true;
  };
  let drawCalls = 0, visibleDrawCalls = 0, voxelParts = 0, visibleParts = 0;
  p.group.traverse(o => {
    if (!o.isMesh) return;
    drawCalls++;
    const count = o.userData.voxelPartCount ?? 1;
    voxelParts += count;
    if (visibleInTree(o)) { visibleDrawCalls++; visibleParts += count; }
  });
  ok('soldier keeps its detailed articulated assembly', voxelParts >= 55,
    `${voxelParts} voxel parts`);
  ok('visible soldier voxel parts are consolidated into bounded draw calls',
    visibleDrawCalls <= 28, `${visibleDrawCalls} visible / ${drawCalls} total assemblies`);
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
  triggerSoldierHit(p, -1, 10);
  triggerSoldierFire(p, 10);
  animateSoldier(p, 0, 0, 10.05);
  const reacting = p.torso.rotation.z < 0 && p.head.rotation.z > 0
    && p.gun.rotation.x < 0;
  animateSoldier(p, 0, 0, 10.3);
  ok('hit and firing reactions are readable, brief, and reuse existing groups',
    reacting && p.torso.rotation.z === 0 && p.head.rotation.z === 0
      && p.gun.rotation.x === 0);
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
  ok('default visible complexity remains bounded', visibleParts < 45,
    `${visibleParts} visible voxel parts`);
  applySoldierGraphics(p, 'low');
  let liveLowParts = 0;
  p.group.traverse(o => {
    if (o.isMesh && visibleInTree(o)) liveLowParts += o.userData.voxelPartCount ?? 1;
  });
  ok('graphics changes apply to an already-spawned soldier', liveLowParts <= visibleParts - 8,
    `${visibleParts} -> ${liveLowParts} visible parts`);
  applySoldierGraphics(p, 'high');
  let shadowReads = 0;
  const shadowWorld = { revision: 0,
    solid: (_x, y) => { shadowReads++; return y === 5; } };
  p.group.position.set(10.5, 10, 10.5);
  placeShadow(p, shadowWorld);
  const initialShadowReads = shadowReads;
  placeShadow(p, shadowWorld);
  const cachedShadowReads = shadowReads;
  shadowWorld.revision++;
  placeShadow(p, shadowWorld);
  ok('soldier shadow scans cache unchanged terrain and invalidate after an edit',
    initialShadowReads > 0 && cachedShadowReads === initialShadowReads
      && shadowReads > cachedShadowReads);
  disposeObject(p.group);

  const hadStorage = 'localStorage' in globalThis;
  const priorStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => key === 'tos.gfx' ? 'low' : null };
  const low = makeSoldier(0x4e8b57);
  let lowVisible = 0;
  low.group.traverse(o => {
    if (o.isMesh && visibleInTree(o)) lowVisible += o.userData.voxelPartCount ?? 1;
  });
  ok('low graphics removes only nonessential soldier detail',
    lowVisible <= visibleParts - 8, `${visibleParts} -> ${lowVisible} visible parts`);
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

  const sweepWorld = floorAt(30);
  for (let y = 31; y <= 33; y++)
    sweepWorld.data[(y * SZ + 50) * SX + 50] = BLOCK.STONE;
  const sweepBody = new Body(sweepWorld, 48.5, 31, 50.5);
  ok('swept validation catches a wall between clear endpoints',
    sweepBody.sweptOverlapsSolid(48.5, 31, 50.5, 51.5, 31, 50.5));
  ok('swept validation permits an unobstructed report',
    !sweepBody.sweptOverlapsSolid(48.5, 31, 48.5, 49.2, 31, 48.5));

  const sweptStep = floorAt(30);
  sweptStep.data[(31 * SZ + 50) * SX + 50] = BLOCK.STONE;
  const stepBody = new Body(sweptStep, 49.2, 31, 50.5);
  ok('swept validation preserves a legal one-block step',
    !stepBody.sweptOverlapsSolid(49.2, 31, 50.5, 50.5, 32.001, 50.5));

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
  ok('only welcome and snapshot packets count as host heartbeat traffic',
    hostHeartbeatMessage({ t: 'w' }) && hostHeartbeatMessage({ t: 's' })
      && !hostHeartbeatMessage({ t: 'r' }) && !hostHeartbeatMessage({ t: 'e' })
      && !hostHeartbeatMessage({ t: 'full' }) && !hostHeartbeatMessage({ t: 'version' })
      && !hostHeartbeatMessage({ t: 'sync' }));
  const net = new Net();
  let sent = 0;
  net.conns = new Map([['p', { open: true, dataChannel: { bufferedAmount: 32 }, send: () => sent++ }]]);
  net.sendTo('p', { t: 'e', k: 'hit' });
  const stats = net.stats(net.telemetry.startedAt + 1000);
  ok('network telemetry records packets, bytes, rate, and queue depth',
    sent === 1 && stats.sentPackets === 1 && stats.sentBytes > 0
      && Math.abs(stats.sentBytesPerSecond - stats.sentBytes) < 0.001
      && stats.peakBuffered === 32);
  const throwingNet = new Net();
  throwingNet.conns = new Map([['p', { open: true, send: () => { throw new Error('closed'); } }]]);
  let threw = false, sendResult;
  try { sendResult = throwingNet.sendTo('p', { t: 'e', k: 'hit' }); }
  catch { threw = true; }
  const throwingStats = throwingNet.stats();
  ok('synchronous WebRTC send races fail quietly without false packet telemetry',
    sendResult === false && !threw && throwingStats.sendErrors === 1
      && throwingStats.sentPackets === 0);
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
    validClientMessage({ t: 'a', k: 'reload', n: 1, life: 1 })
      && !validClientMessage({ t: 'a', k: 'reload' })
      && !validClientMessage({ t: 'a', k: 'shoot', n: 0, life: 1, d: [1, 0, 0] }));
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

// ---------------------------------------------------------------------------
async function iceConfigTests() {
  group('ice configuration');
  const cloudflare = { iceServers: [{
    urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp',
      'turns:turn.cloudflare.com:5349?transport=tcp'],
    username: 'user', credential: 'secret' }] };

  ok('a cloudflare credential payload validates into one server entry',
    usableIceServers(cloudflare).length === 1
      && usableIceServers(cloudflare)[0].urls.length === 3
      && usableIceServers(cloudflare)[0].credential === 'secret');
  ok('a single object payload is accepted like a one-entry list',
    usableIceServers({ iceServers: { urls: 'turn:turn.cloudflare.com:3478',
      username: 'u', credential: 'c' } }).length === 1);
  ok('entries without a usable url are dropped before reaching WebRTC',
    usableIceServers({ iceServers: [{ username: 'u' }, { urls: [] }, null, 'nope',
      { urls: [7] }] }).length === 0);
  ok('non-ICE urls and credential-free TURN entries are rejected',
    usableIceServers({ iceServers: [
      { urls: ['https://relay.invalid', 'turn:relay.invalid'] },
      { urls: ['stun:stun.example.test', 'turns:turn.example.test'],
        username: 'u', credential: 'c' },
    ] }).flatMap(s => s.urls).join(',') === 'stun:stun.example.test,turns:turn.example.test');
  ok('a junk payload yields no servers',
    usableIceServers(null).length === 0 && usableIceServers({}).length === 0);

  resetIce();
  ok('peers take PeerJS defaults until credentials arrive', peerOptions() === undefined);

  let calls = 0;
  const stub = async () => { calls++; return { ok: true, json: async () => cloudflare }; };
  const primed = await primeIce({ endpoint: 'https://ice.test/ice', fetch: stub, now: 1000 });
  ok('primed credentials reach peer options',
    primed.length === 1 && peerOptions()?.config?.iceServers?.length === 1);
  await primeIce({ endpoint: 'https://ice.test/ice', fetch: stub, now: 2000 });
  ok('a warm cache is not refetched', calls === 1);

  const refreshFailed = async () => { throw new Error('expired'); };
  await primeIce({ endpoint: 'https://ice.test/ice', fetch: refreshFailed,
    now: 1000 + 60 * 60 * 1000 });
  ok('expired relay credentials are not reused after a failed refresh',
    peerOptions() === undefined);

  resetIce();
  const offline = async () => { throw new Error('offline'); };
  ok('a failed credential fetch falls back to stun rather than throwing',
    (await primeIce({ endpoint: 'https://ice.test/ice', fetch: offline, now: 1000 })).length === 0
      && peerOptions() === undefined);

  resetIce();
  const refused = async () => ({ ok: false, json: async () => ({}) });
  ok('a non-200 from the credential worker yields no servers',
    (await primeIce({ endpoint: 'https://ice.test/ice', fetch: refused, now: 1000 })).length === 0);
  resetIce();
  let failedCalls = 0;
  const failedStub = async () => { failedCalls++; return { ok: false, json: async () => ({}) }; };
  await primeIce({ endpoint: 'https://ice.test/ice', fetch: failedStub, now: 2000 });
  await primeIce({ endpoint: 'https://ice.test/ice', fetch: failedStub,
    now: 2000 + ICE_FAILURE_CACHE_MS - 1 });
  ok('TURN failures use a short negative cache', failedCalls === 1);
  await primeIce({ endpoint: 'https://ice.test/ice', fetch: failedStub,
    now: 2000 + ICE_FAILURE_CACHE_MS });
  ok('TURN failure cache retries after its expiry', failedCalls === 2);
  resetIce();
  await primeIce({ endpoint: 'https://ice.test/ice', fetch: failedStub, now: 3000 });
  resetIce();
  await primeIce({ endpoint: 'https://ice.test/ice', fetch: failedStub, now: 3001 });
  ok('resetIce clears the TURN failure cache', failedCalls === 4);
  resetIce();

  // Regression: probes share one guest peer, so every probe's handler sees
  // every peer-level error. Treating an ICE failure as signaling failure took
  // down all eight probes and reported quick match as offline.
  ok('connection-level errors wait for the affected data channel',
    probeErrorKind('webrtc') === 'ignore');
  ok('an unknown peer error cannot kill every probe sharing that peer',
    probeErrorKind('something-new') === 'ignore' && probeErrorKind(undefined) === 'ignore');
  ok('genuine signaling failures still report the service down',
    ['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected']
      .every(t => probeErrorKind(t) === 'down'));
  ok('peer-unavailable stays distinguishable so a miss can be attributed',
    probeErrorKind('peer-unavailable') === 'unavailable');

  // Regression: claiming had the same asymmetry as probing. A slot that would
  // not take — a lost race, an ICE failure, or a claim that simply timed out —
  // reported the whole matchmaking service as unreachable instead of moving on.
  ok('a claim timing out or failing on ICE frees the search to try the next slot',
    claimErrorKind('webrtc') === 'busy' && claimErrorKind('anything-else') === 'busy');
  ok('losing the race for an id is still reported as taken, not as an outage',
    claimErrorKind('unavailable-id') === 'taken');
  ok('only signaling transport failures abandon the whole search',
    ['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected']
      .every(t => claimErrorKind(t) === 'down'));
}

async function matchmakingSetupFailureTests() {
  group('matchmaking setup failures stay bounded');
  const hadPeer = Object.prototype.hasOwnProperty.call(globalThis, 'Peer');
  const oldPeer = globalThis.Peer;
  const hadFetch = Object.prototype.hasOwnProperty.call(globalThis, 'fetch');
  const oldFetch = globalThis.fetch;
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const oldWindow = globalThis.window;
  try {
    globalThis.window = {};
    globalThis.fetch = async () => { throw new Error('offline'); };
    resetIce();
    globalThis.Peer = class ThrowingPeer {
      constructor() { throw new Error('peer constructor'); }
    };
    const quick = await Net.quickScan('TEST', undefined, 10, 50);
    const rooms = await Net.roomScan(0, 10);
    const claim = await Net._claim('PUB0', 10);
    ok('quick scan normalizes a synchronous Peer constructor failure', quick.kind === 'down');
    ok('room scan normalizes a synchronous Peer constructor failure', rooms.kind === 'down');
    ok('public slot claims normalize a synchronous Peer constructor failure', claim.kind === 'down');

    let destroyed = 0;
    class ConnectThrowsPeer {
      constructor() { this.handlers = new Map(); }
      on(kind, handler) {
        this.handlers.set(kind, handler);
        if (kind === 'open') queueMicrotask(handler);
      }
      off() {}
      connect() { throw new Error('connection setup'); }
      destroy() { destroyed++; }
    }
    globalThis.Peer = ConnectThrowsPeer;
    const quickConnect = await Net.quickScan('TEST', undefined, 10, 50);
    const roomConnect = await Net.roomScan(0, 10);
    ok('quick scan normalizes a synchronous connection setup failure', quickConnect.kind === 'down');
    ok('room scan normalizes a synchronous connection setup failure', roomConnect.kind === 'down');
    const probePeer = new ConnectThrowsPeer();
    const knockPeer = new ConnectThrowsPeer();
    const probe = await Net._probe(probePeer, 'PUB0', 10);
    const knock = await Net._knock(knockPeer, 'PUB0', 'TEST', undefined, 10);
    ok('probe setup failures resolve as down instead of rejecting', probe.kind === 'down');
    ok('knock setup failures resolve as down instead of rejecting', knock.kind === 'down');
    await new Promise(resolve => setTimeout(resolve, 30));
    ok('failed scans destroy their temporary peers', destroyed >= 2);
    ok('failed probe and knock setup leave no delayed timeout exception', destroyed >= 2);

    class SynchronousSignalPeer {
      constructor() { this.connectCalls = 0; }
      on(kind, handler) {
        if (kind === 'error') handler({ type: 'network' });
      }
      off() {}
      connect() { this.connectCalls++; throw new Error('must not connect'); }
    }
    const syncProbePeer = new SynchronousSignalPeer();
    const syncKnockPeer = new SynchronousSignalPeer();
    const syncProbe = await Net._probe(syncProbePeer, 'PUB0', 10);
    const syncKnock = await Net._knock(syncKnockPeer, 'PUB0', 'TEST', undefined, 10);
    ok('synchronous peer errors do not create a probe connection',
      syncProbe.kind === 'down' && syncProbePeer.connectCalls === 0);
    ok('synchronous peer errors do not create a knock connection',
      syncKnock.kind === 'down' && syncKnockPeer.connectCalls === 0);

    const openOffs = [];
    const openConn = {
      on(kind, handler) { if (kind === 'open') handler(); },
      off(kind) { openOffs.push(kind); },
      send() {},
      close() {},
    };
    const openPeer = {
      on() {},
      off() {},
      connect() { return openConn; },
    };
    await Net._probe(openPeer, 'PUB0', 5);
    await new Promise(resolve => setTimeout(resolve, 10));
    ok('probe cleanup removes the named open listener', openOffs.includes('open'));
  } finally {
    resetIce();
    if (hadPeer) globalThis.Peer = oldPeer;
    else delete globalThis.Peer;
    if (hadFetch) globalThis.fetch = oldFetch;
    else delete globalThis.fetch;
    if (hadWindow) globalThis.window = oldWindow;
    else delete globalThis.window;
  }
}

function productionReadinessTests() {
  group('automatic graphics selection and anonymous field diagnostics');
  ok('healthy representative hardware selects High while overloaded hardware selects Medium',
    automaticGraphicsLevel({ sampledFrames: 180, frameP95Ms: 16.7,
      longFrameRate: 0, drawCalls: 400, triangles: 400000 }) === 'high'
      && automaticGraphicsLevel({ sampledFrames: 180, frameP95Ms: 34,
        longFrameRate: .1, drawCalls: 900, triangles: 1e6 }) === 'medium');
  ok('short samples cannot permanently select a graphics tier',
    automaticGraphicsLevel({ sampledFrames: 119, frameP95Ms: 1,
      longFrameRate: 0, drawCalls: 1, triangles: 1 }) === null);
  const benchmark = new FirstSessionGraphicsBenchmark({ warmup: 2, samples: 120 });
  benchmark.frame(200, { eligible: false, drawCalls: 5000, triangles: 9e6 });
  benchmark.frame(100, { drawCalls: 5000, triangles: 9e6 });
  benchmark.frame(100, { drawCalls: 5000, triangles: 9e6 });
  let result = null;
  for (let i = 0; i < 120; i++) result = benchmark.frame(16,
    { drawCalls: 300, triangles: 250000 });
  ok('background frames are ignored and warmup frames do not poison the benchmark',
    result?.level === 'high' && result.sample.sampledFrames === 120
      && result.sample.drawCalls === 300);

  const fingerprint = errorFingerprint(new Error('failed at https://secret.example/room/ABC:12:9'));
  const crash = sanitizeTelemetryEvent('crash', { kind: 'error', fingerprint,
    callsign: 'must-not-survive' });
  ok('client diagnostics retain only a fixed anonymous schema',
    /^[a-f0-9]{8}$/.test(fingerprint) && crash.callsign === undefined
      && sanitizeTelemetryEvent('migration', { outcome: 'bogus', reason: 'other' }) === null);
  const envelope = telemetryEnvelope('p14', [crash, {
    type: 'match_abandon', reason: 'pagehide', seconds: 91, room: 'secret',
  }]);
  ok('telemetry buckets elapsed time and passes the independent edge schema',
    envelope.events[1].time === 1 && envelope.events[1].room === undefined
      && validDiagnosticsEnvelope(envelope));
  const funnelEnvelope = telemetryEnvelope('p14', [{ type: 'funnel', step: 'first_dig',
    seconds: 142, player: 'Ada', room: 'secret', position: [1, 2, 3], text: 'nope' }]);
  ok('funnel telemetry drops private fields and exactly matches the edge schema',
    funnelEnvelope.events[0].step === 'first_dig' && funnelEnvelope.events[0].time === 2
      && Object.keys(funnelEnvelope.events[0]).join(',') === 'type,step,time'
      && validDiagnosticsEnvelope(funnelEnvelope)
      && !validDiagnosticsEnvelope({ ...funnelEnvelope,
        events: [{ ...funnelEnvelope.events[0], session: 'no' }] }));
  const transport = [];
  const telemetry = new ProductionTelemetry({ build: 'p14', sample: true,
    fetcher: async (...args) => { transport.push(args); return { ok: true }; } });
  telemetry.record('frame_budget', { tier: 'medium', result: 'fail', frame: 3, long: 2 });
  ok('a bounded payload can flush without adding a session or player identifier',
    telemetry.flush({ beacon: null }) && transport.length === 1
      && !transport[0][1].body.includes('session') && !transport[0][1].body.includes('player'));
  const batches = [];
  const batching = new ProductionTelemetry({ build: 'p14', sample: true,
    fetcher: async (...args) => { batches.push(args); return { ok: true }; } });
  for (const step of ['opened', 'play_selected', 'joined', 'playable_match',
    'first_spawn', 'first_shoot', 'first_dig', 'first_death'])
    batching.record('funnel', { step, seconds: 12 });
  ok('funnel milestones auto-flush before the fixed event ring can fill',
    batches.length === 1 && batching.events.length === 0
      && JSON.parse(batches[0][1].body).events.length === 8);
  const funnelCalls = [];
  const funnelGame = Object.assign(Object.create(Game.prototype), {
    _funnelSeen: new Set(), matchElapsed: 42,
    fieldTelemetry: { record: (type, data) => { funnelCalls.push([type, data]); return true; } },
  });
  funnelGame.funnel('first_spawn');
  funnelGame.funnel('first_spawn');
  funnelGame._funnelSeen.clear(); // rebuild starts a new anonymous round
  funnelGame.funnel('first_spawn');
  ok('game funnel milestones are exactly once per round and reset for the next',
    funnelCalls.length === 2 && funnelCalls.every(([type, data]) =>
      type === 'funnel' && data.step === 'first_spawn' && data.seconds === 42));

  const base = team => `base:${team}`;
  ok('the extracted spawn policy preserves preference, mode, and safe fallback order',
    chooseSpawn({ mode: 'ctf', base, ctf: () => 'front', dynamic: () => null },
      'green') === 'front'
      && chooseSpawn({ mode: 'tdm', base, ctf: () => null, dynamic: () => null },
        'blue') === 'base:blue'
      && chooseSpawn({ mode: 'ctf', base, ctf: () => 'front', dynamic: () => null },
        'green', 'base') === 'base:green');
  const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const entity = { alive: true, carrier: false, body: { pos: { x: 0, z: 0 } } };
  ok('the extracted CTF controller keeps pickup, return, then capture precedence',
    ctfFlagInteraction(entity, { state: 'home', home: { x: 0, z: 0 } },
      { state: 'home', pos: { x: 1, z: 0 } }, (e, p) => distance(e.body.pos, p)) === 'pickup'
      && ctfFlagInteraction(entity, { state: 'dropped', pos: { x: 1, z: 0 } },
        { state: 'carried', pos: { x: 9, z: 0 } }, (e, p) => distance(e.body.pos, p)) === 'return');
  const clock = advanceMatchClock({ over: false, overtime: false, elapsed: 9,
    remaining: .1 }, .2, () => ({ winner: 'green' }));
  ok('the extracted lifecycle controller crosses regulation exactly once',
    clock.elapsed === 9.2 && clock.remaining === 0
      && clock.event[0] === 'end' && clock.event[1] === 'green');
}

function atmosphereCadenceTests() {
  group('atmosphere animation cadence');
  ok('graphics tiers expose the intended ambient update budgets',
    Math.abs(atmosphereCadence('high') - 1 / 30) < 1e-12
      && Math.abs(atmosphereCadence('medium') - 1 / 24) < 1e-12
      && Math.abs(atmosphereCadence('low') - 1 / 15) < 1e-12);

  const w = new VoxelWorld(scene());
  const pos = w.water.geometry.attributes.position;
  const colors = w.water.geometry.attributes.color;
  ok('the first sky call updates immediately', w.animateSky(10) === true);
  const afterFirstPosition = pos.version, afterFirstColors = colors.version;
  ok('sky work is suppressed before its next cadence deadline',
    w.animateSky(10.01) === false
      && pos.version === afterFirstPosition && colors.version === afterFirstColors);
  const beforeDuePosition = pos.version, beforeDueColors = colors.version;
  ok('sky work resumes on the due tick',
    w.animateSky(10 + 1 / 30) === true
      && pos.version > beforeDuePosition && colors.version > beforeDueColors);
  const beforeRewindPosition = pos.version, beforeRewindColors = colors.version;
  ok('a time rewind safely re-anchors and refreshes atmosphere',
    w.animateSky(2) === true
      && pos.version > beforeRewindPosition && colors.version > beforeRewindColors);
  w.applyGraphics('low');
  const beforeLivePosition = pos.version, beforeLiveColors = colors.version;
  ok('a live graphics-tier change applies cadence immediately',
    w.animateSky(2.001) === true
      && pos.version > beforeLivePosition && colors.version > beforeLiveColors);
  const beforeLowEarlyPosition = pos.version, beforeLowEarlyColors = colors.version;
  ok('the live low-tier cadence suppresses an early follow-up tick',
    w.animateSky(2.01) === false
      && pos.version === beforeLowEarlyPosition && colors.version === beforeLowEarlyColors);
  w.dispose();
}

function combatNetworkContinuityTests() {
  group('latency compensation and reconnect continuity');
  ok('combat history cadence is capped at 30Hz with an accumulator',
    !combatHistoryDue(0, 0.01) && combatHistoryDue(0.02, 0.02)
      && !combatHistoryDue(0.02, 0.01, 1 / 30));
  ok('rewind includes interpolation delay and remains hard-capped',
    Math.abs(rewindSecondsForRtt(0.12) - 0.21) < 1e-9
      && rewindSecondsForRtt(9) === MAX_REWIND_SECONDS);
  const history = [];
  recordPose(history, 1, { pos: { x: 0, y: 3, z: 4 }, half: { h: 1.7 } });
  recordPose(history, 1.1, { pos: { x: 10, y: 5, z: 8 }, half: { h: 1.1 } });
  const middle = samplePose(history, 1.05);
  ok('historical hitboxes interpolate position and crouch height',
    Math.abs(middle.x - 5) < 1e-9 && Math.abs(middle.y - 4) < 1e-9
      && Math.abs(middle.h - 1.4) < 1e-9);
  const sent = new Map([[7, 2], [8, 2.1]]);
  const measured = observeSnapshotRtt(sent, 8, 2.22);
  ok('RTT comes only from a sequence the host actually sent',
    Math.abs(measured - 0.12) < 1e-9 && sent.size === 0
      && observeSnapshotRtt(new Map([[9, 2]]), 99, 2.2, measured) === measured);
  ok('state echoes are strict bounded protocol fields',
    validClientMessage({ t: 's', x: 1, y: 2, z: 3, yaw: 0, tool: 0, c: 0, life: 1, echo: 3 })
      && !validClientMessage({ t: 's', x: 1, y: 2, z: 3, yaw: 0, tool: 0, c: 0, life: 1, echo: 0 }));

  const token = createResumeToken(crypto.webcrypto);
  const reservation = { token, expiresAt: 1200 };
  ok('reload tokens are unguessable-shaped and accepted only during their grace window',
    validResumeToken(token) && reservationMatches(reservation, token, 1199)
      && !reservationMatches(reservation, token, 1201)
      && !reservationMatches(reservation, token + 'x', 1199));
  ok('handshakes accept a valid resume token and reject loose shapes',
    validClientMessage({ t: 'hi', v: PROTOCOL_VERSION, name: 'Ada', resume: token })
      && !validClientMessage({ t: 'hi', v: PROTOCOL_VERSION, name: 'Ada', resume: 'short' }));
}

async function turnWorkerTests() {
  group('turn credential worker');
  ok('production, Pages previews, and local development origins are recognized',
    originAllowed('https://spadefall.io')
      && originAllowed('https://build-123.spadefall.pages.dev')
      && originAllowed('http://localhost:8000'));
  ok('lookalike, insecure, and absent origins are rejected',
    !originAllowed('https://spadefall.io.attacker.test')
      && !originAllowed('http://spadefall.io') && !originAllowed(undefined));

  const payload = { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] },
    { urls: ['turn:turn.cloudflare.com:3478'], username: 'user', credential: 'secret' }] };
  let minted = 0, limited = 0;
  const fetcher = async () => { minted++; return new Response(JSON.stringify(payload), {
    status: 201, headers: { 'content-type': 'application/json' } }); };
  const env = { TURN_API_TOKEN: 'server-secret', TURN_RATE_LIMITER: {
    limit: async ({ key }) => { limited++; return { success: key === '203.0.113.5' }; },
  } };
  const request = () => new Request('https://turn.example/ice', { headers: {
    origin: 'https://spadefall.io', 'cf-connecting-ip': '203.0.113.5',
  } });
  const response = await handleTurnRequest(request(), env, fetcher);
  const body = await response.json();
  ok('an allowed, rate-limited request receives an uncached credential response',
    response.status === 200 && body.iceServers.length === 2
      && response.headers.get('cache-control') === 'no-store' && minted === 1 && limited === 1);
  await handleTurnRequest(request(), env, fetcher);
  ok('credentials are minted per request instead of shared across players', minted === 2);

  const nativeFetch = globalThis.fetch;
  try {
    globalThis.fetch = fetcher;
    const runtimeResponse = await turnWorker.fetch(request(), env, { waitUntil() {} });
    ok('the module handler does not mistake Cloudflare execution context for fetch',
      runtimeResponse.status === 200 && minted === 3);
  } finally { globalThis.fetch = nativeFetch; }

  const forbidden = await handleTurnRequest(new Request('https://turn.example/ice', {
    headers: { origin: 'https://attacker.test' },
  }), env, fetcher);
  ok('unexpected origins are rejected before rate limiting or minting',
    forbidden.status === 403 && minted === 3 && limited === 3
      && !forbidden.headers.has('access-control-allow-origin'));
  const wrongPath = await handleTurnRequest(new Request('https://turn.example/nope', {
    headers: { origin: 'https://spadefall.io' },
  }), env, fetcher);
  ok('only the credential route is exposed', wrongPath.status === 404);
  const missingBinding = await handleTurnRequest(request(), { TURN_API_TOKEN: 'server-secret' }, fetcher);
  ok('a missing edge rate limiter fails closed', missingBinding.status === 500);
  const rateLimited = await handleTurnRequest(request(), { ...env, TURN_RATE_LIMITER: {
    limit: async () => ({ success: false }),
  } }, fetcher);
  ok('excess credential requests receive a bounded retry response',
    rateLimited.status === 429 && rateLimited.headers.get('retry-after') === '60');
  const limiterDown = await handleTurnRequest(request(), { ...env, TURN_RATE_LIMITER: {
    limit: async () => { throw new Error('edge binding down'); },
  } }, fetcher);
  ok('a failed edge limiter cannot fail open', limiterDown.status === 503);

  const points = [];
  const diagnosticsEnv = {
    DIAGNOSTICS_RATE_LIMITER: { limit: async () => ({ success: true }) },
    GAME_ANALYTICS: { writeDataPoint: point => points.push(point) },
  };
  const diagnosticsBody = telemetryEnvelope('p14', [{ type: 'connection_failure',
    stage: 'ice', reason: 'timeout', relay: 'unknown' }]);
  const diagnosticsRequest = body => new Request('https://turn.example/diagnostics', {
    method: 'POST', headers: { origin: 'https://spadefall.io',
      'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.5' }, body,
  });
  const accepted = await handleTurnRequest(diagnosticsRequest(JSON.stringify(diagnosticsBody)),
    diagnosticsEnv, fetcher);
  ok('the diagnostics edge accepts and stores a strict anonymous event',
    accepted.status === 204 && points.length === 1
      && points[0].indexes[0] === 'connection_failure');
  const rejected = await handleTurnRequest(diagnosticsRequest(JSON.stringify({
    ...diagnosticsBody, player: 'Ada',
  })), diagnosticsEnv, fetcher);
  ok('the diagnostics edge rejects identity fields rather than storing them',
    rejected.status === 400 && points.length === 1);
}

export async function run() {
  await iceConfigTests();
  await matchmakingSetupFailureTests();
  await turnWorkerTests();
  collapseTests();
  wireTests();
  networkSyncTests();
  combatNetworkContinuityTests();
  securityPhaseTests();
  releasePhaseTests();
  productionReadinessTests();
  atmosphereCadenceTests();
  audioPaletteTests();
  mapgenTests();
  raycastTests();
  meshingTests();
  hostileInputTests();
  multiplayerRuleTests();
  botRuleTests();
  pacingRuleTests();
  combatFlowTests();
  contributionRuleTests();
  kothRuleTests();
  streakRuleTests();
  matchReportTests();
  terrainContractTests();
  socialProgressionTests();
  engagementFoundationTests();
  firstMinuteTests();
  deviceSupportTests();
  voxelStoryTests();
  deathRecapTests();
  stayAsSquadTests();
  teamBalanceTests();
  damageDirectionTests();
  snapshotInterestTests();
  airstrikeDroneTests();
  soldierModelTests();
  bodyTests();
  environmentalDamageTests();
  timings();
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(fail ? '\nRegression failures remain.\n' : '\nAll green.\n');
  return fail ? 1 : 0;
}
