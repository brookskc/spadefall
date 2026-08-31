// main.js — boot, renderer, sky, lobby flow (solo / host / join), main loop.
import * as THREE from 'three';
import { Game } from './game.js';
import { initAudio } from './audio.js';
import { SX, SZ, skyGradient } from './world.js';
import { MAPS } from './mapgen.js';
import { Net, makeCode, PUBLIC_SLOTS, slotCode } from './net.js';
import { stats, GUN_COLORS } from './stats.js';
import { BASE_FOV, GUN_CLASSES } from './player.js';
import { animateSoldier, setCrouch, setSoldierTool } from './entities.js';
import { getGfxLevel, setGfxLevel, gfxPreset, getShowFps, setShowFps,
  getHudScale, setHudScale, getHudOpacity, setHudOpacity,
  getMotionScale, getMotionLevel, setMotionLevel,
  getColorMode, setColorMode } from './settings.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { RuntimeHealth, resourceDrift } from './runtime-health.js';
import { EngagementTracker, parseEngagementFeatures } from './engagement.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const engagementFeatures = parseEngagementFeatures(location.search);
const engagement = new EngagementTracker();
engagement.record('page_ready', { protocol: PROTOCOL_VERSION });
const diagnostics = window.__spadefallDiagnostics = {
  protocol: PROTOCOL_VERSION, startedAt: new Date().toISOString(), faults: [],
  metrics: null, soakCycles: 0, features: engagementFeatures,
  engagement: engagement.snapshot(),
};
const rememberFault = (kind, value) => {
  diagnostics.faults.push({ kind, at: new Date().toISOString(),
    message: String(value?.message ?? value ?? 'unknown').slice(0, 500) });
  if (diagnostics.faults.length > 20) diagnostics.faults.shift();
};
window.addEventListener('error', e => rememberFault('error', e.error ?? e.message));
window.addEventListener('unhandledrejection', e => rememberFault('rejection', e.reason));
const airstrikeQa = params.has('airstrikeqa');
const soldierQa = params.has('soldierqa');
const mapQa = params.has('mapqa');
const stationQa = params.has('stationqa');
const reportQa = params.has('reportqa');
const pingQa = params.has('pingqa');

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
game.player.vmRoot.visible = false; // hidden until first deploy
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
if (airstrikeQa || soldierQa || mapQa || stationQa || reportQa || pingQa) $('menu').style.display = 'none';

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
  engagement.abandon('pagehide');
  net?.destroy();
});
const CALLSIGNS = ['Ace', 'Deuce', 'Trey', 'Joker', 'King', 'Queen', 'Jack', 'Ten'];

function rawName() {
  return $('nameInput').value.trim().replace(/[^\w \-]/g, '').slice(0, 12);
}
function callsign() {
  return rawName() || CALLSIGNS[Math.floor(Math.random() * CALLSIGNS.length)] + Math.floor(Math.random() * 90 + 10);
}
// No anonymous soldiers: every lobby action needs a callsign first, so the
// name above your head means something to the people shooting at you.
function requireName() {
  if (rawName()) return true;
  status('enter a callsign first — your squad needs to know you');
  $('nameInput').classList.add('need');
  $('nameInput').focus();
  return false;
}
$('nameInput').addEventListener('input', () => $('nameInput').classList.remove('need'));
function status(html) { $('lobbyStatus').innerHTML = html; }

