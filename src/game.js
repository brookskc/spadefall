// game.js — orchestration: combat, flags, grenades, score, HUD.
// Modes: 'solo' (local only), 'host' (authoritative, broadcasts), 'client' (thin).
import * as THREE from 'three';
import { VoxelWorld, SEA, SX, SY, SZ, BLOCK, PALETTE, skyGradient } from './world.js';
import { generateMap, BASE, MAPS, mapsForMode, mapAtmosphere,
  clampToEnvelope, envelopeContains, mapEnvelope, signatureProtectedAreas } from './mapgen.js';
import { contentAvailable, publicContentAvailable } from './content-gating.js';
import { Player, TOOLS, GUN_CLASSES } from './player.js';
import { Bot, reserveBotId } from './bots.js';
import { Effects } from './effects.js';
import { sfx, setListener } from './audio.js';
import { BODY_HALF_WIDTH, CROUCH_HEIGHT, EYE_INSET, STAND_HEIGHT, disposeObject, footDust,
  applySoldierGraphics, makeMq9Drone, retintVoxelBoxes, setSoldierTool,
  triggerSoldierFire, triggerSoldierHit } from './entities.js';
import { Avatar } from './avatar.js';
import { RemotePlayer } from './remote-player.js';
import { stats } from './stats.js';
import { MAX_HUMANS as HUMAN_CAP, chooseTeam, parseSpawnRow, spawnRow,
  teamSizeForMode,
  teamCounts, validateMovementReport, createMovementBudget, normalizeDirection,
  migrationSurvivors, combatDamageAllowed, protectedBuildReason } from './multiplayer.js';
import { PROTOCOL_VERSION, validClientMessage, validServerMessage } from './protocol.js';
import { teamHex } from './settings.js';
import { BREATH_MAX, fallDamageForImpact, impactSpeedForFallDistance,
  resetEnvironmentalState, stepBreath } from './environment.js';
import { CTF_SPAWN, FLAG_RETURN_TIME, KOTH_SPAWN, PUBLIC_TDM_SPAWN, TDM_SPAWN, ctfAnchorAllowed,
  ctfFrontlineAllowed, ctfMedianForwardProgress, ctfObjectiveKind, ctfWaveProgress,
  kothAnchorAllowed, kothCandidateDirectionalAllowed, kothMedianApproachDepth,
  kothWaveApproachDepth,
  modeMatchSeconds, regulationDecision, respawnWaveDelay, scoreLeader,
  tacticalSpawnScore, tdmAnchorAllowed, tdmMedianForwardProgress,
  tdmForwardProgress, tdmTerritoryAllowed, tdmWaveProgress } from './pacing.js';
import { assistCreditors, CONTRIBUTION, contributionRow,
  rankContributionRows } from './scoring.js';
import { HILL_MOVE_WARNING, nextHillIndex,
  occupiedScoringTeam, stepHillCapture, stepHillRotation } from './koth.js';
import { AIRSTRIKE_COST, availableStreakAbility, chooseBotAirstrikeTarget,
  gainStreak, predictBotAirstrikePoint, spendStreak, steerBotAirstrike } from './streaks.js';
import { buildMatchReport } from './match-report.js';
import { staySquadGroups, staySquadState,
  TEAM_PING_COOLDOWN, TEAM_PING_LIMIT, TEAM_PING_RANGE, TEAM_PING_TTL,
  VOTE_KICK_COOLDOWN, VOTE_KICK_DURATION, voteKickVotesNeeded } from './social.js';
import { sanitizeDisplayName } from './callsign.js';
import { assignBotRoles, botsForSquadOrder, botDifficultyCode, botDifficultyKey,
  botTelemetrySummary, ctfFinalApproachPolicy, scheduleBotBrains } from './bot-rules.js';
import { WORLD_HASH_SEED, advanceWorldHash, snapshotDisposition,
  worldEventDisposition, worldLogHash } from './network-sync.js';
import { SECURED_ACTIONS, actionSequenceDisposition, aimYawDelta, authorizeReload,
  authorizeWeaponFire, integritySummary, recordIntegrityViolation,
  settleReload } from './security.js';
import { FirstMinuteGuide, consumeTerrainAck,
  clearAckedTerrainActions } from './first-minute.js';
import { VoxelStoryTracker, voxelBattleStory } from './voxel-stories.js';
import { NEXT_BATTLE_CHOICES, nextBattleChoices, resolveBattleVote,
  validBattleChoice, validBattleChoices } from './next-battle.js';
import { deathRecapCopy, makeDeathRecap } from './death-recap.js';
import { balanceHumanTeams } from './team-balance.js';
import { da, dx, dy, qa, qx, qy, rowsEqual as rowsEq,
  mergeSnapshot } from './replication.js';
import { collapseKey, unsupportedCollapseCells } from './simulation.js';
import { CAP_TIME, HILL_CYCLE, MATCH_TIME_OVERRIDE,
  WIN_SCORE, holdClock, modeScoreLimit } from './match-modes.js';
import { PresentationSchedule } from './presentation.js';
import { contactCue, ctfEscalation, intensityCue,
  nextBotDifficulty, usefulVoxelAction } from './combat-flow.js';
import { observeSnapshotRtt, recordPose, rewindSecondsForRtt,
  samplePose } from './lag-compensation.js';
import { RECONNECT_GRACE_MS, reservationMatches, validResumeToken } from './reconnect.js';
import { createHud } from './hud.js';
import { chooseSpawn } from './spawn-controller.js';
import { ctfFlagInteraction } from './objectives.js';
import { advanceMatchClock } from './match-lifecycle.js';

export { qa, qx, qy, mergeSnapshot, unsupportedCollapseCells };

// Only authoritative welcome and snapshot packets prove that the host is
// still advancing the live match. Roster, event, repair, and version traffic
// can remain valid while snapshots are stalled, so they must not quiet the
// client's snapshot-silence watchdog.
export const hostHeartbeatMessage = message =>
  message?.t === 'w' || message?.t === 's';

// Keep authoritative combat history on a fixed 30Hz cadence instead of tying
// its sample count to the render refresh rate. The boolean is deliberately
// pure so cadence changes can be regression-tested without constructing Game.
export function combatHistoryDue(accumulator, dt, interval = 1 / 30) {
  return Number.isFinite(accumulator) && Number.isFinite(dt)
    && Number.isFinite(interval) && interval > 0
    && Math.max(0, accumulator) + Math.max(0, dt) >= interval;
}

const QUERY = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
const teamCss = team => '#' + teamHex(team).toString(16).padStart(6, '0');
const hud = createHud({
  TOOLS, BREATH_MAX, AIRSTRIKE_COST, BASE, SEA, SX, PALETTE,
  CAP_TIME, HILL_MOVE_WARNING, WIN_SCORE,
  stats, sfx, deathRecapCopy, ctfObjectiveKind,
  occupiedScoringTeam, nextHillIndex, rankContributionRows, teamCss,
});
// A client declares the host dead after this much snapshot silence. Chosen
// against the interval keepalive in main.js: a healthy backgrounded host
// still steps its sim (and broadcasts) at least every 250ms under normal
// conditions, and Chrome's documented standard background-timer clamp is
// ~1Hz — so a genuinely alive host essentially never goes much past 1s
// silent during the first several minutes of being backgrounded. This
// gives roughly 2.5x margin over that 1Hz worst case: tight enough to
// meaningfully speed up real-death detection (was 4000ms), generous enough
// that ordinary timer jitter shouldn't misfire it. Not tested across real
// devices/browsers yet — watch for false migrations under real play and
// adjust. Chrome's separate "intensive throttling" tier (background tabs
// idle 5+ minutes can drop to ~1 timer/min) will eventually trigger a
// migration under ANY value here; that's not fixable by tuning this number,
// and arguably correct — a host who hasn't looked at the game in 5+ minutes
// mid-match probably should hand off.
const HOST_SILENT_MS = 2500;
// A terrain block breaks after BLOCK_HP of weapon damage — gunfire hurts
// blocks exactly as much as it hurts people (rifle 55 -> 3 shots, SMG 22 ->
// 7 shots, bot carbine 16 -> 10). The spade still digs in one hit.
const BLOCK_HP = 150;
// Hard ceiling on humans per room (host + guests). KOTH applies its lower
// mode-specific 4v4 cap at runtime; CTF/TDM retain the 5v5 ceiling here.
// Test hook: ?cap=2.
const capParam = parseInt(QUERY.get('cap'), 10);
export const MAX_HUMANS = Number.isInteger(capParam) ? Math.min(HUMAN_CAP, Math.max(2, capParam)) : HUMAN_CAP;
// Position authority limits live in multiplayer.js so they can be tested
// without importing this DOM-heavy orchestrator.
// Interest management: how close is "obviously aware of them regardless"
// — footsteps, muzzle flash, standing right next to you — and also a
// deliberate buffer against raycast edge cases exactly at point-blank
// range (starting a ray essentially inside the target's own geometry).
// No equivalent upper cap on the line-of-sight branch: a sniper with a
// genuinely clear, unobstructed sightline across the map is legitimate
// play here, not something to hide from them.
const INTEREST_CLOSE_R = 8;
// Spawn exposure is judged at practical sniper sightline distance. Keeping a
// single value prevents CTF, KOTH, TDM, and protected-base fallbacks from
// quietly drifting into different definitions of an unsafe deployment.
const SPAWN_DANGER_LOS = 110;
// Aim-angle plausibility: the max implied turn rate between two
// consecutive ACCEPTED shots (angle changed / time elapsed) before a
// report gets treated as not humanly plausible. 10*PI rad/s = 1800 deg/s
// — deliberately generous. Real flick-shot benchmarks put even a fast,
// deliberate human snap in roughly this range for a brief burst; the
// target here is catching an unsophisticated aimbot that snaps instantly
// and REPEATEDLY between visible targets shot after shot, not shaving a
// human's fastest legitimate flick. A "humanized" aimbot that
// deliberately paces its turn under this rate is a real limit of this
// specific check, not something it can catch — see the comment at the
// actual check below.
const MAX_TURN_RATE = Math.PI * 10;
// Delay between an airstrike being confirmed and the explosion actually
// landing. Duplicated (not imported) in Player#_updatePiloting's
// watching-camera timer, since player.js can't import from game.js
// without a circular dependency (game.js already imports Player from
// there) — both sides are commented to reference this constant by name
// so a future retune of one doesn't silently desync from the other.
const AIRSTRIKE_TELEGRAPH_T = 3;
// Steering speed during the guided fall, in units/sec — deliberately much
// slower than the 40u/s free-scan targeting pan (Player#_updatePiloting):
// this is a last-second correction tool, not a second full-map retarget.
// Over the full AIRSTRIKE_TELEGRAPH_T fall, caps total possible drift at
// 36 units in one direction. Duplicated in player.js's own fall-update
// for the local, unvalidated visual — same circular-import reason as
// AIRSTRIKE_TELEGRAPH_T. This copy is what the host actually enforces.
const AIRSTRIKE_STEER_SPEED = 12;
// Bot identities live outside the human roster-index space used on the wire.
const BOT_STRIKE_OWNER_BASE = 1000000;
const AIRSTRIKE_DRONE_ALTITUDE = 23;
const AIRSTRIKE_DRONE_START = -78;
const AIRSTRIKE_DRONE_END = 10;
// Bullet drop gravity — see Game#_dropCompensate. Matches the world's own
// GRAVITY magnitude (entities.js) for internal consistency; each weapon's
// dropVel is what actually tunes how much a given gun drops, same way the
// grenade arc uses its own separate constant (22) rather than reusing this.
const GRAVITY_DROP = 30;
const $ = id => document.getElementById(id);
const v3 = a => new THREE.Vector3(a[0], a[1], a[2]);
const arr = v => [v.x, v.y, v.z];
const FLAG_CODE = { home: 0, carried: 1, dropped: 2 };

// Horizontal bearing from a viewer to a world-space source, expressed in
// screen convention: 0 ahead, +PI/2 right, -PI/2 left, and PI behind.
// CSS positive rotation is clockwise, so this value drives the damage
// chevron directly without a sign flip.
export function relativeBearing(yaw, fromX, fromZ, toX, toZ) {
  const fx = Math.cos(yaw), fz = -Math.sin(yaw);
  const rx = -fz, rz = fx;
  const dx = toX - fromX, dz = toZ - fromZ;
  return Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz);
}

// Pure flight-path helper kept exported for regression tests. Local +X is
// forward for the MQ-9 model and for player yaw: yaw 0 flies east, yaw PI/2
// flies north (-Z). The drone crosses directly over the live target about
// a third of a second before impact, then is still visibly departing when
// the blast lands instead of vanishing at the exact center point.
export function airstrikeDronePose(x, y, z, yaw, remaining,
  duration = AIRSTRIKE_TELEGRAPH_T) {
  const safeDuration = Math.max(0.001, Number.isFinite(duration) ? duration : AIRSTRIKE_TELEGRAPH_T);
  const safeRemaining = Math.max(0, Math.min(safeDuration,
    Number.isFinite(remaining) ? remaining : safeDuration));
  const safeYaw = Number.isFinite(yaw) ? Math.atan2(Math.sin(yaw), Math.cos(yaw)) : 0;
  const progress = 1 - safeRemaining / safeDuration;
  const along = AIRSTRIKE_DRONE_START
    + (AIRSTRIKE_DRONE_END - AIRSTRIKE_DRONE_START) * progress;
  return {
    x: x + Math.cos(safeYaw) * along,
    y: y + AIRSTRIKE_DRONE_ALTITUDE,
    z: z - Math.sin(safeYaw) * along,
    yaw: safeYaw,
    progress,
  };
}

// ---------------------------------------------------------------- flags
class Flag {
  constructor(game, team) {
    this.game = game;
    this.team = team;
    const stand = BASE[team].flag;
    this.home = new THREE.Vector3(stand.x + 0.5, stand.y, stand.z + 0.5);
    this.pos = this.home.clone();
    this.state = 'home'; // home | carried | dropped
    this.carrier = null;
    this.dropTimer = 0;

    // Built from boxes like everything else. The old flag was the only
    // cylinder in the game and the only double-sided plane, with its cloth
    // rippled by writing vertex positions every frame — a smooth, soft object
    // standing in a world of hard axis-aligned voxels. It read as borrowed
    // from a different game, because it was.
    const color = teamHex(team);
    this.group = new THREE.Group();
    const box = (w, h, d, mat, x, y, z, parent) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };
    const poleMat = new THREE.MeshBasicMaterial({ color: 0x8a8d94 });   // stone grey
    const clothMat = new THREE.MeshBasicMaterial({ color });
    this.clothMat = clothMat;
    box(0.14, 2.4, 0.14, poleMat, 0, 1.2, 0, this.group);
    box(0.26, 0.14, 0.26, poleMat, 0, 2.42, 0, this.group);             // finial
    // Swallowtail banner: three boxes, notch cut from the fly edge.
    this.banner = new THREE.Group();
    this.banner.position.set(0.07, 1.98, 0);
    box(0.62, 0.78, 0.09, clothMat, 0.31, 0, 0, this.banner);           // hoist half
    box(0.36, 0.26, 0.09, clothMat, 0.80, 0.26, 0, this.banner);        // upper tail
    box(0.36, 0.26, 0.09, clothMat, 0.80, -0.26, 0, this.banner);       // lower tail
    this.group.add(this.banner);
    game.scene.add(this.group);
  }

  standPos() { return this.home.clone(); }

  dispose() { disposeObject(this.group); }

  drop(at) {
    this.state = 'dropped';
    this.carrier = null;
    this.pos.copy(at);
    this.pos.y = Math.max(this.pos.y, SEA + 0.5);
    this.dropTimer = FLAG_RETURN_TIME;
    sfx.drop();
  }

  returnHome() {
    this.state = 'home';
    this.carrier = null;
    this.pos.copy(this.home);
    sfx.pickup();
  }

  update(dt, t) {
    if (this.state === 'carried' && this.carrier) {
      this.pos.copy(this.carrier.body.pos);
      this.pos.y += 0.4;
    } else if (this.state === 'dropped') {
      this.dropTimer -= dt;
      if (this.dropTimer <= 0) this.returnHome();
    }
    this.clientUpdate(t);
  }

  // Visuals only — clients set pos/state from snapshots and call this.
  clientUpdate(t) {
    this.group.position.copy(this.pos);
    // Quantized sway instead of a per-frame vertex ripple: the banner steps
    // between five poses rather than flowing between them. Cheaper, and it
    // matches a world where nothing else moves smoothly.
    const step = Math.round(Math.sin(t * 2.2) * 2) / 2;  // -1, -0.5, 0, 0.5, 1
    this.banner.rotation.y = step * 0.17;
    this.banner.position.z = step * 0.04;
  }
}

// ---------------- chat controller ----------------
// T talks to the room, Y talks to your team, Enter sends, Esc walks away.
// While the box is open the soldier holds still: movement keys are released
// and typing lands in the input, not the bindings.
class Chat {
  constructor(game) {
    this.game = game;
    this.scope = 'team';
    this.box = $('chat');
    this.input = $('chatin');
    addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT') return;        // typing elsewhere
      if (this.isOpen) return;                          // input captures its own keys
      if (!$('hud').classList.contains('on')) return;   // menus own the keyboard
      if (this.game.player.controls.matches('roomChat', e.code)
          && this.game.publicChatEnabled()) {
        e.preventDefault(); this.open('all');
      }
      else if (this.game.player.controls.matches('teamChat', e.code)) {
        e.preventDefault(); this.open('team');
      }
    });
    this.input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.code === 'Enter') this.send();
      else if (e.code === 'Escape') this.close();
    });
    this.input.addEventListener('blur', () => this.close());
  }
  get isOpen() { return this.box.classList.contains('open'); }
  open(scope) {
    if (scope === 'all' && !this.game.publicChatEnabled()) return;
    this.scope = scope;
    $('chatscope').textContent = scope === 'team' ? 'TEAM' : 'ALL';
    this.box.classList.add('open');
    this.game.player.keys = {}; // don't keep charging forward while typing
    this.game.player.controls.clear();
    this.input.value = '';
    this.input.focus();
  }
  close() {
    this.box.classList.remove('open');
    this.input.blur();
  }
  send() {
    const text = this.input.value.trim();
    this.close();
    if (text) this.game.sendChat(text, this.scope);
  }
}

const COLLAPSE_PACKET_CELLS = 4000;

const nameSpan = e => `<span style="color:${teamCss(e.team)}">${e.name}</span>`;

// Names arrive over the network and land in HTML (kill feed) and canvas
// (nametags): keep them to the same alphabet the callsign box enforces.
const cleanName = n => sanitizeDisplayName(n);

