// main.js — boot, renderer, sky, lobby flow (solo / host / join), main loop.
import * as THREE from 'three';
import { Game } from './game.js';
import { initAudio, isAudioMuted, setAudioMuted, setMasterVolume as applyMasterVolume, setBusVolume, setCaptionSink, sfx } from './audio.js';
import { captionFromMix } from './captions.js';
import { SX, SZ, skyGradient } from './world.js';
import { MAPS } from './mapgen.js';
import { Net, makeCode, primeIce, PUBLIC_PAGES, PUBLIC_SLOTS, resumeToken, slotCode } from './net.js';
import { stats, GUN_COLORS } from './stats.js';
import { BASE_FOV } from './player.js';
import { animateSoldier, setCrouch, setSoldierTool } from './entities.js';
import { getGfxLevel, setGfxLevel, getGfxMode, requestAutomaticGfx,
  automaticGfxNeeded, saveAutomaticGfxLevel, gfxPreset, getShowFps, setShowFps,
  getHudScale, setHudScale, getHudOpacity, setHudOpacity,
  getMotionScale, getMotionLevel, setMotionLevel,
  getColorMode, setColorMode, getMouseSensitivity, setMouseSensitivity,
  getMasterVolume, setMasterVolume, getEffectsVolume, setEffectsVolume, getAmbienceVolume, setAmbienceVolume, getUiVolume, setUiVolume,
  getCaptionMode, setCaptionMode, getCrouchMode, setCrouchMode, getAimMode, setAimMode, getObjectiveContrast, setObjectiveContrast, getDamageContrast, setDamageContrast, getMuted, setMuted } from './settings.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { RuntimeHealth, resourceDrift } from './runtime-health.js';
import { EngagementTracker, parseEngagementFeatures } from './engagement.js';
import { callsignIssue, normalizeCallsign } from './callsign.js';
import { topSpecialty } from './combat-flow.js';
import { BINDING_LABELS } from './controls.js';
import { AUTO_GFX_BENCHMARK_VERSION,
  FirstSessionGraphicsBenchmark } from './performance-auto.js';
import { ProductionTelemetry, errorFingerprint } from './telemetry.js';

const $ = id => document.getElementById(id);
// Legacy visual controls retain their look, but are reachable and activatable
// with a keyboard until their markup can be retired in a visual refresh.
for (const el of document.querySelectorAll('.opt, .plink, .play')) {
  if (el.matches('button,a,input,select,summary')) continue;
  el.tabIndex = 0; el.setAttribute('role', 'button');
  el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } });
}
const params = new URLSearchParams(location.search);
const engagementFeatures = parseEngagementFeatures(location.search);
if (engagementFeatures.publicChat)
  document.documentElement.dataset.publicChat = 'on';
const engagement = new EngagementTracker();
const fieldTelemetry = new ProductionTelemetry({ build: `p${PROTOCOL_VERSION}` });
const connectionReason = value => {
  const reason = String(value?.type ?? value ?? '').toLowerCase();
  if (reason.includes('timeout')) return 'timeout';
  if (reason.includes('unavailable') || reason.includes('not-found')) return 'unavailable';
  if (reason.includes('close')) return 'closed';
  if (reason.includes('version') || reason.includes('protocol')) return 'protocol';
  if (reason.includes('down')) return 'down';
  if (reason.includes('network') || reason.includes('webrtc') || reason.includes('ice')) return 'network';
  return 'other';
};
const reportConnectionFailure = (stage, value) => {
  if (fieldTelemetry.record('connection_failure', {
    stage, reason: connectionReason(value), relay: 'unknown',
  })) fieldTelemetry.flush();
};
engagement.record('page_ready', { protocol: PROTOCOL_VERSION });
const diagnostics = window.__spadefallDiagnostics = {
  protocol: PROTOCOL_VERSION, startedAt: new Date().toISOString(), faults: [],
  metrics: null, soakCycles: 0, features: engagementFeatures,
  engagement: engagement.snapshot(), iceServers: 0,
};

// Warm the relay credentials while the player is still reading the menu, so
// the first connection does not wait on a round trip. Failure is silent by
// design: without a relay the game still connects for everyone whose network
// allows a direct route, which is most of them.
primeIce().then(list => { diagnostics.iceServers = list.length; });
const rememberFault = (kind, value) => {
  diagnostics.faults.push({ kind, at: new Date().toISOString(),
    message: String(value?.message ?? value ?? 'unknown').slice(0, 500) });
  if (diagnostics.faults.length > 20) diagnostics.faults.shift();
  fieldTelemetry.record('crash', { kind: kind === 'rejection' ? 'rejection' : 'error',
    fingerprint: errorFingerprint(value) }, { always: true });
  fieldTelemetry.flush();
};
window.addEventListener('error', e => rememberFault('error', e.error ?? e.message));
window.addEventListener('unhandledrejection', e => rememberFault('rejection', e.reason));
const airstrikeQa = params.has('airstrikeqa');
const soldierQa = params.has('soldierqa');
const mapQa = params.has('mapqa');
const reportQa = params.has('reportqa');
const pingQa = params.has('pingqa');
const deathRecapQa = params.has('deathrecapqa');
const audioQa = params.has('audioqa');

const renderer = new THREE.WebGLRenderer({ antialias: gfxPreset().antialias });
renderer.setPixelRatio(Math.min(devicePixelRatio, gfxPreset().pixelRatio));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = skyGradient();
scene.fog = new THREE.Fog(0xcfe4f7, 70, 230);

const camera = new THREE.PerspectiveCamera(BASE_FOV, innerWidth / innerHeight, 0.1, 500);
scene.add(camera); // so the viewmodel renders

// Boots as a solo game — it doubles as the menu's orbiting backdrop.
const game = new Game(scene, camera, renderer.domElement, { engagement, engagementFeatures });
window.__game = game; // debugging/testing handle
window.__renderer = renderer;
game.onRoundEnd = () => {
  if (document.pointerLockElement === renderer.domElement) document.exitPointerLock?.();
};
game.player.vmRoot.visible = false; // hidden until first deploy
let lastCaption = null;
setCaptionSink((name, mix) => {
  const caption = captionFromMix(name, mix, getCaptionMode(), performance.now(), lastCaption);
  if (!caption) return;
  lastCaption = caption;
  const el = $('soundCaption');
  if (!el) return;
  el.textContent = caption.text;
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
});
if (audioQa) {
  const play = name => { initAudio(); sfx[name]?.(); };
  const sequence = (names, gap = 550) => names.forEach((name, i) =>
    setTimeout(() => play(name), i * gap));
  window.__audioQa = {
    sounds: Object.keys(sfx).filter(k => k !== 'at'), play, sequence,
    comparisons: {
      weapons: () => sequence(['rifle', 'smg', 'sniper'], 850),
      feedback: () => sequence(['hit', 'headshot', 'kill'], 650),
      reload: (kind = 'rifle') => {
        initAudio();
        const duration = { rifle: 2.2, smg: 1.8, sniper: 3 }[kind] ?? 2.2;
        [['reloadStart', 0], ['reloadEject', .24], ['reloadInsert', .62],
          ['reloadChamber', .86]].forEach(([name, fraction]) =>
          setTimeout(() => sfx[name](kind), duration * fraction * 1000));
      },
      airstrike: () => sequence(['drone', 'missileLaunch', 'missile', 'airstrikeImpact'], 900),
    },
  };
}
applyMasterVolume(getMasterVolume());
setBusVolume('effects', getEffectsVolume()); setBusVolume('ambience', getAmbienceVolume()); setBusVolume('ui', getUiVolume());
setAudioMuted(getMuted());
if (engagementFeatures.publicChat) $('chatkey').textContent = 'T room chat · Y team · TAB scores';
// Browser screenshot hook: force the sniper loadout and hold ADS without
// relying on pointer lock, which automated browsers cannot grant reliably.
if (params.has('scopeqa')) {
  document.documentElement.dataset.scopeqa = 'on';
  game.player.gunClass = 5;
  game.player._pendingClass = 5;
  game.player.tool = 5;
  game.player.mouseDown[2] = true;
  game.player._scopeQa = true;
  game.player._syncViewmodel();
  setInterval(() => {
    game.player._scopeQa = true;
    game.player.aiming = true;
    game.player.aimK = 1;
  }, 50);
}
// Static component preview for the directional damage marker. Normal play
// never sets this data attribute; it exists only for visual regression QA.
if (params.has('damageqa')) document.documentElement.dataset.damageqa = 'on';
// Browser-only composition hook for inspecting the flyover without needing
// pointer lock or a ten-kill setup. It uses the real model, pose helper, and
// render updater; only the fixed camera and frozen countdown are test aids.
if (airstrikeQa || soldierQa || mapQa || reportQa || pingQa)
  $('menu').style.display = 'none';

// A soft sun sprite high in the sky — one textured quad, always faces the
// camera, excluded from fog so it keeps its glow at any distance.
function makeSun() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(64, 64, 6, 64, 64, 62);
  rg.addColorStop(0, 'rgba(255,252,235,1)');
  rg.addColorStop(0.25, 'rgba(255,244,200,.9)');
  rg.addColorStop(1, 'rgba(255,244,200,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, 128, 128);
  const mat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), fog: false, depthWrite: false });
  const s = new THREE.Sprite(mat);
  s.position.set(180, 210, 60);
  s.scale.setScalar(56);
  return s;
}
scene.add(makeSun());