function inviteUrl() {
  if (!roomCode) return null;
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('code', roomCode);
  return url.href;
}
function showInvite() { $('inviteRow').style.display = roomCode ? 'block' : 'none'; }
async function copyInvite() {
  const url = inviteUrl();
  if (!url) return;
  let copied = false;
  try {
    copied = await Promise.race([
      navigator.clipboard.writeText(url).then(() => true, () => false),
      new Promise(resolve => setTimeout(() => resolve(false), 400)),
    ]);
  } catch { /* fallback below */ }
  if (!copied) {
    const input = document.createElement('textarea');
    input.value = url;
    input.style.position = 'fixed'; input.style.opacity = '0';
    document.body.appendChild(input); input.select();
    try { copied = document.execCommand('copy'); } catch { /* best effort */ }
    input.remove();
  }
  status(copied ? `invite copied — <b>${roomCode}</b>`
    : `copy unavailable — share room code <b>${roomCode}</b>`);
}
$('inviteBtn').addEventListener('click', copyInvite);

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
  $('roomcode').style.display = v && roomCode ? 'block' : 'none';
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
let searchCanceled = false; // Esc pressed mid-search: discard the result
let suppressResume = false; // unlock came from a failed search, not the player
$('playBtn').addEventListener('click', () => {
  if (netDead) return location.reload();
  if (matchmaking) return;
  if (game.mode === 'client' && !game.myId) return; // still connecting
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
      } else status(`network error: ${e.type}`);
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
    onError: e => status(`network error: ${e.type}`),
  };
  game.onAbandoned = abandonedNotice;
  console.debug(`[mig] promoted to host of ${code}`);
  game.promoteToHost(n);
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
  game.onKicked = () => rejectClientSession(n,
    'connection closed after sustained invalid gameplay input');
  console.debug(`[mig] rejoined migrated room ${code} as client`);
  game.clientOnData(welcome); // migrated welcome: world and kit kept as-is
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
  game.onKicked = () => rejectClientSession(n,
    'connection closed after sustained invalid gameplay input');
  n.handlers.onError = e => {
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

// --- host preferences: map + mode, remembered across visits ---
// Applied whenever this player hosts — a private HOST or a quick-match slot
// claim — never on migration promotion, so a replica keeps the room's
// running map and mode. gameMode must be set BEFORE rebuild(), since flags
// only exist in CTF. ?map=2&mode=tdm are test hooks that force the selects.
const mapPref = $('mapPref'), modePref = $('modePref');
{
  // The map list follows the mode: each map declares which modes it supports
  // (DUNES is retired from the CTF rotation; CROWN and CALDERA are hill-first).
  function rebuildMapPref(keep = mapPref.value) {
    mapPref.innerHTML = '';
    const rot = document.createElement('option');
    rot.value = '-1'; rot.textContent = 'rotate';
    mapPref.appendChild(rot);
    MAPS.forEach((m, i) => {
      if (!m.modes.includes(modePref.value)) return;
      const o = document.createElement('option');
      o.value = String(i); o.textContent = m.name;
      mapPref.appendChild(o);
    });
    mapPref.value = [...mapPref.options].some(o => o.value === keep) ? keep : '-1';
  }
  modePref.value = localStorage.getItem('tos.mode') ?? 'ctf';
  rebuildMapPref(localStorage.getItem('tos.map') ?? '-1');
  const save = () => {
    localStorage.setItem('tos.map', mapPref.value);
    localStorage.setItem('tos.mode', modePref.value);
  };
  mapPref.addEventListener('change', save);
  modePref.addEventListener('change', () => { rebuildMapPref(); save(); });
  if (params.get('mode')) modePref.value = params.get('mode');
  rebuildMapPref();
  const pm = parseInt(params.get('map'), 10);
  if (Number.isInteger(pm) && pm >= 0 && pm < MAPS.length) mapPref.value = String(pm);
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
    for (const el of opts) el.classList.toggle('picked', Number(el.dataset.cls) === game.player.gunClass);
  }
  for (const el of opts) {
    el.addEventListener('click', () => {
      const idx = Number(el.dataset.cls);
      if (!GUN_CLASSES.includes(idx)) return;
      try { localStorage.setItem('tos.class', String(idx)); } catch { /* best effort */ }
      game.player.gunClass = idx;
      game.player._pendingClass = idx;
      game.player.tool = idx;
      game.player._syncViewmodel();
      game.hud.refreshTool(game.player);
      renderStartClass();
    });
  }
  renderStartClass();
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

// Graphics preset picker: Low/Medium/High. Pixel ratio applies live —
// setPixelRatio can change on an already-running renderer. Antialiasing
// cannot: it's fixed at WebGL context creation, so a change here only
// takes effect next launch — gfxReloadNote says so explicitly rather
// than silently doing nothing visible until a reload happens to occur.
// Particle pool caps (see settings.js/effects.js) apply on the next
// Effects construction, which a map rebuild already triggers often
// enough that this isn't worth forcing immediately either.
{
  const opts = document.querySelectorAll('#gfxOpts .opt');
  const note = $('gfxReloadNote');
  const startAA = gfxPreset().antialias; // what the renderer was actually built with, to detect a genuine pending AA change
  function renderGfx() {
    const level = getGfxLevel();
    for (const el of opts) el.classList.toggle('picked', el.dataset.gfx === level);
    if (note) note.classList.toggle('show', gfxPreset(level).antialias !== startAA);
  }
  for (const el of opts) {
    el.addEventListener('click', () => {
      const level = el.dataset.gfx;
      setGfxLevel(level);
      renderer.setPixelRatio(Math.min(devicePixelRatio, gfxPreset(level).pixelRatio));
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
function choiceRow(id, read, write, apply) {
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

// Returns the map index to start the new room on: the pinned map if it's
// mode-compatible, else a random pick from the maps this mode supports.
function applyHostPrefs() {
  const mode = ['ctf', 'tdm', 'koth'].includes(modePref.value) ? modePref.value : 'ctf';
  game.gameMode = mode;
  const v = parseInt(mapPref.value, 10);
  game.mapLock = (v >= 0 && MAPS[v]?.modes.includes(mode)) ? v : null;
  if (game.mapLock != null) return game.mapLock;
  const pool = MAPS.map((m, i) => i).filter(i => MAPS[i].modes.includes(mode));
  return pool[Math.floor(Math.random() * pool.length)];
}

$('hostBtn').addEventListener('click', () => {
  if (net || matchmaking) return;
  migrationGen = 0; // a fresh room starts the baton count over
  if (!requireName()) return;
  engagementSource = 'host';
  engagement.record('lobby_action', { action: 'host' });
  initAudio();
  game.mode = 'host';
  game.player.name = callsign();
  game.rebuild(Math.floor(Math.random() * 1e9), applyHostPrefs());
  // Pointer lock is only gesture-valid inside this click — take it now and
  // drop straight in; a refused lock leaves the DEPLOY button as fallback.
  const lock = renderer.domElement.requestPointerLock();
  lock?.catch?.(() => {});
  const tryCode = () => {
    const code = params.get('code')?.toUpperCase() ?? makeCode();
    adoptHost(Net.host(code, {}), code, { onTaken: tryCode });
  };
  tryCode();
  status('creating room…');
  if (document.pointerLockElement === renderer.domElement) setPlaying(true);
});

$('joinBtn').addEventListener('click', () => {
  if (net || matchmaking) return;
  const code = $('codeInput').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}(?:-M[1-9]\d*)?$/.test(code)) return status('enter a valid room code');
  migrationGen = 0;
  if (!requireName()) return;
  engagementSource = 'join';
  engagement.record('lobby_action', { action: 'join' });
  initAudio();
  game.mode = 'client';
  game.player.name = callsign();
  // Lock in the click, drop straight in: the world snaps to the host's map
  // when the welcome lands a moment later (same warm-up as quick match).
  const lock = renderer.domElement.requestPointerLock();
  lock?.catch?.(() => {});
  status('connecting…');
  const n = Net.join(code, {});
  adoptJoin(n, code);
  n.handlers.onOpen = () => n.send({ t: 'hi', v: PROTOCOL_VERSION,
    name: game.player.name, team: teamPref() });
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
const qmTimeout = parseInt(params.get('qmt'), 10) || 9000;

// Back to a clean menu with no session: nothing to resume into.
function bailToMenu() {
  $('playBtn').style.display = 'none';
  if (document.pointerLockElement === renderer.domElement) {
    suppressResume = true;
    document.exitPointerLock();
  }
}

$('quickBtn').addEventListener('click', async () => {
  if (net || matchmaking) return;
  if (!requireName()) return;
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

// --- room browser: scan every public slot and list what answers ---
// Unlike quick match this shows the player what's live and lets them pick.
// The scan's guest peer stays open between scans so a row click can knock
// immediately; it's destroyed on BACK or consumed by the join.
const browserEl = $('browser'), browseSt = $('browsestatus'), browseListEl = $('browselist');
let browseGuest = null, scanning = false;

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
  return row;
}

async function scanRooms() {
  if (scanning) return;
  scanning = true;
  browseGuest?.destroy(); browseGuest = null;
  browseListEl.innerHTML = '';
  browseSt.textContent = 'scanning public rooms…';
  try {
    const r = await Net.roomScan(qmTimeout);
    if (r.kind === 'down') {
      browseSt.textContent = 'cannot reach the matchmaking service — check your connection';
      return;
    }
    browseGuest = r.guest; // kept warm for the join knock
    if (!r.rooms.length) {
      browseSt.innerHTML = 'no public rooms right now — hit <b>QUICK MATCH</b> and one starts with you as host';
      return;
    }
    browseSt.textContent = `${r.rooms.length} room${r.rooms.length === 1 ? '' : 's'} online — click one to join`;
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
  if (net || matchmaking || scanning) return;
  if (!requireName()) return;
  engagementSource = 'browse';
  engagement.record('lobby_action', { action: 'browse' });
  initAudio();
  $('menu').classList.add('hidden');
  browserEl.classList.remove('hidden');
  scanRooms();
});
$('browseBack').addEventListener('click', () => {
  browserEl.classList.add('hidden');
  $('menu').classList.remove('hidden');
  browseGuest?.destroy(); browseGuest = null;
});
$('browseRefresh').addEventListener('click', () => scanRooms());

$('codeInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('joinBtn').click();
});

const invitedCode = (params.get('code') ?? '').trim().toUpperCase();
if (/^[A-Z0-9]{4}(?:-M[1-9]\d*)?$/.test(invitedCode) && !params.get('mp')) {
  $('codeInput').value = invitedCode;
  status(`squad invite ready — enter a callsign and join <b>${invitedCode}</b>`);
}

// Map rotation: the room moves to the next map after each match. The end
// screen offers no choices while it turns — only once the new map is built
// does the lobby come back with DEPLOY ready (pointer lock needs a fresh
// click anyway). The old PLAY AGAIN reloaded the page, which for the host
// tore the whole room down mid-rotation.
game.onRestart = mapName => {
  engagementSource = 'rotation';
  $('end').classList.add('hidden');
  $('pausedTitle').textContent = '— MATCH OVER —';
  if (playing) setPlaying(false);
  showPlay('DEPLOY');
  status(`new map — <b>${mapName}</b>`);
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

function enterPause() {
  // Drop all held inputs so nobody runs/shoots blind while the menu is up.
  game.player.keys = {};
  game.player.mouseDown = [false, false, false];
  game.hud.statsHide(); // a Tab keyup lost to the unlock can't strand it
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
  if (locked) { tabRelockPending = false; if (!(matchmaking && !net)) setPlaying(true); return; }
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
    const resources = { geometries: memory.geometries, textures: memory.textures,
      sceneObjects: game.runtimeCounts().sceneObjects };
    if (!resourceBaseline && runtimeHealth.totalFrames >= 240) resourceBaseline = { ...resources };
    const report = runtimeHealth.snapshot({ drawCalls: info.calls, triangles: info.triangles,
      particles: game.effects.particles.length,
      networkBytesPerSecond: (n?.sentBytesPerSecond ?? 0) + (n?.recvBytesPerSecond ?? 0) });
    game.runtimeHealth = report;
    diagnostics.metrics = { ...report, ...game.runtimeCounts(), resources,
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
    // The backdrop follows the host prefs: a pinned map shows ONLY that map;
    // "rotate" cycles just the maps the selected mode supports. The old
    // carousel ignored both and cycled all six every 30s.
    if (carouselOn && game.mode === 'solo' && !net && !matchmaking) {
      const pinned = parseInt(mapPref.value, 10);
      const pool = MAPS.map((m, i) => i).filter(i => MAPS[i].modes.includes(modePref.value));
      let next = -1;
      if (pinned >= 0 && MAPS[pinned]?.modes.includes(modePref.value)) {
        menuMapT = 0;                          // pinned: no rotation, ever
        if (game.mapIndex !== pinned) next = pinned;
      } else {
        menuMapT += wallDt; // wall-clock: a stalled frame still counts its time
        // Also jump when the mode switch stranded the backdrop off-pool.
        if (menuMapT >= MENU_MAP_EVERY || !pool.includes(game.mapIndex)) {
          menuMapT = 0;
          next = pool[(pool.indexOf(game.mapIndex) + 1) % pool.length];
        }
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
  renderer.render(scene, camera);
}
// Browser composition hook for the real field-cache loop. Automated browsers
// cannot reliably grant pointer lock, so place a deliberately under-supplied
// solo player on cache one and let the ordinary Game update secure it.
if (stationQa) {
  const station = game.fieldStations[Math.max(0, Math.min(game.fieldStations.length - 1,
    Number.parseInt(params.get('stationqa') || '0', 10) || 0))];
  if (station) {
    game.player.body.pos.set(station.x, station.y, station.z + 2);
    game.player.body.vel.set(0, 0, 0);
    game.player.yaw = Math.PI / 2; // face the three signal pylons on the north edge
    game.player.blocks = 1;
    game.player.grenades = 0;
    game.player.protT = 999;
    setPlaying(true);
  }
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
// Representative post-match composition without waiting through a full
// automated round. Uses the real scoreboard rows, report rules, persistence,
// and Game#_end path; only the seeded result is a browser QA fixture.
if (reportQa) {
  game.gameMode = 'ctf';
  game.player.team = 'green';
  game.captures = { green: 3, blue: 2 };
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
  game._end('green');
}
frame();