// Feed rows arrive as host-composed HTML and land in innerHTML — and the
// host is untrusted input like anyone else (a malicious room host could
// otherwise XSS every client). Escape everything, then re-admit only the
// two constructs our own composer emits: colored name spans and <b>.
const safeFeedHtml = html => String(html ?? '').slice(0, 300)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/&lt;span style=&quot;color:(#[0-9a-fA-F]{6})&quot;&gt;/g, '<span style="color:$1">')
  .replace(/&lt;span style="color:(#[0-9a-fA-F]{6})"&gt;/g, '<span style="color:$1">')
  .replace(/&lt;\/span&gt;/g, '</span>')
  .replace(/&lt;b&gt;/g, '<b>').replace(/&lt;\/b&gt;/g, '</b>');

// ---------------------------------------------------------------- game
export class Game {
  constructor(scene, camera, dom, opts = {}) {
    this.scene = scene;
    this.camera = camera;
    this.time = 0;
    this.presentation = new PresentationSchedule();
    this.over = false;
    this.mode = opts.mode ?? 'solo';       // solo | host | client
    this.net = opts.net ?? null;
    this.engagement = opts.engagement ?? null;
    this.fieldTelemetry = opts.fieldTelemetry ?? null;
    this._funnelSeen = new Set();
    this._completedFunnelMatch = false;
    this.engagementFeatures = opts.engagementFeatures ?? {};
    this.firstMinuteGuide = this.engagementFeatures.firstMinute
      ? new FirstMinuteGuide() : null;
    this.voxelStory = this.engagementFeatures.voxelStories
      ? new VoxelStoryTracker() : null;
    this._roundSerial = 0;
    // Public/default rooms protect teammates. Kept as an instance policy so
    // private-room friendly fire can be added later without rewriting every
    // damage source; no UI exposes it yet.
    this.friendlyFire = opts.friendlyFire === true;
    this.seed = opts.seed ?? 1979;
    this.editLog = [];                     // host: every world change, for late joiners
    this._worldHash = WORLD_HASH_SEED;      // rolling edit-log desync alarm
    this.blockHits = new Map();            // host/solo: 'x,y,z' -> remaining gunfire HP
    this.remote = new Map();               // host: peerId -> RemotePlayer
    this.avatars = new Map();              // client: key -> Avatar
    this.myId = null;
    this.myIdx = null;      // client: our roster index (the welcome's 'me')
    this._hostIdx = 0;      // host: our own roster index — inherited on promotion
    this._nextPIdx = 1;     // host: next player index to hand out
    this._rosterP = null;   // client: idx -> { name, team, pid } (identity rides here, not the tick)
    this._rosterB = null;   // client: idx -> { name, team }
    this._fullP = new Map(); // client: idx -> decoded player row, omission-safe
    this._fullB = new Map(); // client: idx -> decoded bot row
    this._snapT = 0;
    this._lastSnapshotSeq = null;
    this._snapshotEcho = null;
    this._combatHistory = new Map();
    this._combatHistoryT = 0;
    this._combatHistoryInitialized = false;
    this._entityFrameActive = false;
    this._entityRoster = [];
    this._teamRosters = { green: [], blue: [] };
    this._reconnectReservations = new Map();
    this._resyncAt = { state: 0, world: 0 };
    this._sendT = 0;
    this._actionSeq = 0;                  // client combat replay protection
    this._pendingTerrainActions = new Map(); // client action -> authoritative edit
    this._serverLife = 1;                 // rejects stale pre-respawn uplinks/actions
    this._lastWeaponActionSeq = 0;
    this._lastHealth = 100;
    this._respawnT = 0;                  // client: cosmetic redeploy countdown
    this._chatCd = 0;                    // chat send cooldown (wall clock)
    this.teamPings = [];                 // short-lived, team-only tactical marks
    this._nextTeamPingId = 1;
    this.botOrders = { green: null, blue: null };
    this.navRevision = 0;                // invalidates bot route snapshots after edits
    this._audioTarget = new THREE.Vector3();
    this._audioDirection = new THREE.Vector3();
    this._losDirection = new THREE.Vector3();
    this._interestEye = new THREE.Vector3();
    this._interestTarget = new THREE.Vector3();
    this._audioOccluded = pos => this._isSoundOccluded(pos);
    this._botTacticsT = 0;
    this._botBrainCursor = 0;
    this._botThinkSet = null;
    this._openingDeployment = false;      // new rounds begin at the authored bases
    this._squadVotes = new Set();
    this._intermissionReady = new Set();
    this._battleChoices = [];
    this._battleVotes = new Map();
    this._donePlayers = new Set();
    this._myBattleChoice = null;
    this._battleTally = [0, 0, 0];
    this._contactState = new Map();
    this._recentDeaths = [];
    this._ctfProgressAt = 0;
    this._ctfEscalation = { active: false, returnTime: FLAG_RETURN_TIME, frontlineBonus: 0 };
    this._intensityFired = new Set();
    this._botDifficultyKey = 'normal';
    this._voteKick = null;
    this._voteKickTimer = null;
    this._activeSquads = [];
    this._squadHostEnabled = false;
    this._nextStrikeId = 1;              // host/solo identity for concurrent flyovers
    this._pendingStrikes = [];           // host/solo authoritative impact timers
    this._airstrikeDrones = new Map();   // every mode: local visual replicas by strike id
    this._lastStrikeRows = [];           // client: latest full strike state for migration
    this._lastAbilityRows = [];          // contribution meter migration state
    this._teamBalanceHostEnabled = this.mode !== 'client'
      && !!this.engagementFeatures.teamBalance;
    // Lifetime kills/deaths persist across matches (see stats.js); this.kd
    // resets every rebuild(), so this tracks "what was my own row's k/d the
    // last time I checked" to diff against, not a running lifetime total.
    this._statsSeen = { k: 0, d: 0 };

    this.world = new VoxelWorld(scene);
    this.mapIndex = 0;                   // MAPS rotation position
    generateMap(this.world, this.seed, this.mapIndex);
    this._applyMapAtmosphere(this.mapIndex);
    this.world.onEdit = (x, z) => hud.mapDirty(x, z);
    hud.mapInit(this.world);
    this.effects = new Effects(scene);
    this.bots = [];                        // before Player: its first spawnPoint reads these
    this.player = new Player(this, camera, dom);
    // A solo/host session's own team was always green — every fight from
    // the same base, the same side of every map, permanently. Coin-flipped
    // once here (unless a saved team preference says otherwise — read with
    // the same try/catch pattern the class preference already uses, since
    // Game is constructed at page load, before the home screen's picker
    // click handler could ever run to set this directly) so hosting (or
    // playing solo) doesn't mean owning one side forever; _rotate() flips
    // it again on every map change from here on either way.
    if (this.mode !== 'client') {
      let teamPref;
      try { teamPref = localStorage.getItem('tos.team'); } catch { /* best effort */ }
      if (teamPref === 'green' || teamPref === 'blue') this.player.team = teamPref;
      else if (Math.random() < 0.5) this.player.team = 'blue';
    }
    this.player.name = opts.name ?? 'You';
    this.hud = hud;
    this.chat = new Chat(this);
    $('squadBtn')?.addEventListener('click', () => this.requestStayAsSquad());
    $('readyBtn')?.addEventListener('click', () => this.requestIntermissionReady());
    $('doneBtn')?.addEventListener('click', () => this.requestDone());
    $('shareResultBtn')?.addEventListener('click', () => this.onShareResult?.(this._resultShareText));

    if (this.mode !== 'client') this._spawnBots();

    this.gameMode = 'tdm';             // Fresh installs begin in the flagship mode.
    this.publicRoom = opts.publicRoom === true;
    this.privateContent = !!this.engagementFeatures.privateContent;
    this.matchElapsed = 0;
    this.matchRemaining = modeMatchSeconds(this.gameMode, {
      publicRoom: this.publicRoom, override: MATCH_TIME_OVERRIDE,
    });
    this.overtime = false;
    this.winner = null;
    this.hill = null;                  // koth: occupied rotating objective state
    this.flags = { green: new Flag(this, 'green'), blue: new Flag(this, 'blue') };
    this.captures = { green: 0, blue: 0 };
    this.grenades = [];
    // A pool, not one shared mesh: several grenades can be airborne at once
    // (two bots + a player), and a single mesh rendered only grenades[0].
    const nadeGeo = new THREE.BoxGeometry(0.17, 0.17, 0.17); // boxes, like everything else
    const nadeMat = new THREE.MeshBasicMaterial({ color: 0x2e3b2e });
    this.grenadeMeshes = [];
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Mesh(nadeGeo, nadeMat);
      m.visible = false;
      scene.add(m);
      this.grenadeMeshes.push(m);
    }
    this.respawnTimers = new Map();
    // Battlefield intel for the bots: every shot, kill and blast leaves a
    // signed ping here, and deathmatch bots hunt the freshest enemy sign
    // instead of camping a base the enemy already left.
    this.intel = []; // { x, z, team, t }
    // Scoreboard: name -> { team, k, d }, seeded for every combatant so a
    // 0/0 soldier still shows up. Host broadcasts the table on each death;
    // clients replace their copy wholesale (names are unique enough keys).
    this.kd = new Map();
    this._scoreDirty = false;
    this._scoreBroadcastT = 0;
    this._kdSeed();

    hud.refreshTool(this.player);
    hud.health(this.player);
    hud.score(this);
  }

  // Tear down and regenerate (host room start / client welcome / map rotation).
  // Repaints the scene's sky, fog, cloud, and water tint to match whichever
  // map just loaded — called after every generateMap() (the initial one
  // in the constructor above, and the one inside rebuild() below), since
  // a map rotation mid-session needs this refreshed just as much as the
  // very first load does. VoxelWorld's own constructor (called just before
  // generateMap in both places) is what creates world.water/cloudMat, so
  // both are guaranteed to already exist by the time this runs.
  _applyMapAtmosphere(mapIndex) {
    const a = mapAtmosphere(mapIndex);
    // If the player happened to be underwater right when this runs (a
    // match ending, or a map rebuilding, mid-swim), the real previous
    // sky texture is sitting in _skyBackup, not scene.background (which
    // would currently hold the underwater overlay color instead) —
    // dispose whichever one is actually the real texture, and reset the
    // underwater state entirely so this map's fresh sky/fog become the
    // source of truth again, rather than getting silently overwritten
    // by a stale backup the next time the player happens to surface.
    (this._skyBackup ?? this.scene.background)?.dispose?.();
    this._underwater = false;
    this._underwaterApplied = false;
    this._skyBackup = null;
    this.scene.background = skyGradient(...a.sky);
    this.scene.fog.color.setHex(a.fog);
    this.scene.fog.near = 70; this.scene.fog.far = 230; // restored explicitly in case a rebuild lands mid-underwater, right as these were swapped to the murky-water values
    this.world.water.material.color.setHex(a.water);
    this.world.configureAtmosphere(this.mapIndex);
    this.world.cloudMat.color.setHex(a.cloud);
    // Horizon peaks: derived from this map's own fog color rather than a
    // fixed one, so a per-map override (a darker, murkier fog on one map
    // vs a brighter one on another) carries through to the distant
    // silhouette automatically -- darkened, not copied directly, so it
    // reads as a distinct shape against the fog/sky rather than blending
    // straight into invisibility at the color it's already fading toward.
    this.world.horizonMat.color.setHex(a.fog).multiplyScalar(0.72);
  }

  applyGraphics(level) {
    this.world.applyGraphics(level);
    this.effects.applyGraphics(level);
    for (const bot of this.bots) applySoldierGraphics(bot.parts, level);
    for (const remote of this.remote.values()) applySoldierGraphics(remote.avatar.parts, level);
    for (const avatar of this.avatars.values()) applySoldierGraphics(avatar.parts, level);
  }

  applyColorMode() {
    const green = teamHex('green'), blue = teamHex('blue');
    const terrainChanged = PALETTE[BLOCK.GREEN].color !== green
      || PALETTE[BLOCK.BLUE].color !== blue;
    PALETTE[BLOCK.GREEN].color = green;
    PALETTE[BLOCK.BLUE].color = blue;
    this.player.syncBlockColor();
    for (const flag of Object.values(this.flags ?? {}))
      flag.clothMat?.color.setHex(teamHex(flag.team));
    for (const bot of this.bots) bot.parts.teamMaterial?.color.setHex(teamHex(bot.team));
    for (const remote of this.remote.values())
      remote.avatar.parts.teamMaterial?.color.setHex(teamHex(remote.team));
    for (const avatar of this.avatars.values())
      avatar.parts.teamMaterial?.color.setHex(teamHex(avatar.team));
    for (const mark of this.teamPings ?? []) mark.mat?.color.setHex(teamHex(mark.team));
    // Terrain colors are baked into chunk vertex buffers; a user-triggered
    // palette change is rare and intentionally rebuilds once so placed team
    // blocks change immediately instead of waiting for the next map.
    if (terrainChanged) {
      this.world.buildAll();
      hud.mapInit(this.world);
    }
    hud.score(this);
  }

  // Called every frame, every mode — purely local/visual, no host
  // authority needed. Swaps to a close, murky fog and a solid-color
  // background (both matching this map's own water tint, so Caldera's
  // murkier water, say, stays consistent underwater too) whenever the
  // camera's eye position is below the surface; restores the normal
  // sky/fog once it isn't. Hysteresis (different enter/exit thresholds,
  // not one shared line) avoids flicker from bobbing right at the
  // surface re-triggering the swap every frame.
  _updateUnderwaterFog() {
    const camY = this.player.camera.position.y;
    if (!this._underwater && camY < SEA + 0.3) this._underwater = true;
    else if (this._underwater && camY > SEA + 0.55) this._underwater = false;
    if (this._underwater === this._underwaterApplied) return;
    this._underwaterApplied = this._underwater;
    if (this._underwater) {
      this._skyBackup = this.scene.background;
      const c = this.world.water.material.color;
      this.scene.background = new THREE.Color(c.getHex());
      this.scene.fog.color.copy(c);
      this.scene.fog.near = 1;
      this.scene.fog.far = 18;
    } else {
      this.scene.background = this._skyBackup;
      this._skyBackup = null;
      const a = mapAtmosphere(this.mapIndex);
      this.scene.fog.color.setHex(a.fog);
      this.scene.fog.near = 70;
      this.scene.fog.far = 230;
    }
  }

  rebuild(seed, map = this.mapIndex) {
    this._roundSerial++;
    this._pendingTerrainActions.clear();
    this._funnelSeen.clear();
    this._entityFrameActive = false;
    this.voxelStory?.reset();
    hud.deathRecap(null);
    this._clearTeamPings();
    this._squadVotes.clear();
    this._intermissionReady.clear();
    this._battleChoices = [];
    this._battleVotes.clear();
    this._donePlayers.clear();
    this._myBattleChoice = null;
    this._battleTally = [0, 0, 0];
    this._contactState.clear();
    this._recentDeaths = [];
    this._ctfProgressAt = this.time;
    this._ctfEscalation = { active: false, returnTime: FLAG_RETURN_TIME, frontlineBonus: 0 };
    this._intensityFired.clear();
    this._clearVoteKick();
    if (this.mode === 'client') this._squadHostEnabled = false;
    hud.staySquad(this, []);
    this._clearAirstrikeDrones();
    this._pendingStrikes = [];
    this._lastStrikeRows = [];
    this._lastAbilityRows = [];
    this.botOrders = { green: null, blue: null };
    this.navRevision = 0;
    this._botTacticsT = 0;
    this._botBrainCursor = 0;
    this.world.dispose();
    for (const b of this.bots) disposeObject(b.parts.group);
    for (const av of this.avatars.values()) av.dispose();
    this.avatars.clear();
    for (const t of ['green', 'blue']) this.flags?.[t].dispose();
    if (this.hillVisual) { disposeObject(this.hillVisual.mesh); this.hillVisual = null; }
    this.seed = seed;
    this.mapIndex = map;
    this.world = new VoxelWorld(this.scene);
    generateMap(this.world, seed, map);
    // Map generation owns the placed-block palette. Refresh the persistent
    // first-person model from that exact source before it is shown again.
    this.player?.syncBlockColor();
    retintVoxelBoxes(this.player?.vmRoot);
    for (const p of this.remote.values()) retintVoxelBoxes(p.avatar?.group);
    this._applyMapAtmosphere(map);
    this.world.onEdit = (x, z) => hud.mapDirty(x, z);
    hud.mapInit(this.world);
    // Bodies capture the world instance at construction; the player and any
    // remote proxies survive rebuild, so rebind them or they'd keep colliding
    // with the previous map while the new one renders on screen.
    this.player.body.world = this.world;
    for (const rp of this.remote.values()) rp.body.world = this.world;
    // Only capture-the-flag has flags; deathmatch and king of the hill don't.
    this.flags = this.gameMode === 'ctf'
      ? { green: new Flag(this, 'green'), blue: new Flag(this, 'blue') } : null;
    // King of the hill: three map-authored, base-equidistant objectives. The
    // active zone rides the live terrain; its vertical band is re-read per
    // tick as players crater or rebuild the ground beneath it.
    const spots = MAPS[this.mapIndex].hills
      ?? [MAPS[this.mapIndex].hill ?? { x: SX / 2, z: SZ / 2, r: 8, label: 'CENTER' }];
    const hd = spots[0];
    this.hill = this.gameMode === 'koth' && hd
      ? { spots, index: 0, label: hd.label ?? 'HILL',
          pos: new THREE.Vector3(hd.x + 0.5,
            this.world.surface(Math.floor(hd.x), Math.floor(hd.z)), hd.z + 0.5),
          r: hd.r, owner: null, progress: 0, contested: false, capTeam: null,
          presence: { green: 0, blue: 0 }, rotateIn: HILL_CYCLE }
      : null;
    if (this.hill) this._createHillVisual();
    this.respawnTimers.clear();
    this.bots = [];
    // Start every human through a real new-round lifecycle. Mark guests dead
    // first so spawn scoring never treats stale old-map positions as enemies.
    for (const p of this.remote.values()) p.alive = false;
    this._openingDeployment = true;
    this.player.respawn();
    if (this.mode !== 'client') {
      for (const p of this.remote.values()) p.resetForRound();
      this._spawnBots();
    }
    this._openingDeployment = false;
    this.captures = { green: 0, blue: 0 };
    this.matchElapsed = 0;
    this.matchRemaining = modeMatchSeconds(this.gameMode, {
      publicRoom: this.publicRoom, override: MATCH_TIME_OVERRIDE,
    });
    this.overtime = false;
    this.winner = null;
    this.editLog = [];
    this._worldHash = WORLD_HASH_SEED;
    this._lastSnapshotSeq = null;
    this._resyncAt = { state: 0, world: 0 };
    this.blockHits.clear();
    this.grenades = [];
    for (const m of this.grenadeMeshes) m.visible = false;
    // Omission state is per-world: a rebuilt map invalidates every row a
    // client reconstructed (client side) and everything a connection was
    // marked as sent (host side — the next tick goes out full).
    this._fullP.clear();
    this._fullB.clear();
    this._combatHistory.clear();
    this._combatHistoryT = 0;
    this._combatHistoryInitialized = false;
    this._reconnectReservations.clear();
    // Rebuilt world, rebuilt cast: bot indices change, so the old roster is
    // stale. Rows whose metadata hasn't re-landed are skipped until it does.
    this._rosterP = null;
    this._rosterB = null;
    if (this.net?.conns) for (const c of this.net.conns.values()) c._sentRows = null;
    this.intel = []; // fresh map, no signs of anyone yet
    this.over = false;
    this._lastHealth = 100;
    this.kd = new Map(); // fresh round, fresh scoreboard
    this._scoreDirty = false;
    this._scoreBroadcastT = 0;
    this._statsSeen = { k: 0, d: 0 }; // fresh baseline — see the constructor note
    this._kdSeed();
    hud.score(this);
  }

  // Scoreboard rows are keyed by roster index, not by display name: the bot
  // name pool is small and nothing stops a human typing a bot's callsign, and
  // two entities sharing a name used to share one row.
  _kdKey(e) {
    if (e === this.player) return 'p' + (this.mode === 'client' ? (this.myIdx ?? 0) : this._hostIdx);
    if (e.isRemote) return 'p' + e.ridx;
    if (Number.isInteger(e._humanRidx)) return 'p' + e._humanRidx;
    return 'b' + e.id;
  }
  _kdRow(e) {
    const key = this._kdKey(e);
    let r = this.kd.get(key);
    if (!r) this.kd.set(key, r = contributionRow({ name: e.name, team: e.team }));
    else Object.assign(r, contributionRow(r));
    r.name = e.name;
    r.team = e.team; // migration/rejoin could flip an index's side
    return r;
  }
  _award(e, points = 0, { assists = 0, objective = 0,
    specialty = null, specialtyPoints = 0 } = {}, refresh = true) {
    if (!e) return;
    const earned = Math.max(0, Number(points) || 0);
    const r = this._kdRow(e);
    r.score += earned;
    r.a += Math.max(0, Number(assists) || 0);
    r.objective += Math.max(0, Number(objective) || 0);
    if (r.specialties && Object.prototype.hasOwnProperty.call(r.specialties, specialty))
      r.specialties[specialty] += Math.max(0, Math.floor(Number(specialtyPoints) || earned));
    if (earned || objective || assists) this._noteAction(e);
    if (e === this.player) {
      this.engagement?.contribution({ points: earned, assists, objective });
      if (objective > 0) this.funnel('objective');
    }
    // All authoritative combatants earn the exact same contribution values as
    // scoreboard. Kills still matter, but assists and playing the objective
    // now advance the meter too. Bots spend their host-side meter autonomously.
    e._streak = gainStreak(e._streak, earned);
    this._scoreDirty = true;
    if (refresh) hud.statsRefresh(this);
  }

  availableStreak(p) {
    return availableStreakAbility(p?._streak ?? 0);
  }
  _scoreRows() {
    return [...this.kd].map(([key, r]) => [key, r.name, r.team, r.k, r.d,
      Math.round(r.score), r.a, Math.round(r.objective), ...['rifle', 'smg', 'sniper', 'objective', 'terrain']
        .map(kind => Math.round(r.specialties?.[kind] ?? 0))]);
  }
  _broadcastScoreboard(force = false) {
    if (!this._scoreDirty && !force) return;
    this._scoreDirty = false;
    if (this.mode === 'host') this.net.broadcast({ t: 'e', k: 'kd', rows: this._scoreRows() });
    hud.statsRefresh(this);
  }
  // Lifetime kills/deaths (see stats.js) are driven off the same scoreboard
  // both roles already keep current — diffed against the last-seen values
  // rather than a direct increment, so one mechanism covers host/solo
  // (called from onDeath, right after this.kd updates) and client (called
  // from the 'kd' broadcast handler) without needing separate paths for
  // each. _statsSeen resets alongside this.kd on every rebuild().
  _syncPersistentStats() {
    const row = this.kd.get(this._kdKey(this.player));
    if (!row) return;
    if (this.mode === 'client')
      for (let i = row.k - this._statsSeen.k; i > 0; i--)
        this.engagement?.combat('kill', 'other');
    for (let i = row.k - this._statsSeen.k; i > 0; i--) stats.addKill();
    for (let i = row.d - this._statsSeen.d; i > 0; i--) stats.addDeath();
    this._statsSeen = { k: row.k, d: row.d };
  }
  _kdSeed() { for (const e of this.entities()) this._kdRow(e); }

  _spawnBots() {
    // Fill the mode's roster target around whoever is already connected:
    // 4 a side in concentrated KOTH fights, 5 a side in CTF/TDM. The host and
    // any remote players occupy real seats on their own team, bots take
    // the rest. Reads team membership live rather than assuming "host is
    // green": that assumption used to be baked in here, which meant a
    // rotation that swapped the host onto blue (see _rotate) would seed a
    // full fresh 5 blue bots on TOP of a now-blue host, for 6v4. It also
    // means this now correctly avoids over-seeding when rebuild() runs on
    // a map rotation with humans already connected, rather than always
    // adding a full 9 fresh bots regardless of who was already in the room.
    const humans = { green: 0, blue: 0 };
    humans[this.player.team] = (humans[this.player.team] ?? 0) + 1;
    for (const p of this.remote.values()) humans[p.team] = (humans[p.team] ?? 0) + 1;
    const bots = { green: 0, blue: 0 };
    for (const b of this.bots) bots[b.team] = (bots[b.team] ?? 0) + 1;
    const target = teamSizeForMode(this.gameMode);
    for (let i = bots.green; i < target - humans.green; i++) {
      this.bots.push(this._newBot('green'));
    }
    for (let i = bots.blue; i < target - humans.blue; i++) {
      this.bots.push(this._newBot('blue'));
    }
  }

  _newBot(team, name = null, difficultyKey = null) {
    return new Bot(this, team, name, difficultyKey ?? this._botDifficultyKey);
  }

  _recordCombatPose(entity) {
    if (!entity?.body) return;
    const history = this._combatHistory.get(entity) ?? [];
    recordPose(history, this.time, entity.body);
    this._combatHistory.set(entity, history);
  }

  _historicalBody(entity, at) {
    const pose = samplePose(this._combatHistory.get(entity), at);
    return pose ? { pos: pose, half: { h: pose.h } } : entity.body;
  }

  _humanCap() { return Math.min(MAX_HUMANS, teamSizeForMode(this.gameMode) * 2); }

  enemyOf(team) { return team === 'blue' ? 'green' : 'blue'; }

  _beginEntityFrame() {
    const all = this._entityRoster, green = this._teamRosters.green;
    const blue = this._teamRosters.blue;
    all.length = green.length = blue.length = 0;
    if (this.player) all.push(this.player);
    for (const entity of this.remote.values()) all.push(entity);
    for (const entity of this.bots) all.push(entity);
    for (const entity of all) {
      if (entity.team === 'green') green.push(entity);
      else if (entity.team === 'blue') blue.push(entity);
    }
    this._entityFrameActive = true;
  }

  _endEntityFrame() { this._entityFrameActive = false; }

  // this.player is undefined while its constructor asks for its first spawn.
  // During a tick every subsystem shares three reusable roster arrays. Outside
  // a tick, return a fresh live view so connection callbacks can never observe
  // a stale frame after a join, departure, rebuild, or host migration.
  entities() {
    return this._entityFrameActive
      ? this._entityRoster : [this.player, ...this.remote.values(), ...this.bots].filter(Boolean);
  }

  teamOf(team) {
    if (this._entityFrameActive && this._teamRosters[team]) return this._teamRosters[team];
    return this.entities().filter(entity => entity?.team === team);
  }

  // Announcements: show locally, and relay to clients when hosting.
  feed(html) {
    hud.feed(html);
    if (this.mode === 'host') this.net.broadcast({ t: 'e', k: 'feed', html });
  }
  message(text, color = '#fff') {
    hud.message(text, color);
    if (this.mode === 'host') this.net.broadcast({ t: 'e', k: 'msg', text, color });
  }
  // A centered message for one specific remote player.
  messageTo(e, text, color) {
    if (e === this.player) hud.message(text, color);
    else if (e.isRemote) this.net.sendTo(e.id, { t: 'e', k: 'msg', text, color });
  }
  // A centered message for everyone on a team (host tags it; clients filter).
  messageTeam(team, text, color) {
    if (this.player.team === team) hud.message(text, color);
    if (this.mode === 'host') this.net.broadcast({ t: 'e', k: 'msg', text, color, team });
  }
  foesOf(team) {
    if (team === 'green') return this.teamOf('blue');
    if (team === 'blue') return this.teamOf('green');
    return this.entities().filter(e => e.team !== team);
  }

  // --- bot intel ---
  // Bots only run host/solo-side, so clients never bother recording.
  pingIntel(pos, team, kind = 'sound') {
    if (this.mode === 'client' || !team) return;
    this.intel.push({ x: pos.x, z: pos.z, team, t: this.time,
      kind: ['sight', 'combat'].includes(kind) ? kind : 'sound' });
    if (this.intel.length > 48) this.intel.splice(0, this.intel.length - 48);
  }

  _noteAction(e) {
    if (!e) return;
    const state = this._contactState.get(e) ?? {};
    state.lastAction = this.time; state.alive = !!e.alive;
    this._contactState.set(e, state);
  }
  _updateContactFlow() {
    if (this.over || this.time < (this._contactNextAt ?? 0)) return;
    this._contactNextAt = this.time + 0.5;
    const humans = this.mode === 'client' ? [this.player]
      : [this.player, ...this.remote.values()];
    for (const e of humans) if (e?.alive) {
      const state = this._contactState.get(e) ?? { lastAction: this.time, alive: true };
      state.alive = true;
      const objective = this.hill?.pos ?? this.flags?.[this.enemyOf(e.team)]?.pos;
      const mark = [...this.teamPings].reverse().find(p => p.team === e.team)?.pos;
      const intel = this.mode === 'client' ? null : this.huntSpot(e.team, e.body.pos);
      // Existing shared intel wins. Objectives are public fallback data and
      // never reveal an enemy who was not already perceived.
      const candidates = [intel && { kind: 'intel', x: intel.x, z: intel.z },
        mark && { kind: 'mark', x: mark.x, z: mark.z },
        objective && { kind: 'objective', x: objective.x, z: objective.z }].filter(Boolean);
      if (this.mode !== 'client' && this.foesOf(e.team).some(foe => foe.alive
          && foe.body.eye().distanceToSquared(e.body.eye()) < 70 ** 2
          && this.losClear(e.body.eye(), foe.body.eye()))) state.lastAction = this.time;
      const cue = contactCue(state, this.time, candidates);
      if (cue) {
        state.lastCue = this.time;
        this.messageTo(e, cue.label, '#ffd97a');
        const y = this.world.surface(Math.floor(cue.x), Math.floor(cue.z)) + 1;
        const msg = { t: 'e', k: 'mark', id: this._nextTeamPingId++, name: 'RADIO',
          team: e.team, x: cue.x, y, z: cue.z, kind: 'MOVE' };
        if (e === this.player) this._receiveTeamPing(msg);
        else if (e.isRemote) this.net.sendTo(e.id, msg);
      }
      this._contactState.set(e, state);
    }
  }

  _updateIntensityCues() {
    if (this.over) return;
    const cue = intensityCue({ mode: this.gameMode, green: this.captures.green,
      blue: this.captures.blue, remaining: this.matchRemaining,
      escalation: this._ctfEscalation.active, fired: this._intensityFired });
    if (!cue) return;
    this._intensityFired.add(cue.id);
    this.message(cue.text, cue.id === 'deadlock' ? '#e05a4e' : '#ffd97a');
    if (cue.id === 'frontline') this.feed('<b>FRONT LINES ADVANCING</b> — BOTH TEAMS PUSH FORWARD');
    sfx.radio();
  }

  _updateGrenadeWarning() {
    const p = this.player;
    if (!p?.alive) return hud.danger(null);
    if (this.time < (this._grenadeWarningNextAt ?? 0)) return;
    this._grenadeWarningNextAt = this.time + .1;
    const rows = this.mode === 'client' ? (this._lastGrenades ?? []) : this.grenades;
    let nearest = null;
    const eye = p.body.eye(this._grenadeEye ??= new THREE.Vector3());
    const probe = this._grenadeProbe ??= new THREE.Vector3();
    for (const row of rows) {
      const x = this.mode === 'client' ? dx(row[0]) : row.pos.x;
      const y = this.mode === 'client' ? dy(row[1]) : row.pos.y;
      const z = this.mode === 'client' ? dx(row[2]) : row.pos.z;
      const distance = Math.hypot(x - p.body.pos.x, y - p.body.pos.y, z - p.body.pos.z);
      if (distance > 10 || (nearest && distance >= nearest.distance)) continue;
      probe.set(x, y, z);
      if (!this.losClear(eye, probe)) continue;
      nearest = { distance, bearing: this._bearingTo(probe) };
    }
    hud.danger(nearest);
    if (nearest && nearest.distance < 7 && this.time >= (this._grenadeWarnAt ?? 0)) {
      this._grenadeWarnAt = this.time + .8;
      sfx.danger();
    }
  }

  // Freshest fair enemy sign. Sightings are shared over the squad radio;
  // ordinary weapon/explosion sounds must be within the listener's hearing
  // range. Older sound reports grow less precise instead of revealing an
  // exact live coordinate to every bot on the map.
  huntSpot(team, listener = null, hearing = 38) {
    for (let i = this.intel.length - 1; i >= 0; i--) {
      const p = this.intel[i];
      const age = this.time - p.t;
      if (age > 25 || p.team === team) continue;
      if (p.kind === 'sound' && listener
          && Math.hypot(p.x - listener.x, p.z - listener.z) > hearing) continue;
      const uncertainty = p.kind === 'sight' ? Math.min(5, age * 0.28)
        : Math.min(12, 2 + age * 0.7);
      const angle = (p.t * 1.71 + (team === 'blue' ? 2.4 : 0.8)) % (Math.PI * 2);
      return { ...p,
        x: Math.max(1, Math.min(SX - 1, p.x + Math.cos(angle) * uncertainty)),
        z: Math.max(1, Math.min(SZ - 1, p.z + Math.sin(angle) * uncertainty)) };
    }
    return null;
  }
  // A hunter reached a ping and found nothing: scratch enemy signs near it.
  consumeIntel(team, spot, r) {
    this.intel = this.intel.filter(p =>
      p.team === team || Math.hypot(p.x - spot.x, p.z - spot.z) > r);
  }

  _spawnSurface(x, z) {
    const fx = Math.floor(x), fz = Math.floor(z);
    if (fx < 2 || fz < 2 || fx >= SX - 2 || fz >= SZ - 2) return null;
    if (!envelopeContains(mapEnvelope(this.mapIndex), x, z, 3)) return null;
    const center = this.world.surface(fx, fz);
    if (center < SEA) return null;
    let rim = center;
    for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3]])
      rim = Math.max(rim, this.world.surface(fx + dx, fz + dz));
    if (rim - center > 3) return null; // crater floor — use the rim instead

    // A center-column surface is insufficient near a voxel boundary: one
    // shoulder can overlap a taller adjacent column and leave both peers
    // correcting the player back into the same bad spawn. Stand on the
    // highest column touched by the real body footprint, then verify the
    // complete standing AABB before advertising this point to a client.
    let support = center;
    const x0 = Math.floor(x - BODY_HALF_WIDTH), x1 = Math.floor(x + BODY_HALF_WIDTH);
    const z0 = Math.floor(z - BODY_HALF_WIDTH), z1 = Math.floor(z + BODY_HALF_WIDTH);
    for (let xx = x0; xx <= x1; xx++) for (let zz = z0; zz <= z1; zz++)
      support = Math.max(support, this.world.surface(xx, zz));
    const y = support + 1.02;
    for (let yy = Math.floor(y); yy <= Math.floor(y + STAND_HEIGHT); yy++)
      for (let xx = x0; xx <= x1; xx++) for (let zz = z0; zz <= z1; zz++)
        if (this.world.solid(xx, yy, zz)) return null;
    return { x, y, z };
  }

  // Authored base deployment remains the opening, full-team-wipe, and unsafe
  // fallback location in every mode.
  _baseSpawnPoint(team) {
    const b = BASE[team];
    const dir = team === 'green' ? 1 : -1; // just outside the gate, facing the field
    const foeEntities = this.foesOf(team).filter(e => e.alive && e.body);
    const foes = foeEntities.map(e => e.body.pos);
    const allies = this.entities().filter(e => e?.alive && e.team === team && e.body)
      .map(e => e.body.pos);
    const recentDeaths = (this._recentDeaths ?? []).filter(d => d.team === team);
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < 32; i++) {
      const x = b.x + dir * (4 + Math.random() * 16) + (Math.random() - 0.5) * 8;
      const z = b.z + (Math.random() - 0.5) * 36;
      const candidate = this._spawnSurface(x, z);
      if (!candidate) continue;
      const eye = new THREE.Vector3(candidate.x, candidate.y + 1.4, candidate.z);
      let visibleEnemies = 0;
      for (const foe of foeEntities) {
        const foeEye = foe.body.eye ? foe.body.eye()
          : new THREE.Vector3(foe.body.pos.x, foe.body.pos.y + 1.4, foe.body.pos.z);
        if (eye.distanceTo(foeEye) <= SPAWN_DANGER_LOS && this.losClear(eye, foeEye)) {
          visibleEnemies++;
          break;
        }
      }
      const score = tacticalSpawnScore(candidate, {
        enemies: foes, allies, visibleEnemies, recentDeaths, mode: this.gameMode,
        objective: { x: SX / 2, z: SZ / 2 },
      });
      if (score > bestScore) { bestScore = score; best = candidate; }
    }
    if (best) return best;
    // A fully camped base can make every strict candidate invalid. Preserve a
    // deterministic protected deployment rather than returning no spawn; the
    // normal spawn protection window gives the wiped team room to break out.
    const x = b.x + dir * 12, z = b.z;
    return { x, y: this.world.surface(Math.floor(x), Math.floor(z)) + 1.02, z };
  }

  // CTF redeploys behind its own midfield line when a safe living teammate
  // still holds the front. This removes the repeated base-to-midfield commute
  // without allowing attackers to materialize in enemy territory. A wipe, a
  // recently fighting squad, or a fully exposed set of candidates naturally
  // falls back to _baseSpawnPoint(), so breaking an attack still matters.
  _ctfSpawnPoint(team) {
    if (this._openingDeployment || !this.flags) return null;
    const living = this.entities().filter(e => e?.alive && e.body);
    const foes = living.filter(e => e.team !== team);
    const allies = living.filter(e => e.team === team);
    const own = BASE[team], enemy = BASE[this.enemyOf(team)];
    const enemyRows = foes.map(e => e.body.pos);
    const visibleAt = ally => {
      const eye = ally.body.eye ? ally.body.eye()
        : new THREE.Vector3(ally.body.pos.x, ally.body.pos.y + 1.4, ally.body.pos.z);
      return foes.some(foe => {
        const foeEye = foe.body.eye ? foe.body.eye()
          : new THREE.Vector3(foe.body.pos.x, foe.body.pos.y + 1.4, foe.body.pos.z);
        return eye.distanceTo(foeEye) <= SPAWN_DANGER_LOS && this.losClear(eye, foeEye);
      }) ? 1 : 0;
    };
    // Carriers are never anchors: redeploying beside one makes the flag
    // carrier's route too easy to collapse and ignores the defensive cue.
    const anchors = allies.filter(e => ctfAnchorAllowed(e, {
      ownX: own.x, enemyX: enemy.x, now: this.time, enemies: enemyRows,
      nearbyAllies: allies, visibleEnemies: visibleAt(e),
    }));
    if (!anchors.length) return null;

    const dir = Math.sign(enemy.x - own.x);
    const frontProgress = ctfMedianForwardProgress(anchors, {
      ownX: own.x, enemyX: enemy.x,
    });
    const raw = [];
    const envelope = mapEnvelope(this.mapIndex);
    const lanes = [0.22, 0.5, 0.78].map(fraction =>
      envelope.minZ + (envelope.maxZ - envelope.minZ) * fraction);
    // Fixed friendly-side lanes remain available even when the squad is
    // concentrated in one channel; qualified anchors add their own lanes.
    const laneZ = [...lanes, ...anchors.map(e => e.body.pos.z)];

    const ownFlag = this.flags[team], enemyFlag = this.flags[this.enemyOf(team)];
    const objective = ownFlag.state !== 'home' ? ownFlag.pos
      : enemyFlag.state !== 'home' ? enemyFlag.pos : enemyFlag.home;
    const activeFlags = Object.values(this.flags)
      .filter(flag => flag.state !== 'home').map(flag => flag.pos);
    const allyRows = anchors.map(e => e.body.pos);
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < 48; i++) {
      const advance = ctfWaveProgress(frontProgress ?? 0, {
        ownX: own.x, enemyX: enemy.x,
        behind: CTF_SPAWN.behindFrontMin
          + Math.random() * (CTF_SPAWN.behindFrontMax - CTF_SPAWN.behindFrontMin),
        defending: ownFlag.state !== 'home',
        frontlineBonus: this._ctfEscalation?.frontlineBonus,
      });
      if (!Number.isFinite(advance)) continue;
      const z = laneZ[i % laneZ.length] + (Math.random() - 0.5) * 28;
      raw.push([own.x + dir * advance, z]);
    }
    for (const [x, z] of raw) {
      const candidate = this._spawnSurface(x, z);
      if (!candidate) continue;
      const eye = new THREE.Vector3(candidate.x, candidate.y + 1.4, candidate.z);
      let visibleEnemies = 0;
      for (const foe of foes) {
        const foeEye = foe.body.eye ? foe.body.eye()
          : new THREE.Vector3(foe.body.pos.x, foe.body.pos.y + 1.4, foe.body.pos.z);
        if (eye.distanceToSquared(foeEye) <= SPAWN_DANGER_LOS ** 2 && this.losClear(eye, foeEye)) {
          visibleEnemies = 1;
          break;
        }
      }
      if (!ctfFrontlineAllowed(candidate, { ownX: own.x, enemyX: enemy.x,
        enemies: enemyRows, activeFlags, visibleEnemies,
        frontlineBonus: this._ctfEscalation?.frontlineBonus })) continue;
      const advance = (candidate.x - own.x) * dir;
      const score = tacticalSpawnScore(candidate, {
        enemies: enemyRows, allies: allyRows, objective, visibleEnemies,
        recentDeaths: (this._recentDeaths ?? []).filter(d => d.team === team), mode: 'ctf',
      }) + advance * 0.65;
      if (score > bestScore) { bestScore = score; best = candidate; }
    }
    return best;
  }

  _dynamicSpawnPoint(team) {
    const living = this.entities().filter(e => e?.alive && e.body);
    const foes = living.filter(e => e.team !== team);
    const allies = living.filter(e => e.team === team);
    const b = BASE[team], dir = team === 'green' ? 1 : -1;
    const objective = this.hill?.pos ?? (foes.length ? {
      x: foes.reduce((n, e) => n + e.body.pos.x, 0) / foes.length,
      z: foes.reduce((n, e) => n + e.body.pos.z, 0) / foes.length,
    } : { x: SX / 2, z: SZ / 2 });
    const raw = [];

    if (this.gameMode === 'tdm') {
      // TDM's battlefield wave follows the robust median allied front. A
      // surviving teammate contributes a lane only when they are a quiet,
      // covered, supported anchor; a lone flanker can never move the wave.
      if (!allies.length) return null;
      const own = BASE[team], enemy = BASE[this.enemyOf(team)];
      const enemyRows = foes.map(e => e.body.pos);
      const allyRows = allies.map(e => e.body.pos);
      // The front is the median of soldiers still on their own side. One
      // infiltrator beyond midfield must not drag the whole respawn wave up
      // behind them; a wiped/fully advanced formation falls back rearward.
      const frontRows = allyRows.filter(point => {
        const progress = tdmForwardProgress(point, { ownX: own.x, enemyX: enemy.x });
        return progress !== null && progress >= 0 && progress < 0.5;
      });
      const frontProgress = tdmMedianForwardProgress(frontRows, {
        ownX: own.x, enemyX: enemy.x,
      });
      const visibleAt = ally => {
        const eye = ally.body.eye ? ally.body.eye()
          : new THREE.Vector3(ally.body.pos.x, ally.body.pos.y + 1.4, ally.body.pos.z);
        return foes.some(foe => {
          const foeEye = foe.body.eye ? foe.body.eye()
            : new THREE.Vector3(foe.body.pos.x, foe.body.pos.y + 1.4, foe.body.pos.z);
          return eye.distanceTo(foeEye) <= SPAWN_DANGER_LOS && this.losClear(eye, foeEye);
        }) ? 1 : 0;
      };
      const anchors = allies.filter(ally => tdmAnchorAllowed(ally, {
        ownX: own.x, enemyX: enemy.x, now: this.time,
        enemies: enemyRows, nearbyAllies: allies,
        visibleEnemies: visibleAt(ally),
      }));
      const envelope = mapEnvelope(this.mapIndex);
      const queue = (x, z) => {
        // Rectangular maps retain broad north/center/south variation; on
        // ellipse maps this keeps those same samples inside the authored rim.
        const point = clampToEnvelope(envelope, x, z, 4);
        if (tdmTerritoryAllowed(point, { ownX: own.x, enemyX: enemy.x }))
          raw.push([point.x, point.z]);
      };
      const fallbackLanes = [0.22, 0.5, 0.78].map(fraction => ({ body: { pos: {
        z: envelope.minZ + (envelope.maxZ - envelope.minZ) * fraction,
      } } }));
      // Keep authored north/center/south approaches in every search, then add
      // qualified squad lanes. A team concentrated in one lane may still
      // reinforce there, but it never erases the map's lateral alternatives.
      const lanes = anchors.length ? [...fallbackLanes, ...anchors] : fallbackLanes;
      const spawnPolicy = this.publicRoom ? PUBLIC_TDM_SPAWN : TDM_SPAWN;
      for (let i = 0; i < 36; i++) {
        const behind = spawnPolicy.behindFrontMin
          + Math.random() * (spawnPolicy.behindFrontMax - spawnPolicy.behindFrontMin);
        // There is always an allied row here, so the median is finite; keep a
        // defensive lower-band fallback for malformed/reconnecting bodies.
        const advance = tdmWaveProgress(frontProgress ?? TDM_SPAWN.minProgress,
          { ownX: own.x, enemyX: enemy.x, behind });
        if (advance === null) continue;
        const lane = lanes[i % lanes.length]?.body?.pos ?? b;
        const z = lane.z + (Math.random() - 0.5) * (anchors.length ? 30 : 20);
        queue(own.x + dir * advance, z);
      }
    }
    if (this.gameMode === 'koth' && this.hill) {
      // KOTH follows the same anchor discipline as CTF: no carrier shortcut,
      // no recently fighting/exposed/unsupported body, and no anchor on the
      // objective itself. This also gives a full-team wipe the protected-base
      // fallback through spawnPoint().
      const enemyRows = foes.map(e => e.body.pos);
      const visibleAt = ally => {
        const eye = ally.body.eye ? ally.body.eye()
          : new THREE.Vector3(ally.body.pos.x, ally.body.pos.y + 1.4, ally.body.pos.z);
        return foes.some(foe => {
          const foeEye = foe.body.eye ? foe.body.eye()
            : new THREE.Vector3(foe.body.pos.x, foe.body.pos.y + 1.4, foe.body.pos.z);
          return eye.distanceTo(foeEye) <= SPAWN_DANGER_LOS && this.losClear(eye, foeEye);
        }) ? 1 : 0;
      };
      const anchors = allies.filter(ally => kothAnchorAllowed(ally, {
        home: b, hill: this.hill, team, now: this.time,
        enemies: enemyRows, nearbyAllies: allies, visibleEnemies: visibleAt(ally),
      }));
      const medianDepth = kothMedianApproachDepth(anchors, {
        home: b, hill: this.hill, team,
      });
      if (medianDepth !== null) {
        const hill = this.hill.pos;
        const homeAngle = Math.atan2(b.z - hill.z, b.x - hill.x);
        // Cycle direct and lateral approaches. Lateral choices stay in the
        // home cone, so a pressured direct lane does not force a base spawn.
        const offsets = [-0.65, -0.35, 0, 0.35, 0.65];
        const maxDepth = Math.max(medianDepth + KOTH_SPAWN.behindFrontMax,
          Math.min(96, Math.max(34, medianDepth + 30)));
        for (let i = 0; i < 48; i++) {
          const depth = kothWaveApproachDepth(medianDepth, {
            behind: KOTH_SPAWN.behindFrontMin
              + Math.random() * (KOTH_SPAWN.behindFrontMax - KOTH_SPAWN.behindFrontMin),
            minDepth: this.hill.r + KOTH_SPAWN.pointClearance,
            maxDepth,
          });
          const offset = offsets[i % offsets.length] + (Math.random() - 0.5) * 0.12;
          const angle = homeAngle + offset;
          // `depth` is measured along the home vector. Compensate the radial
          // range for lateral bearing so every alternative remains behind the
          // median approach, rather than cutting diagonally toward the point.
          const radius = depth / Math.max(0.5, Math.cos(offset));
          raw.push([hill.x + Math.cos(angle) * radius,
            hill.z + Math.sin(angle) * radius]);
        }
      }
      if (this.mapIndex === 5 && this.hill.owner
          && this.hill.owner !== team) {
        // Caldera's bowl can leave a wiped, losing side with no qualifying
        // quiet anchor at all, which otherwise sends it back to the base
        // beyond the rim. These are still ordinary home-facing, off-point
        // candidates and pass the shared LOS/enemy/recent-death scorer below;
        // they merely seed a safe recovery wave at the foot of a ramp.
        const hill = this.hill.pos;
        const homeAngle = Math.atan2(b.z - hill.z, b.x - hill.x);
        for (const offset of [-0.28, 0, 0.28]) {
          const depth = 38 + Math.abs(offset) * 8;
          raw.push([hill.x + Math.cos(homeAngle + offset) * depth,
            hill.z + Math.sin(homeAngle + offset) * depth]);
        }
      }
    }

    const allyRows = allies.map(e => e.body.pos);
    const enemyRows = foes.map(e => e.body.pos);
    let best = null, bestScore = -Infinity;
    for (const [x, z] of raw) {
      const candidate = this._spawnSurface(x, z);
      if (!candidate) continue;
      if (this.gameMode === 'tdm'
          && !tdmTerritoryAllowed(candidate, { ownX: b.x,
            enemyX: BASE[this.enemyOf(team)].x })) continue;
      if (this.gameMode === 'koth' && this.hill
          && !kothCandidateDirectionalAllowed(candidate, {
            home: b, hill: this.hill, team,
          })) continue;
      const eye = new THREE.Vector3(candidate.x, candidate.y + 1.4, candidate.z);
      let visibleEnemies = 0;
      for (const foe of foes) {
        const foeEye = foe.body.eye ? foe.body.eye()
          : new THREE.Vector3(foe.body.pos.x, foe.body.pos.y + 1.4, foe.body.pos.z);
        if (eye.distanceTo(foeEye) <= SPAWN_DANGER_LOS && this.losClear(eye, foeEye))
          visibleEnemies++;
      }
      const score = tacticalSpawnScore(candidate, {
        enemies: enemyRows, allies: allyRows, objective, visibleEnemies,
        recentDeaths: this._recentDeaths.filter(d => d.team === team), mode: this.gameMode,
        upcomingObjective: this.gameMode === 'koth' ? this.hill?.spots?.[nextHillIndex(this.hill.index, this.hill.spots.length)] : null,
      });
      if (score > bestScore) { bestScore = score; best = candidate; }
    }
    return best;
  }

  // Opening CTF deployments and failed safety searches use the base. Later
  // CTF waves reinforce their own frontline; TDM waves track a protected
  // territorial band while KOTH retains its objective approach behavior.
  spawnPoint(team, preference = 'front') {
    return chooseSpawn({ mode: this.gameMode, base: t => this._baseSpawnPoint(t), ctf: t => this._ctfSpawnPoint(t), dynamic: t => this._dynamicSpawnPoint(t) }, team, preference);
  }

  losClear(a, b) {
    const dir = this._losDirection.subVectors(b, a);
    const d = dir.length();
    return !this.world.raycast(a, dir.normalize(), d);
  }

  // Interest management: is `body` something `eye` could actually
  // perceive right now — close range, or a genuinely clear sightline.
  // Used by _broadcastSnapshot to decide, per connection, which rows of
  // the snapshot that connection even needs to receive — closing the
  // trivial wallhack this codebase had until now (every position sent to
  // every client, every tick, regardless of walls or distance). Measured
  // to center mass, matching the same reference point _blastDamage uses
  // for cover checks, rather than ground-level feet — a raycast at foot
  // height can clip through low terrain lips that wouldn't actually
  // block a real sightline at eye/torso height.
  _perceives(eye, body) {
    const target = this._interestTarget.set(body.pos.x, body.pos.y + 0.9, body.pos.z);
    if (eye.distanceTo(target) <= INTEREST_CLOSE_R) return true;
    return this.losClear(eye, target);
  }

  _isSoundOccluded(pos) {
    const ear = this._listenerEye;
    if (!ear || !pos || !this.world) return false;
    const target = this._audioTarget.set(pos.x,
      (Number.isFinite(pos.y) ? pos.y : ear.y) + 0.7, pos.z);
    const direction = this._audioDirection.subVectors(target, ear);
    const distance = direction.length();
    if (!Number.isFinite(distance) || distance <= 4) return false;
    // Stop before the source itself: footsteps, digging, and impacts are
    // commonly emitted on a solid boundary and must not occlude themselves.
    return !!this.world.raycast(ear, direction.multiplyScalar(1 / distance),
      Math.max(0, distance - 1.25));
  }

  // Range the first visible surface or enemy under a shot ray. The sniper
  // HUD uses this probe directly, and bullet-drop compensation uses the same
  // result so the displayed distance and the ballistic solution cannot drift.
  _rangeProbe(from, dir, shooter, maxRange = 130) {
    const voxel = this.world.raycast(from, dir, maxRange);
    let distance = voxel ? voxel.dist : maxRange;
    let kind = voxel ? 'terrain' : 'far';
    for (const e of this.foesOf(shooter.team)) {
      if (!e.alive) continue;
      const r = rayVsSoldier(from, dir, e.body);
      if (r !== null && r.t < distance) { distance = r.t; kind = 'target'; }
    }
    return { distance, kind, hit: kind !== 'far' };
  }

  aimRange(shooter, maxRange = 130) {
    return this._rangeProbe(shooter.body.eye(), shooter.lookDir(), shooter, maxRange);
  }

  // Bullet drop: no projectile, no travel time — the shot still resolves
  // instantly like every weapon always has, this just tilts the fired
  // direction down before it does. Range is estimated with a probe against
  // the SAME target the player is looking at (terrain, but also the
  // nearest foe: a terrain-only probe would badly overestimate range
  // against someone standing in open ground with nothing behind them for
  // 100+ units, wildly over-dropping what should be a flat close shot).
  // Called on both the host's authoritative fireHitscan AND a client's own
  // local tracer preview in requestShoot, so what you see lines up with
  // what actually lands rather than the client's tracer going one way and
  // the real hit landing somewhere else.
  _dropCompensate(from, dir, spec, shooter) {
    if (!spec.dropVel) return dir; // spade/block/nade: no ballistics at all
    const range = this._rangeProbe(from, dir, shooter, 130).distance;
    const drop = GRAVITY_DROP * range * range / (2 * spec.dropVel * spec.dropVel);
    if (drop < 0.01) return dir; // negligible at this range — not worth the trig
    const point = from.clone().addScaledVector(dir, range);
    point.y -= drop;
    return point.sub(from).normalize();
  }

  // ---------------- combat ----------------
  fireHitscan(shooter, from, dir, spec, rewindAt = null) {
    this._noteAction(shooter);
    shooter._combatAt = this.time;
    triggerSoldierFire(shooter.parts ?? shooter.avatar?.parts);
    shooter.protT = 0; // firing drops spawn protection
    dir = this._dropCompensate(from, dir, spec, shooter);
    // Crouch steadies aim; iron sights steady it more (rifle ×0.5, SMG ×0.7 —
    // the SMG keeps its close-range identity, the rifle owns aimed mid-range).
    const spread = (spec.spread ?? 0) * (shooter.crouched ? 0.35 : 1)
      * (shooter.aiming ? (spec.aimSpread ?? 0.6) : 1);
    const d = dir.clone()
      .add(new THREE.Vector3((Math.random() - .5) * spread * 2,
                             (Math.random() - .5) * spread * 2,
                             (Math.random() - .5) * spread * 2))
      .normalize();

    const RANGE = 130;
    const voxel = this.world.raycast(from, d, RANGE);
    const maxT = voxel ? voxel.dist : RANGE;

    // Nearest entity struck before the wall.
    let hit = null, hitT = maxT, head = false;
    for (const e of this.foesOf(shooter.team)) {
      if (!e.alive) continue;
      const body = rewindAt == null ? e.body : this._historicalBody(e, rewindAt);
      const r = rayVsSoldier(from, d, body);
      if (r !== null && r.t < hitT) { hit = e; hitT = r.t; head = r.head; }
    }

    const end = hit
      ? from.clone().addScaledVector(d, hitT)
      : voxel
        ? from.clone().addScaledVector(d, Math.max(0, voxel.dist - 0.05))
        : from.clone().addScaledVector(d, RANGE);
    const muzzle = from.clone().addScaledVector(d, 1.2).add(new THREE.Vector3(0, -0.12, 0));
    const hex = voxel ? PALETTE[this.world.get(voxel.x, voxel.y, voxel.z)].color : 0;
    this.pingIntel(muzzle, shooter.team); // gunfire gives away your position
    this.shotFx(muzzle, end, !!hit, hex, from, spec.key);

    if (this.mode === 'host') {
      this.net.broadcast({ t: 'e', k: 'shot', sid: shooter.isRemote ? shooter.id : 'HOST',
        f: arr(muzzle), e: arr(end), hit: !!hit, hex, gun: spec.key });
    }

    if (hit) {
      // Sniper-only close-range penalty: the one mechanical gap in an
      // otherwise well-costed weapon was that its accuracy and damage were
      // exactly as good at point-blank as at range — no scope-sway, no
      // minimum-range falloff, nothing that made it worse in a fight it
      // wasn't supposed to win. This ramps damage from half at point-blank
      // up to full by 15 units, using the ACTUAL resolved hit distance
      // (hitT) rather than guessing a target's range before the shot even
      // fires — headshots stay comfortably lethal at any range (247.5×0.5
      // = 124, still a clean kill: skillful aim should always pay off) —
      // it's specifically the free 2-shot BODY kill at any range, including
      // a shotgun-range rush, that this removes (90×0.5=45, now needs a
      // 3rd hit up close, which the slow interval makes genuinely costly).
      const closeMul = spec.key === 'sniper' ? Math.min(1, 0.5 + 0.5 * (hitT / 15)) : 1;
      const dmg = spec.damage * (head ? (spec.headMult ?? 1.5) : 1) * closeMul;
      const damaged = this.damage(hit, dmg, shooter, null,
        { cause: spec.key, headshot: head });
      // hit was drawn from alive-only foes above, so !hit.alive here means
      // THIS shot is what did it — not just "they happen to be dead."
      if (damaged) this._hitFeedback(shooter, !hit.alive, head);
    }

    // Gunfire chips blocks: the voxel that stopped the bullet accumulates
    // damage and breaks after BLOCK_HP. Skipped when an entity absorbed the
    // shot first — the bullet never reached the wall. (fireHitscan only ever
    // runs on the host/solo side, so this stays authoritative and the break
    // reaches clients through the edit broadcast.)
    if (voxel && !hit) this.hitBlock(voxel.x, voxel.y, voxel.z, spec.damage ?? 20, shooter);
  }

  hitBlock(x, y, z, dmg, who = null) {
    if (this._protectedVoxelReason(x, y, z)) return;
    const key = x + ',' + y + ',' + z;
    const hp = (this.blockHits.get(key) ?? BLOCK_HP) - dmg;
    if (hp > 0) { this.blockHits.set(key, hp); return; }
    this.blockHits.delete(key);
    const v = this.world.get(x, y, z);
    this.applyEdit(x, y, z, 0, who);
    this.effects.blockBurst([{ x, y, z, v }]);
  }

  // Tracer + impact particles + report sound (shared by local sim and net
  // replay). Gunfire is positional: the report pans by bearing and fades
  // with range, so you can hear where a fight is. Your own muzzle (within
  // 2 blocks of your ear) already played its sound locally.
  shotFx(muzzle, end, hit, hex, from, kind = 'smg') {
    this.effects.tracer(muzzle, end);
    this.effects.muzzleFlash(muzzle, kind);
    this.effects.ejectCasing(muzzle);
    if (hit) this.effects.burst(end, 10, 0xc0392b, 4);
    else if (hex) this.effects.burst(end, 6, hex, 3);
    if (from.distanceToSquared(this.player.body.eye()) > 4) sfx.at(kind, muzzle);
  }

  // A small puff at whatever's actually underfoot, matching blockBurst's
  // own precedent of coloring debris from the real block rather than a
  // fixed neutral tone. Guards against no solid ground directly beneath
  // (an edge, a floating-point sliver at a block boundary) by just
  // skipping that one step's dust rather than guessing a color for it.
  // Thin wrapper around entities.js's shared footDust — kept so the two
  // existing call sites (own footsteps, and the entities() loop covering
  // bots/remote proxies on host/solo) don't need to change, since they
  // already have a Body handy and just want its position.
  _footDust(b) {
    footDust(this.world, this.effects, b.pos.x, b.pos.y, b.pos.z);
  }

  // Player tool entry points — route locally (solo/host) or to the host (client).
  _sendAction(k, payload = {}) {
    const n = ++this._actionSeq;
    this.net?.send({ t: 'a', k, n, life: this._serverLife, ...payload });
    return n;
  }

  requestShoot(p, t) {
    this._recordLocalAction(p, 'shoot');
    if (this.mode !== 'client') return this.fireHitscan(p, p.body.eye(), p.lookDir(), t);
    p.protT = 0; // firing drops spawn protection (the host drops its copy too)
    const from = p.body.eye(), dir = p.lookDir();
    // Local preview only, using the SAME raw dir sent below — the host
    // independently runs _dropCompensate on that raw direction inside
    // fireHitscan, so both sides land on the same answer without this
    // needing to send anything but what the player actually looked at.
    const previewDir = this._dropCompensate(from, dir, t, p);
    const vox = this.world.raycast(from, previewDir, 130);
    const end = vox
      ? from.clone().addScaledVector(previewDir, Math.max(0, vox.dist - 0.05))
      : from.clone().addScaledVector(previewDir, 130);
    const muzzle = from.clone().addScaledVector(previewDir, 1.2).add(new THREE.Vector3(0, -0.12, 0));
    this.effects.tracer(muzzle, end);
    this.effects.muzzleFlash(muzzle);
    this._lastWeaponActionSeq = this._sendAction('shoot',
      { o: arr(from), d: arr(dir), tool: p.tool });
  }

  // No speculative client preview: the host validates the streak, then its
  // one-shot telegraph event creates the drone on every machine. This is
  // just: send target + captured facing, wait for confirmation. p is the
  // caller's OWN player object in
  // both branches — solo/host validates and spends the streak against it
  // directly; a guest never touches its own _streak here at all, since
  // the host's copy (the RemotePlayer) is the only one that counts.
  requestAirstrike(p, x, z, yaw = p.yaw) {
    this._recordLocalAction(p, 'airstrike');
    if (this.mode !== 'client') return this._confirmAirstrike(p, x, z, yaw);
    this._sendAction('strike', { x, z, yaw });
  }
  requestReload(p) {
    if (this.mode === 'client' && GUN_CLASSES.includes(p.tool))
      this._lastWeaponActionSeq = this._sendAction('reload');
  }
  requestDig(p) {
    if (this.mode !== 'client') {
      const accepted = this.playerDig(p);
      if (accepted) this._recordLocalAction(p, 'dig');
      return accepted;
    }
    const n = this._sendAction('dig', { o: arr(p.body.eye()), d: arr(p.lookDir()) });
    this._pendingTerrainActions.set(n, 'dig');
    return n;
  }
  requestPlace(p) {
    if (this.mode !== 'client') {
      const accepted = this.playerPlace(p);
      if (accepted) this._recordLocalAction(p, 'place');
      return accepted;
    }
    if (p.blocks <= 0) { sfx.click(); return false; }
    const n = this._sendAction('place', { o: arr(p.body.eye()), d: arr(p.lookDir()) });
    this._pendingTerrainActions.set(n, 'place');
    return n;
  }
  requestNade(p) {
    this._recordLocalAction(p, 'grenade');
    p.protT = 0; // throwing is firing, as far as spawn protection is concerned
    if (this.mode !== 'client') return this.throwGrenade(p, p.body.eye(), p.lookDir(), 13);
    this._sendAction('nade', { o: arr(p.body.eye()), d: arr(p.lookDir()) });
  }

  // ---------------- bot team tactics ----------------
  activeBotOrder(team) {
    const order = this.botOrders?.[team];
    if (!order || order.expires <= this.time) {
      if (this.botOrders) this.botOrders[team] = null;
      return null;
    }
    return order;
  }

  _updateBotTactics(dt) {
    this._botTacticsT -= dt;
    if (this._botTacticsT <= 0) {
      this._botTacticsT = 0.5;
      for (const team of ['green', 'blue']) {
        const teamBots = this.bots.filter(b => b.team === team).map(b => ({
          id: b.id, x: b.body.pos.x, z: b.body.pos.z, alive: b.alive,
          carrier: b.carrier, role: b.tacticalRole,
        }));
        const ownFlag = this.flags?.[team];
        const friendlyCarrier = this.entities().find(e => e.alive && e.team === team && e.carrier);
        // Before taking a home flag, a lone bot advertises its short staging
        // position to the director. The existing escort allocation then pulls
        // close cover in while still reserving recovery and one defender.
        const stagingRunner = !friendlyCarrier && ownFlag?.state === 'home'
          && this.flags?.[this.enemyOf(team)]?.state === 'home'
          ? this.bots.filter(b => b.alive && b.team === team && !b.carrier
            && Number.isFinite(b.ctfStageAt)).sort((a, b) => a.ctfStageAt - b.ctfStageAt || a.id - b.id)[0]
          : null;
        const friendlySupportTarget = friendlyCarrier?.body?.pos ?? stagingRunner?.body?.pos;
        const flagPoint = ownFlag?.state === 'carried'
          ? this.standOf(team).clone().lerp(this.standOf(this.enemyOf(team)), 0.5)
          : ownFlag?.state === 'dropped' ? ownFlag.pos : ownFlag?.home;
        const roles = assignBotRoles(this.gameMode, teamBots, {
          ownFlagEmergency: ownFlag && ownFlag.state !== 'home',
          ownFlag: flagPoint,
          friendlyCarrier: friendlySupportTarget,
          friendlyCarrierId: stagingRunner?.id,
          ownStand: this.flags?.[team]?.home ?? this.standOf(team),
          midfield: { x: SX / 2, z: SZ / 2 },
          hill: this.hill?.pos,
        });
        for (const b of this.bots) if (b.team === team && roles[b.id]) {
          b.tacticalRole = roles[b.id];
          b.role = roles[b.id];
        }

        const order = this.activeBotOrder(team);
        if (order) {
          const fresh = this.bots.filter(b => b.team === team).map(b => ({
            id: b.id, x: b.body.pos.x, z: b.body.pos.z, alive: b.alive,
            carrier: b.carrier, role: b.tacticalRole,
          }));
          const limit = ['ATTACK', 'HILL'].includes(order.kind) ? 3 : 2;
          order.responders = botsForSquadOrder(fresh, order, limit);
        }
      }
    }

    const scheduled = scheduleBotBrains(this.bots, this.time,
      this._botBrainCursor, 3);
    this._botBrainCursor = scheduled.cursor;
    this._botThinkSet = new Set(scheduled.ids);
  }

  _updateBotAirstrikes() {
    if (!this._pendingStrikes) return;
    const reserved = this._pendingStrikes.map(s => s.pos);
    for (const bot of this.bots) {
      if (!bot.alive || this.availableStreak(bot) !== 'airstrike'
          || this._pendingStrikes.some(s => s.attacker === bot)) continue;
      const foes = this.foesOf(bot.team).filter(e => e.alive).map(e =>
        predictBotAirstrikePoint(e.body.pos, e.body.vel, 0.45, SX, SZ)).filter(Boolean);
      const allies = this.entities().filter(e => e.alive && e.team === bot.team)
        .filter(e => e !== bot).map(e => e.body.pos);
      const target = chooseBotAirstrikeTarget(foes, allies, reserved);
      if (!target) continue;
      this._confirmAirstrike(bot, target.x, target.z, bot.heading > 0 ? 0 : Math.PI);
      reserved.push(target);
    }
  }

  botTelemetry() {
    return botTelemetrySummary(this.bots.map(b => ({
      thinkMs: b.telemetry.thinkSamples
        ? b.telemetry.thinkMs / b.telemetry.thinkSamples : 0,
      stuckRecoveries: b.telemetry.stuckRecoveries,
      objectiveSeconds: b.telemetry.objectiveSeconds,
    })));
  }

  // ---------------- squad pings ----------------
  requestTeamPing(e = this.player) {
    if (!e?.alive || this.over) return;
    this._recordLocalAction(e, 'ping');
    const d = arr(e.lookDir());
    if (this.mode === 'client') this.net?.send({ t: 'a', k: 'mark', d });
    else this._hostPlaceTeamPing(e, d);
  }

  _teamPingKind(pos, team) {
    if (this.hill && pos.distanceToSquared(this.hill.pos) <= (this.hill.r + 4) ** 2)
      return 'HILL';
    if (this.flags) {
      if (pos.distanceToSquared(this.flags[team].home) <= 64) return 'DEFEND';
      if (pos.distanceToSquared(this.flags[this.enemyOf(team)].home) <= 64) return 'ATTACK';
    }
    return 'MOVE';
  }

  _hostPlaceTeamPing(e, rawDir) {
    const direction = normalizeDirection(rawDir);
    if (!direction || !e?.alive || this.over) return;
    if (this.time - (e._teamPingAt ?? -Infinity) < TEAM_PING_COOLDOWN) return;
    e._teamPingAt = this.time;
    const origin = e.body.eye();
    const dir = v3(direction);
    const hit = this.world.raycast(origin, dir, TEAM_PING_RANGE);
    const voxelDistance = hit?.dist ?? TEAM_PING_RANGE;
    let aimedEnemy = null, aimedDistance = Infinity;
    for (const foe of this.foesOf(e.team)) {
      if (!foe.alive) continue;
      const ray = rayVsSoldier(origin, dir, foe.body);
      if (ray && ray.t < voxelDistance && ray.t < aimedDistance) {
        aimedEnemy = foe; aimedDistance = ray.t;
      }
    }
    let pos;
    if (aimedEnemy) {
      pos = aimedEnemy.body.pos.clone().add(new THREE.Vector3(0, 1, 0));
    } else if (hit) {
      pos = new THREE.Vector3(hit.x + 0.5 + hit.nx * 0.56,
        hit.y + 0.5 + hit.ny * 0.56, hit.z + 0.5 + hit.nz * 0.56);
    } else {
      pos = origin.clone().addScaledVector(dir, TEAM_PING_RANGE * 0.62);
      pos.x = Math.min(SX - 1, Math.max(1, pos.x));
      pos.z = Math.min(SZ - 1, Math.max(1, pos.z));
      pos.y = Math.max(SEA + 1, this.world.surface(Math.floor(pos.x), Math.floor(pos.z)) + 1);
    }
    pos.x = Math.min(SX, Math.max(0, pos.x));
    pos.y = Math.min(SY + 8, Math.max(-4, pos.y));
    pos.z = Math.min(SZ, Math.max(0, pos.z));
    const msg = { t: 'e', k: 'mark', id: this._nextTeamPingId++, name: cleanName(e.name),
      team: e.team, x: pos.x, y: pos.y, z: pos.z,
      kind: aimedEnemy ? 'ENEMY' : this._teamPingKind(pos, e.team) };
    const candidates = this.bots.filter(b => b.team === e.team).map(b => ({
      id: b.id, x: b.body.pos.x, z: b.body.pos.z, alive: b.alive,
      carrier: b.carrier, role: b.tacticalRole,
    }));
    const limit = ['ATTACK', 'HILL', 'ENEMY'].includes(msg.kind) ? 3 : 2;
    this.botOrders[e.team] = { ...msg, expires: this.time + TEAM_PING_TTL,
      responders: botsForSquadOrder(candidates, msg, limit) };
    if (this.player.team === e.team) this._receiveTeamPing(msg);
    if (this.mode === 'host') for (const p of this.remote.values())
      if (p.team === e.team) this.net.sendTo(p.id, msg);
  }

  _receiveTeamPing(d) {
    if (d.team !== this.player.team) return;
    // Gold is already the HUD's navigation language and stays legible on
    // both green and blue terrain; team filtering, not color, protects scope.
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd97a, transparent: true });
    const group = new THREE.Group();
    const add = (w, h, z, y) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, z), mat);
      m.position.y = y; group.add(m);
    };
    add(0.28, 0.08, 0.28, 0.04);
    add(0.07, 0.62, 0.07, 0.35);
    add(0.4, 0.08, 0.4, 0.7);
    group.position.set(d.x, d.y, d.z);
    this.scene.add(group);
    this.teamPings.push({ id: d.id, name: cleanName(d.name), team: d.team,
      kind: d.kind, pos: new THREE.Vector3(d.x, d.y, d.z), group, mat, ttl: TEAM_PING_TTL });
    while (this.teamPings.length > TEAM_PING_LIMIT) this._removeTeamPing(this.teamPings[0]);
    sfx.ping();
  }

  _removeTeamPing(mark) {
    const i = this.teamPings.indexOf(mark);
    if (i >= 0) this.teamPings.splice(i, 1);
    disposeObject(mark.group);
  }

  _clearTeamPings() {
    for (const mark of [...(this.teamPings ?? [])]) this._removeTeamPing(mark);
    this.teamPings = [];
    this.botOrders = { green: null, blue: null };
  }

  _updateTeamPings(dt) {
    for (const mark of [...this.teamPings]) {
      mark.ttl -= dt;
      if (mark.ttl <= 0) { this._removeTeamPing(mark); continue; }
      mark.group.visible = this.player.body.pos.distanceToSquared(mark.pos) > 9;
      mark.group.position.y = mark.pos.y + Math.round(Math.sin(this.time * 5) * 2) * 0.04;
      mark.mat.opacity = Math.min(1, mark.ttl * 1.5);
    }
  }

  // ---------------- chat ----------------
  // Local echo is immediate; in a room the host is the relay (and the spam
  // filter), so a message reaches every screen exactly once.
  // Host/solo diagnostics and the harmless local /netstats readout are
  // checked before the chat rate limit because they are never real chat
  // messages and are never relayed.
  publicChatEnabled() { return !!this.engagementFeatures.publicChat; }

  sendChat(text, scope) {
    // Network telemetry is local and harmless on guests too; gameplay state
    // commands remain host/solo-only as described above.
    if ((this.mode !== 'client' || text.trim() === '/netstats') && this._devCommand(text)) return;
    scope = scope === 'all' && this.publicChatEnabled() ? 'all' : 'team';
    const now = performance.now();
    if (now < this._chatCd) return;         // easy on the enter key
    this._chatCd = now + 1200;
    const p = this.player;
    hud.chatMsg({ name: p.name, team: p.team, text, scope });
    if (this.mode === 'client') this.net.send({ t: 'a', k: 'chat', text, scope });
    else if (this.mode === 'host') this._hostRelayChat(null, p.team, text, scope);
  }

  // Returns true if `text` was a recognized local diagnostic command, so
  // the caller never forwards it as ordinary chat.
  _devCommand(text) {
    const t = text.trim();
    if (t === '/botstats') {
      const s = this.botTelemetry();
      hud.feed(`BOTS: ${s.samples} active · ${s.averageThinkMs.toFixed(2)}ms avg · `
        + `${s.maxThinkMs.toFixed(2)}ms max · ${s.stuckRecoveries} recoveries · `
        + `${Math.round(s.objectiveSeconds)}s objective`);
      return true;
    }
    if (t === '/netstats') {
      const n = this.net?.stats?.();
      if (!n) hud.feed('NET: offline');
      else hud.feed(`NET: ↑${(n.sentBytesPerSecond / 1024).toFixed(1)}KB/s `
        + `↓${(n.recvBytesPerSecond / 1024).toFixed(1)}KB/s · `
        + `${n.droppedState} stale state drops · ${n.droppedInbound} rate drops · `
        + `${Math.round(n.peakBuffered / 1024)}KB peak queue`);
      return true;
    }
    if (t === '/securitystats') {
      const s = this.securityTelemetry();
      hud.feed(`INTEGRITY: ${s.flagged} flagged · ${s.violations} rejected inputs · `
        + `${s.peakScore.toFixed(1)} peak score`);
      return true;
    }
    if (t === '/health') {
      const h = this.runtimeHealth;
      if (!h) hud.feed('HEALTH: diagnostics warming up');
      else hud.feed(`HEALTH: ${h.budget.pass ? 'PASS' : 'OVER BUDGET'} · `
        + `${h.frameP95Ms.toFixed(1)}ms p95 · ${h.drawCalls} calls · `
        + `${Math.round(h.triangles / 1000)}k tris`);
      return true;
    }
    return false;
  }

  runtimeCounts() {
    let sceneObjects = 0;
    this.scene.traverse(() => sceneObjects++);
    return {
      sceneObjects, chunks: this.world.chunks.size, particles: this.effects.particles.length,
      avatars: this.avatars.size, remotes: this.remote.size, bots: this.bots.length,
      strikes: this._pendingStrikes.length, editLog: this.editLog.length,
      respawnTimers: this.respawnTimers.size,
    };
  }

  engagementContext(source = 'resume') {
    const humans = this.mode === 'client'
      ? Math.max(1, this._rosterP?.size ?? 1) : this.remote.size + 1;
    const bots = this.mode === 'client'
      ? (this._rosterB?.size ?? this.bots.length) : this.bots.length;
    return {
      mode: this.gameMode, map: this.mapIndex, network: this.mode, source,
      humans, bots, round: this._roundSerial,
    };
  }

  // Match-local and exactly once: telemetry has no identifiers or arbitrary
  // data; its strict sanitizer is the only route to the production endpoint.
  funnel(step) {
    if (this._funnelSeen.has(step)) return false;
    this._funnelSeen.add(step);
    return this.fieldTelemetry?.record('funnel', { step, seconds: this.matchElapsed }) ?? false;
  }

  beginFirstMinute() {
    const p = this.player?.body?.pos;
    if (!p) return false;
    this.funnel('first_spawn');
    return this.firstMinuteGuide?.start({
      mode: this.gameMode, mapIndex: this.mapIndex,
      matchSecond: this.matchElapsed, x: p.x, z: p.z,
    }) ?? false;
  }

  // Find a nearby, actually editable voxel for the first-minute marker. The
  // probe is deterministic from the player's current facing and never points
  // at protected map foundations or an occupied build cell.
  tutorialTerrainTarget(kind = 'dig') {
    if (!this.player?.alive || !this.world) return null;
    const eye = this.player.body.eye();
    const yaw = this.player.yaw;
    const rays = [0, -0.35, 0.35, -0.7, 0.7, -1.1, 1.1].map(offset =>
      new THREE.Vector3(Math.cos(yaw + offset), -0.08,
        -Math.sin(yaw + offset)).normalize());
    for (const dir of rays) {
      const hit = this.world.raycast(eye, dir, kind === 'dig' ? 5 : 6);
      if (!hit) continue;
      if (kind === 'dig') {
        if (this.world.get(hit.x, hit.y, hit.z)
            && !this._protectedVoxelReason(hit.x, hit.y, hit.z))
          return { x: hit.x + 0.5, y: hit.y + 0.5, z: hit.z + 0.5 };
        continue;
      }
      const x = hit.x + hit.nx, y = hit.y + hit.ny, z = hit.z + hit.nz;
      if (!this.world.get(x, y, z) && !this._protectedBuildReason(x, y, z)) {
        const occupied = this.entities().some(e => e.alive
          && x + 1 > e.body.pos.x - e.body.half.x && x < e.body.pos.x + e.body.half.x
          && z + 1 > e.body.pos.z - e.body.half.x && z < e.body.pos.z + e.body.half.x
          && y + 1 > e.body.pos.y && y < e.body.pos.y + e.body.half.h);
        if (!occupied) return { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
      }
    }
    return null;
  }

  _recordLocalAction(p, action) {
    if (p !== this.player) return;
    this._noteAction(p);
    // Terrain contracts are advanced only here, after the authoritative
    // success path (solo/host validation or a client edit acknowledgement).
    // This keeps clicks into air, rejected builds, remote edits, and intent
    // packets out of persistent progression.
    if (action === 'dig' || action === 'place') {
      const contractUpdate = stats.recordTerrainAction(action);
      if (contractUpdate.unlocked.length) {
        const tags = contractUpdate.unlocked.join(' · ');
        this.messageTo(this.player,
          `CONTRACT COMPLETE · ${tags} BADGE UNLOCKED · AVAILABLE NEXT SESSION`, '#ffd97a');
      }
      this.onStatsChanged?.();
    }
    this.engagement?.action(action, this.matchElapsed);
    const step = { shoot: 'first_shoot', dig: 'first_dig', place: 'first_place', ping: 'first_ping' }[action];
    if (step) this.funnel(step);
    this.firstMinuteGuide?.mark(action);
  }

  // Host side: show it here, then forward to everyone the message is for —
  // the whole room, or just the sender's team — never back to the sender.
  _hostRelayChat(fromId, team, text, scope) {
    if (scope === 'all' && !this.publicChatEnabled()) return;
    const m = { t: 'e', k: 'chat', name: fromId == null ? this.player.name
      : this.remote.get(fromId)?.name, team, text, scope };
    for (const [id, p] of this.remote) {
      if (id === fromId) continue;
      if (scope === 'team' && p.team !== team) continue;
      this.net.sendTo(id, m);
    }
  }

  _hostOnChat(id, text, scope) {
    const p = this.remote.get(id);
    if (!p) return;
    const now = performance.now();          // per-sender throttle, host-enforced
    if (now < (p._chatCd ?? 0)) return;
    p._chatCd = now + 1200;
    text = String(text ?? '').trim().slice(0, 120);
    if (!text) return;
    scope = scope === 'all' && this.publicChatEnabled() ? 'all' : 'team';
    // Team chatter is for teammates only — the host included.
    if (scope === 'all' || p.team === this.player.team)
      hud.chatMsg({ name: p.name, team: p.team, text, scope });
    this._hostRelayChat(id, p.team, text, scope);
  }

  // Bearing of a world point relative to the LOCAL player's own current
  // facing — 0 = straight ahead, +PI/2 = directly right, -PI/2 = directly
  // left, ±PI = directly behind. Same forward/right convention used
  // everywhere else in this game (f=(cos(yaw),-sin(yaw)), r=(sin(yaw),cos(yaw)),
  // matching the normal WASD movement code and the flycam) — just run
  // through atan2 for the full angle instead of a single dot product the
  // way sfx.at()'s audio panning does. Panning only ever needed "how far
  // left or right am I," which a dot product against the right vector
  // alone gives you; a screen-edge indicator needs the full circle, since
  // a hit from directly behind has to read differently from a hit from
  // the side, not just collapse to the same "no left/right bias" value.
  _bearingTo(pos) {
    const p = this.player.body.pos;
    return relativeBearing(this.player.yaw, p.x, p.z, pos.x, pos.z);
  }

  // Shared by every attack that can attribute a single attacker (gunfire,
  // melee, grenades) — decides whether that attacker sees/hears a plain
  // hit or a kill confirmation. Always call this AFTER damage() has
  // already run, not before: killed has to reflect what damage() actually
  // did (which can no-op on spawn protection or an already-dead target),
  // not a guess made before applying it.
  //
  // Multi-kill tracking lives here too, not in a separate method — this
  // is already the one place every lethal hit passes through with the
  // attacker in hand, so a second chokepoint would just be a second place
  // for the two to drift out of sync. _mkCount/_mkT are tracked directly
  // on whatever entity got the kill (Player, RemotePlayer, or Bot) rather
  // than in some Game-level map — reset to zero on death (see each die()),
  // so a chain never survives past a life the way it shouldn't. A window
  // of 5 seconds SINCE THE LAST KILL, not since the first: three kills
  // 4 seconds apart each still chains into a triple, but 5+ seconds of
  // nothing breaks it, matching the sliding-window convention this genre
  // already uses (Halo's multikill medals work the same way).
  _hitFeedback(attacker, killed, headshot = false) {
    if (!attacker) return;
    let tier = null;
    if (killed) {
      const now = this.time;
      attacker._mkCount = (attacker._mkT != null && now - attacker._mkT <= 5) ? attacker._mkCount + 1 : 1;
      attacker._mkT = now;
      if (attacker._mkCount >= 2) {
        tier = attacker._mkCount >= 4 ? 'multi' : attacker._mkCount === 3 ? 'triple' : 'double';
      }
    }
    if (attacker === this.player) {
      hud.hitmark(killed); // the crosshair confirmation is unconditional — multi-kill or not, every kill gets it
      if (tier) hud.killCallout(tier); // replaces the plain chime below, doesn't play alongside it
      else if (headshot) sfx.headshot(killed);
      else killed ? sfx.kill() : sfx.hit();
    } else if (attacker.isRemote) {
      this.net.sendTo(attacker.id, { t: 'e', k: 'hit', kill: killed, tier,
        head: headshot ? 1 : 0 });
    }
  }

  // sourcePos is optional and defaults to the attacker's own position —
  // right for gunfire/melee, where the shooter IS the source. Grenades
  // pass it explicitly as the blast center: the thrower can be standing
  // somewhere completely different by the time their nade goes off, so
  // "which way did this come from" has to mean the explosion, not
  // wherever they've since moved to.
  damage(victim, amount, attacker, sourcePos, options = {}) {
    if (victim.protT > 0 && !options.ignoreProtection) return false; // environmental harm is never spawn-shielded
    if (!victim.alive || this.over) return false;
    // Central friendly-damage boundary. Gunfire and melee already search only
    // foes, but explosions and structural collapses iterate every entity.
    // Terrain destruction still happened before this call; only teammate HP
    // is protected. Self-damage remains valid.
    if (!options.environmental && !combatDamageAllowed(victim.team, attacker?.team,
        victim === attacker, this.friendlyFire)) return false;
    if (attacker && attacker !== victim && Number.isFinite(amount) && amount > 0) {
      const ledger = victim._damageLedger ??= new Map();
      const prior = ledger.get(attacker) ?? { damage: 0, at: this.time };
      prior.damage += Math.min(Math.max(0, victim.health), amount);
      prior.at = this.time;
      ledger.set(attacker, prior);
    }
    victim._combatAt = this.time;
    if (attacker && attacker !== victim) attacker._combatAt = this.time;
    this._noteAction(victim);
    this._noteAction(attacker);
    victim.health -= amount;
    victim.alert?.(attacker); // bots whirl toward whoever shot them
    const src = sourcePos ?? attacker?.body?.pos;
    if (victim !== this.player) {
      const facing = victim.parts?.group?.rotation?.y
        ?? victim.avatar?.group?.rotation?.y ?? victim.yaw ?? 0;
      const side = src && victim.body?.pos
        ? Math.sign((src.x - victim.body.pos.x) * Math.cos(facing)
          - (src.z - victim.body.pos.z) * Math.sin(facing)) || 1 : 1;
      triggerSoldierHit(victim.parts ?? victim.avatar?.parts, side);
    }
    if (victim === this.player) {
      hud.damage(); sfx.hurt(); hud.health(this.player);
      if (src) hud.damageDir(this._bearingTo(src));
    } else if (victim.isRemote && options.environmental && victim.health > 0) {
      // Environmental harm has no direction, but the guest still needs the
      // same flash/sound feedback the host gets locally.
      this.net.sendTo(victim.id, { t: 'e', k: 'envdmg', cause: options.cause });
    } else if (victim.isRemote && src && victim.health > 0) {
      // Non-lethal only: a dying guest is already headed into the crumple
      // + flycam sequence over on Player#die, and there's nothing left to
      // react to by the time this would land — no point telling someone
      // which way to look after the fight's already over for them.
      this.net.sendTo(victim.id, { t: 'e', k: 'dmgdir', x: src.x, z: src.z });
    }
    if (victim.health <= 0) {
      victim._deathCause = options.cause ?? null;
      const self = attacker === victim;
      victim._lastDeathRecap = makeDeathRecap({
        cause: options.cause,
        attacker: attacker && !self ? cleanName(attacker.name) : null,
        team: attacker && !self ? attacker.team : null,
        distance: src && victim.body?.pos ? src.distanceTo?.(victim.body.pos)
          ?? Math.hypot(src.x - victim.body.pos.x, src.z - victim.body.pos.z) : null,
        health: attacker && !self ? attacker.health : null,
        headshot: options.headshot,
        self,
      });
      victim.die(attacker);
      if (victim === this.player) hud.air(BREATH_MAX, false);
    }
    return true;
  }

  _updateBreathFor(entity, dt, authoritative) {
    const submerged = entity.body.pos.y + entity.body.half.h - EYE_INSET < SEA + 0.3;
    const next = stepBreath(entity._breath, entity._drownClock, submerged, dt);
    entity._breath = next.breath;
    entity._drownClock = next.drownClock;
    if (entity === this.player) hud.air(next.breath, submerged || next.breath < BREATH_MAX);
    if (authoritative && next.damage > 0) {
      this.damage(entity, next.damage, null, null,
        { environmental: true, ignoreProtection: true, cause: 'drowned' });
      if (entity === this.player && !entity.alive) hud.air(BREATH_MAX, false);
    }
  }

  // Host/solo authority for both hazards. Local bodies and bots expose their
  // real collision speed through Body#landedSpeed; connected guests get an
  // equivalent event reconstructed from host-observed fall distance.
  _updateEnvironmentalDamage(dt) {
    for (const e of this.entities()) {
      if (!e?.alive || !e.body) continue;
      const impact = e.body.landedSpeed ?? 0;
      e.body.landedSpeed = 0;
      if (impact > 0 && !e.body.inWater) {
        const amount = fallDamageForImpact(impact);
        if (amount > 0) this.damage(e, amount, null, null,
          { environmental: true, ignoreProtection: true, cause: 'fell' });
      }
      if (e.alive) this._updateBreathFor(e, dt, true);
    }
  }

  onDeath(victim, killer) {
    const wasCarrier = !!victim.carrier;
    const deathCause = victim._deathCause;
    this._recentDeaths.push({ x: victim.body.pos.x, z: victim.body.pos.z,
      t: this.time, team: victim.team });
    this._recentDeaths = this._recentDeaths.filter(row => this.time - row.t < 20).slice(-24);
    if (deathCause === 'collapse') this.voxelStory?.recordCollapseKill();
    const engagementCause = deathCause
      ?? (killer === victim ? 'suicide' : killer ? 'weapon' : 'environment');
    if (victim === this.player) {
      this.engagement?.combat('death', engagementCause);
      this.funnel('first_death');
    }
    if (killer === this.player && killer !== victim)
      this.engagement?.combat('kill', engagementCause);
    if (victim === this.player)
      hud.deathRecap(this.engagementFeatures.deathRecap ? victim._lastDeathRecap : null);
    // Flag drops where the carrier fell (capture-the-flag only).
    if (this.flags && victim.carrier) {
      victim.carrier = false;
      this.flags[this.enemyOf(victim.team)].drop(victim.body.pos.clone());
      this.flags[this.enemyOf(victim.team)].dropTimer = this._ctfEscalation.returnTime;
      // this.feed/this.message, not hud.* — the wrappers relay to clients.
      this.feed(`${nameSpan(victim)} dropped the flag`);
      this.message('FLAG DROPPED', '#ffd97a');
    }
    if (killer && killer !== victim) this.feed(`${nameSpan(killer)} ⚔ ${nameSpan(victim)}`);
    else if (victim._deathCause === 'drowned') this.feed(`${nameSpan(victim)} drowned`);
    else if (victim._deathCause === 'fell') this.feed(`${nameSpan(victim)} fell`);
    else if (victim._deathCause === 'void') this.feed(`${nameSpan(victim)} fell out of the world`);
    else this.feed(`${nameSpan(victim)} blew up`);
    victim._deathCause = null;
    // A corpse marks a fight: the fallen's teammates hunt toward it.
    if (killer && killer !== victim) this.pingIntel(victim.body.pos, killer.team, 'combat');
    if (killer) this._noteAction(killer);

    // Scoreboard: a death for the fallen, a kill for the killer — suicides
    // and terrain score a death only, same as TDM team scoring below.
    this._kdRow(victim).d++;
    this._scoreDirty = true;
    if (killer && killer !== victim) {
      this._kdRow(killer).k++;
      const weaponSpecialty = ['rifle', 'smg', 'sniper'].includes(deathCause) ? deathCause
        : deathCause === 'collapse' ? 'terrain' : null;
      this._award(killer, CONTRIBUTION.kill,
        { specialty: weaponSpecialty, specialtyPoints: 1 });
      if (deathCause === 'collapse')
        this._award(killer, CONTRIBUTION.collapseKill,
          { specialty: 'terrain', specialtyPoints: 1 });

      if (wasCarrier) this._award(killer, CONTRIBUTION.carrierStop,
        { objective: 1, specialty: 'objective', specialtyPoints: 1 });
      if (this.flags) {
        const own = this.flags[killer.team].home;
        if (killer.body.pos.distanceTo(own) <= 18 || victim.body.pos.distanceTo(own) <= 18)
          this._award(killer, CONTRIBUTION.objectiveDefense,
            { objective: 1, specialty: 'objective', specialtyPoints: 1 });
        const carrier = this.entities().find(e => e !== killer && e.alive
          && e.team === killer.team && e.carrier);
        if (carrier && (carrier.body.pos.distanceTo(killer.body.pos) <= 20
            || carrier.body.pos.distanceTo(victim.body.pos) <= 20))
          this._award(killer, CONTRIBUTION.carrierEscort,
            { objective: 1, specialty: 'objective', specialtyPoints: 1 });
      } else if (this.hill) {
        const radius = this.hill.r + 8;
        if (killer.body.pos.distanceTo(this.hill.pos) <= radius
            || victim.body.pos.distanceTo(this.hill.pos) <= radius)
          this._award(killer, CONTRIBUTION.objectiveDefense,
            { objective: 1, specialty: 'objective', specialtyPoints: 1 });
      }

      for (const helper of assistCreditors(victim._damageLedger, killer, this.time))
        this._award(helper, CONTRIBUTION.assist, { assists: 1 });
    }
    victim._damageLedger?.clear();
    this._broadcastScoreboard(true); // keep every open TAB overlay and client current
    this._syncPersistentStats(); // host/solo side; the client path is in the 'kd' case below

    // Deathmatch: a kill is a point. Suicides and the terrain score nothing.
    if (this.gameMode === 'tdm' && killer && killer !== victim && !this.over) {
      this.captures[killer.team]++;
      hud.score(this);
      if (this.captures[killer.team] >= modeScoreLimit('tdm', {
        publicRoom: this.publicRoom,
      })) this._end(killer.team);
      else this._checkOvertimeEnd();
    }

    if (this.over) return 0;
    // Every death joins the next shared mode-specific team wave. Players who
    // fall together return together instead of trickling back one by one.
    const redeploy = respawnWaveDelay(this.gameMode, this.matchElapsed);
    this.respawnTimers.set(victim, redeploy);
    if (victim === this.player) hud.respawn(redeploy);
    return redeploy;
  }

  // ---------------- block tools ----------------
  _appendWorldEdit(entry) {
    this.editLog.push(entry);
    this._worldHash = advanceWorldHash(this._worldHash, entry);
  }

  _worldStamp(message) {
    message.wr = this.editLog.length;
    message.wh = this._worldHash >>> 0;
    return message;
  }

  applyEdit(x, y, z, v, who = null) {
    if (!v && this._protectedVoxelReason(x, y, z)) return false;
    this.blockHits.delete(x + ',' + y + ',' + z);  // fresh block / cleared cell: full HP
    const before = this.world.get(x, y, z);
    this.world.set(x, y, z, v);
    const after = this.world.get(x, y, z);
    this.voxelStory?.recordEdit(before, after);
    this.navRevision++;
    if (this.mode === 'host') {
      this._appendWorldEdit([x, y, z, v]);
      const stamp = { t: 'e', k: 'edit', x, y, z, v };
      // Carry the accepted action sequence only for a remote player. Clients
      // use it as an authoritative terrain-lesson acknowledgement; without
      // this stamp a guest would have to guess which edit was theirs.
      if (Number.isSafeInteger(who?._lastActionSeq) && who.isRemote) {
        stamp.aid = who._lastActionSeq;
        if (Number.isSafeInteger(who.ridx)) stamp.actor = who.ridx;
      }
      this.net.broadcast(this._worldStamp(stamp));
    }
    if (!v) this._collapseFrom([{ x, y, z }], who); // cut the legs out? it falls
    return true;
  }

  // Structural support: whatever isn't connected to bedrock comes down.
  // Multi-source BFS from every solid face of the void a removal left. A
  // clump that can't reach y=0 within its proof budget collapses. Natural
  // terrain stays conservatively bounded; placed structures get enough room
  // for broad bridges. Host/solo only: clients replay the 'col' event so
  // every world converges on the host's.
  _collapseFrom(holes, who = null) {
    if (this.mode === 'client' || !holes.length) return;
    // Per connected component: a dig at a tower's base touches BOTH the
    // terrain and the tower — the grounded dirt must not vouch for the
    // severed tower. Each clump has to find its own way to bedrock.
    // Cells carry a VERDICT, not just a visited mark. A shared visited set
    // was wrong: when one clump exits early on reaching bedrock it leaves a
    // half-explored frontier marked visited with no answer recorded, and the
    // next seed in that same clump can't expand through it — so it measures
    // a small isolated blob and condemns terrain that is perfectly held up.
    // Fuzzing found this on ~3% of digs, always in the "drops what should
    // stand" direction. Reaching an already-resolved cell means same clump,
    // same answer: inherit it and stop.
    const doomed = unsupportedCollapseCells((x, y, z) => this.world.get(x, y, z), holes);
    for (const key of doomed) {
      const [x, y, z] = key.split(',').map(Number);
      if (this._protectedVoxelReason(x, y, z)) doomed.delete(key);
    }
    if (!doomed.size) return;
    // Down it comes: remove the clump, dust it, and hurt anyone standing in
    // it or directly under it — a falling tower should kill.
    const cells = [...doomed].map(k => {
      const [x, y, z] = k.split(',').map(Number);
      return { x, y, z, v: this.world.get(x, y, z) };
    });
    this.world.batchEdits(() => {
      for (const c of cells) this.world.set(c.x, c.y, c.z, 0);
    });
    this.voxelStory?.recordCollapse(cells.length);
    this.effects.blockBurst(cells.filter((_, i) => i % Math.ceil(cells.length / 48) === 0));
    sfx.crumble();
    for (const e of this.entities()) {
      if (!e.alive) continue;
      const b = e.body;
      const x0 = Math.floor(b.pos.x - b.half.x), x1 = Math.floor(b.pos.x + b.half.x);
      const y0 = Math.floor(b.pos.y),        y1 = Math.floor(b.pos.y + b.half.h);
      const z0 = Math.floor(b.pos.z - b.half.x), z1 = Math.floor(b.pos.z + b.half.x);
      let hit = 0, source = null;
      for (let x = x0; x <= x1 && hit < 55; x++)
        for (let z = z0; z <= z1 && hit < 55; z++) {
          for (let y = y0; y <= y1; y++)
            if (doomed.has(collapseKey(x, y, z))) {
              hit = 55; source = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5); break;
            }
          for (let y = y1 + 1; !hit && y <= y1 + 3; y++)
            if (doomed.has(collapseKey(x, y, z))) {
              hit = 30; source = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5);
            }
        }
      // Falling masonry is the damage source, not whoever happened to
      // remove its support. Point the victim toward the collapsing cell.
      if (hit) this.damage(e, hit, who, source, { cause: 'collapse' });
    }
    if (this.mode === 'host') {
      // Keep each event within protocol.js's existing 4,000-cell trust
      // boundary. Larger built bridges arrive as a short ordered sequence;
      // every packet advances the edit revision by exactly its own payload.
      for (let i = 0; i < cells.length; i += COLLAPSE_PACKET_CELLS) {
        const batch = cells.slice(i, i + COLLAPSE_PACKET_CELLS);
        for (const c of batch) this._appendWorldEdit([c.x, c.y, c.z, 0]); // late joiners
        this.net.broadcast(this._worldStamp({ t: 'e', k: 'col',
          cells: batch.flatMap(c => [c.x, c.y, c.z]) }));
      }
    }
  }

  digVoxel(who, x, y, z) {
    if (Number.isFinite(who?._editTokens) && who._editTokens < 1) return false;
    const v = this.world.get(x, y, z);
    if (!v) return false;
    if (this._protectedVoxelReason(x, y, z)) return false;
    this.applyEdit(x, y, z, 0, who);
    this.effects.blockBurst([{ x, y, z, v }]);
    if (who === this.player) {
      this.player.blocks = Math.min(99, this.player.blocks + 1);
      sfx.dig(v);
      hud.refreshTool(this.player);
    } else {
      // Someone else's shovel: audible where it happens — tunneling is a
      // stealth tradeoff, not free silence.
      sfx.at('dig', { x, y, z }, v);
      if (who.isRemote) who.blocks = Math.min(99, who.blocks + 1);
    }
    const bodyPassage = (dx, dz) => !this.world.get(x + dx, y, z + dz)
      && !this.world.get(x + dx, y + 1, z + dz);
    const changedPassability = (bodyPassage(-1, 0) && bodyPassage(1, 0))
      || (bodyPassage(0, -1) && bodyPassage(0, 1));
    const tactical = this.time - (who?._combatAt ?? -Infinity) < 10
      || v === BLOCK.BLUE || v === BLOCK.GREEN;
    this._recognizeVoxel(who, usefulVoxelAction({ type: 'dig',
      changedPassability: changedPassability && tactical }));
    if (Number.isFinite(who?._editTokens)) {
      who._editTokens = Math.max(0, who._editTokens - 1);
      who._terrainEdits++;
    }
    return true;
  }

  playerDig(p, origin = null, dir = null) {
    this._noteAction(p);
    p._combatAt = this.time;
    p.protT = 0; // swinging is firing: melee must not stay invulnerable
    origin = origin ?? p.body.eye();
    dir = dir ?? p.lookDir();
    const hit = this.world.raycast(origin, dir, 5);
    // Spade doubles as a melee weapon.
    for (const e of this.foesOf(p.team)) {
      if (e.alive && e.body.eye().distanceTo(origin) < 3.2) {
        this.effects.burst(e.body.eye(), 10, 0xc0392b, 4);
        if (p === this.player) sfx.spadeHit();
        else sfx.at('spadeHit', e.body.eye());
        if (this.damage(e, 45, p, null, { cause: 'spade' }))
          this._hitFeedback(p, !e.alive); // e was drawn from the alive-only loop above
        return false;
      }
    }
    if (hit) return this.digVoxel(p, hit.x, hit.y, hit.z);
    if (p === this.player) sfx.swing();
    return false;
  }

  playerPlace(p, origin = null, dir = null) {
    this._noteAction(p);
    if (p.blocks <= 0) { if (p === this.player) sfx.click(); return false; }
    origin = origin ?? p.body.eye();
    dir = dir ?? p.lookDir();
    const hit = this.world.raycast(origin, dir, 6);
    if (!hit) return false;
    const x = hit.x + hit.nx, y = hit.y + hit.ny, z = hit.z + hit.nz;
    const accepted = this.tryBuild(p, x, y, z);
    if (accepted && p === this.player) { sfx.place(); hud.refreshTool(p); }
    return accepted;
  }

  // Shared placement rules for players and bots: cell must be empty, nobody
  // gets entombed, the builder's team color is used, inventory decremented.
  tryBuild(p, x, y, z) {
    if (Number.isFinite(p?._editTokens) && p._editTokens < 1) return false;
    if (p.blocks <= 0 || this.world.get(x, y, z)) return false;
    const protectedReason = this._protectedBuildReason(x, y, z);
    if (protectedReason) {
      // Rate-limited feedback: holding place against a protected edge should
      // explain itself, not turn into a center-screen message machine.
      if ((p === this.player || p.isRemote) && this.time - (p._buildDenyT ?? -9) > 0.8) {
        p._buildDenyT = this.time;
        const label = protectedReason === 'flag' ? 'FLAG STAND MUST STAY CLEAR'
          : protectedReason === 'hill' ? 'HILL CENTER MUST STAY CLEAR'
          : protectedReason === 'signature' ? 'ROUTE FOUNDATION MUST STAY CLEAR'
          : 'SPAWN PAD MUST STAY CLEAR';
        this.messageTo(p, label, '#ffd97a');
      }
      return false;
    }
    for (const e of this.entities()) {
      if (!e.alive) continue;
      const b = e.body;
      if (x + 1 > b.pos.x - b.half.x && x < b.pos.x + b.half.x &&
          z + 1 > b.pos.z - b.half.x && z < b.pos.z + b.half.x &&
          y + 1 > b.pos.y && y < b.pos.y + b.half.h) return false;
    }
    const beforeSurface = this.world.surface(x, z);
    const bridgedGap = beforeSurface < SEA || y > beforeSurface + 1;
    const recentCombat = this.time - (p._combatAt ?? -Infinity) < 8;
    const pCenter = p.body.pos.clone().add(new THREE.Vector3(0, .9, 0));
    const clearThreats = recentCombat ? this.foesOf(p.team).filter(e => e.alive
      && e.body.pos.distanceToSquared(p.body.pos) < 24 ** 2
      && this.losClear(e.body.eye(), pCenter)) : [];
    this.applyEdit(x, y, z, p.team === 'blue' ? BLOCK.BLUE : BLOCK.GREEN, p);
    p.blocks--;
    this._recognizeVoxel(p, usefulVoxelAction({ type: 'build',
      bridgedGap, tactical: recentCombat,
      blockedThreat: clearThreats.some(e => !this.losClear(e.body.eye(), pCenter)) }));
    if (Number.isFinite(p?._editTokens)) {
      p._editTokens = Math.max(0, p._editTokens - 1);
      p._terrainEdits++;
    }
    return true;
  }

  _recognizeVoxel(p, label) {
    if (!label || !p || this.time - (p._voxelRecognitionAt ?? -Infinity) < 12) return;
    p._voxelRecognitionAt = this.time;
    this._award(p, 20, { specialty: 'terrain', specialtyPoints: 1 });
    this.messageTo(p, label, '#ffd97a');
  }

  _protectedBuildReason(x, y, z) {
    const flags = this.flags ? ['green', 'blue'].map(team => {
      const p = this.flags[team].home;
      return { x: p.x, y: p.y, z: p.z, r: 2.25, below: 1, above: 4 };
    }) : [];
    // spawnPoint's deterministic fallback is the one position that must stay
    // usable even after every randomized candidate has been cratered or built
    // over. Protect only that compact pad, not the broader base approaches.
    const spawns = ['green', 'blue'].map(team => {
      const b = BASE[team], dir = team === 'green' ? 1 : -1;
      const sx = b.x + dir * 12, sz = b.z;
      return { x: sx, y: this.world.surface(Math.floor(sx), Math.floor(sz)) + 1,
        z: sz, r: 3.5, below: 1, above: 4 };
    });
    const hill = this.hill && { x: this.hill.pos.x, y: this.hill.pos.y,
      z: this.hill.pos.z, r: 2.5, below: 2, above: 4 };
    return protectedBuildReason(x, y, z, { flags, spawns, hill,
      signature: signatureProtectedAreas(this.mapIndex, this.seed) });
  }

  _protectedVoxelReason(x, y, z) {
    return this._protectedBuildReason(x, y, z);
  }

  // ---------------- grenades ----------------
  throwGrenade(owner, origin, dir, speed) {
    this._noteAction(owner);
    owner._combatAt = this.time;
    owner.protT = 0; // covers proxy throws arriving via the host action path
    this.grenades.push({
      pos: origin.clone().addScaledVector(dir, 0.5),
      vel: dir.clone().multiplyScalar(speed).add(new THREE.Vector3(0, 2.5, 0)),
      fuse: 2.4,
      owner,
    });
  }

  _updateGrenades(dt) {
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.fuse -= dt;
      g.vel.y -= 22 * dt;
      for (const axis of ['x', 'y', 'z']) {
        const next = g.pos[axis] + g.vel[axis] * dt;
        const probe = g.pos.clone(); probe[axis] = next;
        if (this.world.solid(probe.x, probe.y, probe.z)) g.vel[axis] *= -0.42;
        else g.pos[axis] = next;
      }
      if (g.fuse <= 0) {
        this.grenades.splice(i, 1);
        this._explode(g);
      }
    }
    for (let i = 0; i < this.grenadeMeshes.length; i++) {
      const g = this.grenades[i], m = this.grenadeMeshes[i];
      m.visible = !!g;
      if (g) m.position.copy(g.pos);
    }
  }

  _explode(g) {
    const R = 2.4; // a modest divot: grenades maim players, not landscapes
    this.explodeAt(g.pos.x, g.pos.y, g.pos.z, R, g.owner);
    if (this.mode === 'host') {
      this._appendWorldEdit(['b', g.pos.x, g.pos.y, g.pos.z, R]);
      this.net.broadcast(this._worldStamp(
        { t: 'e', k: 'boom', x: g.pos.x, y: g.pos.y, z: g.pos.z, r: R }));
    }
    this._blastDamage(g.pos, g.owner, R, 9, 150, 15, R, 'grenade');
  }

  // Extracted from the original grenade-only version of _explode so
  // Airstrike (below) can reuse the exact same damage-falloff-plus-cover
  // logic at a bigger scale instead of duplicating the whole loop.
  // craterR: below this range, always hits regardless of cover (you're
  // standing in the fireball itself). dmgRadius/baseDamage/minDamage:
  // linear falloff from baseDamage at the center to minDamage at the edge.
  // noCoverR defaults to craterR — grenades don't pass it, so their
  // behavior is completely unchanged. Airstrike passes a wider, explicit
  // value instead (see _airstrikeImpact): the visual crater size and the
  // "cover doesn't matter here" radius don't have to be the same number,
  // they just always were for grenades because nobody had a reason to
  // pull them apart until now.
  _blastDamage(pos, owner, craterR, dmgRadius, baseDamage, minDamage,
      noCoverR = craterR, cause = 'grenade') {
    for (const e of this.entities()) {
      if (!e.alive) continue;
      // Measured to center mass, not the eye — a shot to the ground under
      // someone used to lose real reach to eye height alone.
      const center = e.body.pos.clone().add(new THREE.Vector3(0, 0.9, 0));
      const d = pos.distanceTo(center);
      if (d >= dmgRadius) continue;
      // Cover has to mean something: without this, a blast behind a wall
      // it never breached still dealt damage through solid stone.
      if (d > noCoverR && !this.losClear(pos, center)) continue;
      const damaged = this.damage(e,
        Math.max(minDamage, baseDamage * (1 - d / dmgRadius)), owner, pos, { cause });
      // Grenades can catch their own thrower (this loop is entities(), no
      // team filter, unlike gunfire/melee which only ever loop foesOf) —
      // self-damage still applies, it just shouldn't ring a "kill
      // confirmed" chime for blowing yourself up.
      if (damaged && e !== owner) this._hitFeedback(owner, !e.alive);
    }
  }

  // Host/solo-authoritative — re-validates the streak against the
  // attacker's OWN authoritative copy rather than trusting whatever a
  // guest claims, and re-clamps the target coordinates: this is wire data
  // from requestAirstrike's client branch, same untrusted-input treatment
  // every other player-originated network message gets in this codebase.
  // Spends the streak HERE, not when piloting mode was entered — cancel
  // out of targeting with no shot fired and nothing was ever charged.
  _confirmAirstrike(attacker, x, z, yaw) {
    if (availableStreakAbility(attacker._streak ?? 0) !== 'airstrike') return;
    x = Math.max(0, Math.min(SX, x)); z = Math.max(0, Math.min(SZ, z));
    // The action packet captures the caller's first-person yaw at commit
    // time. Normalize it once here so arbitrarily large but finite angles
    // cannot leak into transforms or the quantized snapshot representation.
    yaw = Number.isFinite(yaw) ? Math.atan2(Math.sin(yaw), Math.cos(yaw))
      : attacker === this.player ? attacker.yaw : attacker.yaw + Math.PI / 2;
    attacker._streak = spendStreak(attacker._streak, AIRSTRIKE_COST);
    const y = this.world.surface(Math.floor(x), Math.floor(z)) + 1;
    const id = this._nextStrikeId++;
    const owner = attacker === this.player ? this._hostIdx
      : attacker.isRemote ? attacker.ridx : BOT_STRIKE_OWNER_BASE + attacker.id;
    if (this.mode === 'host') this.net.broadcast({ t: 'e', k: 'telegraph',
      id, x, y, z, yaw, remaining: AIRSTRIKE_TELEGRAPH_T, owner });
    this._telegraph(x, y, z);
    this.messageTeam(attacker.team, 'ALLY AIRSTRIKE INBOUND — CLEAR THE TARGET', teamCss(attacker.team));
    this.messageTeam(this.enemyOf(attacker.team),
      'ENEMY AIRSTRIKE INBOUND — MOVE OFF THE TARGET', '#e05a4e');
    this._pendingStrikes.push({ id, pos: new THREE.Vector3(x, y, z), owner,
      attacker, yaw, t: AIRSTRIKE_TELEGRAPH_T });
    this._syncAirstrikeDrone(id, x, y, z, yaw, AIRSTRIKE_TELEGRAPH_T, owner);
  }

  // Create or update one local visual replica. Target coordinates are kept
  // separate from displayTarget so 15Hz steering snapshots remain smooth at
  // render rate. Updating an existing entry also derives a small bank from
  // lateral target movement; no physics or authority lives in this object.
  _syncAirstrikeDrone(id, x, y, z, yaw, remaining, owner) {
    if (!Number.isInteger(id) || id < 0) return;
    yaw = Number.isFinite(yaw) ? Math.atan2(Math.sin(yaw), Math.cos(yaw)) : 0;
    remaining = THREE.MathUtils.clamp(Number.isFinite(remaining) ? remaining : 0,
      0, AIRSTRIKE_TELEGRAPH_T);
    let flight = this._airstrikeDrones.get(id);
    if (!flight) {
      const parts = makeMq9Drone();
      const target = new THREE.Vector3(x, y, z);
      flight = { id, ...parts, target, displayTarget: target.clone(), yaw,
        remaining, owner, bank: 0, bankGoal: 0, expired: 0,
        droneSfxT: 0, missileSfxT: 0, soundPos: target.clone() };
      parts.group.rotation.order = 'YXZ';
      this.scene.add(parts.group);
      this._airstrikeDrones.set(id, flight);
      sfx.at('missileLaunch', target);
    } else {
      const dxTarget = x - flight.target.x, dzTarget = z - flight.target.z;
      // Right vector for forward=(cos(yaw), -sin(yaw)). Only side-to-side
      // steering banks the aircraft; moving the target along its flight line
      // should not make it roll.
      const lateral = dxTarget * Math.sin(flight.yaw) + dzTarget * Math.cos(flight.yaw);
      flight.bankGoal = THREE.MathUtils.clamp(-lateral * 0.055, -0.25, 0.25);
      flight.target.set(x, y, z);
      flight.yaw = yaw;
      flight.remaining = remaining;
      flight.owner = owner;
      flight.expired = 0;
    }
    return flight;
  }

  _removeAirstrikeDrone(id) {
    const flight = this._airstrikeDrones.get(id);
    if (!flight) return;
    disposeObject(flight.group);
    this._airstrikeDrones.delete(id);
  }

  _clearAirstrikeDrones() {
    if (!this._airstrikeDrones) return;
    for (const flight of this._airstrikeDrones.values()) disposeObject(flight.group);
    this._airstrikeDrones.clear();
  }

  // Render-rate motion for every mode. Clients locally lead their own
  // steerable target with _pilotPos to avoid adding a round trip to the drone
  // they are actively guiding; authoritative snapshots still correct it.
  _updateAirstrikeDrones(dt) {
    for (const [id, flight] of this._airstrikeDrones) {
      if (this.mode === 'client') {
        if (flight.owner === this.myIdx && this.player._fallingT > 0) {
          const p = this.player._pilotPos;
          const y = this.world.surface(Math.floor(p.x), Math.floor(p.z)) + 1;
          this._syncAirstrikeDrone(id, p.x, y, p.z, flight.yaw,
            this.player._fallingT, flight.owner);
        } else {
          flight.remaining = Math.max(0, flight.remaining - dt);
        }
      }
      const smoothing = 1 - Math.exp(-dt * 12);
      flight.displayTarget.lerp(flight.target, smoothing);
      flight.bank += (flight.bankGoal - flight.bank) * (1 - Math.exp(-dt * 7));
      flight.bankGoal *= Math.exp(-dt * 5);
      const pose = airstrikeDronePose(flight.displayTarget.x, flight.displayTarget.y,
        flight.displayTarget.z, flight.yaw, flight.remaining);
      flight.group.position.set(pose.x, pose.y, pose.z);
      flight.group.rotation.y = pose.yaw;
      flight.group.rotation.x = flight.bank;
      flight.propeller.rotation.x += dt * 24;
      const progress = 1 - flight.remaining / AIRSTRIKE_TELEGRAPH_T;
      flight.droneSfxT -= dt;
      if (flight.droneSfxT <= 0) {
        flight.droneSfxT += 0.13;
        sfx.at('drone', flight.group.position, progress);
      }
      // The falling cell starts just after release, rises in pitch/level as
      // it approaches, and follows the guided target rather than the plane.
      flight.missileSfxT -= dt;
      if (progress > 0.08 && flight.missileSfxT <= 0) {
        flight.missileSfxT += 0.19;
        flight.soundPos.set(flight.displayTarget.x,
          flight.displayTarget.y + (1 - progress) * AIRSTRIKE_DRONE_ALTITUDE,
          flight.displayTarget.z);
        sfx.at('missile', flight.soundPos, progress);
      }
      if (flight.remaining <= 0) {
        flight.expired += dt;
        // Normally the boom event or next empty snapshot removes it first.
        // This grace is only a lost-message safety net.
        if (flight.expired > 1) this._removeAirstrikeDrone(id);
      }
    }
  }

  // Active strikes are an unconditional snapshot channel, like grenades.
  // Reconcile the whole small list rather than inventing removal messages;
  // this also gives a late joiner the current flyover immediately.
  _syncAirstrikeRows(rows) {
    if (!Array.isArray(rows)) return;
    this._lastStrikeRows = rows.map(row => row.slice());
    const want = new Set();
    for (const row of rows) {
      const [id, xq, yq, zq, yawq, millis, owner] = row;
      want.add(id);
      const x = THREE.MathUtils.clamp(dx(xq), 0, SX);
      const y = THREE.MathUtils.clamp(dy(yq), 0, SY);
      const z = THREE.MathUtils.clamp(dx(zq), 0, SZ);
      this._syncAirstrikeDrone(id, x, y, z, da(yawq),
        Math.max(0, millis) / 1000, owner);
    }
    for (const id of [...this._airstrikeDrones.keys()])
      if (!want.has(id)) this._removeAirstrikeDrone(id);
  }

  _abilityRows() {
    const row = (p, idx) => [idx, Math.round(p._streak ?? 0)];
    return [row(this.player, this._hostIdx),
      ...[...this.remote.values()].map(p => row(p, p.ridx))];
  }

  _syncAbilityRows(rows) {
    if (!Array.isArray(rows)) return;
    this._lastAbilityRows = rows.map(row => row.slice());
    for (const [idx, points] of rows) {
      if (this.mode === 'client') {
        if (idx === this.myIdx) this.player._streak = points;
      } else {
        const p = idx === this._hostIdx ? this.player
          : [...this.remote.values()].find(remote => remote.ridx === idx);
        if (!p) continue;
        p._streak = points;
      }
    }
  }

  // The warning itself stays one-shot. Flight visuals are created separately
  // and their moving target is carried by snapshots, so steering never
  // retriggers three beeps or floods the feed the way a repeated telegraph
  // would. The aircraft replaces the old vertical pillar, which occupied the
  // guided camera's exact XZ column and could block the caller's view.
  _telegraph(x, y, z) {
    sfx.telegraph();
    this.feed('AIRSTRIKE INBOUND');
  }

  // A genuinely bigger, more dangerous explosion than a hand grenade —
  // meant to read as a different scale of munition entirely, matching a
  // 1,000 contribution points of buildup. Same explodeAt + editLog/'boom'
  // sync pattern as a grenade, just larger numbers throughout.
  _airstrikeImpact(pos, owner, strikeId) {
    const R = 4.5; // visual crater radius — unchanged
    this.explodeAt(pos.x, pos.y, pos.z, R, owner, 'airstrikeImpact');
    this._removeAirstrikeDrone(strikeId);
    if (this.mode === 'host') {
      this._appendWorldEdit(['b', pos.x, pos.y, pos.z, R]);
      this.net.broadcast(this._worldStamp({ t: 'e', k: 'boom', x: pos.x, y: pos.y, z: pos.z,
        r: R, strikeId }));
    }
    // The gap that made "hit in/around the target should kill them" not
    // quite true: anywhere the raw damage falloff below is already
    // lethal against full health (100hp) deserves to actually BE lethal,
    // not silently zeroed by minor cover a few units past the crater's
    // edge — the old behavior only ignored cover inside the crater
    // itself (R=4.5), even though the falloff alone stays lethal out to
    // ~6.22 units. Derived, not hardcoded, so a future retune of the
    // damage numbers below keeps this radius honest automatically:
    // dmgRadius * (1 - maxHealth/baseDamage). Deliberately the EXACT
    // value, not rounded up — the strict ">" comparison in _blastDamage
    // already treats a hit exactly at this distance as inside the
    // no-cover zone, so no margin is needed; rounding UP would be a real
    // mistake here (caught by a failing test before this shipped), since
    // it widens which distances ignore cover without touching how much
    // damage they deal — past this exact point, damage is BELOW 100
    // regardless, so a wider radius would just ignore cover for hits
    // that were never going to be lethal anyway, achieving nothing.
    const NO_COVER_R = 14 * (1 - 100 / 180); // ≈ 6.222
    this._blastDamage(pos, owner, R, 14, 180, 20, NO_COVER_R, 'airstrike');
  }

  // Visual + terrain side of an explosion — identical on host and clients.
  explodeAt(x, y, z, r, owner = null, sound = 'explosion') {
    const pos = new THREE.Vector3(x, y, z);
    this.effects.explode(pos);
    sfx.at(sound, pos);
    const removed = this.world.carve(Math.floor(x), Math.floor(y), Math.floor(z), r,
      (vx, vy, vz) => !this._protectedVoxelReason(vx, vy, vz));
    if (removed.length) this.navRevision++;
    this.voxelStory?.recordBlast(removed.length, { airstrike: sound === 'airstrikeImpact' });
    this.effects.blockBurst(removed);
    this.effects.addShake(Math.max(0, 0.5 - pos.distanceTo(this.player.body.pos) * 0.012));
    this.pingIntel(pos, owner?.team); // explosions echo on the intel feed
    this._collapseFrom(removed, owner); // craters can drop whole structures
  }

  // ---------------- flag logic ----------------
  _updateFlags(dt) {
    const wasDropped = Object.fromEntries(['green', 'blue'].map(team =>
      [team, this.flags[team].state === 'dropped']));
    const flagLive = Object.values(this.flags).some(flag => flag.state !== 'home');
    if (flagLive) this._ctfProgressAt = this.time;
    const escalation = ctfEscalation({ active: this._ctfEscalation.active,
      progressAt: this._ctfProgressAt }, this.time, flagLive);
    this._ctfEscalation = escalation;
    for (const team of ['green', 'blue']) this.flags[team].update(dt, this.time);
    if (['green', 'blue'].some(team => wasDropped[team] && this.flags[team].state === 'home'))
      this._ctfProgressAt = this.time;

    for (const e of this.entities()) {
      if (!e.alive) continue;
      const enemyFlag = this.flags[this.enemyOf(e.team)];
      const ownFlag = this.flags[e.team];
      const interaction = ctfFlagInteraction(e, ownFlag, enemyFlag,
        (entity, point) => entity.body.pos.distanceTo(point));

      // A bot near a home flag stages for close cover rather than converting a
      // teammate merely somewhere on the enemy half into imaginary support.
      // Humans and recovery of a dropped flag keep the ordinary interaction.
      let pickupAllowed = true;
      if (interaction === 'pickup' && e instanceof Bot && enemyFlag.state === 'home') {
        const nearestSupportDistance = this.entities().filter(ally => ally !== e
          && ally.alive && ally.team === e.team).reduce((nearest, ally) => Math.min(nearest,
          Math.hypot(ally.body.pos.x - e.body.pos.x, ally.body.pos.z - e.body.pos.z)), Infinity);
        const stagedSeconds = Number.isFinite(e.ctfStageAt) ? this.time - e.ctfStageAt : 0;
        pickupAllowed = ctfFinalApproachPolicy({
          distanceToFlag: e.body.pos.distanceTo(enemyFlag.home), nearestSupportDistance,
          stagedSeconds, escalation: this._ctfEscalation.active,
        }) === 'advance';
        if (!pickupAllowed && !Number.isFinite(e.ctfStageAt)) e.ctfStageAt = this.time;
      }

      if (interaction === 'pickup' && pickupAllowed) {
        enemyFlag.state = 'carried';
        enemyFlag.carrier = e;
        e.carrier = true;
        e.ctfStageAt = -Infinity;
        this._ctfProgressAt = this.time;
        this._ctfEscalation = { active: false, returnTime: FLAG_RETURN_TIME, frontlineBonus: 0 };
        sfx.pickup();
        this._award(e, CONTRIBUTION.flagPickup,
          { objective: 1, specialty: 'objective', specialtyPoints: 1 });
        this._broadcastScoreboard(true);
        this.feed(`${nameSpan(e)} took the ${this.enemyOf(e.team).toUpperCase()} flag`);
        this.messageTo(e, 'YOU HAVE THE FLAG — RUN HOME!', '#ffd97a');
        this.messageTeam(e.team === 'blue' ? 'green' : 'blue', 'OUR FLAG IS TAKEN!', '#e74c3c');
      }
      // Touching your own dropped flag sends it home.
      if (interaction === 'return') {
        ownFlag.returnHome();
        this._ctfProgressAt = this.time;
        this._ctfEscalation = { active: false, returnTime: FLAG_RETURN_TIME, frontlineBonus: 0 };
        this._award(e, CONTRIBUTION.flagReturn,
          { objective: 1, specialty: 'objective', specialtyPoints: 1 });
        this._broadcastScoreboard(true);
        this.feed(`${nameSpan(e)} returned the ${e.team.toUpperCase()} flag`);
        this.messageTo(e, 'FLAG RETURNED', '#8fd98f');
      }
      // Capture: reach your stand with the enemy flag while yours is home.
      if (interaction === 'capture') {
        e.carrier = false;
        this.captures[e.team]++;
        this._ctfProgressAt = this.time;
        this._ctfEscalation = { active: false, returnTime: FLAG_RETURN_TIME, frontlineBonus: 0 };
        enemyFlag.returnHome();
        this._award(e, CONTRIBUTION.flagCapture,
          { objective: 1, specialty: 'objective', specialtyPoints: 3 });
        this._broadcastScoreboard(true);
        sfx.capture();
        this.feed(`${nameSpan(e)} <b>CAPTURED</b> the flag`);
        this.message(e.team === 'green' ? 'CAPTURE! GREEN SCORES' : 'CAPTURE! BLUE SCORES',
          teamCss(e.team));
        hud.score(this);
        if (this.captures[e.team] >= WIN_SCORE) this._end(e.team);
        else this._checkOvertimeEnd();
      }
    }
    hud.score(this);
  }

  // ---------------- king of the hill ----------------
  _setHillIndex(index, resetState = true) {
    const h = this.hill;
    if (!h?.spots?.length) return;
    const next = ((Number.isInteger(index) ? index : 0) % h.spots.length
      + h.spots.length) % h.spots.length;
    const spot = h.spots[next];
    if (this.hillVisual) { disposeObject(this.hillVisual.mesh); this.hillVisual = null; }
    h.index = next;
    h.label = spot.label ?? `HILL ${next + 1}`;
    h.pos.set(spot.x + 0.5,
      this.world.surface(Math.floor(spot.x), Math.floor(spot.z)), spot.z + 0.5);
    h.r = spot.r ?? 8;
    if (resetState) {
      h.owner = null;
      h.progress = 0;
      h.contested = false;
      h.capTeam = null;
      h.presence = { green: 0, blue: 0 };
      h.rotateIn = HILL_CYCLE;
    }
    this._createHillVisual();
  }

  _relocateHill() {
    const h = this.hill;
    if (!h?.spots?.length) return;
    const index = nextHillIndex(h.index, h.spots.length);
    this._setHillIndex(index, true);
    sfx.capture();
    this.feed(`<b>HILL RELOCATED</b> — ${h.label}`);
    this.message(`HILL RELOCATED — ${h.label}`, '#ffd97a');
    hud.score(this);
  }

  _createHillVisual() {
    const h = this.hill, cells = [];
    const r = Math.max(4, Math.round(h.r));
    for (let d = -r; d <= r; d += 2) {
      cells.push([Math.round(h.pos.x + d), Math.round(h.pos.z - r)]);
      cells.push([Math.round(h.pos.x + d), Math.round(h.pos.z + r)]);
      if (Math.abs(d) < r) {
        cells.push([Math.round(h.pos.x - r), Math.round(h.pos.z + d)]);
        cells.push([Math.round(h.pos.x + r), Math.round(h.pos.z + d)]);
      }
    }
    const material = new THREE.MeshBasicMaterial({ color: 0xe8ecf2, transparent: true,
      opacity: 0.72, depthWrite: false });
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.35, 0.12, 1.35), material, cells.length);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.hillVisual = { mesh, material, cells, nextGroundT: 0 };
    this._updateHillVisual(true);
  }

  _updateHillVisual(force = false) {
    const v = this.hillVisual, h = this.hill;
    if (!v || !h) return;
    v.material.color.setHex(h.owner ? teamHex(h.owner) : 0xe8ecf2);
    // A stepped pulse stays in the voxel language and avoids a smooth glow.
    v.material.opacity = h.contested
      ? 0.82 + 0.13 * Math.round((Math.sin(this.time * 7) + 1) * 2) / 4 : 0.72;
    if (!force && this.time < v.nextGroundT) return;
    v.nextGroundT = this.time + 0.25;
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < v.cells.length; i++) {
      const [x, z] = v.cells[i];
      matrix.makeTranslation(x + 0.5, this.world.surface(x, z) + 1.07, z + 0.5);
      v.mesh.setMatrixAt(i, matrix);
    }
    v.mesh.instanceMatrix.needsUpdate = true;
  }

  // Capture takes CAP_TIME uncontested seconds. Ownership alone is not worth
  // time: the owning team must keep at least one soldier physically present,
  // and any enemy contest freezes both capture and scoring. The objective
  // relocates on a host-authoritative clock during regulation, then remains
  // fixed through overtime so the deciding fight cannot move away.
  _updateHill(dt) {
    const h = this.hill;
    const rotation = stepHillRotation(h.rotateIn, dt, this.overtime,
      HILL_CYCLE, HILL_MOVE_WARNING);
    h.rotateIn = rotation.remaining;
    if (rotation.warn) {
      const next = h.spots[nextHillIndex(h.index, h.spots.length)];
      this.feed(`<b>HILL MOVES IN ${HILL_MOVE_WARNING}</b> — ${next.label ?? 'NEXT POINT'}`);
      this.message(`NEXT HILL — ${next.label ?? 'NEW POSITION'}`, '#ffd97a');
    }
    if (rotation.rotate) { this._relocateHill(); return; }

    const present = { green: [], blue: [] };
    for (const e of this.entities()) {
      if (!e.alive) continue;
      const dx = e.body.pos.x - h.pos.x, dz = e.body.pos.z - h.pos.z;
      if (dx * dx + dz * dz > h.r * h.r) continue;
      const surf = this.world.surface(Math.floor(e.body.pos.x), Math.floor(e.body.pos.z));
      if (e.body.pos.y < surf - 4 || e.body.pos.y > surf + 6) continue;
      present[e.team].push(e);
    }
    const g = present.green.length, b = present.blue.length;
    h.contested = g > 0 && b > 0;
    h.presence = { green: g, blue: b };
    const sole = g > 0 && b === 0 ? 'green' : b > 0 && g === 0 ? 'blue' : null;
    const capture = stepHillCapture(h, sole, h.contested, dt, CAP_TIME);
    h.owner = capture.owner;
    h.capTeam = capture.capTeam;
    h.progress = capture.progress;
    if (capture.captured) {
      for (const e of present[capture.captured])
        this._award(e, CONTRIBUTION.hillCapture,
          { objective: 1, specialty: 'objective', specialtyPoints: 1 }, false);
      this._broadcastScoreboard(true);
      sfx.capture();
      this.feed(capture.captured === 'green' ? '<b>GREEN</b> holds the hill' : '<b>BLUE</b> holds the hill');
      this.message(capture.captured === 'green' ? 'GREEN HOLDS THE HILL' : 'BLUE HOLDS THE HILL',
        teamCss(capture.captured));
    }
    const scoring = occupiedScoringTeam(h.owner, h.presence);
    if (scoring && !this.over) {
      this.captures[scoring] += dt; // occupied seconds (floats; displayed as clocks)
      for (const e of present[scoring]) this._award(e,
        CONTRIBUTION.hillHoldPerSecond * dt, { objective: dt }, false);
      if (this.captures[scoring] >= modeScoreLimit('koth', {
        publicRoom: this.publicRoom,
      })) this._end(scoring);
    }
    hud.score(this);
    this._updateHillVisual();
    this._checkOvertimeEnd();
  }

  _flagsLive() {
    return !!this.flags && ['green', 'blue'].some(team => this.flags[team].state !== 'home');
  }

  _losingTeamOnHill() {
    const leader = scoreLeader(this.captures);
    if (!leader || !this.hill) return false;
    const losing = this.enemyOf(leader);
    return (this.hill.presence?.[losing] ?? 0) > 0;
  }

  _startOvertime() {
    if (this.overtime || this.over) return;
    this.overtime = true;
    this.matchRemaining = 0;
    this.feed('<b>OVERTIME</b>');
    this.message('OVERTIME', '#ffd97a');
    hud.clock(this);
  }

  _checkOvertimeEnd() {
    if (!this.overtime || this.over) return;
    const leader = scoreLeader(this.captures);
    if (!leader) return;
    if (this.gameMode === 'ctf' && this._flagsLive()) return;
    if (this.gameMode === 'koth' && this._losingTeamOnHill()) return;
    this._end(leader);
  }

  _updateMatchClock(dt) {
    const next = advanceMatchClock({ over: this.over, overtime: this.overtime,
      elapsed: this.matchElapsed, remaining: this.matchRemaining }, dt, () => regulationDecision(this.gameMode, this.captures, {
        flagsLive: this._flagsLive(),
        losingTeamOnHill: this._losingTeamOnHill(),
      }));
    this.matchElapsed = next.elapsed; this.matchRemaining = next.remaining;
    if (next.event === 'overtimeTick') this._checkOvertimeEnd();
    else if (next.event === 'startOvertime') this._startOvertime();
    else if (Array.isArray(next.event)) this._end(next.event[1]);
    hud.clock(this);
  }

  _end(winner, authoritativeStory = null) {
    if (this.over) {
      // A snapshot can announce game-over just ahead of the reliable end
      // event. Let that later event replace the locally reconstructed story
      // with the host's complete bounded counters.
      if (this.voxelStory && authoritativeStory)
        hud.voxelStory(voxelBattleStory(authoritativeStory));
      return;
    }
    // A player can join while the room is already on results. In that case
    // the reliable choices event can arrive before the first authoritative
    // snapshot supplies the final score/clock needed to justify `_end` on
    // the client. Preserve that already-validated intermission state instead
    // of clearing it when the snapshot finally opens the results screen.
    const keepClientIntermission = this.mode === 'client'
      && validBattleChoices(this._battleChoices, MAPS,
        { publicRoom: this.publicRoom, privateContent: this.privateContent });
    const retainedChoices = keepClientIntermission ? this._battleChoices : [];
    const retainedTally = keepClientIntermission ? this._battleTally.slice(0, 3) : [0, 0, 0];
    const retainedReady = keepClientIntermission ? new Set(this._intermissionReady) : new Set();
    const retainedMine = keepClientIntermission ? this._myBattleChoice : null;
    this._broadcastScoreboard(true);
    this.over = true;
    this.winner = winner;
    this._squadVotes.clear();
    this._intermissionReady = retainedReady;
    this._battleVotes.clear();
    this._donePlayers.clear();
    this._battleChoices = this.mode === 'client' ? retainedChoices : nextBattleChoices({
      maps: MAPS, mode: this.gameMode, mapIndex: this.mapIndex,
      publicRoom: this.publicRoom, privateContent: this.privateContent, seed: this.seed });
    this._battleTally = retainedTally;
    this._myBattleChoice = retainedMine;
    const storyMetrics = authoritativeStory ?? this.voxelStory?.metrics();
    const story = this.voxelStory ? voxelBattleStory(storyMetrics) : null;
    if (this.mode === 'host') {
      const event = { t: 'e', k: 'end', winner };
      if (storyMetrics) event.story = storyMetrics;
      this.net.broadcast(event);
      this._publishBattleChoices();
    }
    const report = buildMatchReport(this._kdKey(this.player), this.kd.entries());
    const botScores = [...this.kd].filter(([key]) => key.startsWith('b')).map(([, row]) => row.score)
      .sort((a, b) => a - b);
    const medianBot = botScores.length ? botScores[Math.floor(botScores.length / 2)] : 0;
    const humanScores = [...this.kd].filter(([key]) => key.startsWith('p')).map(([, row]) => row.score);
    const humanAverage = humanScores.length
      ? humanScores.reduce((sum, score) => sum + score, 0) / humanScores.length : report.local.score;
    this._nextBotDifficultyKey = nextBotDifficulty(this._botDifficultyKey,
      { margin: humanAverage - medianBot, humanScore: humanAverage, medianScore: medianBot });
    const recordUpdate = stats.finishMatch(winner === this.player.team,
      this.gameMode, report.local);
    this.onStatsChanged?.();
    hud.statsHide(); // the summary board replaces the overlay
    $('hud').classList.remove('on');
    const won = winner === this.player.team;
    this.engagement?.finishMatch({
      outcome: 'complete', won, duration: this.matchElapsed, overtime: this.overtime,
      scoreMargin: Math.abs((this.captures.green ?? 0) - (this.captures.blue ?? 0)),
      points: report.local.score, objective: report.local.objective, assists: report.local.a,
    });
    this.funnel('match_complete');
    // A completed round is a natural delivery boundary; do not make product
    // diagnostics depend on a later pagehide or on filling a whole batch.
    this.fieldTelemetry?.flush();
    this._completedFunnelMatch = true;
    $('endTitle').textContent = won ? 'VICTORY' : 'DEFEAT';
    $('end').dataset.outcome = won ? 'victory' : 'defeat';
    $('end').dataset.map = MAPS[this.mapIndex]?.key ?? 'island';
    $('endGreenScore').textContent = this.hill
      ? holdClock(this.captures.green) : Math.floor(this.captures.green ?? 0);
    $('endBlueScore').textContent = this.hill
      ? holdClock(this.captures.blue) : Math.floor(this.captures.blue ?? 0);
    $('endDetail').textContent = `${MAPS[this.mapIndex].name} · ${this.gameMode.toUpperCase()}`
      + ` · ${holdClock(this.matchElapsed)}`;
    this._resultShareText = `${won ? 'Victory' : 'Defeat'} in Spadefall — `
      + `${MAPS[this.mapIndex].name} ${this.gameMode.toUpperCase()}, `
      + `${Math.floor(this.captures.green)}–${Math.floor(this.captures.blue)}. `
      + `${Math.round(report.local.score)} score, ${report.local.k}/${report.local.d}/${report.local.a} K/D/A. `
      + 'Play at https://spadefall.io';
    hud.matchReport(this, report, recordUpdate);
    hud.voxelStory(story);
    $('endBoard').innerHTML = hud.kdTable(this, { groupTeams: true }); // round contribution summary
    hud.classPick(this.player._pendingClass);
    const balanceNote = this.teamBalanceEnabled() ? ' · teams balance between rounds' : '';
    $('endNote').textContent = `choose a battle, then PLAY ANOTHER · waiting for players${balanceNote}`;
    hud.rotationProgress(0, false);
    hud.nextBattles(this, this._battleChoices, this._battleTally, this._myBattleChoice);
    $('end').classList.remove('hidden');
    this.player.vmRoot.visible = false;
    // Results contain real choices. Release captured mouse input before the
    // overlay appears so class, ready, squad, and share controls are usable.
    this.onRoundEnd?.();
    this._publishSquadState();
    this._publishReadyState();
    if (!won) sfx.lose();
  }

  // Next map in the rotation for the current mode.
  _nextMap() {
    const pool = mapsForMode(this.gameMode, {
      publicOnly: this.publicRoom,
      privateContent: this.privateContent,
    });
    // Legacy public CTF has no public rotation pool. _end reads the next map
    // for its intermission copy before _rotate can normalize the mode.
    if (!pool.length && this.publicRoom)
      return mapsForMode('tdm', { publicOnly: true })[0];
    return pool[(pool.indexOf(this.mapIndex) + 1) % pool.length];
  }

  publicContentAvailable() {
    return !this.publicRoom || publicContentAvailable(this.gameMode, this.mapIndex);
  }

  _rotate() {
    // Let an already-running legacy public room finish, then bring it back
    // onto the public catalogue instead of carrying CTF into another round.
    if (this.publicRoom && !publicContentAvailable(this.gameMode, this.mapIndex))
      this.gameMode = 'tdm';
    const map = this._nextMap();
    const seed = Math.floor(Math.random() * 1e9);
    this._restartRound(map, seed);
  }

  _restartRound(map, seed, mode = this.gameMode) {
    if (!['ctf', 'tdm', 'koth'].includes(mode)) return false;
    if (!Number.isInteger(map) || !MAPS[map]
        || !MAPS[map].modes.includes(mode)
        || !contentAvailable(mode, map, { publicOnly: this.publicRoom,
          privateContent: this.privateContent })) return false;
    this.gameMode = mode;
    this._activeSquads = staySquadGroups(this._humanSquadRows(), [...this._squadVotes]);
    // Normal rounds rotate everyone green<->blue. With Phase 8 enabled, that
    // full side flip is the preferred baseline but a sufficiently lopsided
    // prior result can recompose the human teams here; explicit squads remain
    // atomic.
    // Host/solo only — clients receive the result in the roster below.
    const balance = this._balanceNextRoundTeams();
    this._botDifficultyKey = this._nextBotDifficultyKey ?? this._botDifficultyKey;
    if (!balance.enabled) {
      const flip = t => (t === 'blue' ? 'green' : 'blue');
      this.player.team = flip(this.player.team);
      for (const p of this.remote.values()) p.team = flip(p.team);
    }
    if (this.mode === 'host')
      this.net.broadcast({ t: 'e', k: 'restart', map, seed, mode: this.gameMode });
    this.rebuild(seed, map);
    // Fresh world, fresh bot ids: everyone rebuilds their replica and needs
    // the roster again (their full-state maps were cleared on rebuild).
    if (this.mode === 'host') this.net.broadcast(this._rosterMsg());
    if (balance.adjusted)
      this.message('TEAMS BALANCED FOR THE NEXT ROUND · CONFIRMED SQUADS KEPT TOGETHER', '#ffd97a');
    this.onRestart?.(MAPS[map].name);
    return true;
  }

  teamBalanceEnabled() {
    return this.mode === 'client' ? !!this._teamBalanceHostEnabled
      : !!(this._teamBalanceHostEnabled || this.engagementFeatures.teamBalance);
  }

  _balanceNextRoundTeams() {
    const humans = [this.player, ...this.remote.values()];
    if (!this.teamBalanceEnabled() || humans.length < 2)
      return { enabled: false, adjusted: false };
    const players = humans.map(p => ({
      key: this._kdKey(p),
      team: p.team,
      rating: this.kd.get(this._kdKey(p))?.score ?? 0,
    }));
    const botScores = this.bots.map(b => this.kd.get(this._kdKey(b))?.score)
      .filter(Number.isFinite);
    const botRating = botScores.length
      ? botScores.reduce((sum, score) => sum + score, 0) / botScores.length : 0;
    const result = balanceHumanTeams(players, this._activeSquads,
      teamSizeForMode(this.gameMode), botRating);
    for (const p of humans) p.team = result.assignments[this._kdKey(p)] ?? p.team;
    return { enabled: true, adjusted: result.moved > 0, result };
  }

  _humanKeys() {
    if (this.mode === 'client')
      return [...(this._rosterP ?? new Map()).keys()].map(idx => 'p' + idx);
    return ['p' + this._hostIdx, ...[...this.remote.values()].map(p => 'p' + p.ridx)];
  }

  // The elected browser remains authoritative, so a malicious host cannot
  // honestly be vote-kicked in a peer-hosted room. Every other human is a
  // bounded candidate and the target never counts among eligible voters.
  voteKickCandidates() {
    if (this.mode === 'solo') return [];
    if (this.mode === 'host') return [...this.remote.values()].map(p => ({
      target: p.ridx, key: 'p' + p.ridx, name: p.name, team: p.team,
    }));
    return [...(this._rosterP ?? new Map())]
      .filter(([idx, meta]) => idx !== this.myIdx && meta.pid !== 'HOST')
      .map(([idx, meta]) => ({ target: idx, key: 'p' + idx,
        name: meta.name, team: meta.team }));
  }

  voteKickState() {
    if (!this._voteKick) return { active: false };
    const remaining = this.mode === 'client' ? this._voteKick.remaining
      : Math.max(0, Math.ceil((this._voteKick.expiresAt - performance.now()) / 1000));
    return { active: true, target: this._voteKick.target, name: this._voteKick.name,
      voters: [...this._voteKick.voters], needed: this._voteKick.needed, remaining };
  }

  requestVoteKick(target) {
    if (!Number.isInteger(target)) return false;
    if (this.mode === 'client') {
      return !!this.net?.send({ t: 'a', k: 'votekick', target });
    }
    if (this.mode === 'host') return this._hostVoteKick(this.player, target);
    return false;
  }

  _publishVoteKickState() {
    const state = this.voteKickState();
    this.onVoteKickState?.(state);
    if (this.mode === 'host') this.net.broadcast({ t: 'e', k: 'votekick', ...state });
  }

  _clearVoteKick(publish = false) {
    if (this._voteKickTimer) clearTimeout(this._voteKickTimer);
    this._voteKickTimer = null;
    this._voteKick = null;
    this.onVoteKickState?.({ active: false });
    if (publish && this.mode === 'host')
      this.net.broadcast({ t: 'e', k: 'votekick', active: false });
  }

  _passVoteKick() {
    const kicked = this._voteKick;
    if (!kicked) return false;
    const target = this.remote.get(kicked.id);
    if (target) target._noReconnect = true;
    this.feed(`<b>${kicked.name}</b> WAS REMOVED BY PLAYER VOTE`);
    this.net.sendTo(kicked.id, { t: 'e', k: 'kick', reason: 'vote' });
    this._clearVoteKick(true);
    this.net.kick(kicked.id);
    return true;
  }

  _hostVoteKick(voter, targetIdx) {
    if (this.mode !== 'host' || !voter || this.remote.size + 1 < 3) {
      if (voter) this.messageTo(voter, 'VOTE-KICK NEEDS AT LEAST 3 HUMANS', '#ffd97a');
      return false;
    }
    const target = [...this.remote.values()].find(p => p.ridx === targetIdx);
    if (!target || target === voter) return false;
    const key = this._kdKey(voter);
    if (this._voteKick && this._voteKick.target !== targetIdx) {
      this.messageTo(voter, `VOTE ALREADY OPEN FOR ${this._voteKick.name}`, '#ffd97a');
      return false;
    }
    if (!this._voteKick) {
      const now = performance.now();
      if (now < (voter._voteKickCooldownAt ?? 0)) {
        const wait = Math.ceil((voter._voteKickCooldownAt - now) / 1000);
        this.messageTo(voter, `VOTE-KICK COOLDOWN · ${wait}s`, '#ffd97a');
        return false;
      }
      voter._voteKickCooldownAt = now + VOTE_KICK_COOLDOWN * 1000;
      this._voteKick = { target: targetIdx, id: target.id, name: target.name,
        voters: new Set(), needed: voteKickVotesNeeded(this.remote.size + 1),
        expiresAt: now + VOTE_KICK_DURATION * 1000 };
      const ballot = this._voteKick;
      this._voteKickTimer = setTimeout(() => {
        if (this._voteKick !== ballot) return;
        this.feed(`VOTE-KICK FOR <b>${ballot.name}</b> EXPIRED`);
        this._clearVoteKick(true);
      }, VOTE_KICK_DURATION * 1000);
      this.feed(`<b>${cleanName(voter.name)}</b> STARTED A VOTE-KICK FOR <b>${target.name}</b>`);
    }
    if (key === 'p' + targetIdx || this._voteKick.voters.has(key)) return false;
    this._voteKick.voters.add(key);
    this._voteKick.needed = voteKickVotesNeeded(this.remote.size + 1);
    this._publishVoteKickState();
    if (this._voteKick.voters.size < this._voteKick.needed) return true;
    return this._passVoteKick();
  }

  _humanSquadRows() {
    if (this.mode === 'client') return [...(this._rosterP ?? new Map())]
      .map(([idx, meta]) => ['p' + idx, meta.team]);
    return [['p' + this._hostIdx, this.player.team],
      ...[...this.remote.values()].map(p => ['p' + p.ridx, p.team])];
  }

  staySquadState(voters = [...this._squadVotes]) {
    return staySquadState(this._humanSquadRows(), voters, this._kdKey(this.player));
  }

  _publishSquadState() {
    const voters = [...this._squadVotes];
    hud.staySquad(this, voters);
    if (this.mode === 'host' && this.engagementFeatures.stayAsSquad)
      this.net.broadcast({ t: 'e', k: 'squad', voters });
  }

  _battleChoiceRows() {
    return this._battleChoices.map(choice => [choice.mode, choice.map]);
  }

  _battleCounts() {
    const counts = Array.from({ length: NEXT_BATTLE_CHOICES }, () => 0);
    for (const index of this._battleVotes.values())
      if (Number.isInteger(index) && index >= 0 && index < counts.length) counts[index]++;
    return counts;
  }

  _publishBattleChoices() {
    const counts = this._battleCounts();
    this._battleTally = counts;
    const ready = [...this._intermissionReady].filter(key => !this._donePlayers.has(key));
    hud.nextBattles(this, this._battleChoices, counts,
      this._battleVotes.get(this._kdKey(this.player)) ?? null);
    hud.ready(ready.length, this._humanKeys().filter(key => !this._donePlayers.has(key)).length,
      this._intermissionReady.has(this._kdKey(this.player)));
    if (this.mode === 'host') this.net.broadcast({ t: 'e', k: 'choices',
      choices: this._battleChoiceRows(), votes: counts, ready });
  }

  requestBattleVote(choice) {
    if (!this.over || !Number.isInteger(choice) || choice < 0 || choice >= NEXT_BATTLE_CHOICES)
      return false;
    if (this.mode === 'client') {
      const sent = !!this.net?.send({ t: 'a', k: 'vote', choice });
      if (sent) { this._myBattleChoice = choice; hud.nextBattles(this, this._battleChoices,
        this._battleTally, choice); }
      return sent;
    }
    return this._hostBattleVote(this.player, choice);
  }

  _hostBattleVote(player, choice) {
    const key = this._kdKey(player);
    if (this.mode === 'client' || !this.over || this._donePlayers.has(key)
        || !Number.isInteger(choice) || !this._battleChoices[choice]
        || !validBattleChoice(this._battleChoices[choice], MAPS,
          { publicRoom: this.publicRoom, privateContent: this.privateContent })) return false;
    if (this._battleVotes.has(key)) return false;
    this._battleVotes.set(key, choice);
    this._publishBattleChoices();
    return true;
  }

  _maybeStartNextBattle() {
    if (this.mode === 'client' || !this.over) return false;
    const active = this._humanKeys().filter(voter => !this._donePlayers.has(voter));
    if (!active.length || !active.every(voter => this._intermissionReady.has(voter)))
      return false;
    const votes = [...this._battleVotes.entries()].map(([actor, choice]) => ({ actor, choice }));
    const resolved = resolveBattleVote(this._battleChoices, votes, active);
    if (!resolved) return false;
    this._battleVotes.clear();
    this._intermissionReady.clear();
    return this._restartRound(resolved.choice.map, Math.floor(Math.random() * 1e9),
      resolved.choice.mode);
  }

  _hostContinue(player) {
    const key = this._kdKey(player);
    if (this.mode === 'client' || !this.over || this._donePlayers.has(key)) return false;
    if (!this._battleVotes.has(key)) this._battleVotes.set(key, 0);
    this._intermissionReady.add(key);
    this._publishBattleChoices();
    this._maybeStartNextBattle();
    return true;
  }

  _publishReadyState() {
    const voters = [...this._intermissionReady].filter(key => !this._donePlayers.has(key));
    hud.ready(voters.length, this._humanKeys().filter(key => !this._donePlayers.has(key)).length,
      this._intermissionReady.has(this._kdKey(this.player)));
    if (this.mode === 'host') this.net.broadcast({ t: 'e', k: 'ready', voters });
  }

  requestIntermissionReady() {
    if (!this.over) return false;
    this._recordLocalAction(this.player, 'ready');
    this.engagement?.record('continuation', { action: 'ready' });
    if (this.mode === 'client') return !!this.net?.send({ t: 'a', k: 'ready' });
    return this._hostContinue(this.player);
  }

  requestDone() {
    if (!this.over) return false;
    this.engagement?.record('continuation', { action: 'done' });
    if (this.mode === 'client') this.net?.send({ t: 'a', k: 'done' });
    this.onDone?.();
    return true;
  }

  requestStayAsSquad() {
    if (!this.over || !this.engagementFeatures.stayAsSquad) return;
    if (this.mode === 'client') {
      this.net?.send({ t: 'a', k: 'squad' });
      return;
    }
    this._hostSquadVote(this.player);
  }

  _hostSquadVote(e) {
    if (!this.over || !e || !this.engagementFeatures.stayAsSquad) return;
    const key = this._kdKey(e);
    if (!this._humanKeys().includes(key) || this._squadVotes.has(key)) return;
    this._squadVotes.add(key);
    this._publishSquadState();
  }

  // ---------------- host networking ----------------
  _hasFootingAt(body, x, y, z) {
    if (y < SEA + 0.55) return true; // swimming is its own supported state
    const h = body.half;
    const by = Math.floor(y - 0.08);
    for (let xx = Math.floor(x - h.x); xx <= Math.floor(x + h.x); xx++)
      for (let zz = Math.floor(z - h.x); zz <= Math.floor(z + h.x); zz++)
        if (this.world.solid(xx, by, zz)) return true;
    return false;
  }

  _correctRemotePosition(p) {
    const now = performance.now();
    if (now - (p._lastCorrectionAt ?? -Infinity) < 200) return;
    p._lastCorrectionAt = now;
    this.net.sendTo(p.id, { t: 'e', k: 'corr',
      x: p.body.pos.x, y: p.body.pos.y, z: p.body.pos.z });
  }

  _hostResync(id, scope) {
    const conn = this.net?.conns?.get(id);
    if (!conn) return;
    const now = performance.now();
    if (now < (conn._resyncAt ?? 0)) return;
    conn._resyncAt = now + 1000; // repair is expensive; one request is enough
    if (scope === 'state') {
      conn._forceFullSnapshot = true;
      return;
    }
    this.net.sendTo(id, { t: 'sync', seed: this.seed, map: this.mapIndex,
      log: this.editLog, wr: this.editLog.length, wh: this._worldHash >>> 0 });
  }

  _securityViolation(p, kind, severity = 1, correct = false) {
    if (!p) return;
    p._integrity = recordIntegrityViolation(p._integrity, kind, severity, this.time);
    if (correct || p._integrity.action === 'correct') this._correctRemotePosition(p);
    if (p._integrity.action !== 'disconnect' || p._disconnecting) return;
    p._disconnecting = true;
    p._noReconnect = true;
    this.net.sendTo(p.id, { t: 'e', k: 'kick', reason: 'integrity' });
    const conn = this.net.conns.get(p.id);
    setTimeout(() => conn?.close(), 250);
  }

  securityTelemetry() { return integritySummary(this.remote.values()); }

  _remoteWeaponState(p) {
    const spec = TOOLS[p.gunClass];
    const settled = settleReload({ ammo: p.ammo[p.gunClass],
      reloadUntil: p._reloadUntil, lastShotAt: p._actT.shoot }, spec, this.time);
    p.ammo[p.gunClass] = settled.ammo;
    p._reloadUntil = settled.reloadUntil;
    if (Number.isFinite(settled.lastShotAt)) p._actT.shoot = settled.lastShotAt;
    return settled;
  }

  _hostReload(p) {
    if (!GUN_CLASSES.includes(p.tool) || p.tool !== p.gunClass) {
      this._securityViolation(p, 'reload-tool', 0.5); return;
    }
    const spec = TOOLS[p.gunClass], current = this._remoteWeaponState(p);
    const next = authorizeReload(current, spec, this.time);
    if (!next.ok) return; // duplicate/full reload taps are ordinary input noise
    p._reloadUntil = next.state.reloadUntil;
  }

  hostOnData(id, d) {
    if (d?.t === 'hi' && d.v !== PROTOCOL_VERSION) {
      this.net.sendTo(id, { t: 'version', v: PROTOCOL_VERSION });
      return;
    }
    if (!validClientMessage(d)) {
      this._securityViolation(this.remote.get(id), 'malformed', 2);
      return;
    }
    // A public slot from before the catalogue gate can remain registered for
    // a while. It must neither advertise nor admit a late public player.
    if (!this.publicContentAvailable() && (d.t === 'ping' || d.t === 'hi')) {
      this.net.sendTo(id, { t: 'full' });
      return;
    }
    // Matchmaking probe: answer on the same channel, before any join logic.
    if (d.t === 'ping') {
      // Room-browser probe: everything the list row wants to show.
      const humanCap = this._humanCap();
      this.net.sendTo(id, { t: 'pong', humans: this.remote.size + this._reconnectReservations.size + 1, max: humanCap,
        map: this.mapIndex, mode: this.gameMode,
        g: this.captures.green, b: this.captures.blue,
        names: [this.player.name, ...[...this.remote.values()].map(p => p.name)].slice(0, humanCap) });
      return;
    }
    if (d.t === 'hi') {
      const reservation = this._reconnectReservations.get(d.resume);
      if (reservationMatches(reservation, d.resume))
        return this._reclaimPlayer(id, reservation);
      const mig = this._migRoster?.get(id);
      if (mig) {
        // A survivor finding the new room. Their proxy was already restored
        // at promotion under this very peer id — what they need is a
        // welcome, not a respawn. Seed/map ride along so a stale replica
        // can catch the mismatch and rebuild instead of fighting it.
        const p = this.remote.get(id);
        if (!p) return; // lapsed entry — fall through would double-spawn
        if (validResumeToken(d.resume)) p._resumeToken = d.resume;
        // Keep the reservation through the migration grace window. Under
        // full-room load the first WebRTC channel can flap even after the
        // client receives its welcome; a retry must still recover this exact
        // seat instead of entering as a brand-new player.
        const firstWelcome = !mig.rejoined;
        mig.rejoined = true;
        mig.acknowledged = false;
        const reset = !!p._migrationRespawn;
        if (reset) {
          p.respawn(null, false);
          delete p._migrationRespawn;
        }
        this.net.sendTo(id, { t: 'w', id, team: p.team, migrated: 1, mode: this.gameMode,
          seed: this.seed, map: this.mapIndex, log: this.editLog, me: p.ridx,
          life: p._life,
          tb: this.teamBalanceEnabled() ? 1 : 0,
          wr: this.editLog.length, wh: this._worldHash >>> 0,
          spawn: spawnRow(p.body, p.yaw + Math.PI / 2), reset: reset ? 1 : 0,
          r: this._rosterMsg() });
        if (firstWelcome) this.feed(`${nameSpan(p)} rejoined ${p.team.toUpperCase()}`);
        return;
      }
      // A live browser can open a replacement channel before its old channel
      // has closed. The resume token is the stable seat identity in that
      // overlap window; never turn a replacement into a second seat.
      const resume = validResumeToken(d.resume) ? d.resume : null;
      const active = resume
        ? [...this.remote.values()].find(p => p._resumeToken === resume)
        : null;
      if (active) {
        if (active._noReconnect || active._disconnecting) {
          this.net.sendTo(id, { t: 'e', k: 'kick', reason: 'integrity' });
          const conn = this.net.conns.get(id);
          setTimeout(() => {
            if (this.net.conns.get(id) !== conn) return;
            try { conn?.close(); } catch { /* already closed */ }
          }, 250);
          return;
        }
        if (active.id === id)
          return this._hostSendWelcome(id, active, active.yaw + Math.PI / 2);
        return this._hostRebindActivePlayer(id, active);
      }
      // A same-id replacement must still prove ownership of the stable seat
      // token.  Without that, a peer id that became reusable after a broker
      // flap could inherit an active soldier merely by repeating its id.
      if (this.remote.has(id)) return;
      return this._hostAddPlayer(id, d.name, d.team, d.resume);
    }
    const p = this.remote.get(id);
    if (!p) return;
    // A valid state packet proves the migration welcome was adopted. Retain
    // the record until the grace window closes so a just-opened WebRTC
    // channel can flap and retry without changing this player's identity.
    const migration = this._migRoster?.get(id);
    if (d.t === 's' && migration?.rejoined) migration.acknowledged = true;
    // A reliable channel preserves order in one direction, not across the
    // host->client respawn and client->host uplink directions. Late packets
    // from the corpse's life are normal under load; ignore them rather than
    // treating the spawn-sized jump as cheating or firing it from a new body.
    if (d.t === 's' && d.life !== p._life) return;
    if (d.t === 'a' && SECURED_ACTIONS.includes(d.k) && d.life !== p._life) return;
    if (d.t === 'a' && SECURED_ACTIONS.includes(d.k)) {
      const order = actionSequenceDisposition(p._lastActionSeq, d.n);
      if (!order.accept) { this._securityViolation(p, 'action-' + order.reason, 2); return; }
      p._lastActionSeq = d.n;
    }
    if (d.t === 'a' && d.k === 'resync') return this._hostResync(id, d.scope);
    if (d.t === 'a' && d.k === 'chat') return this._hostOnChat(id, d.text, d.scope);
    if (d.t === 'a' && d.k === 'votekick') {
      this._hostVoteKick(p, d.target);
      return;
    }
    if (d.t === 'a' && d.k === 'mark') {
      this._hostPlaceTeamPing(p, d.d);
      return;
    }
    if (d.t === 'a' && d.k === 'squad') {
      this._hostSquadVote(p);
      return;
    }
    if (d.t === 'a' && d.k === 'ready') {
      if (this.over) this._hostContinue(p);
      return;
    }
    if (d.t === 'a' && d.k === 'vote') {
      if (this.over) this._hostBattleVote(p, d.choice);
      return;
    }
    if (d.t === 'a' && d.k === 'done') {
      if (this.over) {
        const key = this._kdKey(p);
        this._donePlayers.add(key);
        this._intermissionReady.delete(key);
        this._battleVotes.delete(key);
        p._noReconnect = true;
        this._publishBattleChoices();
        this._maybeStartNextBattle();
        this.net.kick(id);
      }
      return;
    }
    if (d.t === 'a' && d.k === 'spawnpref') {
      if (!p.alive && !this.over) p._spawnPreference = d.pref;
      return;
    }
    // Class pick: sent while dead, so it must NOT require p.alive the way
    // shoot/dig/place/nade do below (same reason chat gets its own early
    // case above it) — applied at the NEXT respawn, not immediately.
    if (d.t === 'a' && d.k === 'class') {
      if (GUN_CLASSES.includes(d.cls)) p._pendingClass = d.cls;
      return;
    }
    if (d.t === 's') {
      // Finite + bounded: a NaN here poisons every distance check downstream.
      if (![d.x, d.y, d.z, d.yaw].every(Number.isFinite)) return;
      const nx = Math.min(Math.max(d.x, 0), SX), ny = Math.min(Math.max(d.y, -8), SY + 8),
        nz = Math.min(Math.max(d.z, 0), SZ);
      const elapsed = this.time - (p._lastPosT ?? this.time);
      // Spend movement credit only after every authority check accepts the
      // candidate. Collision rejection followed by a correction is normal
      // under packet jitter; charging the rejected move drained the budget
      // and turned one harmless disagreement into a disconnect cascade.
      const budget = p._movementBudget ??= createMovementBudget();
      const candidateBudget = { ...budget };
      const movement = validateMovementReport(p.body.pos,
        { x: nx, y: ny, z: nz, yaw: d.yaw }, elapsed, undefined,
        candidateBudget);
      if (!movement.ok) {
        this._securityViolation(p, 'move-' + movement.reason, 1, true); return;
      }
      // No-clip: speed-legal isn't enough on its own — the landing spot
      // itself has to be somewhere the player's actual body could occupy.
      // Reuses the exact whole-body AABB the physics itself already checks
      // for real collision (Body#overlapsSolid mirrors _axis's box), as a
      // pure query against this not-yet-applied candidate — no fake
      // movement step needed to ask the question. Rejected outright rather
      // than partially applied: there's no sensible "half accept" for a
      // report that's claiming to be inside a wall. An honest client's own
      // local physics already keeps it out of solid geometry in the first
      // place, so this only ever catches a dishonest one.
      if (p.body.overlapsSolid(nx, ny, nz)) {
        this._securityViolation(p, 'move-solid', 1.5, true); return;
      }
      if (p.body.sweptOverlapsSolid(p.body.pos.x, p.body.pos.y, p.body.pos.z,
          nx, ny, nz)) {
        this._securityViolation(p, 'move-sweep', 1.5, true); return;
      }

      // A legal jump follows y(t)=y0+v0*t-15*t² (gravity is -30). Track the
      // current unsupported interval so a zero-delta stream cannot hover in
      // mid-air forever while still passing per-packet speed checks.
      const supported = this._hasFootingAt(p.body, nx, ny, nz);
      if (supported) p._airMove = null;
      else {
        const air = p._airMove ??= { t: 0, y0: p.body.pos.y };
        air.t += movement.dt;
        const highestLegal = air.y0 + 10.5 * air.t - 15 * air.t * air.t + 0.8;
        if (ny > highestLegal) {
          this._securityViolation(p, 'move-hover', 1.5, true); return;
        }
      }

      // Remote bodies are client-predicted rather than integrated here. Use
      // accepted reports to preserve the peak of each unsupported interval,
      // then reconstruct impact speed when support returns.
      const oldY = p.body.pos.y;
      if (!supported) p._fallPeakY = Math.max(p._fallPeakY ?? oldY, oldY, ny);
      else if (!p._remoteSupported && p._fallPeakY != null) {
        const speed = impactSpeedForFallDistance(Math.max(0, p._fallPeakY - ny));
        p.body.landedSpeed = Math.max(p.body.landedSpeed ?? 0, speed);
        p._fallPeakY = null;
      }
      p._remoteSupported = supported;

      Object.assign(budget, candidateBudget);
      p.body.pos.set(nx, ny, nz);
      p.body.inWater = ny < SEA + 0.4;
      p._lastPosT = this.time;
      // The active belt contains exactly this life's gun plus spade/block/nade.
      // Invalid client claims never become authoritative proxy state.
      if (d.tool === p.gunClass || d.tool === 2 || d.tool === 3 || d.tool === 4) {
        p.tool = d.tool;
        p.avatar.setTool(d.tool);
      }
      p.yaw = d.yaw;
      p.crouched = !!d.c;
      p.body.half.h = p.crouched ? CROUCH_HEIGHT : STAND_HEIGHT;
      p.avatar.push(p.body.pos.x, p.body.pos.y, p.body.pos.z, p.yaw);
      // Echoed straight back on this connection's next snapshot (see
      // _broadcastSnapshot) so the client can read its own round trip —
      // no extra message, just one more number on traffic already flowing.
      if (Number.isFinite(d.ts)) p._pingTs = d.ts;
      if (Number.isSafeInteger(d.echo)) {
        const conn = this.net.conns.get(id);
        p._rttSeconds = observeSnapshotRtt(conn?._snapshotSentAt, d.echo,
          this.time, p._rttSeconds);
      }
      this._recordCombatPose(p);
      // Airstrike steering: piggybacked on this same uplink rather than a
      // separate message. Untrusted like everything else here — bounds-
      // clamp, and rate-limit the IMPLIED steering speed the same way
      // ordinary movement is speed-gated above, so a patched client can't
      // retarget faster than the real steering mechanic allows. Only
      // applies if this player actually has a strike in flight — an
      // unrelated or stale field is silently ignored, not trusted at all.
      if (d.strike && Number.isFinite(d.strike.x) && Number.isFinite(d.strike.z) && this._pendingStrikes) {
        const s = this._pendingStrikes.find(s => s.attacker === p);
        if (s) {
          const sx = Math.max(0, Math.min(SX, d.strike.x)), sz = Math.max(0, Math.min(SZ, d.strike.z));
          const sElapsed = Math.max(1 / 30, this.time - (s._lastSteerT ?? this.time));
          const maxSteerDist = AIRSTRIKE_STEER_SPEED * 2 * sElapsed; // 2x slack, same jitter-tolerance philosophy as MAX_SPEED_SLACK
          if (Math.hypot(sx - s.pos.x, sz - s.pos.z) <= maxSteerDist) {
            s.pos.x = sx; s.pos.z = sz;
            s.pos.y = this.world.surface(Math.floor(sx), Math.floor(sz)) + 1;
            s._lastSteerT = this.time;
            // No re-telegraph here anymore — that existed purely to keep
            // the (now-removed) marker mesh in sync for bystanders.
            // Re-triggering the warning sound and feed message on every
            // steering update (up to 30x/sec while a key is held) turned
            // one clean warning into a continuous, overlapping alarm for
            // the entire fall — the actual "why does an alarm go off"
            // bug. _confirmAirstrike's own one-time telegraph is the
            // only place this should ever fire.
          }
        }
      }
    } else if (d.t === 'a' && p.alive && !this.over) {
      // Airstrike is handled first and separately: unlike every other
      // action here, its target isn't near the sender's own position (the
      // whole point is calling in a strike somewhere else entirely, while
      // piloting the overhead camera from a frozen body) — the "must
      // originate near the proxy's known position" sanity check just
      // below doesn't apply and would incorrectly reject every legitimate
      // request, plus this message never carries an o/d origin+direction
      // pair the way shoot/dig/place/nade do.
      if (d.k === 'strike') {
        if ([d.x, d.z, d.yaw].every(Number.isFinite))
          this._confirmAirstrike(p, d.x, d.z, d.yaw);
        return;
      }
      if (d.k === 'reload') { this._hostReload(p); return; }
      const normalized = normalizeDirection(d.d);
      if (!normalized) { this._securityViolation(p, 'zero-direction', 1); return; }
      // The client supplies aim only. The host's accepted body position owns
      // the action origin, so a patched packet cannot shoot/build through a
      // nearby wall by inventing an eye point on its far side.
      const o = p.body.eye(), dir = v3(normalized);
      if (aimYawDelta(p.yaw, normalized) > 1.4) {
        this._securityViolation(p, 'aim-body-mismatch', 1); return;
      }
      // Rate-limit by the tool's own interval (60% floor for frame jitter):
      // an honest client paces itself — a patched one must not get
      // per-packet full-auto, a shovel blender, or a grenade sprinkler.
      const now = this.time, gap = k => now - (p._actT[k] ?? -9);
      if (d.k === 'shoot') {
        if (!GUN_CLASSES.includes(p.tool) || p.tool !== p.gunClass) {
          this._securityViolation(p, 'shoot-tool', 1); return;
        }
        const spec = TOOLS[p.tool];
        if (!spec?.damage) return;
        const fire = authorizeWeaponFire(this._remoteWeaponState(p), spec, now);
        if (!fire.ok) {
          this._securityViolation(p, 'shoot-' + fire.reason,
            fire.reason === 'cadence' ? 0.5 : 0.25);
          return;
        }
        p.ammo[p.gunClass] = fire.state.ammo;
        p._reloadUntil = fire.state.reloadUntil;
        // Rate-limit timestamp updates here, BEFORE the aim check below —
        // an implausible-aim rejection still has to cost its slot in the
        // fire-rate budget. Without this, a rejected attempt would be
        // free to immediately retry, turning this into a probe for
        // whatever direction happens to pass rather than an actual gate.
        p._actT.shoot = fire.state.lastShotAt;
        // Aim-angle plausibility: origin was already checked above (must
        // be near the player's own position) but the DIRECTION itself
        // had no equivalent limit — it could change instantly, shot to
        // shot, with no cost. Compare against this player's own most
        // recently ACCEPTED aim (never an updated-on-rejection value —
        // that would let a string of individually-plausible steps walk
        // the baseline anywhere over time, defeating the point). No
        // baseline yet (first shot of this life) always passes — there's
        // nothing to compare against, and everyone spawns facing an
        // arbitrary direction.
        if (p._lastAimDir) {
          const aimElapsed = Math.max(1 / 60, now - p._lastAimT);
          if (p._lastAimDir.angleTo(dir) / aimElapsed > MAX_TURN_RATE) {
            this._securityViolation(p, 'aim-turn', 1); return;
          }
        }
        p._lastAimDir = dir.clone();
        p._lastAimT = now;
        const rewindAt = this.time - rewindSecondsForRtt(p._rttSeconds);
        this.fireHitscan(p, o, dir, spec, rewindAt);
      }
      else if (d.k === 'dig') {
        if (p.tool !== 2) { this._securityViolation(p, 'dig-tool', 0.5); return; }
        if (gap('dig') < 0.2) return;
        p._actT.dig = now;
        this.playerDig(p, o, dir);
      }
      else if (d.k === 'place') {
        if (p.tool !== 3) { this._securityViolation(p, 'place-tool', 0.5); return; }
        if (gap('place') < 0.12) return;
        p._actT.place = now;
        this.playerPlace(p, o, dir); // tryBuild enforces the block count
      }
      else if (d.k === 'nade') {
        if (p.tool !== 4) { this._securityViolation(p, 'nade-tool', 0.5); return; }
        if (gap('nade') < 0.6 || p.nades <= 0) return;
        p._actT.nade = now;
        p.nades--;
        // Aim-angle plausibility, same mechanism and reasoning as
        // shooting (see that comment above for the full rationale: rate
        // cap not absolute-angle cap, deliberately generous threshold,
        // baseline only advances on an accepted throw). Its own,
        // separate baseline — _lastNadeAimDir, not _lastAimDir — rather
        // than sharing state with gunfire: snapping from "aiming a gun
        // at one target" to "throwing a grenade at a completely
        // different angle" within the same instant is ordinary,
        // legitimate play (react to a flank while already in a
        // firefight), and coupling the two would let an unrelated
        // gunshot from a moment ago reject a grenade throw now, or vice
        // versa. Charged (rate-limit timestamp, nade count) BEFORE this
        // check runs, same as shooting's rate-limit timestamp — a
        // rejected throw still costs a real grenade, which is what
        // actually makes repeated angle-probing self-limiting rather
        // than free.
        if (p._lastNadeAimDir) {
          const aimElapsed = Math.max(1 / 60, now - p._lastNadeAimT);
          if (p._lastNadeAimDir.angleTo(dir) / aimElapsed > MAX_TURN_RATE) {
            this._securityViolation(p, 'nade-turn', 1); return;
          }
        }
        p._lastNadeAimDir = dir.clone();
        p._lastNadeAimT = now;
        this.throwGrenade(p, o, dir, 13);
      }
    }
  }

  // Identity (index, name, team, peer id) rides this one message, sent on
  // join/leave/bot churn — the per-tick snapshot carries indices only.
  _rosterMsg() {
    const p = [[this._hostIdx, this.player.name, this.player.team, 'HOST']];
    for (const pr of this.remote.values()) p.push([pr.ridx, pr.name, pr.team, pr.id]);
    // A reconnect reservation is still a human seat. Its cover bot runs the
    // body on the host, but peers must retain the original roster identity so
    // an election during the grace window can hand that same seat back to the
    // returning player instead of admitting them as a newcomer.
    for (const { player } of this._reconnectReservations.values())
      p.push([player.ridx, player.name, player.team, player.id]);
    return { t: 'r', p,
      b: this.bots.filter(b => !Number.isInteger(b._humanRidx))
        .map(b => [b.id, b.name, b.team]) };
  }

  _hostSendWelcome(id, p, yaw = null) {
    this.net.sendTo(id, { t: 'w', id, team: p.team, seed: this.seed,
      map: this.mapIndex, log: this.editLog, mode: this.gameMode, me: p.ridx,
      life: p._life,
      tb: this.teamBalanceEnabled() ? 1 : 0,
      wr: this.editLog.length, wh: this._worldHash >>> 0,
      spawn: spawnRow(p.body, yaw ?? (p.team === 'green' ? 0 : Math.PI)),
      r: this._rosterMsg() });
  }

  _hostRebindActivePlayer(id, p) {
    const oldId = p.id;
    if (oldId === id) return this._hostSendWelcome(id, p, p.yaw + Math.PI / 2);
    const oldConn = this.net.conns.get(oldId);
    const migration = this._migRoster?.get(oldId);
    this.net.sendTo(oldId, { t: 'e', k: 'kick', reason: 'resumed' });
    this.remote.delete(oldId);
    if (this.net.conns.get(oldId) === oldConn) this.net.conns.delete(oldId);
    if (migration && this._migRoster) {
      this._migRoster.delete(oldId);
      migration.rejoined = true;
      migration.acknowledged = false;
      this._migRoster.set(id, migration);
    }
    p.id = id;
    p._lastActionSeq = 0;
    p._movementBudget = null;
    p._lastPosT = null;
    p._airMove = null;
    p._fallPeakY = null;
    p._remoteSupported = true;
    p._pingTs = undefined;
    p._rttSeconds = undefined;
    this.remote.set(id, p);
    if (this._voteKick?.id === oldId) this._voteKick.id = id;
    this._hostSendWelcome(id, p, p.yaw + Math.PI / 2);
    if (this._voteKick) this.net.sendTo(id,
      { t: 'e', k: 'votekick', ...this.voteKickState() });
    this.net.broadcast(this._rosterMsg());
    this._broadcastScoreboard(true);
    setTimeout(() => {
      try { oldConn?.close(); } catch { /* already closed */ }
    }, 250);
    return p;
  }

  _hostAddPlayer(id, rawName, teamPref, resume = null) {
    if (this.remote.size + this._reconnectReservations.size + 1 >= this._humanCap()) { // room full — turn them away politely
      this.net.sendTo(id, { t: 'full' });
      setTimeout(() => this.net.conns.get(id)?.close(), 400); // let the packet land
      return;
    }
    const name = cleanName(rawName); // one sanitizer, one fallback ('Player')
    // Preferences are best-effort: never exceed this mode's team size.
    // When the requested side is full, fall back to the side with a seat;
    // AUTO still chooses the less-populated human team.
    const occupied = [...this.remote.values(),
      ...[...this._reconnectReservations.values()].map(r => r.player)];
    const team = chooseTeam(teamPref, teamCounts(this.player.team, occupied),
      teamSizeForMode(this.gameMode), this.teamBalanceEnabled());
    if (!team) {
      this.net.sendTo(id, { t: 'full' });
      setTimeout(() => this.net.conns.get(id)?.close(), 400);
      return;
    }
    const proxy = new RemotePlayer(this, id, name, team);
    if (validResumeToken(resume)) proxy._resumeToken = resume;
    proxy.ridx = this._nextPIdx++;
    this.remote.set(id, proxy);
    this._kdRow(proxy); // scoreboard seat from the moment they join
    this._removeBot(team);
    this._hostSendWelcome(id, proxy);
    if (this._voteKick) this.net.sendTo(id,
      { t: 'e', k: 'votekick', ...this.voteKickState() });
    if (this.over) {
      this.net.sendTo(id, { t: 'e', k: 'end', winner: this.winner });
      this.net.sendTo(id, { t: 'e', k: 'choices', choices: this._battleChoiceRows(),
        votes: this._battleCounts(), ready: [...this._intermissionReady] });
      if (this.engagementFeatures.stayAsSquad)
        this.net.sendTo(id, { t: 'e', k: 'squad', voters: [...this._squadVotes] });
      this.net.sendTo(id, { t: 'e', k: 'ready', voters: [...this._intermissionReady] });
    }
    this.net.broadcast(this._rosterMsg()); // the joiner gets it twice — idempotent
    this._broadcastScoreboard(true);
    this.feed(`${nameSpan(proxy)} joined ${team.toUpperCase()}`);
  }

  _reserveDisconnectedPlayer(player, respawnLeft) {
    const bot = this._newBot(player.team, player.name);
    bot._humanRidx = player.ridx;
    bot._humanLife = player._life;
    bot.body.pos.copy(player.body.pos);
    bot.body.vel.copy(player.body.vel);
    bot.body.half.h = player.body.half.h;
    bot.body.onGround = player.body.onGround;
    bot.body.inWater = player.body.inWater;
    bot.health = player.health;
    bot.alive = player.alive;
    bot.carrier = false; // flags drop on disconnect; never hide one in a reservation
    bot.gunClass = player.gunClass;
    bot.ammo = player.ammo[player.gunClass];
    bot.blocks = player.blocks;
    bot.nades = player.nades;
    bot.crouched = !!player.crouched;
    bot.protT = player.protT;
    bot._spawnedAt = player._spawnedAt;
    bot._breath = player._breath;
    bot._drownClock = player._drownClock;
    bot._damageLedger = player._damageLedger;
    setSoldierTool(bot.parts, bot.gunClass);
    bot.parts.group.position.copy(bot.body.pos);
    bot.parts.group.rotation.y = player.yaw;
    bot.parts.group.visible = bot.alive;
    this.bots.push(bot);
    if (!bot.alive && Number.isFinite(respawnLeft)) this.respawnTimers.set(bot, respawnLeft);
    const reservation = { token: player._resumeToken, player, bot,
      expiresAt: performance.now() + RECONNECT_GRACE_MS };
    this._reconnectReservations.set(reservation.token, reservation);
  }

  _reclaimPlayer(id, reservation) {
    this._reconnectReservations.delete(reservation.token);
    const bot = reservation.bot;
    const i = this.bots.indexOf(bot);
    if (i >= 0) this.bots.splice(i, 1);
    const respawnLeft = this.respawnTimers.get(bot);
    this.respawnTimers.delete(bot);
    this._combatHistory.delete(bot);

    const p = new RemotePlayer(this, id, reservation.player.name, reservation.player.team);
    p.ridx = reservation.player.ridx;
    p._life = bot._humanLife;
    p._resumeToken = reservation.token;
    p.body.pos.copy(bot.body.pos);
    p.body.vel.copy(bot.body.vel);
    p.body.half.h = bot.body.half.h;
    p.body.onGround = bot.body.onGround;
    p.body.inWater = bot.body.inWater;
    p.health = bot.health;
    p.alive = bot.alive;
    p.carrier = false;
    p.gunClass = bot.gunClass;
    p._pendingClass = reservation.player._pendingClass;
    p.tool = bot.gunClass;
    p.ammo[p.gunClass] = bot.ammo;
    p.blocks = bot.blocks;
    p.nades = bot.nades;
    p.crouched = bot.crouched;
    p.yaw = bot.parts.group.rotation.y;
    p._streak = reservation.player._streak;
    p.protT = bot.protT;
    p._spawnedAt = bot._spawnedAt;
    p._breath = bot._breath;
    p._drownClock = bot._drownClock;
    p._damageLedger = bot._damageLedger;
    p.avatar.setAlive(p.alive);
    p.avatar.setTool(p.tool);
    p.avatar.push(p.body.pos.x, p.body.pos.y, p.body.pos.z, p.yaw);
    disposeObject(bot.parts.group);
    this.remote.set(id, p);
    if (!p.alive && Number.isFinite(respawnLeft)) this.respawnTimers.set(p, respawnLeft);
    this._recordCombatPose(p);

    this._hostSendWelcome(id, p, p.yaw + Math.PI / 2);
    this.net.broadcast(this._rosterMsg());
    this._broadcastScoreboard(true);
    this.feed(`${nameSpan(p)} reclaimed their soldier`);
  }

  _expireReconnectReservations() {
    const now = performance.now();
    let changed = false;
    for (const [token, reservation] of this._reconnectReservations) {
      if (now <= reservation.expiresAt) continue;
      this._reconnectReservations.delete(token);
      delete reservation.bot._humanRidx;
      this._kdRow(reservation.bot);
      changed = true;
    }
    if (changed) {
      this.net?.broadcast(this._rosterMsg());
      this._broadcastScoreboard(true);
    }
  }

  // Where a team's home stand is — the flag stand in CTF, the base plateau
  // in deathmatch (which has no flags). Bots navigate by this either way.
  standOf(team) {
    if (this.flags) return this.flags[team].standPos();
    const b = BASE[team].flag;
    return new THREE.Vector3(b.x + 0.5, b.y, b.z + 0.5);
  }

  // ---------------- host migration ----------------
  // The host dropped and the election picked us: promote this client's
  // replica into the authoritative simulation. World, scores, flags, and
  // the edit log are already snapshot-synced; players and bots get real
  // host-side bodies restored to their last replicated state, so the match
  // just… keeps going.
  promoteToHost(net) {
    const oldIdx = this.myIdx ?? 0;
    this.mode = 'host';
    this.net = net;
    this.myId = 'HOST';
    // Recompute rather than trust a stale cached digest: the promoted replica
    // is now the source of truth for every survivor and late joiner.
    this._worldHash = worldLogHash(this.editLog);
    // Keep our old client index: every survivor's avatars and reconstructed
    // maps are keyed by it, and re-keying mid-match would orphan them all.
    this._hostIdx = oldIdx;
    // Client stand-in avatars give way to real bodies — RemotePlayer and Bot
    // construct their own.
    for (const av of this.avatars.values()) av.dispose();
    this.avatars.clear();
    // Rebuild from the RECONSTRUCTED full-state maps, not the last packet:
    // with unchanged-row omission the wire hasn't carried a complete
    // snapshot in a long time. This is the one place that must not read
    // raw d.p/d.b.
    // The roster is the authoritative membership list. The reconstructed
    // snapshot contains only entities this client could perceive, so using
    // it as membership silently lost out-of-sight survivors during a baton
    // pass. Give every roster member a seat; restore an exact row where one
    // is available and create a dormant, safe-respawn placeholder otherwise.
    this._migRoster = migrationSurvivors(this._rosterP, oldIdx, this._fullP);
    let maxIdx = oldIdx;
    for (const [id, survivor] of this._migRoster) {
      const { idx, name, team, row } = survivor;
      if (row) this._restoreProxy(id, name, idx, team, row);
      else {
        const proxy = new RemotePlayer(this, id, name, team);
        proxy.ridx = idx;
        proxy.alive = false;
        proxy.avatar.setAlive(false);
        proxy._migrationRespawn = true;
        this.remote.set(id, proxy);
      }
      this._kdRow(this.remote.get(id));
      if (idx > maxIdx) maxIdx = idx;
    }
    this._nextPIdx = maxIdx + 1;
    for (const [idx, row] of this._fullB) {
      const meta = this._rosterB?.get(idx);
      const [x, y, z, ry, health, alive, carrier, , difficultyCode] = row;
      const bot = this._newBot(meta?.team ?? 'green', meta?.name ?? null,
        botDifficultyKey(difficultyCode));
      bot.id = idx;          // survivors key bot avatars by it — keep it stable
      reserveBotId(idx);     // and never hand it to a future spawn
      bot.body.pos.set(x, y, z);
      bot.body.vel.set(0, 0, 0);
      bot.parts.group.rotation.y = ry;
      bot.health = health;
      bot.carrier = !!carrier;
      if (!alive) {
        bot.alive = false;
        bot.deadT = 1.5; // corpse already finished tumbling on our screen
        bot.parts.group.visible = false;
        this.respawnTimers.set(bot, respawnWaveDelay(this.gameMode, this.matchElapsed));
      }
      this.bots.push(bot);
    }
    // Interest management can hide bots too. Refill only the missing seats;
    // _spawnBots now accounts for the visible bots restored just above.
    this._spawnBots();
    this._syncAbilityRows(this._lastAbilityRows);
    // Airstrike rows are unconditional full state, so a strike already in
    // flight survives the baton pass too. Damage attribution is retained
    // when its caller survived; if the departed host called it, the blast
    // still lands but has no living attacker object to credit.
    this._pendingStrikes = [];
    let maxStrikeId = 0;
    for (const row of this._lastStrikeRows) {
      const [id, xq, yq, zq, yawq, millis, owner] = row;
      const attacker = owner === oldIdx ? this.player
        : [...this.remote.values()].find(p => p.ridx === owner) ?? null;
      const pos = new THREE.Vector3(dx(xq), dy(yq), dx(zq));
      const yaw = da(yawq), t = Math.max(0, millis) / 1000;
      if (t <= 0) continue;
      this._pendingStrikes.push({ id, pos, owner, attacker, yaw, t });
      this._syncAirstrikeDrone(id, pos.x, pos.y, pos.z, yaw, t, owner);
      maxStrikeId = Math.max(maxStrikeId, id);
    }
    this._nextStrikeId = Math.max(this._nextStrikeId, maxStrikeId + 1);
    this._fullP.clear();
    this._fullB.clear();
    // Snapshots record that a flag is carried, not by whom — reattach it to
    // whoever on the enemy team was flagged as carrier. If the carrier was
    // the departed host, the flag drops where it was.
    for (const team of ['green', 'blue']) {
      const f = this.flags?.[team];
      if (f && f.state === 'carried') {
        const c = this.entities().find(e => e.carrier && e.team === this.enemyOf(team));
        if (c) f.carrier = c;
        else { f.state = 'dropped'; f.carrier = null; f.dropTimer = FLAG_RETURN_TIME; }
      }
    }
    // The hill keeps its location, owner, capture progress, and relocation
    // clock across the handover.
    if (this.hill && this._hillRow) {
      if (Number.isInteger(this._hillRow[4]) && this._hillRow[4] !== this.hill.index)
        this._setHillIndex(this._hillRow[4], false);
      this.hill.owner = this._hillRow[0];
      this.hill.progress = this._hillRow[1];
      this.hill.contested = !!this._hillRow[2];
      this.hill.capTeam = this._hillRow[3];
      if (Number.isFinite(this._hillRow[5])) this.hill.rotateIn = this._hillRow[5];
      if (Number.isFinite(this._hillRow[6]) && Number.isFinite(this._hillRow[7]))
        this.hill.presence = { green: this._hillRow[6], blue: this._hillRow[7] };
    }
    // A death mid-handover still gets its respawn; a finished match still
    // gets its rotation.
    if (!this.player.alive) this.respawnTimers.set(this.player,
      respawnWaveDelay(this.gameMode, this.matchElapsed));
    // Stragglers get a minute to find the new room before their roster entry
    // lapses and any later knock is treated as a fresh join.
    setTimeout(() => {
      // Anyone who never found the new room is gone for good. Their proxy has
      // no channel, so hostOnLeave can never fire for it, and it would stand
      // in the world forever holding a roster seat and a slot against
      // MAX_HUMANS. Retire them the same way a normal leave does.
      const stale = [...(this._migRoster?.entries() ?? [])]
        .filter(([id, migration]) => !migration.acknowledged
          || !this.net?.conns?.get(id)?.open)
        .map(([id]) => id);
      this._migRoster = null;
      if (this.mode !== 'host') return;
      for (const id of stale) {
        const p = this.remote.get(id);
        if (!p) continue;
        if (p.carrier && this.flags) {
          p.carrier = false;
          this.flags[this.enemyOf(p.team)].drop(p.body.pos.clone());
        }
        p.avatar.dispose();
        this.remote.delete(id);
        this.respawnTimers.delete(p);
        if (!this.over) this.bots.push(this._newBot(p.team));
        this.feed(`${nameSpan(p)} never made it back`);
      }
      if (stale.length) this.net.broadcast(this._rosterMsg());
    }, 60000);
  }

  // Rebuild one RemotePlayer from its reconstructed full-state row.
  // Weapon class is explicit so migration remains exact while a non-gun tool is held.
  _restoreProxy(id, name, idx, team, row) {
    const [x, y, z, ry, health, alive, carrier, tool, blocks, crouch, nades,
      ammo, reloadMs, gunClass] = row;
    const proxy = new RemotePlayer(this, id, name, team);
    proxy.ridx = idx;
    proxy.body.pos.set(x, y, z);
    proxy.avatar.push(x, y, z, ry);
    proxy.yaw = ry; // uplink yaw is already model rotation; snapshot passes it through
    proxy.health = health;
    proxy.alive = !!alive;
    proxy.carrier = !!carrier;
    proxy.tool = tool;
    proxy.gunClass = GUN_CLASSES.includes(gunClass) ? gunClass
      : GUN_CLASSES.includes(tool) ? tool : 0;
    proxy._pendingClass = proxy.gunClass;
    if (Number.isInteger(ammo)) proxy.ammo[proxy.gunClass] = ammo;
    proxy._reloadUntil = Number.isFinite(reloadMs) && reloadMs > 0
      ? this.time + reloadMs / 1000 : 0;
    proxy.blocks = blocks;
    proxy.crouched = !!crouch;
    if (nades !== undefined) proxy.nades = nades;
    if (!proxy.alive) this.respawnTimers.set(proxy,
      respawnWaveDelay(this.gameMode, this.matchElapsed));
    this.remote.set(id, proxy);
    return proxy;
  }

  hostOnLeave(id) {
    const p = this.remote.get(id);
    if (!p) return;
    const migration = this._migRoster?.get(id);
    if (migration) {
      // A survivor's first post-handoff channel can flap while the full room
      // is reconnecting. Preserve the reconstructed seat for another knock;
      // the grace-window cleanup retires it if no live acknowledged channel
      // ultimately settles. As with an ordinary disconnect, never let a
      // missing player hold the flag hostage.
      migration.rejoined = false;
      migration.acknowledged = false;
      if (p.carrier && this.flags) {
        p.carrier = false;
        this.flags[this.enemyOf(p.team)].drop(p.body.pos.clone());
      }
      this.feed(`${nameSpan(p)} reconnecting after host migration`);
      return;
    }
    if (p.carrier && this.flags) {
      p.carrier = false;
      this.flags[this.enemyOf(p.team)].drop(p.body.pos.clone());
    }
    const canRecover = validResumeToken(p._resumeToken) && !p._noReconnect && !this.over;
    this.feed(`${nameSpan(p)} ${canRecover ? 'lost connection — bot covering' : 'left the battle'}`);
    p.avatar.dispose();
    this.remote.delete(id);
    this._combatHistory.delete(p);
    if (this._voteKick?.id === id) this._clearVoteKick(true);
    else if (this._voteKick) {
      this._voteKick.voters.delete('p' + p.ridx);
      this._voteKick.needed = voteKickVotesNeeded(this.remote.size + 1);
      if (this._voteKick.needed < 2) this._clearVoteKick(true);
      else if (this._voteKick.voters.size >= this._voteKick.needed) this._passVoteKick();
      else this._publishVoteKickState();
    }
    this._squadVotes.delete('p' + p.ridx);
    const respawnLeft = this.respawnTimers.get(p);
    this.respawnTimers.delete(p);
    if (canRecover) this._reserveDisconnectedPlayer(p, respawnLeft);
    else if (!this.over) this.bots.push(this._newBot(p.team));
    this.net.broadcast(this._rosterMsg()); // seat emptied, bot filled in
    if (this.over) {
      this._publishSquadState();
      this._publishBattleChoices();
      this._maybeStartNextBattle();
    }
    this._checkAbandoned();
  }

  // Everyone vanishing at once usually means they didn't leave — we did.
  // A stalled tab, a dropped uplink: the survivors' watchdogs fired, the
  // baton passed, and this room carried on hosting nobody while still
  // answering matchmaking. We can't detect that from inside, so say so
  // rather than act on it — a host that genuinely emptied out normally is
  // still a room worth keeping open.
  _checkAbandoned() {
    if (this.mode !== 'host') return;
    const now = performance.now();
    this._leaveTimes = [...(this._leaveTimes ?? []), now].filter(t => now - t < 3000);
    if (this._leaveTimes.length >= 2 && this.remote.size === 0
        && this._reconnectReservations.size === 0) {
      this._leaveTimes = [];
      this.onAbandoned?.();
    }
  }

  _removeBot(team) {
    const i = this.bots.findIndex(b => b.team === team && !Number.isInteger(b._humanRidx));
    if (i < 0) return;
    const [b] = this.bots.splice(i, 1);
    disposeObject(b.parts.group);
    this.respawnTimers.delete(b);
  }

  // One full tick of state: indexed, quantized rows for every entity, plus
  // the unconditional channels (flags, hill, captures, grenades, game-over).
  // _broadcastSnapshot trims this per connection down to what changed.
  snapshot() {
    const ry = yaw => Math.atan2(-Math.cos(yaw), Math.sin(yaw)); // our yaw -> model rotation
    const pos = p => [qx(p.x), qy(p.y), qx(p.z)];
    const P = [[this._hostIdx, ...pos(this.player.body.pos), qa(ry(this.player.yaw)),
      Math.round(this.player.health), this.player.alive ? 1 : 0,
      this.player.carrier ? 1 : 0, this.player.tool, this.player.blocks,
      this.player.crouched ? 1 : 0, this.player.grenades,
      this.player.ammo[this.player.gunClass], Math.max(0, Math.round(this.player.reloading * 1000)),
      this.player.gunClass]];
    for (const p of this.remote.values()) {
      this._remoteWeaponState(p);
      P.push([p.ridx, ...pos(p.body.pos), qa(p.yaw), Math.round(p.health),
        p.alive ? 1 : 0, p.carrier ? 1 : 0, p.tool, p.blocks, p.crouched ? 1 : 0,
        p.nades, p.ammo[p.gunClass], Math.max(0, Math.round((p._reloadUntil - this.time) * 1000)),
        p.gunClass]);
    }
    // Cover bots occupy their reserved HUMAN row while the owner reconnects.
    // That preserves the full state needed for host migration without drawing
    // a duplicate bot avatar or losing the peer id that owns this seat.
    for (const b of this.bots) {
      if (!Number.isInteger(b._humanRidx)) continue;
      P.push([b._humanRidx, ...pos(b.body.pos), qa(b.parts.group.rotation.y),
        Math.round(b.health), b.alive ? 1 : 0, 0, b.gunClass, b.blocks,
        b.crouched ? 1 : 0, b.nades, b.ammo,
        Math.max(0, Math.round(b.reloading * 1000)), b.gunClass]);
    }
    const B = [];
    for (const b of this.bots) {
      if (Number.isInteger(b._humanRidx)) continue;
      B.push([b.id, ...pos(b.body.pos), qa(b.parts.group.rotation.y),
        Math.round(b.health), b.alive ? 1 : 0, b.carrier ? 1 : 0,
        b.parts.crouched ? 1 : 0, botDifficultyCode(b.difficulty?.key)]);
    }
    return {
      t: 's',
      p: P,
      b: B,
        // Crouch and cognitive profile both survive client reconstruction and
        // host migration. Neither changes bot health, damage, or weapon stats.
      f: this.flags && {
        g: [FLAG_CODE[this.flags.green.state], ...pos(this.flags.green.pos), Math.ceil(this.flags.green.dropTimer)],
        b: [FLAG_CODE[this.flags.blue.state], ...pos(this.flags.blue.pos), Math.ceil(this.flags.blue.dropTimer)],
      },
      h: this.hill && [this.hill.owner, Math.round(this.hill.progress * 10) / 10,
        this.hill.contested ? 1 : 0, this.hill.capTeam, this.hill.index,
        Math.max(0, Math.round(this.hill.rotateIn * 10) / 10),
        this.hill.presence?.green ?? 0, this.hill.presence?.blue ?? 0],
      // Preserve the current CTF pressure state if the host leaves. Age is
      // relative, so a promoted guest can continue its own local clock.
      ct: this.flags && [this._ctfEscalation.active ? 1 : 0,
        Math.max(0, Math.min(820, Math.round((this.time - this._ctfProgressAt) * 10)))],
      c: [Math.round(this.captures.green * 10) / 10, Math.round(this.captures.blue * 10) / 10],
      g: this.grenades.map(g => pos(g.pos)),
      // Small unconditional channel: [id, target xyz, approach yaw,
      // remaining milliseconds, caller roster index]. Unlike player rows it
      // must not be interest-culled — the warning aircraft is gameplay intel.
      a: this._pendingStrikes.map(s => [s.id, ...pos(s.pos), qa(s.yaw),
        Math.max(0, Math.round(s.t * 1000)), s.owner]),
      u: this._abilityRows(),
      tb: this.teamBalanceEnabled() ? 1 : 0,
      m: [Math.max(0, Math.round(this.matchRemaining * 10)), this.overtime ? 1 : 0,
        Math.max(0, Math.round(this.matchElapsed * 10))],
      o: this.over ? 1 : 0,
      w: this.winner,
    };
  }

  // Per-connection delta broadcast: a row rides the wire only when it
  // changed since what THAT channel was last sent (the reliable ordered
  // channel makes "sent" mean "will arrive"). Removals are explicit — an
  // omitted row means "unchanged", never "gone". A congested channel is
  // skipped WITHOUT updating its sent map, so the next tick resends
  // everything the skipped tick would have.
  //
  // Interest management layers on top of the same cur/rm machinery: a row
  // that isn't perceptible to a given connection is simply never added to
  // `cur` for that connection. The EXISTING removal logic below already
  // treats "known before, missing from cur now" as "gone" — the client
  // can't tell the difference between an entity leaving the room and one
  // walking behind a wall, and doesn't need to; both correctly hide it.
  // On re-entering interest (LOS restored, or closing distance),
  // sent[key] no longer has an entry for that idx (the removal loop
  // deleted it), so it comes back as `!prev` — a fresh row, not a stale
  // diff against whatever it was doing while unseen.
  //
  // Uniform for every team, not just enemies: nothing in this codebase
  // currently grants x-ray teammate awareness either (the minimap draws
  // no player blips at all, only your own position) — so there's no
  // existing feature to carve out an exemption for.
  //
  // Scope: this closes the wallhack for GUESTS receiving this broadcast.
  // The host's own client still holds every live position directly in
  // memory to run the simulation at all — a malicious host reading its
  // own RemotePlayer/Bot objects locally is the separate, unsolved
  // host-authority problem, not something a wire-level filter can touch.
  _broadcastSnapshot() {
    const snap = this.snapshot();
    // idx -> live entity, built once per tick and shared across every
    // connection's interest check below, instead of re-searching
    // this.remote/this.bots for every row on every connection.
    const byIdx = { p: new Map([[this._hostIdx, this.player]]), b: new Map() };
    for (const p of this.remote.values()) byIdx.p.set(p.ridx, p);
    for (const b of this.bots) {
      if (Number.isInteger(b._humanRidx)) byIdx.p.set(b._humanRidx, b);
      else byIdx.b.set(b.id, b);
    }
    for (const [id, conn] of this.net.conns) {
      if (!conn.open) continue;
      if (conn.dataChannel?.bufferedAmount > 64 * 1024) continue;
      const full = !conn._sentRows || conn._forceFullSnapshot
        || this.time >= (conn._nextFullSnapshotAt ?? 0);
      const sent = conn._sentRows ??= { p: new Map(), b: new Map() };
      if (full) { sent.p.clear(); sent.b.clear(); }
      const out = { t: 's', q: (conn._snapshotSeq ?? 0) + 1, full: full ? 1 : 0,
        wr: this.editLog.length, wh: this._worldHash >>> 0,
        f: snap.f, h: snap.h, ct: snap.ct, c: snap.c, g: snap.g,
        a: snap.a, u: snap.u, tb: snap.tb, m: snap.m,
        o: snap.o, w: snap.w };
      const pingTs = this.remote.get(id)?._pingTs;
      if (pingTs !== undefined) out.ts = pingTs;
      out.ack = this.remote.get(id)?._lastActionSeq ?? 0;
      const viewer = this.remote.get(id);
      const eye = viewer?.body.eye(this._interestEye);
      for (const key of ['p', 'b']) {
        const cur = new Set();
        out[key] = [];
        for (const row of snap[key]) {
          const idx = row[0];
          // Never hide a connection's own row, and fail OPEN (show
          // everything) if the viewer can't be resolved at all — a
          // transient lookup gap should never blind someone outright,
          // that's a far worse failure than briefly over-showing during
          // an edge case that shouldn't occur in the first place.
          if (eye && idx !== viewer.ridx) {
            const ent = byIdx[key].get(idx);
            if (!ent || !this._perceives(eye, ent.body)) continue;
          }
          cur.add(idx);
          const prev = sent[key].get(idx);
          if (!prev || !rowsEq(prev, row)) { out[key].push(row); sent[key].set(idx, row); }
        }
        const rm = [];
        for (const idx of sent[key].keys())
          if (!cur.has(idx)) { rm.push(idx); sent[key].delete(idx); }
        if (rm.length) (out.rm ??= {})[key] = rm;
      }
      if (this.net.sendTo(id, out)) {
        conn._snapshotSeq = out.q;
        const sentAt = conn._snapshotSentAt ??= new Map();
        sentAt.set(out.q, this.time);
        while (sentAt.size > 16) sentAt.delete(sentAt.keys().next().value);
        if (full) {
          conn._forceFullSnapshot = false;
          conn._nextFullSnapshotAt = this.time + 2;
        }
      }
    }
  }

  // ---------------- client networking ----------------
  // Identity arrives once per churn, indexed: [[idx, name, team, pid], ...]
  // for players (pid lets a promoted replica match rejoining survivors),
  // [[idx, name, team], ...] for bots.
  _applyRoster(r) {
    const team = t => (t === 'blue' ? 'blue' : 'green');
    this._rosterP = new Map((r?.p ?? []).map(row =>
      [row[0], { name: cleanName(row[1]), team: team(row[2]), pid: row[3] }]));
    this._rosterB = new Map((r?.b ?? []).map(row =>
      [row[0], { name: cleanName(row[1]), team: team(row[2]) }]));
    // A rotation can swap which color you're playing (see _rotate). The
    // welcome sets this.player.team exactly once, at join — without this a
    // guest's own team goes stale the moment the host flips it, silently
    // mislabeling their own chat scope, flag alerts, and avatar friend/foe
    // coloring for the rest of the match.
    if (this.mode === 'client' && this.myIdx != null) {
      const mine = this._rosterP.get(this.myIdx);
      if (mine) this.player.team = mine.team;
    }
  }

  _applyWorldEntry(e) {
    if (e[0] === 'b') {
      const removed = this.world.carve(Math.floor(e[1]), Math.floor(e[2]), Math.floor(e[3]),
        Math.min(Math.max(e[4] ?? 0, 0), 6),
        (x, y, z) => !this._protectedVoxelReason(x, y, z));
      this.voxelStory?.recordBlast(removed.length);
    } else {
      const before = this.world.get(e[0], e[1], e[2]);
      this.world.set(e[0], e[1], e[2], e[3]);
      this.voxelStory?.recordEdit(before, this.world.get(e[0], e[1], e[2]));
    }
  }

  _replayEdits(log) {
    this.editLog = [];
    this._worldHash = WORLD_HASH_SEED;
    this.voxelStory?.reset();
    this.world.batchEdits(() => {
      for (const e of log ?? []) {
        this._applyWorldEntry(e);
        this._appendWorldEdit(e);
      }
    });
  }

  _requestResync(scope) {
    const now = performance.now();
    if (now < (this._resyncAt[scope] ?? 0)) return;
    this._resyncAt[scope] = now + 1000;
    this.net?.send({ t: 'a', k: 'resync', scope });
  }

  _applyWorldSync(d) {
    if (d.seed !== this.seed || d.map !== this.mapIndex) return;
    if (worldLogHash(d.log) !== (d.wh >>> 0)) return;
    const localLength = this.editLog.length;
    const isPrefix = localLength <= d.log.length
      && worldLogHash(d.log.slice(0, localLength)) === (this._worldHash >>> 0);
    if (isPrefix) {
      for (const e of d.log.slice(localLength)) {
        this._applyWorldEntry(e);
        this._appendWorldEdit(e);
      }
    } else {
      // Same deterministic baseline, repaired in place so bodies and scene
      // references remain valid while the terrain replica is rebuilt.
      this.world.data.fill(0);
      this.world.revision++;
      this.world.dirty?.clear();
      generateMap(this.world, this.seed, this.mapIndex);
      this._replayEdits(d.log);
      this.world.flushDirty();
      hud.mapInit(this.world);
      this.player.syncBlockColor();
      retintVoxelBoxes(this.player.vmRoot);
    }
    this.navRevision++;
  }

  clientOnData(d) {
    if (!validServerMessage(d)) return;
    // Public-room identity comes from the deterministic PUB code, not a host
    // claim. Reject a stale/racing welcome before touching client state.
    if (d.t === 'w' && this.publicRoom && !publicContentAvailable(d.mode, d.map))
      return this.onPublicContentRejected?.(d);
    if (hostHeartbeatMessage(d)) {
      this.lastRecv = performance.now(); // welcome/snapshots are the host heartbeat
      this._unstableShown = false; // the link's talking again — clear the warning flag
    }
    if (d.t === 'full') return this.onFull?.();
    if (d.t === 'version') return this.onVersion?.(d.v);
    if (d.t === 'r') return this._applyRoster(d);
    if (d.t === 'sync') return this._applyWorldSync(d);
    if (d.t === 'w') {
      this.myId = d.id;
      this.myIdx = d.me;
      this._serverLife = d.life;
      this.player.team = d.team;
      if (d.tb !== undefined) this._teamBalanceHostEnabled = d.tb === 1;
      if (d.mode) this.gameMode = d.mode; // rebuild below needs it (flagless TDM)
      if (d.migrated) {
        // Baton-pass rejoin: we never left — keep position and kit; the new
        // host corrects drift via snapshots. But if its world isn't the one
        // we remember, ours is stale: rebuild from its seed instead.
        if (d.seed !== this.seed || (d.map ?? 0) !== this.mapIndex) {
          this.rebuild(d.seed, d.map ?? 0);
          this._replayEdits(d.log);
        }
        // The new host marks nothing as sent and never mentions the departed
        // host's row — drop every replica so the full first snapshot
        // repopulates from zero rather than leaving a ghost behind.
        for (const av of this.avatars.values()) av.dispose();
        this.avatars.clear();
        this._fullP.clear();
        this._fullB.clear();
        this._applyRoster(d.r);
        this._lastSnapshotSeq = null;
        if (d.wh !== undefined && (d.wh >>> 0) !== (this._worldHash >>> 0))
          this._applyWorldSync(d);
        // Interest management may have hidden our old body from the promoted
        // replica. Its reset flag supplies the authoritative safe redeploy;
        // apply it on the migrated path where that flag is actually sent.
        if (d.reset) {
          const spawn = parseSpawnRow(d.spawn);
          if (spawn) {
            this.player.respawn({ x: spawn.x, y: spawn.y, z: spawn.z });
            this.player.yaw = spawn.yaw;
            this.player.pitch = 0;
          }
        }
        this.onWelcome?.();
      } else {
        this.rebuild(d.seed, d.map ?? 0);
        // The host chose the spawn when it created our RemotePlayer. Never
        // independently roll another client-side spawn: doing so starts the
        // two peers at different coordinates and makes the first movement
        // report look like a teleport to the host.
        const spawn = parseSpawnRow(d.spawn);
        if (spawn) {
          this.player.body.pos.set(spawn.x, spawn.y, spawn.z);
          this.player.body.vel.set(0, 0, 0);
          this.player.yaw = spawn.yaw;
          this.player.pitch = 0;
        }
        this._replayEdits(d.log);
        if (d.wh !== undefined && (d.wh >>> 0) !== (this._worldHash >>> 0))
          this._requestResync('world');
        this._applyRoster(d.r);
        this._lastSnapshotSeq = null;
        this.onWelcome?.();
      }
    } else if (d.t === 's') {
      if (d.q !== undefined) {
        const order = snapshotDisposition(this._lastSnapshotSeq, d.q, !!d.full);
        if (!order.accept) {
          if (order.resync) this._requestResync('state');
          return;
        }
        if (d.full) { this._fullP.clear(); this._fullB.clear(); }
        this._lastSnapshotSeq = d.q;
        this._snapshotEcho = d.q;
      }
      if (Number.isSafeInteger(d.wr)) {
        if (d.wr > this.editLog.length
            || (d.wr === this.editLog.length && d.wh !== undefined
              && (d.wh >>> 0) !== (this._worldHash >>> 0)))
          this._requestResync('world');
      }
      // Same EWMA idiom as Avatar's arrival-jitter tracking: smooth rather
      // than snap, so one late packet doesn't make the corner number jump.
      if (Number.isFinite(d.ts)) {
        const rtt = performance.now() - d.ts;
        this.pingMs = this.pingMs != null ? this.pingMs + 0.2 * (rtt - this.pingMs) : rtt;
      }
      this._clientSnapshot(d);
    }
    else if (d.t === 'e') this._clientEvent(d);
  }

  _clientSnapshot(d) {
    // Merge first: the tick carries only what changed, so the reconstructed
    // maps — iterated whole below — are the real picture. If the host drops,
    // promoteToHost rebuilds the match from exactly these.
    mergeSnapshot(this._fullP, this._fullB, d);
    // The reliable host->client channel preserves the order of an accepted
    // edit event followed by this snapshot. Therefore an action at or below
    // the host's ack has either produced its stamped edit (and was consumed
    // above) or was authoritatively denied; drop the latter so failed/no-op
    // attempts cannot accumulate forever.
    if (Number.isSafeInteger(d.ack)) {
      clearAckedTerrainActions(this._pendingTerrainActions, d.ack);
    }
    this._syncAirstrikeRows(d.a ?? []);
    if (d.tb !== undefined) this._teamBalanceHostEnabled = d.tb === 1;
    const want = new Set();
    for (const [idx, r] of this._fullP) {
      const [x, y, z, ry, health, alive, carrier, tool, blocks, crouch, nades,
        ammo, reloadMs, gunClass] = r;
      if (idx === this.myIdx) {
        if (!alive && this.player.alive) this._clientDied();
        // No hud.damage()/sfx.hurt() here anymore — damage() is the sole
        // place health ever decreases (verified directly, not assumed),
        // so every drop this would have caught already went through the
        // new explicit 'dmgdir' message above, which carries the actual
        // source position this snapshot-diff never had. Firing both would
        // have doubled the flash/sound on every single hit.
        // Semantic bounds: shape validation only guarantees finite numbers,
        // so clamp the self row into the legal loadout (0-100 health, 0-99
        // blocks, mag-sized ammo, 0-3 grenades). A hostile host can still
        // damage you — that IS its job — but it cannot buff you to 9999
        // or corrupt the HUD with out-of-range values.
        this._lastHealth = Math.min(100, Math.max(0, health));
        this.player.health = this._lastHealth;
        this.player.blocks = Math.min(99, Math.max(0, blocks));
        this.player.carrier = !!carrier;
        if (GUN_CLASSES.includes(gunClass)) {
          this.player.gunClass = gunClass;
          // While dead or between rounds, the local pending choice has already
          // been sent to the host but is not represented by the current-class
          // snapshot field until respawn. Do not erase that choice on every
          // 15Hz state packet while waiting for the authoritative application.
          if (this.player.alive && !this.over) this.player._pendingClass = gunClass;
        }
        const weaponAcked = !Number.isSafeInteger(d.ack)
          || d.ack >= this._lastWeaponActionSeq;
        const ammoChanged = weaponAcked && Number.isInteger(ammo)
          && GUN_CLASSES.includes(this.player.gunClass)
          && this.player.ammo[this.player.gunClass] !== ammo;
        if (ammoChanged) this.player.ammo[this.player.gunClass] =
          Math.min(TOOLS[this.player.gunClass]?.mag ?? 10, Math.max(0, ammo));
        if (Number.isFinite(reloadMs)) {
          if (reloadMs > 0 && this.player.reloading <= 0)
            this.player.reloading = reloadMs / 1000;
          else if (reloadMs <= 0 && ammo === TOOLS[this.player.gunClass]?.mag)
            this.player.reloading = 0;
        }
        if (ammoChanged && this.player.tool === this.player.gunClass)
          hud.refreshTool(this.player);
        // Ordinary movement remains client-predicted, but a large divergence
        // means the host rejected a report or corrected state. Snap only then;
        // applying every 15Hz row would make normal movement visibly stutter.
        // Upper bound: a correction bigger than the whole arena is forged or
        // hopelessly desynced — hold position and wait for a resync instead
        // of teleporting across the map on one packet.
        const div = Math.hypot(this.player.body.pos.x - x, this.player.body.pos.y - y,
          this.player.body.pos.z - z);
        if (div > 4 && div < 60) {
          this.player.body.pos.set(x, y, z);
          this.player.body.vel.set(0, 0, 0);
        }
        // The host owns the grenade stock (its rate gate can refuse a throw
        // the client already counted). Without this the HUD drifts and the
        // belt eventually reads full while every throw is silently rejected.
        if (nades !== undefined && nades !== this.player.grenades) {
          this.player.grenades = Math.min(3, Math.max(0, Math.floor(nades)));
          if (this.player.tool === 4) hud.refreshTool(this.player);
        }
        hud.health(this.player);
        if (this.player.tool === 3) hud.refreshTool(this.player);
        continue;
      }
      const meta = this._rosterP?.get(idx);
      if (!meta) continue; // roster always lands before its rows; belt + braces
      const key = 'p' + idx;
      want.add(key);
      let av = this.avatars.get(key);
      if (!av) {
        av = new Avatar(this.scene, meta.team, meta.name, meta.team === this.player.team);
        this.avatars.set(key, av);
      }
      av.setAlive(!!alive);
      av.setHealth(health);
      av.setCrouch(!!crouch);
      av.setTool(tool);
      av.push(x, y, z, ry);
    }
    for (const [idx, r] of this._fullB) {
      const [x, y, z, ry, health, alive, , crouch] = r;
      const meta = this._rosterB?.get(idx);
      if (!meta) continue;
      const key = 'b' + idx;
      want.add(key);
      let av = this.avatars.get(key);
      if (!av) {
        av = new Avatar(this.scene, meta.team, meta.name, meta.team === this.player.team);
        this.avatars.set(key, av);
      }
      av.setAlive(!!alive);
      av.setHealth(health);
      av.setCrouch(!!crouch); // host shrinks ducking bots; draw them that way
      av.push(x, y, z, ry);
    }
    // Anything the reconstructed state no longer holds is gone (left the
    // room / bot swapped out) — its removal rode an explicit rm list.
    for (const [key, av] of this.avatars) {
      if (!want.has(key)) { av.dispose(); this.avatars.delete(key); }
    }
    this._syncAbilityRows(d.u ?? []);
    const stateName = ['home', 'carried', 'dropped'];
    if (d.f && this.flags)
      for (const team of ['green', 'blue']) {
        const f = d.f[team[0]], flag = this.flags[team];
        // Shape validation only guarantees finite indices: an out-of-range
        // state would land as undefined and corrupt flag logic downstream.
        if (stateName[f[0]] !== undefined) flag.state = stateName[f[0]];
        flag.pos.set(dx(f[1]), dy(f[2]), dx(f[3]));
        flag.dropTimer = Math.max(0, f[4]);
      }
    this._hillRow = d.h ?? null; // kept raw: a promoted replica restores it
    if (d.h && this.hill) {
      if (Number.isInteger(d.h[4]) && d.h[4] !== this.hill.index)
        this._setHillIndex(d.h[4], false);
      this.hill.owner = d.h[0];
      this.hill.progress = d.h[1];
      this.hill.contested = !!d.h[2];
      this.hill.capTeam = d.h[3];
      if (Number.isFinite(d.h[5])) this.hill.rotateIn = d.h[5];
      if (Number.isFinite(d.h[6]) && Number.isFinite(d.h[7]))
        this.hill.presence = { green: d.h[6], blue: d.h[7] };
      this._updateHillVisual();
    }
    if (d.ct && this.flags) {
      this._ctfEscalation = { active: !!d.ct[0],
        returnTime: d.ct[0] ? 12 : FLAG_RETURN_TIME,
        frontlineBonus: d.ct[0] ? 8 : 0 };
      this._ctfProgressAt = this.time - d.ct[1] / 10;
    }
    // Scoreboard integrity: a hostile host's cheapest win is a forged
    // finale — captures jumping to the limit or a bare 'over' flag at 0-0.
    // Captures never decrease mid-round, never exceed the mode limit, and
    // never jump faster than play allows (integers +1 for CTF, small
    // catch-up steps for TDM/KOTH after a gap). Full snapshots and
    // decreases are baselines instead: late joins, resyncs, and round
    // resets. Forging a win now takes sustained plausible traffic.
    const scoreCap = modeScoreLimit(this.gameMode, { publicRoom: this.publicRoom });
    const scoreJump = this.gameMode === 'ctf' ? 1 : 5;
    const scoreKeys = ['green', 'blue'];
    let scoreGrew = false;
    for (let i = 0; i < 2; i++) {
      const raw = Math.max(0, d.c[i]);
      const prev = this.captures[scoreKeys[i]] ?? 0;
      let next;
      if (d.full || raw < prev) next = Math.min(scoreCap, raw);
      else {
        next = Math.max(prev, Math.min(scoreCap, Math.min(prev + scoreJump, raw)));
        if (next > prev) scoreGrew = true;
      }
      this.captures[scoreKeys[i]] = next;
    }
    if (d.m) {
      // Match clock is capped well above the longest legitimate override:
      // a host that keeps resetting the clock only buys bounded extensions.
      this.matchRemaining = Math.min(3900, d.m[0] / 10);
      this.overtime = !!d.m[1];
      this.matchElapsed = d.m[2] / 10;
    }
    this.winner = d.w ?? null;
    hud.score(this);
    const limit = modeScoreLimit(this.gameMode, { publicRoom: this.publicRoom });
    // A finale is honored only when the sanitized scoreboard or the clock
    // justifies it: limit reached, clock expired outside overtime, or the
    // score grew on this snapshot (custom-limit hosts end through growth).
    // Anything else is a forged 0-0 finale — ignore it and keep playing.
    const limitReached = this.captures.green >= limit || this.captures.blue >= limit;
    const clockExpired = d.m ? d.m[0] <= 0 : this.matchRemaining <= 0;
    const overtimeNow = d.m ? !!d.m[1] : this.overtime;
    const finaleJustified = limitReached || (clockExpired && !overtimeNow) || scoreGrew;
    // When the limit decides it, the scoreboard names the winner — a d.w
    // naming anyone else is contradicted on its face. Clock and growth
    // finales accept the host's call with the scoreboard as fallback.
    const limitWinner = this.captures.green >= limit ? 'green'
      : this.captures.blue >= limit ? 'blue' : null;
    if (d.o && !this.over && finaleJustified) this._end(limitWinner
      ?? d.w ?? scoreLeader(this.captures) ?? 'green');
    this._lastGrenades = d.g;
  }

  _clientEvent(d) {
    if (d.k === 'edit' || d.k === 'boom' || d.k === 'col') {
      const count = d.k === 'col' ? d.cells.length / 3 : 1;
      if (d.wr !== undefined) {
        const order = worldEventDisposition(this.editLog.length, d.wr, count);
        if (!order.accept) {
          if (order.resync) this._requestResync('world');
          return;
        }
      }
    }
    switch (d.k) {
      case 'edit': {
        // Explosions and structural collapses already replay their particle
        // burst on every client (explodeAt and the 'col' case below both
        // call blockBurst directly). An ordinary single-block break — a
        // shovel dig, a gunfire-chipped block — never did: this just set the
        // voxel and moved on, so a block disappearing from someone ELSE's
        // dig or someone ELSE's gunfire was silent and invisible on every
        // screen but the one that caused it.
        const before = this.world.get(d.x, d.y, d.z);
        this.world.set(d.x, d.y, d.z, d.v);
        this.voxelStory?.recordEdit(before, this.world.get(d.x, d.y, d.z));
        this._appendWorldEdit([d.x, d.y, d.z, d.v]); // migration: late joiners get it from us
        if (!d.v && before) this.effects.blockBurst([{ x: d.x, y: d.y, z: d.z, v: before }]);
        const action = consumeTerrainAck(this._pendingTerrainActions, d, this.myIdx);
        if (action) this._recordLocalAction(this.player, action);
        break;
      }
      case 'boom': {
        // The host is untrusted input like anyone else: an oversized radius
        // would let a patched host crater the whole map on every client.
        // Raised from 4 to 6 when airstrike landed — its own crater is
        // 4.5, comfortably under the new cap with headroom, while 6 is
        // still tiny relative to the 256x256 map, so the original intent
        // (can't crater the whole map) still holds.
        const r = Math.min(Math.max(d.r ?? 0, 0), 6);
        this.explodeAt(d.x, d.y, d.z, r, null,
          d.strikeId !== undefined ? 'airstrikeImpact' : 'explosion');
        this._appendWorldEdit(['b', d.x, d.y, d.z, r]);
        if (d.strikeId !== undefined) this._removeAirstrikeDrone(d.strikeId);
        break;
      }
      case 'telegraph': {
        // Untrusted host input again — clamp coordinates into the map
        // bounds before drawing anything, same discipline as 'boom' above.
        const x = Math.max(0, Math.min(SX, d.x ?? 0));
        const y = Math.max(0, Math.min(SY, d.y ?? 0));
        const z = Math.max(0, Math.min(SZ, d.z ?? 0));
        this._telegraph(x, y, z);
        this._syncAirstrikeDrone(d.id, x, y, z, d.yaw, d.remaining, d.owner);
        break;
      }
      case 'col': { // host collapsed a structure: replay removal + dust only
        const cells = [];
        this.world.batchEdits(() => {
          for (let i = 0; i + 2 < d.cells.length; i += 3) {
            const x = d.cells[i] | 0, y = d.cells[i + 1] | 0, z = d.cells[i + 2] | 0;
            const v = this.world.get(x, y, z);
            if (v) this.world.set(x, y, z, 0);
            this._appendWorldEdit([x, y, z, 0]); // keep stream history exact despite drift
            if (!v) continue;
            cells.push({ x, y, z, v });
          }
        });
        if (cells.length) {
          this.voxelStory?.recordCollapse(cells.length);
          this.effects.blockBurst(cells.filter((_, i) => i % Math.ceil(cells.length / 48) === 0));
          sfx.crumble();
        }
        break;
      }
      case 'shot': {
        if (d.sid === this.myId) break;
        const from = v3(d.f);
        let firingAvatar = null, nearest = 3 * 3;
        for (const avatar of this.avatars.values()) {
          if (!avatar.alive || !avatar.group.visible) continue;
          const distance = avatar.group.position.distanceToSquared(from);
          if (distance < nearest) { nearest = distance; firingAvatar = avatar; }
        }
        firingAvatar?.fire();
        this.shotFx(from, v3(d.e), d.hit, d.hex, from, d.gun);
        break;
      }
      case 'feed': hud.feed(safeFeedHtml(d.html)); break;
      case 'msg':
        if (!d.team || d.team === this.player.team) hud.message(d.text, d.color);
        break;
      case 'hit':
        hud.hitmark(d.kill);
        if (d.tier) hud.killCallout(d.tier); // replaces the plain chime, same rule as the host-side path
        else if (d.head) sfx.headshot(d.kill);
        else d.kill ? sfx.kill() : sfx.hit();
        break;
      case 'dmgdir': this._noteAction(this.player);
        hud.damageDir(this._bearingTo({ x: d.x, z: d.z })); break;
      case 'envdmg': this._noteAction(this.player); hud.damage(); sfx.hurt(); break;
      case 'chat':
        if (d.scope === 'all' && !this.publicChatEnabled()) break;
        hud.chatMsg({ name: cleanName(d.name), team: d.team === 'blue' ? 'blue' : 'green',
                      text: String(d.text ?? '').slice(0, 120), scope: d.scope });
        break;
      case 'died': this._clientDied(d.rt, d.recap); break;
      case 'spawn':
        this._serverLife = d.life;
        this.player.respawn({ x: d.x, y: d.y, z: d.z });
        if (Number.isFinite(d.yaw)) this.player.yaw = d.yaw;
        hud.respawn(0); hud.health(this.player); hud.refreshTool(this.player);
        this._lastHealth = 100;
        break;
      case 'mark': this._receiveTeamPing(d); break;
      case 'squad':
        this._squadHostEnabled = true;
        this._squadVotes = new Set(d.voters);
        hud.staySquad(this, d.voters);
        break;
      case 'ready':
        this._intermissionReady = new Set(d.voters);
        hud.ready(d.voters.length, this._humanKeys().length,
          this._intermissionReady.has(this._kdKey(this.player)));
        break;
      case 'choices': {
        const choices = d.choices.map(([mode, map]) => ({ mode, map,
          name: MAPS[map]?.name, key: MAPS[map]?.key }));
        if (!validBattleChoices(choices, MAPS,
          { publicRoom: this.publicRoom, privateContent: this.privateContent })) break;
        this._battleChoices = choices;
        this._intermissionReady = new Set(d.ready);
        const mine = this._myBattleChoice;
        this._battleTally = d.votes.slice();
        hud.nextBattles(this, choices, d.votes, mine);
        hud.ready(d.ready.length, this._humanKeys().length,
          d.ready.includes(this._kdKey(this.player)));
        break;
      }
      case 'votekick':
        this._voteKick = d.active ? { target: d.target, name: d.name,
          voters: new Set(d.voters), needed: d.needed, remaining: d.remaining } : null;
        this.onVoteKickState?.(this.voteKickState());
        break;
      case 'corr':
        // Host nudges are small by nature. A correction bigger than the
        // whole arena is a teleport attempt — hold position instead.
        if ([d.x, d.y, d.z].every(Number.isFinite)
            && Math.hypot(this.player.body.pos.x - d.x, this.player.body.pos.y - d.y,
              this.player.body.pos.z - d.z) < 60) {
          this.player.body.pos.set(d.x, d.y, d.z);
          this.player.body.vel.set(0, 0, 0);
        }
        break;
      case 'kick': this.onKicked?.(d.reason); break;
      case 'kd': // host's authoritative contribution scoreboard
        this.kd = new Map((d.rows || []).map(r =>
          [String(r[0]).slice(0, 8), contributionRow({ name: cleanName(r[1]),
            team: r[2] === 'blue' ? 'blue' : 'green', k: r[3] | 0, d: r[4] | 0,
            score: r[5] ?? (r[3] | 0) * CONTRIBUTION.kill,
            a: r[6] ?? 0, objective: r[7] ?? 0,
            specialties: { rifle: r[8], smg: r[9], sniper: r[10],
              objective: r[11], terrain: r[12] } })]));
        hud.statsRefresh(this);
        this._syncPersistentStats(); // client side; the host/solo path is in onDeath
        break;
      case 'end': {
        // Same finale justification as snapshots, minus their growth
        // signal (this event carries no score): a bare end at 0-0 with time
        // on the clock is forged. Custom-limit hosts still land through the
        // snapshot path, which does carry score growth.
        const endLimit = modeScoreLimit(this.gameMode, { publicRoom: this.publicRoom });
        if (this.captures.green >= endLimit || this.captures.blue >= endLimit
            || (this.matchRemaining <= 0 && !this.overtime)) this._end(d.winner, d.story);
        break;
      }
      case 'restart': {
        // Round restarts are host-driven, but a hostile host can spam them
        // (the round never progresses) or force retired content (a public
        // room shoved into CTF/Crown past the catalogue gate). Reject both
        // client-side; legitimate rotations are minutes apart.
        const restartCatalogueOk = ['ctf', 'tdm', 'koth'].includes(d.mode)
          && mapsForMode(d.mode, { publicOnly: this.publicRoom,
            privateContent: this.privateContent }).includes(d.map);
        const nowMs = Date.now();
        if (restartCatalogueOk && (this._lastRestartMs === undefined
            || nowMs - this._lastRestartMs >= 10000)) {
          this._lastRestartMs = nowMs;
          this.gameMode = d.mode;
          this.rebuild(d.seed, d.map);
          this.onRestart?.(MAPS[d.map].name);
        }
        break;
      }
    }
    if ((d.k === 'edit' || d.k === 'boom' || d.k === 'col') && d.wh !== undefined
        && (d.wh >>> 0) !== (this._worldHash >>> 0)) this._requestResync('world');
  }

  _clientDied(redeploy, recap = null) {
    const firstTransition = this.player.alive;
    if (!firstTransition) {
      if (Number.isFinite(redeploy)) this._respawnT = redeploy;
      if (this.engagementFeatures.deathRecap && recap) hud.deathRecap(recap);
      return;
    }
    this.engagement?.combat('death', 'other');
    this.player.alive = false;
    // A guest's own death never goes through Player.die() at all — the
    // host tells us we're dead over the wire and we land here instead.
    // This mirrors die()'s own resets directly (everything except
    // onDeath(), which is host-authoritative match-flow logic that
    // doesn't belong on this side). Discovered as a genuine, direct
    // consequence of the same gap: this was ALREADY missing the reward-
    // related resets (multi-kill chain, streak, in-progress airstrike
    // piloting/fall) before this fix, meaning none of them
    // ever cleared between a guest's lives — silently breaking the whole
    // reward system for anyone who wasn't hosting, on top of a few other
    // real if smaller bugs (a visible gun model surviving death, stale
    // crouch height/hitbox carrying into the next life).
    this.player.health = 0;
    this.player.deadT = 0;
    this.player.crouched = false;
    this.player.body.half.h = STAND_HEIGHT;
    resetEnvironmentalState(this.player);
    hud.air(BREATH_MAX, false);
    this.player.swing = 0;
    this.player._mkCount = 0; this.player._mkT = null;
    this.player._streak = 0;
    this.player._piloting = false;
    this.player._fallingT = 0;
    this.player._lingerT = 0;
    this.player.vmRoot.visible = false; // no floating gun while down
    this._respawnT = Number.isFinite(redeploy)
      ? redeploy : respawnWaveDelay(this.gameMode, this.matchElapsed);
    this.player.resetZoom(); // same reason as Player.die() — this is the guest's equivalent of it
    this.effects.burst(this.player.body.eye(), 26, teamHex(this.player.team), 6);
    sfx.hurt();
    hud.damage();
    hud.respawn(this._respawnT);
    hud.deathRecap(this.engagementFeatures.deathRecap ? recap : null);
    hud.classPick(this.player._pendingClass); // show the current pick before any key is pressed
  }

  // Menu-open clients skip update() entirely (the frame loop freezes their
  // world), but the watchdog must keep ticking or a host dropping mid-Esc
  // is never detected.
  clientIdleTick() {
    const silent = this.lastRecv ? performance.now() - this.lastRecv : 0;
    if (silent > HOST_SILENT_MS) { this.onHostSilent?.(); return; }
    // A soft early warning, at 60% of the hard threshold — well before the
    // migration trigger. This game has no client-side prediction for anyone
    // but yourself, so a silent host doesn't fully freeze the screen — you
    // can still walk and look around, everyone ELSE just stops moving,
    // which without any signal reads as "did this break?" rather than
    // "we're about to recover." Fires once per silence episode; cleared in
    // clientOnData the instant a snapshot resumes.
    if (silent > HOST_SILENT_MS * 0.6 && !this._unstableShown) {
      this._unstableShown = true;
      hud.message('CONNECTION UNSTABLE…', '#ffd97a');
    }
  }

  _clientUpdate(dt) {
    // Host-drop watchdog: a host whose tab is killed (or network unplugged)
    // never sends a close frame — WebRTC silence is the only signal, and ICE
    // can take ages to give up on its own. Snapshots beat at 15Hz; four
    // seconds of silence means the host is gone and the baton must pass.
    this.clientIdleTick();
    if (!this.over) {
      this.matchElapsed += dt;
      if (!this.overtime) this.matchRemaining = Math.max(0, this.matchRemaining - dt);
      hud.clock(this);
    }
    // Cosmetic redeploy countdown — the host's 'rs' event is the real one.
    if (!this.player.alive && this._respawnT > 0) {
      this._respawnT -= dt;
      if (this._respawnT > 0) hud.respawn(this._respawnT);
    }
    // Own footsteps + cosmetic protection countdown (the host's copy is the
    // one that actually gates damage); everyone else steps via Avatar.update.
    {
      const p = this.player, b = p.body;
      const moved = p._sx === undefined ? 0 : Math.hypot(b.pos.x - p._sx, b.pos.z - p._sz);
      p._sx = b.pos.x; p._sz = b.pos.z;
      if (p.protT > 0) {
        p.protT = Math.max(0, p.protT - dt * (moved > dt * 2 ? 2 : 1));
        hud.health(p);
      }
      if (p.alive && b.onGround) {
        p._stepAcc = (p._stepAcc ?? 0) + moved;
        if (p._stepAcc >= 2.2) {
          p._stepAcc = 0;
          const surface = this.world.get(Math.floor(b.pos.x), Math.floor(b.pos.y) - 1,
            Math.floor(b.pos.z));
          sfx.step(0.25, surface); this._footDust(b);
        }
      }
    }
    if (this.player.alive) {
      this.player.update(dt);
      // The host alone applies damage; the client advances the same pure
      // breath state only so its HUD responds immediately to local movement.
      this._updateBreathFor(this.player, dt, false);
    } else {
      hud.air(BREATH_MAX, false);
      this.player.deathCam(dt);
    }
    for (const av of this.avatars.values()) av.update(this.time, this.world, this.effects);
    this._sendT -= dt;
    // A connection object exists before its welcome lands. Until the host has
    // assigned myId/spawn/world, the local body still belongs to the menu map;
    // sending it would look like an impossible teleport into the new room.
    if (this._sendT <= 0 && this.net && this.myId) {
      this._sendT = 1 / 30; // 33ms input age — the uplink is tiny, spend it
      const p = this.player;
      const out = { t: 's', x: p.body.pos.x, y: p.body.pos.y, z: p.body.pos.z,
        yaw: Math.atan2(-Math.cos(p.yaw), Math.sin(p.yaw)), tool: p.tool,
        c: p.crouched ? 1 : 0, life: this._serverLife, ts: performance.now() };
      if (Number.isSafeInteger(this._snapshotEcho)) out.echo = this._snapshotEcho;
      // Piggybacked on this same, already-firing 30Hz message rather
      // than a new send loop: while a called-in airstrike is falling,
      // this also reports where it's CURRENTLY being steered to, so the
      // host can update the real, authoritative impact point and
      // publish it in the next authoritative snapshot. The drone flight line
      // shifts with this live target, so its pass remains useful warning intel
      // instead of pointing at the original click after steering begins.
      if (p._fallingT > 0) out.strike = { x: p._pilotPos.x, z: p._pilotPos.z };
      this.net.send(out);
    }
    if (this.flags) for (const team of ['green', 'blue']) this.flags[team].clientUpdate(this.time);
    for (let i = 0; i < this.grenadeMeshes.length; i++) {
      const g = this._lastGrenades?.[i], m = this.grenadeMeshes[i];
      m.visible = !!g;
      if (g) m.position.set(dx(g[0]), dy(g[1]), dx(g[2]));
    }
    this._updateAirstrikeDrones(dt);
    this._shakeCamera();
    this.effects.update(dt);
  }

  // Camera shake rides on top of whatever the player camera did.
  _shakeCamera() {
    if (this.effects.shake <= 0.001) return;
    const s = this.effects.shake * (this.player.motionScale ?? 1);
    this.camera.position.x += (Math.random() - .5) * s * 0.4;
    this.camera.position.y += (Math.random() - .5) * s * 0.4;
    this.camera.rotation.z = (Math.random() - .5) * s * 0.05;
  }

  // ---------------- main tick ----------------
  update(dt) {
    this.time += dt;
    this._beginEntityFrame();
    this.world.animateSky(this.time);
    this._updateUnderwaterFog();
    this._updateTeamPings(dt);
    const presentation = this.presentation.step(dt);
    if (presentation.fast) {
      hud.objective(this);
      hud.teamPing(this);
    }
    if (presentation.slow) {
      hud.minimap(this);
      hud.streakStatus(this.player);
      const firstMinuteView = this.firstMinuteGuide?.update({
        matchSecond: this.matchElapsed,
        x: this.player.body.pos.x,
        z: this.player.body.pos.z,
        alive: this.player.alive && !this.player.aiming && !this.player._piloting
          && this.player._fallingT <= 0,
        over: this.over,
      });
      this._firstMinuteView = firstMinuteView;
      hud.firstMinute(firstMinuteView);
    }
    if (presentation.network) hud.ping(this);
    // The scoreboard mirrors the held key exactly: if a Tab keyup gets lost
    // to a pointer-lock hiccup or a window switch, the overlay can never
    // strand itself over the screen. Runs while dead too (TAB works there).
    if (!this.player.controls.down('scoreboard')) hud.statsHide();
    // Positional audio hears from the player's ear, right vector included.
    {
      const p = this.player, e = p.body.eye(this._listenerEye ??= new THREE.Vector3());
      setListener({ x: e.x, y: e.y, z: e.z, rx: Math.sin(p.yaw), rz: Math.cos(p.yaw),
        occluded: this._audioOccluded });
    }
    this._updateContactFlow();
    this._updateGrenadeWarning();
    this._updateIntensityCues();
    if (this.mode === 'client') {
      this._clientUpdate(dt); this.world.flushDirty(); this._endEntityFrame(); return;
    }

    // Pending airstrikes: host/solo only, since only this side is
    // authoritative for when damage actually lands. Iterated backward so
    // splicing a finished one out mid-loop never skips the next entry.
    if (this._pendingStrikes) {
      for (let i = this._pendingStrikes.length - 1; i >= 0; i--) {
        const s = this._pendingStrikes[i];
        // The host/solo's OWN steering never crosses the wire at all —
        // there's no message for it to arrive on, unlike a guest's
        // (handled entirely in the 't:s' uplink case above). Synced
        // directly from the trusted local player here instead, no
        // validation needed since it was never untrusted input in the
        // first place. The ordinary 15Hz snapshot cadence handles observer
        // replication, while this trusted local copy can update each frame.
        if (s.attacker === this.player && this.player._fallingT > 0) {
          const np = this.player._pilotPos;
          s.pos.x = np.x; s.pos.z = np.z;
          s.pos.y = this.world.surface(Math.floor(s.pos.x), Math.floor(s.pos.z)) + 1;
        }
        // A bot may guide only while it lives. It steers toward a bounded
        // predicted pressure point; death stops guidance but never cancels
        // the confirmed missile.
        if (s.attacker?.id !== undefined && s.attacker.alive) {
          const foes = this.foesOf(s.attacker.team).filter(e => e.alive).map(e =>
            predictBotAirstrikePoint(e.body.pos, e.body.vel, 0.45, SX, SZ)).filter(Boolean);
          const allies = this.entities().filter(e => e.alive && e.team === s.attacker.team)
            .filter(e => e !== s.attacker).map(e => e.body.pos);
          const target = chooseBotAirstrikeTarget(foes, allies, []);
          const next = target && steerBotAirstrike(s.pos, target, AIRSTRIKE_STEER_SPEED * dt);
          if (next) {
            s.pos.x = next.x; s.pos.z = next.z;
            s.pos.y = this.world.surface(Math.floor(next.x), Math.floor(next.z)) + 1;
          }
        }
        s.t -= dt;
        if (s.t <= 0) {
          this._airstrikeImpact(s.pos, s.attacker, s.id);
          this._pendingStrikes.splice(i, 1);
        } else {
          this._syncAirstrikeDrone(s.id, s.pos.x, s.pos.y, s.pos.z,
            s.yaw, s.t, s.owner);
        }
      }
    }
    if (this.player.alive) this.player.update(dt);
    else this.player.deathCam(dt);
    this._updateBotTactics(dt);
    this._updateBotAirstrikes();
    for (const b of this.bots) b.update(dt);
    this._updateAirstrikeDrones(dt);
    this._updateEnvironmentalDamage(dt);
    this._combatHistoryT += Math.max(0, dt);
    if (!this._combatHistoryInitialized || combatHistoryDue(0, this._combatHistoryT)) {
      for (const e of this.entities()) if (e.alive) this._recordCombatPose(e);
      const wasInitialized = this._combatHistoryInitialized;
      this._combatHistoryInitialized = true;
      this._combatHistoryT = wasInitialized ? this._combatHistoryT % (1 / 30) : 0;
    }
    if (this.mode === 'host') this._expireReconnectReservations();

    // Fell out of the world: Body parked them above the sea and raised the
    // flag. Kill them properly so the flag drops and the redeploy timer runs.
    for (const e of this.entities()) {
      if (!e.body?.voidFall) continue;
      e.body.voidFall = false;
      if (e.alive) this.damage(e, 1000, null, null,
        { environmental: true, ignoreProtection: true, cause: 'void' });
    }

    // Footsteps + spawn-protection drain, from actual ground covered:
    // every 2.2 blocks of grounded travel sounds a step where they are, and
    // moving burns protection twice as fast as standing (firing ends it
    // outright — see fireHitscan/throwGrenade).
    for (const e of this.entities()) {
      if (!e?.alive || !e.body) continue;
      const b = e.body;
      if (e._sx === undefined) { e._sx = b.pos.x; e._sz = b.pos.z; e._stepAcc = 0; continue; }
      const moved = Math.hypot(b.pos.x - e._sx, b.pos.z - e._sz);
      e._sx = b.pos.x; e._sz = b.pos.z;
      if (e.protT > 0) {
        e.protT = Math.max(0, e.protT - dt * (moved > dt * 2 ? 2 : 1));
        if (e === this.player) hud.health(e); // live SAFE indicator
      }
      if (!b.onGround) continue;
      e._stepAcc += moved;
      if (e._stepAcc >= 2.2) {
        e._stepAcc = 0;
        const surface = this.world.get(Math.floor(b.pos.x), Math.floor(b.pos.y) - 1,
          Math.floor(b.pos.z));
        if (e === this.player) sfx.step(0.25, surface); // your own feet: centered, quieter
        else sfx.at('step', b.pos, 1, surface);         // everyone else: placed
        this._footDust(b);
      }
    }

    // Respawns.
    for (const [e, t] of this.respawnTimers) {
      const nt = t - dt;
      if (nt <= 0) {
        this.respawnTimers.delete(e);
        e.respawn();
        if (e === this.player) { hud.respawn(0); hud.health(this.player); hud.refreshTool(this.player); }
      } else {
        this.respawnTimers.set(e, nt);
        if (e === this.player) hud.respawn(nt);
      }
    }

    if (!this.over) {
      this._updateGrenades(dt);
      if (this.flags) this._updateFlags(dt);
      if (this.hill) this._updateHill(dt);
      this._updateMatchClock(dt);
    }
    this._scoreBroadcastT -= dt;
    if (this._scoreBroadcastT <= 0) {
      this._scoreBroadcastT = 0.5;
      this._broadcastScoreboard();
    }

    if (this.mode === 'host') {
      for (const p of this.remote.values()) {
        p.avatar.setAlive(p.alive);
        p.avatar.setCrouch?.(!!p.crouched);
        // Crouching guests get the same hitbox as everyone else: the proxy
        // body was staying full height, so a crouched guest was drawn short
        // but shot tall. Same lerp the bots use.
        p.body.half.h += ((p.crouched ? CROUCH_HEIGHT : STAND_HEIGHT) - p.body.half.h)
          * Math.min(1, dt * 10);
        // Grenade trickle, same terms as a local player: +1 per 12s, cap 3.
        if (p.nades < 3 && (p.nadeRegen += dt) > 12) { p.nadeRegen = 0; p.nades++; }
        p.avatar.update(this.time);
      }
      this._snapT -= dt;
      if (this._snapT <= 0) {
        this._snapT = 1 / 15;
        this._broadcastSnapshot();
      }
    }

    // Camera shake rides on top of whatever the player camera did.
    this._shakeCamera();
    this.effects.update(dt);
    // One remesh pass per frame: single-voxel set() calls queue their chunks
    // here instead of each synchronously rebuilding up to 5 of them.
    this.world.flushDirty();
    this._endEntityFrame();
  }
}