// Soft vertical sky gradient — moved to world.js (and generalized to take
// color-stop parameters) so per-map atmosphere can share the same
// implementation instead of duplicating it. Called here with no
// arguments, matching its defaults exactly — this stays the pre-game
// fallback background, immediately overwritten by the real map's
// atmosphere the moment the Game constructor runs below.

// ---------------- lobby ----------------
let playing = false;
let net = null;
let roomCode = null;
window.addEventListener('pagehide', e => {
  if (e.persisted) return;
  if (!game.over && (playing || game.mode === 'host' || game.mode === 'client')) {
    fieldTelemetry.record('match_abandon', { reason: netDead ? 'network' : 'pagehide',
      seconds: game.matchElapsed ?? 0 });
    fieldTelemetry.flush();
  }
  engagement.abandon('pagehide');
  net?.destroy();
});
const CALLSIGNS = ['Ace', 'Deuce', 'Trey', 'Joker', 'King', 'Queen', 'Jack', 'Ten'];

function rawName() {
  return normalizeCallsign($('nameInput').value);
}
function callsign() {
  return rawName() || CALLSIGNS[Math.floor(Math.random() * CALLSIGNS.length)] + Math.floor(Math.random() * 90 + 10);
}
function ensureCallsign() {
  const issue = callsignIssue($('nameInput').value);
  if (issue === 'profanity') {
    status('choose a different callsign');
    $('nameInput').classList.add('need');
    $('nameInput').focus();
    return false;
  }
  if (issue === 'empty') $('nameInput').value = callsign();
  $('nameInput').value = rawName();
  try { localStorage.setItem('tos.name', $('nameInput').value); } catch { /* best effort */ }
  return true;
}
try { $('nameInput').value = normalizeCallsign(localStorage.getItem('tos.name')); }
catch { /* best effort */ }
$('nameInput').addEventListener('input', () => {
  $('nameInput').classList.remove('need');
});
function status(html) { $('lobbyStatus').innerHTML = html; }

function inviteUrl() {
  if (!roomCode) return null;
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('code', roomCode);
  url.searchParams.set('invite', '1');
  return url.href;
}
function showInvite() { $('inviteRow').style.display = roomCode ? 'block' : 'none'; }
async function writeClipboard(value) {
  let copied = false;
  try {
    copied = await Promise.race([
      navigator.clipboard.writeText(value).then(() => true, () => false),
      new Promise(resolve => setTimeout(() => resolve(false), 400)),
    ]);
  } catch { /* fallback below */ }
  if (!copied) {
    const input = document.createElement('textarea');
    input.value = value;
    input.style.position = 'fixed'; input.style.opacity = '0';
    document.body.appendChild(input); input.select();
    try { copied = document.execCommand('copy'); } catch { /* best effort */ }
    input.remove();
  }
  return copied;
}
async function copyInvite() {
  const url = inviteUrl();
  if (!url) return;
  const copied = await writeClipboard(url);
  status(copied ? `invite copied — <b>${roomCode}</b>`
    : `copy unavailable — share room code <b>${roomCode}</b>`);
}
$('inviteBtn').addEventListener('click', copyInvite);
game.onShareResult = async text => {
  const copied = await writeClipboard(text);
  const button = $('shareResultBtn');
  if (!button) return;
  button.textContent = copied ? 'RESULT COPIED' : 'COPY UNAVAILABLE';
  setTimeout(() => { button.textContent = 'COPY RESULT'; }, 1800);
};

// The big DEPLOY/RESUME button only exists once there's a session to enter.
function showPlay(label) {
  $('playBtn').style.display = 'block';
  $('playBtn').textContent = label;
}

let sessionLive = false; // a match was entered: pause shows the slim screen
let engagementSource = 'solo';
function setPlaying(v) {
  playing = v;
  if (v) {
    sessionLive = true;
    // A client can obtain pointer lock while its welcome is still in flight.
    // Wait for a roster identity before counting that as a playable match.
    if (game.mode !== 'client' || game.myId) {
      const started = engagement.beginMatch(game.engagementContext(engagementSource));
      if (started) game.beginFirstMinute();
    }
  } else if (engagement.pauseMatch('menu')) engagementSource = 'resume';
  // Dropping in with the callsign box still focused (a click on a
  // non-focusable lobby link doesn't blur it in every browser) leaves the
  // hidden input eating every WASD press — a frozen soldier with a working
  // mouse. Entering play always drops stray focus.
  if (v) document.activeElement?.blur?.();
  $('menu').classList.toggle('hidden', v);
  // In-session menu (Esc pause / rotation break / a lost pointer lock) is a
  // different screen from the home lobby: no callsign, no map selector, no
  // QUICK MATCH — just resume or leave. Applies solo too: an OS-level unlock
  // mid-fight should never dump the lobby chrome on the player.
  $('menu').classList.toggle('paused', !v && (sessionLive || !!net));
  $('hud').classList.toggle('on', v);
  game.player.vmRoot.visible = v;
  $('roomcode').style.display = !v && (sessionLive || !!net) && roomCode ? 'block' : 'none';
}

$('leaveBtn').addEventListener('click', () => location.reload());

function deploy() {
  initAudio();
  renderer.domElement.requestPointerLock();
}

// --- solo / resume ---
// After a dead connection the button becomes a way back to a clean menu.
let netDead = false;
let matchmaking = false;   // quick-match scan in flight — lobby buttons hold
let connecting = false;    // private host/join waiting for relay credentials
let searchCanceled = false; // Esc pressed mid-search: discard the result
let suppressResume = false; // unlock came from a failed search, not the player
$('playBtn').addEventListener('click', () => {
  if (netDead) return location.reload();
  if (matchmaking) return;
  if (game.mode === 'client' && !game.myId) return; // still connecting
  stopRotationCountdown(); // clicking through is just skipping the wait
  engagement.record('lobby_action', { action: 'deploy' });
  deploy();
});

// --- room wiring, shared by HOST / JOIN / QUICK MATCH ---
// Handlers live on the Net instance, so these adopt functions can attach (or
// re-attach) the full game wiring to a connection at any moment — including
// one that quick match already used for its handshake.

// Adopt a claimed host peer: UI text, lobby hooks, game handlers.
// opts.alreadyOpen: the claim succeeded before adoption — fire onOpen now.
function adoptHost(n, code, opts = {}) {
  net = n;
  window.__net = n;
  roomCode = code;
  showInvite();
  game.net = n;
  n.handlers = {
    onOpen: () => {
      if (opts.public) {
        const num = +code.slice(3) + 1;
        status(`hosting <b>PUBLIC ROOM ${num}</b> — quick-match players will drop in`);
        $('roomcode').querySelector('b').textContent = 'PUBLIC ' + num;
      } else {
        status(`room code <b>${code}</b> — share it`);
        $('roomcode').querySelector('b').textContent = code;
      }
      showPlay('DEPLOY — START MATCH');
      if (playing) setPlaying(true); // quick match dropped in already: resync HUD
      if (params.get('auto')) setPlaying(true);
      opts.onOpen?.();
    },
    onError: e => {
      if (e.type === 'unavailable-id' && (opts.public || !params.get('code'))) {
        n.destroy();
        if (net === n) net = null;
        opts.onTaken?.(); // roll again with a fresh peer
      } else {
        reportConnectionFailure('signaling', e);
        status(`network error: ${e.type}`);
      }
    },
    onData: (id, d) => game.hostOnData(id, d),
    onLeave: id => game.hostOnLeave(id),
  };
  game.onAbandoned = abandonedNotice;
  n.flushPending?.(); // anything that knocked while the slot had no handlers
  if (opts.alreadyOpen) n.handlers.onOpen();
}

// ---------------- host migration ----------------
// The host's browser IS the simulation, so a host dropping used to end the
// match for everyone. Instead every client keeps a migration-ready replica
// (world edit log + the last full snapshot), and when the connection dies
// the survivors converge on a deterministic fallback room — <code>-M1, then
// -M2 if the baton fumbles again. The lowest-ranked survivor claims it and
// promotes its replica to host; the rest knock until it answers. From the
// players' seats the world freezes for a few seconds, then just continues.
let migrationGen = 0; // which baton pass this room is on

// Every client dropping at once is the signature of the room having moved on
// without us (our tab stalled, our uplink died, the survivors migrated). We
// can't prove it from this side, so tell the player and let them decide.
function abandonedNotice() {
  game.hud.message('EVERYONE DISCONNECTED AT ONCE', '#ffd97a');
  status('every player dropped at once — if your connection stalled, they may have '
    + 'moved to a new room. Leave and quick-match again to find them.');
}

function failMigration(guest) {
  guest?.destroy();
  engagement.abandon('network');
  fieldTelemetry.record('migration', { outcome: 'failure', reason: 'timeout' }, { always: true });
  fieldTelemetry.flush();
  netDead = true;
  $('end').classList.add('hidden'); // a dead room ends the rotation wait too
  status('connection lost — the host left, and nobody could pick up the baton');
  showPlay('RETURN TO MENU');
  if (playing) { setPlaying(false); document.exitPointerLock?.(); }
}

function rejectClientSession(n, message) {
  if (net !== n) return;
  engagement.abandon('network');
  n.handlers.onClose = null;
  game.onHostSilent = null;
  game.onVersion = null;
  game.onKicked = null;
  net = null; game.net = null; game.mode = 'solo';
  n.destroy();
  status(message);
  bailToMenu();
}

function adoptMigratedHost(n, code, gen) {
  net = n;
  window.__net = n;
  roomCode = code;
  showInvite();
  game.net = n;
  game.migGen = gen; // which baton pass we adopted (0 = original room)
  n.handlers = {
    onData: (id, d) => game.hostOnData(id, d),
    onLeave: id => game.hostOnLeave(id),
    onError: e => {
      reportConnectionFailure('reconnect', e);
      status(`network error: ${e.type}`);
    },
  };
  game.onAbandoned = abandonedNotice;
  console.debug(`[mig] promoted to host of ${code}`);
  game.promoteToHost(n);
  if (fieldTelemetry.record('migration', { outcome: 'success', reason: 'other' }))
    fieldTelemetry.flush();
  // Survivors who knocked between the claim and this moment were buffered,
  // not dropped — hand them to the now-live handlers.
  n.flushPending?.();
  $('roomcode').querySelector('b').textContent = code;
  game.hud.message('BATON PASSED — YOU ARE HOSTING THE MATCH', '#ffd97a');
  status('the host dropped — <b>you are hosting now</b>');
}

function adoptMigratedClient(peer, conn, code, welcome, gen) {
  const n = Net.adoptGuest(peer, conn);
  net = n;
  window.__net = n;
  roomCode = code;
  showInvite();
  game.net = n;
  game.migGen = gen;
  n.handlers.onData = d => game.clientOnData(d);
  n.handlers.onClose = () => startMigration(n); // the baton can pass again
  n.handlers.onError = () => {};
  game.onHostSilent = () => startMigration(n);
  game.onVersion = v => rejectClientSession(n,
    `game version mismatch — refresh this page (room protocol ${v}, yours ${PROTOCOL_VERSION})`);
  game.onKicked = reason => rejectClientSession(n, reason === 'vote'
    ? 'players in that room voted to remove you'
    : reason === 'resumed' ? 'this soldier was resumed in another tab'
    : 'connection closed after sustained invalid gameplay input');
  console.debug(`[mig] rejoined migrated room ${code} as client`);
  game.clientOnData(welcome); // migrated welcome: world and kit kept as-is
  if (fieldTelemetry.record('migration', { outcome: 'success', reason: 'other' }))
    fieldTelemetry.flush();
  $('roomcode').querySelector('b').textContent = code;
  game.hud.message('BATON PASSED — THE MATCH CONTINUES', '#ffd97a');
  status('host dropped — a teammate picked it up');
}

async function migrateRoom(deadNet) {
  const gen = ++migrationGen;
  const migCode = `${roomCode}-M${gen}`;
  const myOldId = game.myId;
  const all = [...(game._rosterP?.values() ?? [])].map(m => m.pid)
    .filter(id => id !== 'HOST').sort();
  const rank = Math.max(0, all.indexOf(myOldId)); // lowest survivor claims first
  game.hud.message('HOST DROPPED — PASSING THE BATON…', '#ffd97a');
  const guest = deadNet.peer; // still open: our identity for the knock
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const t0 = performance.now();
  // Wall-clock deadline: without it a flaky broker (claim/knock cycling
  // 'taken' forever) strands the tab on "passing the baton" indefinitely.
  const deadline = t0 + 60000 + rank * 3000;
  while (net === deadNet) { // a newer session would supersede this loop
    if (performance.now() > deadline) return failMigration(guest);
    if (performance.now() - t0 >= rank * 3000) {
      console.debug(`[mig] gen${gen} rank${rank} claiming ${migCode}`);
      // Generous timeouts: a busy tab (throttled, backgrounded, or just
      // loaded) can take many seconds to finish the broker + ICE handshake.
      const c = await Net._claim(migCode, 15000);
      console.debug(`[mig] claim -> ${c.kind}`);
      if (net !== deadNet) { c.net?.destroy(); return; }
      if (c.kind === 'host') { guest.destroy(); return adoptMigratedHost(c.net, migCode, gen); }
      // 'down' is the broker not answering in time — the same flakiness that
      // may have taken the host out in the first place, so it is exactly when
      // giving up is wrong. Fall through, knock, and let the deadline above
      // be the only thing that calls it. 'taken' means someone beat us to the
      // baton: also fall through and knock.
    }
    // undefined team: the host already knows this connection's team from
    // the roster entry it kept across the migration (see the migIdx branch
    // in hostOnData) and never even looks at d.team for a rejoin — this
    // just keeps the positional args lined up with _knock's real signature.
    const k = await Net._knock(guest, migCode, game.player.name, undefined, 15000);
    console.debug(`[mig] gen${gen} knock ${migCode} -> ${k.kind}`);
    if (net !== deadNet) { k.conn?.close(); return; }
    if (k.kind === 'join') return adoptMigratedClient(guest, k.conn, migCode, k.welcome, gen);
    if (k.kind === 'version') return rejectClientSession(deadNet,
      'game version mismatch after host migration — refresh this page');
    await sleep(700); // 'dead' (nobody hosting yet) and 'down' (broker hiccup)
                      // both just mean: try again until the deadline.
  }
}

function startMigration(n) {
  // The silence watchdog fires every frame once the host goes quiet — only
  // the first call may start the loop.
  if (net !== n || n._migrating) return;
  n._migrating = true;
  // Neuter the old session's handlers NOW: its peer-level error listener
  // ("room not found — check the code") is still attached, and every probe
  // of the not-yet-claimed migration room legitimately errors
  // 'peer-unavailable' while we wait for the new host to register. That
  // stale handler would reset the lobby mid-migration and kill the loop.
  n.handlers = {};
  if (game.mode !== 'client' || !game.myId || !game._rosterP)
    return failMigration(n.peer); // died before the first roster — nothing to save
  migrateRoom(n).catch(() => failMigration(n.peer));
}

// Adopt a welcomed guest connection: HUD code, game handlers, welcome/full
// callbacks. The caller that opened the channel decides whether 'hi' still
// needs sending (quick match already sent it during the knock).
function adoptJoin(n, code) {
  net = n;
  window.__net = n;
  roomCode = code;
  showInvite();
  game.net = n;
  const pub = /^PUB(\d+)$/.exec(code); // public slots show as "PUBLIC n"
  $('roomcode').querySelector('b').textContent = pub ? `PUBLIC ${+pub[1] + 1}` : code;
  n.handlers.onData = d => game.clientOnData(d);
  n.handlers.onClose = () => startMigration(n);
  game.onHostSilent = () => startMigration(n);
  game.onVersion = v => rejectClientSession(n,
    `game version mismatch — refresh this page (room protocol ${v}, yours ${PROTOCOL_VERSION})`);
  game.onKicked = reason => rejectClientSession(n, reason === 'vote'
    ? 'players in that room voted to remove you'
    : reason === 'resumed' ? 'this soldier was resumed in another tab'
    : 'connection closed after sustained invalid gameplay input');
  n.handlers.onError = e => {
    reportConnectionFailure('welcome', e);
    // Join failed before the match started — reset so the lobby still works.
    if (net === n) { net = null; game.net = null; game.mode = 'solo'; }
    n.destroy();
    status(e.type === 'peer-unavailable' ? 'room not found — check the code' : `network error: ${e.type}`);
    if (playing) bailToMenu(); // we were warming up in-world for a quick match
  };
  game.onFull = () => {
    if (net === n) { net = null; game.net = null; game.mode = 'solo'; }
    n.handlers.onClose = null; // a polite refusal, not a dropped connection
    n.destroy();
    status('that room is full — 10 players max');
    if (playing) bailToMenu();
  };
  game.onWelcome = () => {
    status(`connected — you are <b>${game.player.team.toUpperCase()}</b>`);
    showPlay('DEPLOY');
    if (playing) setPlaying(true); // quick match dropped in already: resync HUD
    if (params.get('auto')) setPlaying(true);
  };
}

// --- host preferences: mode-first, with maps always rotating ---
// Applied whenever this player hosts — a private HOST or a quick-match slot
// claim — never on migration promotion, so a replica keeps the room's
// running map and mode. gameMode must be set BEFORE rebuild(), since flags
// only exist in CTF. ?map=2&mode=tdm remain QA hooks for the starting map.
const modePref = $('modePref');
{
  const allowedModes = ['any', 'ctf', 'tdm', 'koth'];
  let savedMode = 'any';
  try { savedMode = localStorage.getItem('tos.mode') ?? savedMode; } catch { /* best effort */ }
  modePref.value = allowedModes.includes(savedMode) ? savedMode : 'any';
  if (allowedModes.includes(params.get('mode'))) modePref.value = params.get('mode');
  modePref.addEventListener('change', () => {
    try { localStorage.setItem('tos.mode', modePref.value); } catch { /* best effort */ }
  });
}