// Ray vs upright cylinder (torso) + sphere (head). Returns { t, head } or null.
function rayVsSoldier(origin, dir, body) {
  const cx = body.pos.x, cz = body.pos.z;
  const ox = origin.x - cx, oz = origin.z - cz;
  const a = dir.x * dir.x + dir.z * dir.z;
  const y0 = body.pos.y, y1 = body.pos.y + body.half.h;
  let t = null;

  if (a > 1e-6) {
    const bq = 2 * (ox * dir.x + oz * dir.z);
    const cq = ox * ox + oz * oz - 0.42 * 0.42;
    const disc = bq * bq - 4 * a * cq;
    if (disc >= 0) {
      const t0 = (-bq - Math.sqrt(disc)) / (2 * a);
      if (t0 > 0) {
        const y = origin.y + dir.y * t0;
        if (y >= y0 && y <= y1) t = t0;
      }
    }
  }
  // Head sphere.
  const hy = y1 - 0.18;
  const hx = origin.x - cx, hyy = origin.y - hy, hz = origin.z - cz;
  const bh = 2 * (hx * dir.x + hyy * dir.y + hz * dir.z);
  const ch = hx * hx + hyy * hyy + hz * hz - 0.34 * 0.34;
  const dh = bh * bh - 4 * ch;
  if (dh >= 0) {
    const t0 = (-bh - Math.sqrt(dh)) / 2;
    if (t0 > 0 && (t === null || t0 < t)) return { t: t0, head: true };
  }
  return t === null ? null : { t, head: false };
}