// Lifetime stats + gun color unlocks (see stats.js). Purely a home-screen
// display — the color itself gets read once at Player construction and
// updated live from here, so a swatch click works the same whether it's
// the first thing you do or the fiftieth.
{
  const statsLine = $('statsLine'), masteryLine = $('masteryLine'), gunColors = $('gunColors');
  function renderStats() {
    const s = stats.get();
    const kd = (s.kills / Math.max(1, s.deaths)).toFixed(2);
    statsLine.textContent =
      `${s.kills} K · ${s.deaths} D · ${kd} K/D · ${s.matches} MATCHES · ${s.wins} WINS`;
    const mastery = stats.mastery();
    masteryLine.textContent = mastery.next
      ? `${mastery.tier.name} MASTERY · ${mastery.points} / ${mastery.next.points} · `
        + `${mastery.remaining} TO ${mastery.next.name}`
      : `${mastery.tier.name} MASTERY · ${mastery.points} · MAXIMUM RANK`;
    const specialty = topSpecialty(s.specialties).toUpperCase();
    const specialtyPoints = s.specialties?.[specialty.toLowerCase()] ?? 0;
    if (specialtyPoints > 0) masteryLine.textContent += ` · ${specialty} SPECIALTY ${specialtyPoints}`;
    gunColors.innerHTML = '';
    const unlockedHex = new Set(stats.unlocked().map(c => c.hex));
    const equipped = stats.gunColor();
    for (const c of GUN_COLORS) {
      const locked = !unlockedHex.has(c.hex);
      const sw = document.createElement('div');
      sw.className = 'swatch' + (locked ? ' locked' : '') + (c.hex === equipped ? ' equipped' : '');
      sw.style.background = '#' + c.hex.toString(16).padStart(6, '0');
      sw.title = locked ? `${c.name} — ${c.kills} kills` : c.name;
      if (locked) {
        const need = document.createElement('div');
        need.className = 'need';
        need.textContent = c.kills;
        sw.appendChild(need);
      } else {
        sw.addEventListener('click', () => {
          if (!stats.setGunColor(c.hex)) return; // re-checked here regardless of what the UI shows
          game.player.setGunColor(c.hex);
          renderStats();
        });
      }
      gunColors.appendChild(sw);
    }
  }
  game.onStatsChanged = renderStats;
  renderStats();
}

// Starting class — the same choice the death-screen picker offers, just
// reachable before your first life too, instead of only after you've
// already died once. Applies directly to the already-constructed Player
// (game/player exist from page load, before any menu click is possible),
// the same way a respawn would, since there's no first-deploy path that
// goes through Player#respawn to pick it up on its own.
{
  const opts = document.querySelectorAll('#startClassOpts .opt');
  function renderStartClass() {
    for (const el of opts) el.classList.toggle('picked', Number(el.dataset.cls) === game.player._pendingClass);
  }
  for (const el of opts) {
    el.addEventListener('click', () => {
      const idx = Number(el.dataset.cls);
      if (!game.player.selectClass(idx, { applyNow: true })) return;
      renderStartClass();
      // If automatic rotation lost pointer lock, choosing the next class is
      // also the fresh browser gesture needed to resume. No second DEPLOY
      // click should be required.
      if ($('menu').classList.contains('rotating')
          && document.pointerLockElement !== renderer.domElement) deployAuto();
    });
  }
  renderStartClass();
}

// Results class choice: the click itself is also the user gesture that can
// re-arm pointer lock after Escape. The result screen stays up until the
// actual rotation callback hides it.
for (const el of document.querySelectorAll('#endClassOpts .opt')) {
  el.addEventListener('click', () => {
    if (!game.player.selectClass(Number(el.dataset.cls))) return;
    if (document.pointerLockElement !== renderer.domElement) {
      initAudio();
      let lock;
      try { lock = renderer.domElement.requestPointerLock(); }
      catch { status('mouse capture was blocked — click a class to retry'); return; }
      Promise.resolve(lock).catch(() =>
        status('mouse capture was blocked — click a class to retry'));
    }
  });
}


// Team preference — the player's own side, chosen before deploying.
// Host/solo: applied directly to game.player.team, a live-recoloring
// setter (same mechanism _rotate() already uses for map-to-map team
// swaps), so the block color etc. update immediately. A guest can't
// assign itself a team though — the host owns that decision and answers
// with one in its welcome message (see Game#_hostAddPlayer) — so for a
// guest this only sets what preference rides along in the join handshake;
// teamPref() below is what every join call site actually reads. 'auto'
// (or never touching this at all) means what it always meant: the host's
// own count-balance pick, completely unchanged.
{
  const opts = document.querySelectorAll('#startTeamOpts .opt');
  function renderStartTeam() {
    let pref;
    try { pref = localStorage.getItem('tos.team'); } catch { pref = null; }
    for (const el of opts) el.classList.toggle('picked', el.dataset.team === (pref ?? 'auto'));
  }
  for (const el of opts) {
    el.addEventListener('click', () => {
      const val = el.dataset.team;
      try {
        if (val === 'auto') localStorage.removeItem('tos.team');
        else localStorage.setItem('tos.team', val);
      } catch { /* best effort */ }
      // Live preview for host/solo; a guest's choice here is only ever a
      // preview too, since the host's welcome message is what actually
      // decides and will correct this the moment a join resolves.
      if (val === 'green' || val === 'blue') game.player.team = val;
      renderStartTeam();
    });
  }
  renderStartTeam();
}

// Graphics preset picker: Low/Medium/High. Pixel ratio, particle capacity,
// ambience, and foam apply live —
// setPixelRatio can change on an already-running renderer. Antialiasing
// cannot: it's fixed at WebGL context creation, so a change here only
// takes effect next launch — gfxReloadNote says so explicitly rather
// than silently doing nothing visible until a reload happens to occur.
// Antialiasing remains the sole reload-only option because WebGL fixes it
// when the rendering context is created.
{
  const opts = document.querySelectorAll('#gfxOpts .opt');
  const note = $('gfxReloadNote');
  const startAA = gfxPreset().antialias; // what the renderer was actually built with, to detect a genuine pending AA change
  function renderGfx() {
    const level = getGfxLevel();
    const automatic = getGfxMode() === 'auto';
    const selected = automatic ? 'auto' : level;
    for (const el of opts) el.classList.toggle('picked', el.dataset.gfx === selected);
    const auto = [...opts].find(el => el.dataset.gfx === 'auto');
    if (auto) auto.textContent = automatic
      && !automaticGfxNeeded(AUTO_GFX_BENCHMARK_VERSION)
      ? `AUTO · ${level.toUpperCase()}` : 'AUTO';
    if (note) note.classList.toggle('show', gfxPreset(level).antialias !== startAA);
  }
  for (const el of opts) {
    el.addEventListener('click', () => {
      const level = el.dataset.gfx;
      if (level === 'auto') {
        requestAutomaticGfx();
        autoGfxBenchmark = new FirstSessionGraphicsBenchmark();
      } else {
        setGfxLevel(level);
        renderer.setPixelRatio(Math.min(devicePixelRatio, gfxPreset(level).pixelRatio));
        game.applyGraphics(level);
        autoGfxBenchmark = null;
      }
      renderGfx();
    });
  }
  renderGfx();
}

// FPS counter toggle — off by default, so it never appears unasked for.
// The frame loop below only touches #fps's text when it's visible; this
// handler owns visibility itself, for instant feedback on click.
{
  const opts = document.querySelectorAll('#fpsOpts .opt');
  function renderFpsOpt() {
    const on = getShowFps();
    for (const el of opts) el.classList.toggle('picked', el.dataset.fps === (on ? 'on' : 'off'));
    const el = $('fps');
    if (el) el.style.display = on ? 'block' : 'none';
  }
  for (const el of opts) {
    el.addEventListener('click', () => {
      setShowFps(el.dataset.fps === 'on');
      renderFpsOpt();
    });
  }
  renderFpsOpt();
}

// Accessibility/display choices apply live and remain cosmetic: they never
// alter fog, draw distance, objective geometry, or multiplayer information.
function choiceRow(id, read, write, apply = () => {}) {
  const opts = document.querySelectorAll(`#${id} .opt`);
  const render = () => {
    const value = String(read());
    for (const el of opts) el.classList.toggle('picked', el.dataset.value === value);
    apply(value);
  };
  for (const el of opts) el.addEventListener('click', () => {
    write(el.dataset.value); render();
  });
  render();
}

choiceRow('hudScaleOpts', () => Math.round(getHudScale() * 100), setHudScale, value => {
  $('hud').style.setProperty('--hud-scale', String(Number(value) / 100));
});
choiceRow('hudOpacityOpts', () => Math.round(getHudOpacity() * 100), setHudOpacity, value => {
  $('hud').style.setProperty('--hud-alpha', String(Number(value) / 100));
});
choiceRow('motionOpts', getMotionLevel, setMotionLevel, value => {
  game.player.motionScale = getMotionScale();
  document.body.classList.toggle('reduced-motion', value === 'reduced');
});
choiceRow('colorOpts', getColorMode, setColorMode, value => {
  document.body.dataset.colors = value;
  game.applyColorMode();
});
choiceRow('mouseSensitivityOpts', () => Math.round(getMouseSensitivity() * 100),
  setMouseSensitivity, () => { game.player.mouseSensitivity = getMouseSensitivity(); });
choiceRow('masterVolumeOpts', () => Math.round(getMasterVolume() * 100),
  setMasterVolume, () => { applyMasterVolume(getMasterVolume()); });
choiceRow('effectsVolumeOpts', () => Math.round(getEffectsVolume() * 100), setEffectsVolume, () => setBusVolume('effects', getEffectsVolume()));
choiceRow('ambienceVolumeOpts', () => Math.round(getAmbienceVolume() * 100), setAmbienceVolume, () => setBusVolume('ambience', getAmbienceVolume()));
choiceRow('uiVolumeOpts', () => Math.round(getUiVolume() * 100), setUiVolume, () => setBusVolume('ui', getUiVolume()));
choiceRow('captionOpts', getCaptionMode, setCaptionMode);
choiceRow('crouchModeOpts', getCrouchMode, setCrouchMode, () => { game.player._crouchToggled = false; });
choiceRow('aimModeOpts', getAimMode, setAimMode, () => { game.player._aimToggled = false; });
choiceRow('objectiveContrastOpts', getObjectiveContrast, setObjectiveContrast, value => { document.body.dataset.objectiveContrast = value; });
choiceRow('damageContrastOpts', getDamageContrast, setDamageContrast, value => { document.body.dataset.damageContrast = value; });

// Rebinding is intentionally a short capture state, never a modal: Escape
// cancels; duplicates report their action and leave the current binding alone.
const bindBox = $('controlsBindings');
if (bindBox) {
  const renderBindings = () => {
    bindBox.replaceChildren();
    for (const [action, label] of Object.entries(BINDING_LABELS)) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'bind'; button.dataset.action = action;
      button.textContent = `${label}: ${game.player.controls.bindings[action].join(' / ')}`;
      bindBox.appendChild(button);
    }
    const reset = document.createElement('button');
    reset.type = 'button'; reset.className = 'bind'; reset.dataset.reset = '1';
    reset.textContent = 'RESET DEFAULTS'; bindBox.appendChild(reset);
    const status = document.createElement('small'); status.id = 'bindStatus';
    status.setAttribute('aria-live', 'polite'); bindBox.appendChild(status);
  };
  renderBindings();
  bindBox.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.reset) { game.player.controls.reset(); renderBindings(); return; }
    const action = button.dataset.action;
    const status = $('bindStatus');
    status.textContent = `PRESS A KEY OR MOUSE BUTTON FOR ${BINDING_LABELS[action]} (ESC CANCELS)`;
    const done = (code, event) => {
      cleanup();
      if (code === 'Escape') status.textContent = 'CANCELLED';
      else {
        const result = game.player.controls.rebind(action, code);
        status.textContent = result.ok ? 'BOUND' : `CONFLICT: ${result.conflicts.map(name => BINDING_LABELS[name]).join(', ')}`;
        if (result.ok) renderBindings();
      }
      event.preventDefault(); event.stopPropagation();
    };
    const keyCapture = event => done(event.code, event);
    const mouseCapture = event => done(`Mouse${event.button}`, event);
    const cleanup = () => {
      window.removeEventListener('keydown', keyCapture, true);
      window.removeEventListener('mousedown', mouseCapture, true);
    };
    window.addEventListener('keydown', keyCapture, true);
    window.addEventListener('mousedown', mouseCapture, true);
  });
}

addEventListener('keydown', e => {
  if (!game.player.controls.matches('mute', e.code) || e.repeat || e.ctrlKey || e.metaKey || e.altKey
      || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const next = !isAudioMuted();
  setMuted(next);
  setAudioMuted(next);
  if (playing) game.hud.message(next ? 'AUDIO MUTED' : 'AUDIO ON', '#ffd97a');
});

// Reads the preference the picker above sets, or undefined if the player
// never touched it ('auto') — this is what every fresh-join call site
// sends so the host can honor it. Migration/rejoin knocks don't use this:
// the host already knows a rejoining player's team from the roster entry
// it kept across the handoff, and never even looks at it for that path.
function teamPref() {
  try {
    const v = localStorage.getItem('tos.team');
    return (v === 'green' || v === 'blue') ? v : undefined;
  } catch { return undefined; }
}

// Returns a random compatible starting map. The room advances through that
// mode's map rotation after every match; there is no public one-map pin.
function applyHostPrefs() {
  const modes = ['ctf', 'tdm', 'koth'];
  const mode = modes.includes(modePref.value) ? modePref.value
    : modes[Math.floor(Math.random() * modes.length)];
  game.gameMode = mode;
  const qaMap = Number.parseInt(params.get('map'), 10);
  if (Number.isInteger(qaMap) && MAPS[qaMap]?.modes.includes(mode)) return qaMap;
  const pool = MAPS.map((m, i) => i).filter(i => MAPS[i].modes.includes(mode));
  return pool[Math.floor(Math.random() * pool.length)];
}

$('hostBtn').addEventListener('click', async () => {
  if (net || matchmaking || connecting) return;
  migrationGen = 0; // a fresh room starts the baton count over
  if (!ensureCallsign()) return;
  engagementSource = 'host';
  engagement.record('lobby_action', { action: 'host' });
  initAudio();
  game.player.name = callsign();
  // Pointer lock is only gesture-valid inside this click — take it now and
  // drop straight in; a refused lock leaves the DEPLOY button as fallback.
  const lock = renderer.domElement.requestPointerLock();
  lock?.catch?.(() => {});
  connecting = true;
  status('preparing network…');
  await primeIce();
  // Stay in solo mode while awaiting credentials: host-mode simulation
  // assumes game.net already exists and can otherwise tick into a null peer.
  game.mode = 'host';
  game.rebuild(Math.floor(Math.random() * 1e9), applyHostPrefs());
  const tryCode = () => {
    const code = params.get('code')?.toUpperCase() ?? makeCode();
    adoptHost(Net.host(code, {}), code, { onTaken: tryCode });
  };
  tryCode();
  connecting = false;
  status('creating room…');
  if (document.pointerLockElement === renderer.domElement) setPlaying(true);
});

$('joinBtn').addEventListener('click', async () => {
  if (net || matchmaking || connecting) return;
  const code = $('codeInput').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}(?:-M[1-9]\d*)?$/.test(code)) return status('enter a valid room code');
  migrationGen = 0;
  if (!ensureCallsign()) return;
  engagementSource = 'join';
  engagement.record('lobby_action', { action: 'join' });
  initAudio();
  game.player.name = callsign();
  // Lock in the click, drop straight in: the world snaps to the host's map
  // when the welcome lands a moment later (same warm-up as quick match).
  const lock = renderer.domElement.requestPointerLock();
  lock?.catch?.(() => {});
  connecting = true;
  status('preparing network…');
  await primeIce();
  game.mode = 'client';
  const n = Net.join(code, {});
  connecting = false;
  status('connecting…');
  adoptJoin(n, code);
  n.handlers.onOpen = () => n.send({ t: 'hi', v: PROTOCOL_VERSION,
    name: game.player.name, team: teamPref(), resume: resumeToken() });
  if (document.pointerLockElement === renderer.domElement) setPlaying(true);
});

// --- quick match: drop into a public room with strangers ---
// Net.quickScan probes the public slots over a single signaling socket, joins
// the fullest room that still has space, or claims a dead slot and hosts it —
// the next quick-matcher then finds you. If every room is full we wait a beat
// and scan once more: rooms churn fast, and a probe may have raced a join.
// ?qmt=30000 stretches per-step timeouts (CI/very slow networks).
//
// The first click drops you straight in: pointer lock is only guaranteed
// inside this click's gesture, not when the async scan resolves seconds
// later — so lock NOW and hold it behind a searching ticker; when the room
// is ready the menu drops away and you're already playing. If the browser
// refuses the lock, the DEPLOY button flow is the fallback.
const qmTimeout = Math.max(1000, Math.min(30000,
  parseInt(params.get('qmt'), 10) || 9000));

// Back to a clean menu with no session: nothing to resume into.
function bailToMenu() {
  $('playBtn').style.display = 'none';
  if (document.pointerLockElement === renderer.domElement) {
    suppressResume = true;
    document.exitPointerLock();
  }
}

$('quickBtn').addEventListener('click', async () => {
  if (net || matchmaking || connecting) return;
  if (!ensureCallsign()) return;
  engagementSource = 'quick';
  engagement.record('lobby_action', { action: 'quick' });
  matchmaking = true;
  searchCanceled = false;
  initAudio();
  game.player.name = callsign();
  const lock = renderer.domElement.requestPointerLock(); // gesture-valid only now
  lock?.catch?.(() => {}); // refused → DEPLOY fallback below
  $('menu').classList.add('searching');
  status('searching for a public room…');
  try {
    let r = await Net.quickScan(game.player.name, teamPref(), qmTimeout);
    if (r.kind === 'full-all') { // one retry: a room may have just opened up
      status('all rooms full — rescanning…');
      await new Promise(res => setTimeout(res, 1500));
      r = await Net.quickScan(game.player.name, teamPref(), qmTimeout);
    }
    if (searchCanceled) { r.net?.destroy(); return; } // bailed with Esc mid-search
    $('menu').classList.remove('searching');
    if (r.kind === 'join') {
      migrationGen = 0;
      game.mode = 'client';
      adoptJoin(r.net, slotCode(r.slot));
      const plain = game.onWelcome;
      game.onWelcome = () => { // richer line than the code-join default
        plain();
        status(`joined <b>PUBLIC ROOM ${r.slot + 1}</b> — you are <b>${game.player.team.toUpperCase()}</b>`);
        game.hud.message(`JOINED PUBLIC ROOM ${r.slot + 1} — YOU ARE ${game.player.team.toUpperCase()}`, '#ffd97a');
      };
      game.clientOnData(r.welcome); // replay the welcome through the normal path
    } else if (r.kind === 'host') {
      migrationGen = 0;
      game.mode = 'host';
      game.rebuild(Math.floor(Math.random() * 1e9), applyHostPrefs());
      adoptHost(r.net, slotCode(r.slot), { public: true, alreadyOpen: true });
      game.hud.message(`HOSTING PUBLIC ROOM ${r.slot + 1} — PLAYERS WILL DROP IN`, '#ffd97a');
    } else {
      reportConnectionFailure('signaling', r.kind);
      status(r.kind === 'down' ? 'cannot reach the matchmaking service — check your connection'
        : r.kind === 'version' ? 'game version mismatch — refresh this page'
        : r.kind === 'timeout' ? 'matchmaking is taking too long — try again, or HOST a private room'
        : 'all public rooms are full — try again shortly, or HOST a private room');
      bailToMenu();
      return;
    }
    // Lock held since the click: drop straight in, no DEPLOY gate. (If the
    // lock was refused, adopt* already surfaced the DEPLOY button instead.)
    if (document.pointerLockElement === renderer.domElement) setPlaying(true);
  } finally { matchmaking = false; }
});

// --- room browser: scan one eight-room page and list what answers ---
// Unlike quick match this shows the player what's live and lets them pick.
// Pagination prevents the expanded 64-room pool from creating 64 temporary
// peer connections at once. The page's guest peer stays open so a row click
// can knock immediately; it is destroyed on navigation/BACK or consumed by
// the join.
const browserEl = $('browser'), browseSt = $('browsestatus'), browseListEl = $('browselist');
let browseGuest = null, scanning = false, browsePage = 0;

function updateBrowsePager() {
  $('browsePage').textContent = `${browsePage + 1} / ${PUBLIC_PAGES}`;
  $('browsePrev').classList.toggle('disabled', browsePage === 0);
  $('browseNext').classList.toggle('disabled', browsePage === PUBLIC_PAGES - 1);
}

function roomRow(room) {
  const row = document.createElement('div');
  row.className = 'brow';
  const main = document.createElement('div');
  main.className = 'bmain';
  const map = document.createElement('div');
  map.className = 'bmap';
  map.textContent = MAPS[room.map]?.name ?? 'UNKNOWN MAP';
  const meta = document.createElement('div');
  meta.className = 'bmeta';
  const modeName = room.mode === 'tdm' ? 'team deathmatch'
    : room.mode === 'koth' ? 'king of the hill' : 'capture the flag';
  const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const score = room.mode === 'koth' ? `${clock(room.g)} — ${clock(room.b)} occupied`
    : room.mode === 'tdm' ? `${room.g} — ${room.b} kills` : `${room.g} — ${room.b} captures`;
  meta.textContent = `${modeName} · ${score}`;
  const names = document.createElement('div');
  names.className = 'bnames';
  names.textContent = room.names.join(' · ');
  main.append(map, meta, names);
  const seats = document.createElement('div');
  seats.className = 'bseats';
  seats.textContent = `${room.humans}/${room.max}`;
  const join = document.createElement('div');
  join.className = 'bjoin';
  join.textContent = 'JOIN →';
  row.append(main, seats, join);
  row.addEventListener('click', () => joinFromBrowser(room));
  row.tabIndex = 0; row.setAttribute('role', 'button');
  row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); } });
  return row;
}

async function scanRooms() {
  if (scanning) return;
  scanning = true;
  browseGuest?.destroy(); browseGuest = null;
  browseListEl.innerHTML = '';
  updateBrowsePager();
  browseSt.textContent = `scanning rooms ${browsePage * PUBLIC_SLOTS + 1}–${(browsePage + 1) * PUBLIC_SLOTS}…`;
  try {
    const r = await Net.roomScan(browsePage, qmTimeout);
    if (r.kind === 'down') {
      browseSt.textContent = 'cannot reach the matchmaking service — check your connection';
      return;
    }
    if (r.kind !== 'rooms') {
      browseSt.textContent = 'that room page is unavailable';
      return;
    }
    browseGuest = r.guest; // kept warm for the join knock
    if (!r.rooms.length) {
      browseSt.innerHTML = browsePage === 0
        ? 'no public rooms right now — hit <b>QUICK MATCH</b> and one starts with you as host'
        : `no active rooms on page ${browsePage + 1}`;
      return;
    }
    browseSt.textContent = `${r.rooms.length} room${r.rooms.length === 1 ? '' : 's'} online on page ${browsePage + 1} — click one to join`;
    for (const room of r.rooms) browseListEl.appendChild(roomRow(room));
  } finally { scanning = false; }
}

async function joinFromBrowser(room) {
  if (net || scanning) return;
  const guest = browseGuest; browseGuest = null;
  if (!guest) { scanRooms(); return; } // stale rows: rescan, pick again
  engagementSource = 'browse';
  engagement.record('lobby_action', { action: 'browse_join' });
  initAudio();
  game.player.name = callsign();
  const lock = renderer.domElement.requestPointerLock(); // gesture-valid only now
  lock?.catch?.(() => {});
  browseSt.textContent = `joining ${MAPS[room.map]?.name ?? 'room'}…`;
  const k = await Net._knock(guest, slotCode(room.slot), game.player.name, teamPref(), qmTimeout);
  if (k.kind === 'join') {
    migrationGen = 0;
    game.mode = 'client';
    browserEl.classList.add('hidden');
    $('menu').classList.remove('hidden');
    adoptJoin(Net.adoptGuest(guest, k.conn), slotCode(room.slot));
    const plain = game.onWelcome;
    game.onWelcome = () => {
      plain();
      status(`joined <b>PUBLIC ROOM ${room.slot + 1}</b> — you are <b>${game.player.team.toUpperCase()}</b>`);
      game.hud.message(`JOINED PUBLIC ROOM ${room.slot + 1} — YOU ARE ${game.player.team.toUpperCase()}`, '#ffd97a');
    };
    game.clientOnData(k.welcome); // replay the welcome through the normal path
    if (document.pointerLockElement === renderer.domElement) setPlaying(true);
  } else {
    guest.destroy();
    browseSt.textContent = k.kind === 'full' ? 'that room just filled up'
      : k.kind === 'version' ? 'game version mismatch — refresh this page'
      : k.kind === 'down' ? 'cannot reach the matchmaking service — check your connection'
      : 'that room just ended';
    if (k.kind !== 'down') scanRooms(); // show what is actually live now
  }
}

$('browseBtn').addEventListener('click', () => {
  if (net || matchmaking || connecting || scanning) return;
  if (!ensureCallsign()) return;
  engagementSource = 'browse';
  engagement.record('lobby_action', { action: 'browse' });
  initAudio();
  browsePage = 0;
  $('menu').classList.add('hidden');
  browserEl.classList.remove('hidden');
  scanRooms();
});
$('browseBack').addEventListener('click', () => {
  browserEl.classList.add('hidden');
  $('menu').classList.remove('hidden');
  browseGuest?.destroy(); browseGuest = null;
});
$('browsePrev').addEventListener('click', () => {
  if (scanning || browsePage <= 0) return;
  browsePage--;
  scanRooms();
});
$('browseNext').addEventListener('click', () => {
  if (scanning || browsePage >= PUBLIC_PAGES - 1) return;
  browsePage++;
  scanRooms();
});
$('browseRefresh').addEventListener('click', () => scanRooms());

$('codeInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('joinBtn').click();
});

const invitedCode = (params.get('code') ?? '').trim().toUpperCase();
if (/^[A-Z0-9]{4}(?:-M[1-9]\d*)?$/.test(invitedCode) && !params.get('mp')) {
  $('codeInput').value = invitedCode;
  status(params.get('invite') === '1'
    ? `joining squad room <b>${invitedCode}</b>…`
    : `squad invite ready — enter a callsign and join <b>${invitedCode}</b>`);
}

// Map rotation: the room moves to the next map after each match. The old
// PLAY AGAIN reloaded the page, which for the host tore the whole room down
// mid-rotation.
//
// Rotation used to end on the DEPLOY button and wait there indefinitely. The
// room had already built the next map and picked the teams; the only thing
// standing between the player and the match was a click that carried no
// decision. Now the countdown takes you in on its own, and the window exists
// for the one choice that IS worth making between rounds: your class.
const ROTATION_DEPLOY_SECONDS = 6;
let rotateTimer = null;

function stopRotationCountdown() {
  if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
  $('menu').classList.remove('rotating');
}

// Pointer lock normally wants a user gesture. Re-requesting it moments after
// the game itself released it usually succeeds, but any browser is free to
// refuse — so a refusal must land the player back on a working DEPLOY button
// rather than stranded in a menu that has stopped counting.
function deployAuto() {
  initAudio();
  let lock;
  try { lock = renderer.domElement.requestPointerLock(); }
  catch { lock = Promise.reject(new Error('refused')); }
  Promise.resolve(lock).catch(() => {
    showPlay('DEPLOY');
    status('press <b>DEPLOY</b> to drop in');
  });
}

function startRotationCountdown() {
  stopRotationCountdown();
  let left = ROTATION_DEPLOY_SECONDS;
  $('menu').classList.add('rotating');
  $('playOptions').open = true;
  const tick = () => {
    if (playing) return stopRotationCountdown(); // already dropped in
    if (left <= 0) {
      stopRotationCountdown();
      showPlay('DEPLOY');
      deployAuto();
      return;
    }
    showPlay(`DEPLOYING IN ${left}`);
    left--;
  };
  tick();
  rotateTimer = setInterval(tick, 1000);
}

game.onRestart = mapName => {
  engagementSource = 'rotation';
  $('end').classList.add('hidden');
  $('pausedTitle').textContent = '— MATCH OVER —';
  if (document.pointerLockElement === renderer.domElement) {
    stopRotationCountdown();
    setPlaying(true);
    status(`new map — <b>${mapName}</b>`);
    return;
  }
  if (playing) setPlaying(false);
  status(`new map — <b>${mapName}</b> · pick a class`);
  startRotationCountdown();
};

// Tab (and Shift+Tab) can force pointer lock closed on some browsers as an
// unblockable accessibility escape hatch — the keydown handler's
// preventDefault cannot stop it, confirmed by the fact this file already
// had to work around a "Tab keyup lost to the unlock" stranding the
// scoreboard. If that's what just happened mid-match, the player almost
// certainly meant "let me check the score," not "pause the game" — try to
// silently re-acquire the lock instead of dropping into the pause menu.
// pointerlockerror is the failure path: some browsers throttle back-to-back
// lock requests, and if this one is refused we fall back to a normal pause
// rather than stranding the player with no UI at all.
let tabRelockPending = false;
document.addEventListener('pointerlockerror', () => {
  if (!tabRelockPending) return;
  tabRelockPending = false;
  enterPause();
});

function renderPlayerSafety() {
  const root = $('safetyPlayers');
  if (!root) return;
  root.replaceChildren();
  const candidates = game.voteKickCandidates();
  const humans = game.mode === 'client' ? Math.max(1, game._rosterP?.size ?? 1)
    : game.remote.size + 1;
  const state = game.voteKickState();
  const myKey = game.mode === 'client' ? 'p' + game.myIdx : 'p' + game._hostIdx;
  if (!candidates.length) {
    const empty = document.createElement('span');
    empty.textContent = game.mode === 'solo' ? 'AVAILABLE IN MULTIPLAYER'
      : 'NO ELIGIBLE PLAYERS';
    root.appendChild(empty);
    return;
  }
  for (const candidate of candidates) {
    const button = document.createElement('button');
    const selected = state.active && state.target === candidate.target;
    const voted = selected && state.voters.includes(myKey);
    button.textContent = selected
      ? `${voted ? 'VOTED' : 'VOTE'} ${candidate.name} · ${state.voters.length}/${state.needed} · ${state.remaining}s`
      : `VOTE OUT ${candidate.name}`;
    button.disabled = humans < 3 || (state.active && !selected) || voted;
    button.addEventListener('click', () => {
      game.requestVoteKick(candidate.target);
      renderPlayerSafety();
    });
    root.appendChild(button);
  }
}
game.onVoteKickState = renderPlayerSafety;

function enterPause() {
  // Drop all held inputs so nobody runs/shoots blind while the menu is up.
  game.player.keys = {};
  game.player.controls.clear();
  game.player.mouseDown = [false, false, false];
  game.hud.statsHide(); // a Tab keyup lost to the unlock can't strand it
  renderPlayerSafety();
  if (matchmaking && !net) { // Esc mid-search, before any room adopted us
    searchCanceled = true;
    $('menu').classList.remove('searching');
    status('search canceled');
  }
  if (!game.over && !netDead) {
    $('pausedTitle').textContent = '— PAUSED —';
    setPlaying(false);
    // A canceled/failed search leaves no session — RESUME would be a solo
    // backdoor into the menu map, so the button stays hidden.
    if (searchCanceled || suppressResume) $('playBtn').style.display = 'none';
    else showPlay('RESUME');
    suppressResume = false;
  }
}

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  // While a quick-match search runs, the lock is held behind the searching
  // ticker — don't start playing until the room is actually ready.
  if (locked) {
    tabRelockPending = false;
    stopRotationCountdown(); // in the match — the window has served its purpose
    // A results-screen class click may have supplied the gesture that restored
    // pointer lock. Keep showing the report and wait for the authoritative
    // restart before beginning the next engagement session.
    if (game.over) return;
    if (!(matchmaking && !net)) setPlaying(true);
    return;
  }
  if (playing && performance.now() - (game._tabUnlockAt ?? 0) < 200) {
    tabRelockPending = true;
    renderer.domElement.requestPointerLock();
    return;
  }
  enterPause();
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// Headless/test hooks: ?mp=host&code=TEST&auto=1 · ?mp=join&code=TEST&auto=1
// ?mp=quick&auto=1&ns=<namespace> · ?mp=browse&auto=1 · host cap: &cap=2
// Pref hooks: &map=0..5&mode=ctf|tdm|koth · visual QA:
// &scopeqa=1 / &airstrikeqa=1 / &soldierqa=1 / &mapqa=1
// TDM kill limit: &killcap=2
// Auto runs can't type, so they get a callsign to satisfy the lobby gate.
if (params.get('auto') && !rawName())
  $('nameInput').value = 'TEST' + Math.floor(Math.random() * 90 + 10);
if (params.get('mp') === 'host') {
  $('codeInput').value = '';
  $('hostBtn').click();
} else if (params.get('mp') === 'join') {
  $('codeInput').value = params.get('code') ?? 'TEST';
  setTimeout(() => $('joinBtn').click(), 800);
} else if (params.get('mp') === 'quick') {
  setTimeout(() => $('quickBtn').click(), 400);
} else if (params.get('mp') === 'browse') {
  setTimeout(() => $('browseBtn').click(), 400);
} else if (params.get('invite') === '1' && invitedCode) {
  if (!rawName()) $('nameInput').value = callsign();
  setTimeout(() => $('joinBtn').click(), 500);
}

// ---------------- loop ----------------
const clock = new THREE.Clock();
// FPS tracking: an exponential moving average (raw 1/dt is far too
// jittery frame to frame to read), display text only refreshed every
// 0.4s so it's actually readable rather than flickering every frame.
let fpsEma = 60, fpsDisplayT = 0;
const perfOn = params.has('perf');
const perfSamples = new Float32Array(240);
let perfCount = 0, perfCursor = 0;
const runtimeHealth = new RuntimeHealth(240);
let autoGfxBenchmark = automaticGfxNeeded(AUTO_GFX_BENCHMARK_VERSION)
  ? new FirstSessionGraphicsBenchmark() : null;
let resourceBaseline = null;
const soakOn = params.has('soak');
const soakEvery = Math.max(5, parseInt(params.get('soak'), 10) || 12);
let soakT = 0;
if (perfOn) $('perf').style.display = 'block';
let menuT = Math.PI * 0.15;
let menuMapT = 0; // seconds the current backdrop map has been showing
// Test hook: ?mmt=2 rotates every 2s.
const MENU_MAP_EVERY = parseInt(params.get('mmt'), 10) || 15;
// The backdrop carousel only runs on the idle solo menu — never while
// hosting (host world is authoritative) or connected as a client (a rebuild
// would wipe the synced match). ?auto= disables it: tests drive the world
// directly and would lose their terrain mid-scenario.
const carouselOn = !params.get('auto');

// Last time the simulation actually stepped, from either driver below.
let lastSimT = performance.now();

// Browsers PAUSE requestAnimationFrame in a hidden tab. Since rAF was the
// only thing calling game.update, a host that alt-tabbed stopped sending
// snapshots entirely, every client's 4s watchdog fired, and the room migrated
// away from a host that was alive and unaware — leaving two rooms and a
// zombie holding the original id. Timers in a hidden tab are throttled to
// ~1Hz but not stopped, so this fallback keeps the authoritative sim (and its
// snapshots) beating slowly instead of dying. While the tab is visible rAF
// runs at 60Hz, lastSimT stays fresh, and this never fires.
setInterval(() => {
  const now = performance.now();
  if (now - lastSimT < 250) return; // rAF is healthy — leave it alone
  if (game.mode === 'client') { game.clientIdleTick(); lastSimT = now; return; }
  if (game.mode !== 'host') { lastSimT = now; return; }
  // Step at most one interval's worth per tick. Catching up fully would fire
  // a burst of ~15 snapshots at once, which scrambles every client's arrival
  // statistics and inflates their send buffer. The honest trade: a hidden
  // host's match runs slowly rather than pausing. Slow is recoverable; the
  // room splitting in two is not.
  let owed = Math.min((now - lastSimT) / 1000, 0.25);
  lastSimT = now;
  while (owed > 0) { const step = Math.min(owed, 0.05); game.update(step); owed -= step; }
}, 250);

function frame() {
  requestAnimationFrame(frame);
  const wallDt = clock.getDelta();          // real elapsed time
  const dt = Math.min(wallDt, 0.05);        // sim step, capped for physics

  if (wallDt > 0) fpsEma = fpsEma * 0.9 + (1 / wallDt) * 0.1;
  if (wallDt > 0) runtimeHealth.frame(wallDt * 1000);
  if (autoGfxBenchmark && wallDt > 0) {
    const info = renderer.info.render;
    const result = autoGfxBenchmark.frame(wallDt * 1000, {
      // Background tabs, browser automation, and matchmaking transitions are
      // not representative of this device's normal play budget.
      eligible: playing && !game.over && !params.has('auto')
        && document.visibilityState === 'visible' && document.hasFocus()
        && !matchmaking && !scanning,
      drawCalls: info.calls,
      triangles: info.triangles,
    });
    if (result?.level) {
      const level = result.level;
      saveAutomaticGfxLevel(level, AUTO_GFX_BENCHMARK_VERSION);
      renderer.setPixelRatio(Math.min(devicePixelRatio, gfxPreset(level).pixelRatio));
      game.applyGraphics(level);
      diagnostics.autoGraphics = result;
      fieldTelemetry.record('frame_budget', {
        tier: level,
        result: level === 'high' ? 'pass' : 'fail',
        frame: Math.max(0, Math.min(4, Math.floor(result.sample.frameP95Ms / 8))),
        long: Math.max(0, Math.min(4, Math.floor(result.sample.longFrameRate * 100))),
      });
      fieldTelemetry.flush();
      const auto = document.querySelector('#gfxOpts [data-gfx="auto"]');
      if (auto) auto.textContent = `AUTO · ${level.toUpperCase()}`;
      autoGfxBenchmark = null;
    }
  }
  if (perfOn && wallDt > 0) {
    perfSamples[perfCursor] = wallDt * 1000;
    perfCursor = (perfCursor + 1) % perfSamples.length;
    perfCount = Math.min(perfSamples.length, perfCount + 1);
  }
  fpsDisplayT += wallDt;
  if (fpsDisplayT >= 0.4) {
    fpsDisplayT = 0;
    const el = $('fps');
    if (el && el.style.display !== 'none') {
      const f = Math.round(fpsEma);
      el.textContent = f + ' fps';
      el.className = f < 25 ? 'bad' : f < 45 ? 'warn' : '';
    }
    const info = renderer.info.render, memory = renderer.info.memory;
    const n = game.net?.stats?.();
    const counts = game.runtimeCounts();
    const resources = { geometries: memory.geometries, textures: memory.textures,
      sceneObjects: counts.sceneObjects };
    if (!resourceBaseline && runtimeHealth.totalFrames >= 240) resourceBaseline = { ...resources };
    const report = runtimeHealth.snapshot({ drawCalls: info.calls, triangles: info.triangles,
      particles: game.effects.particles.length,
      networkBytesPerSecond: (n?.sentBytesPerSecond ?? 0) + (n?.recvBytesPerSecond ?? 0) });
    game.runtimeHealth = report;
    diagnostics.metrics = { ...report, ...counts, resources,
      resourceDrift: resourceBaseline ? resourceDrift(resourceBaseline, resources) : null };
    diagnostics.engagement = engagement.snapshot();
    if (perfOn && perfCount) {
      const sorted = Array.from(perfSamples.slice(0, perfCount)).sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
      $('perf').textContent = `${getGfxLevel().toUpperCase()}  ${innerWidth}×${innerHeight}\n`
        + `frame p95 ${p95.toFixed(1)}ms\n`
        + `${info.calls} calls  ${info.triangles} tris\n`
        + `${game.effects.particles.length} debris\n`
        + `${report.budget.pass ? 'release budgets pass' : 'release budget exceeded'}`
        + (soakOn ? `\n${diagnostics.soakCycles} soak rotations` : '');
    }
  }

  // Opt-in browser soak mode: repeatedly rebuilds/rotates the authoritative
  // match while the normal diagnostics watch GPU resources and frame/network
  // budgets. It never runs in ordinary play and never rebuilds a guest.
  if (soakOn && game.mode !== 'client') {
    soakT += wallDt;
    if (soakT >= soakEvery) {
      soakT = 0;
      const pool = MAPS.map((m, i) => i).filter(i => MAPS[i].modes.includes(game.gameMode));
      const next = pool[(pool.indexOf(game.mapIndex) + 1) % pool.length];
      const seed = (game.seed + 104729) % 1e9;
      if (game.mode === 'host') game._restartRound(next, seed);
      else game.rebuild(seed, next);
      diagnostics.soakCycles++;
    }
  }

  // The host is authoritative — the simulation must never pause, even while
  // the host's own menu is up, or every client freezes with it.
  if (playing || game.mode === 'host' || game.over) {
    lastSimT = performance.now();
    game.update(dt);
  } else if (game.mode === 'client') {
    lastSimT = performance.now();
    // Menu-open client: the world can freeze, but the host-silence watchdog
    // must not — a host dropping while you're in the Esc menu has to fire
    // the baton pass here, not on resume.
    game.clientIdleTick();
    // Slow cinematic orbit behind the menu.
    menuT += dt * 0.05;
  } else {
    // Slow cinematic orbit behind the menu.
    menuT += dt * 0.05;
    // The backdrop previews the same rotation a hosted room will use.
    if (carouselOn && game.mode === 'solo' && !net && !matchmaking) {
      const pool = MAPS.map((m, i) => i).filter(i => modePref.value === 'any'
        || MAPS[i].modes.includes(modePref.value));
      let next = -1;
      menuMapT += wallDt; // wall-clock: a stalled frame still counts its time
      if (menuMapT >= MENU_MAP_EVERY || !pool.includes(game.mapIndex)) {
        menuMapT = 0;
        next = pool[(pool.indexOf(game.mapIndex) + 1) % pool.length];
      }
      if (next >= 0) {
        game.rebuild(Math.floor(Math.random() * 1e9), next);
        game.player.vmRoot.visible = false; // rebuild respawns: no menu gun
        $('mapname').innerHTML = `now showing — <b>${MAPS[next].name}</b>`;
      }
    }
    if (airstrikeQa) {
      const x = SX / 2, z = SZ / 2;
      const y = game.world.surface(Math.floor(x), Math.floor(z)) + 1;
      const remaining = Math.max(0, Math.min(3,
        Number.parseFloat(params.get('airstriket') ?? '0.34')));
      game._syncAirstrikeDrone(999999, x, y, z, 0, remaining, 0);
      game._updateAirstrikeDrones(dt);
      if (params.get('airstrikeview') === 'top') {
        camera.position.set(x, y + 62, z + 8);
        camera.lookAt(x, y + 16, z);
      } else {
        camera.position.set(x - 32, y + 7, z + 26);
        camera.lookAt(x, y + 18, z);
      }
    } else if (soldierQa) {
      const x = SX / 2, z = SZ / 2;
      const green = game.bots.filter(b => b.team === 'green');
      const blue = game.bots.filter(b => b.team === 'blue');
      const lineup = [green[0], blue[0], green[1]].filter(Boolean);
      const py = game.world.surface(Math.floor(x), Math.floor(z)) + 1;
      for (let i = 0; i < lineup.length; i++) {
        const b = lineup[i], px = x + (i - 1) * 1.35;
        b.parts.group.position.set(px, py, z);
        b.parts.group.rotation.set(0, (i - 1) * -0.18, 0);
        b.parts.group.visible = true;
        setSoldierTool(b.parts, [0, 1, 5][i]);
        setCrouch(b.parts, params.get('soldierpose') === 'crouch' && i === 1);
        animateSoldier(b.parts, params.get('soldierpose') === 'walk' ? 5 : 0, game.time);
      }
      camera.position.set(x, py + 1.15,
        z + (params.get('soldierview') === 'back' ? 4.6 : -4.6));
      camera.lookAt(x, py + 0.95, z);
    } else {
      camera.position.set(
        SX / 2 + Math.cos(menuT) * 95,
        58,
        SZ / 2 + Math.sin(menuT) * 95
      );
      camera.lookAt(SX / 2, 24, SZ / 2);
    }
    game.world.animateSky(game.time += dt);
    if (game.flags) for (const f of ['green', 'blue']) game.flags[f].clientUpdate(game.time);
    game.effects.update(dt);
  }
  if (game.over) {
    // Keep the map the players just altered behind its results. A fixed high
    // three-quarter view reads as the actual battlefield, while the overlay
    // remains stable enough to scan and click during the short intermission.
    const angle = 0.55 + game.mapIndex * 0.83;
    const cx = SX / 2, cz = SZ / 2;
    const cy = game.world.surface(Math.floor(cx), Math.floor(cz));
    camera.position.set(cx + Math.cos(angle) * 74, Math.max(50, cy + 34),
      cz + Math.sin(angle) * 74);
    camera.lookAt(cx, Math.max(14, cy + 5), cz);
    game.player.vmRoot.visible = false;
  }
  renderer.render(scene, camera);
}
// Tactical-ping composition hook. It uses the real host-side raycast,
// context classification, world marker, minimap mark, HUD bearing, and TTL;
// only the synthetic key press is skipped because automation cannot reliably
// acquire browser pointer lock.
if (pingQa) {
  game.player.name = 'SCOUT';
  game.player.protT = 999;
  setPlaying(true);
  game._hostPlaceTeamPing(game.player, [0.65, -0.25, -0.72]);
}
// Death-recap composition hook. The fixture enters through authoritative
// Game#damage and the ordinary Player#die/Game#onDeath route so browser QA
// covers fact capture and HUD presentation together, not a hand-filled card.
if (deathRecapQa) {
  const attacker = game.bots.find(b => b.team !== game.player.team);
  if (attacker) {
    attacker.name = 'BIRCH';
    attacker.health = 18;
    attacker.body.pos.set(game.player.body.pos.x + 24, game.player.body.pos.y,
      game.player.body.pos.z + 29);
    game.player.protT = 0;
    setPlaying(true);
    game.damage(game.player, 120, attacker, attacker.body.pos,
      { cause: 'rifle', headshot: true });
  }
}
// Representative post-match composition without waiting through a full
// automated round. Uses the real scoreboard rows, report rules, persistence,
// and Game#_end path; only the seeded result is a browser QA fixture.
if (reportQa) {
  game.gameMode = 'ctf';
  game.player.team = 'green';
  const reportWinner = params.get('reportqa') === 'defeat' ? 'blue' : 'green';
  game.captures = reportWinner === 'green'
    ? { green: 3, blue: 2 } : { green: 2, blue: 3 };
  game.matchElapsed = 503;
  const mine = game._kdKey(game.player);
  let i = 0;
  for (const [key, row] of game.kd) {
    if (key === mine) Object.assign(row,
      { team: 'green', score: 820, k: 6, d: 0, a: 3, objective: 7 });
    else Object.assign(row, { score: Math.max(80, 600 - i * 55),
      k: Math.max(0, 5 - i), d: 2 + i % 4, a: i % 3, objective: Math.max(0, 4 - i) });
    i++;
  }
  if (game.voxelStory) {
    game.voxelStory.recordBlast(18, { airstrike: true });
    game.voxelStory.recordCollapse(34);
    game.voxelStory.recordCollapseKill();
  }
  game._end(reportWinner);
}
frame();
