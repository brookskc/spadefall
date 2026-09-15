// Two real Chromium pages joined over the same PeerJS/WebRTC path players use.
// The test owns a tiny static server; no application-only transport is injected.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');

const root = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const mime = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.png', 'image/png'],
]);

const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const path = normalize(join(root, relative));
    if (!path.startsWith(root) || !(await stat(path)).isFile()) throw new Error('not found');
    res.writeHead(200, { 'content-type': mime.get(extname(path)) ?? 'application/octet-stream',
      'cache-control': 'no-store' });
    res.end(await readFile(path));
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const namespace = `ci${Date.now().toString(36)}`.slice(-16);
const base = `http://127.0.0.1:${port}/?auto=1&code=TEST&ns=${namespace}&map=1&mode=tdm`;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const executablePath = process.env.SPADEFALL_BROWSER
  ?? (process.platform === 'win32' && existsSync(edge) ? edge : undefined);
// GitHub's shared runners can pause a busy Chromium tab for several seconds.
// Keep local failures quick while allowing bounded CI synchronization time.
const syncTimeout = process.env.CI ? 30_000 : 5_000;
const browser = await chromium.launch({ headless: true, executablePath });
const host = await browser.newPage();
const guest = await browser.newPage();
const target = await browser.newPage();
const faults = [];
for (const [name, page] of [['host', host], ['guest', guest], ['target', target]]) {
  page.on('pageerror', error => faults.push(`${name}: ${error.message}`));
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (response.status() >= 400 && path !== '/favicon.ico' && !path.endsWith('.map'))
      faults.push(`${name}: ${response.status()} ${path}`);
  });
}

try {
  await host.goto(`${base}&mp=host`, { waitUntil: 'domcontentloaded' });
  await host.waitForFunction(() => window.__net?.peer?.open === true, null, { timeout: 20_000 });
  await guest.goto(`${base}&mp=join`, { waitUntil: 'domcontentloaded' });
  await guest.waitForFunction(() => window.__game?.myId && window.__game?.myIdx != null,
    null, { timeout: 25_000 });
  await host.waitForFunction(() => window.__game?.remote?.size === 1,
    null, { timeout: 10_000 });

  const identity = await guest.evaluate(() => ({
    mode: window.__game.mode, id: window.__game.myId, index: window.__game.myIdx,
    roster: window.__game._rosterP.size,
  }));
  assert.equal(identity.mode, 'client');
  assert.ok(identity.id);
  assert.ok(identity.roster >= 2, 'guest received the authoritative roster');

  // A fresh-browser guest must traverse the complete authoritative lifecycle:
  // host damage -> validated death recap -> team-wave countdown -> host spawn
  // event -> live player with every death-only HUD layer cleared. Previously
  // this suite tested spawn preferences by hand-toggling alive, so a recap or
  // protocol regression could strand real players while CI remained green.
  await guest.evaluate(() => {
    const game = window.__game;
    game._auditClientEvent = game._clientEvent.bind(game);
    game._auditDroppedSpawn = false;
    game._clientEvent = event => {
      if (event.k === 'spawn') { game._auditDroppedSpawn = true; return; }
      game._auditClientEvent(event);
    };
  });
  const death = await host.evaluate(() => {
    const game = window.__game;
    const remote = [...game.remote.values()][0];
    remote.protT = 0;
    game.damage(remote, 200, game.player, game.player.body.pos,
      { cause: 'rifle', ignoreProtection: true });
    return { alive: remote.alive, redeploy: game.respawnTimers.get(remote) };
  });
  assert.equal(death.alive, false, 'host records the guest death');
  assert.ok(death.redeploy > 0 && death.redeploy <= 9,
    'host schedules the guest on a bounded respawn wave');
  await guest.waitForFunction(() => !window.__game.player.alive
    && document.getElementById('deathRecap')?.classList.contains('on')
    && Number.parseFloat(getComputedStyle(document.getElementById('respawn')).opacity) > 0,
  null, { timeout: syncTimeout });
  await guest.waitForFunction(() => window.__game._auditDroppedSpawn
    && window.__game.player.alive
    && window.__game.player.health === 100
    && !document.getElementById('deathRecap')?.classList.contains('on'),
  null, { timeout: 12_000 });
  const respawnHud = await guest.evaluate(() => {
    const game = window.__game;
    game._clientEvent = game._auditClientEvent;
    delete game._auditClientEvent;
    return {
      recap: document.getElementById('deathRecap').className,
      countdown: getComputedStyle(document.getElementById('respawn')).opacity,
      classPick: getComputedStyle(document.getElementById('classPick')).opacity,
      spawnPick: getComputedStyle(document.getElementById('spawnPick')).opacity,
    };
  });
  assert.deepEqual(respawnHud, {
    recap: '', countdown: '0', classPick: '0', spawnPick: '0',
  }, 'respawn clears every death-only HUD layer');

  // Reproduce the production failure more aggressively: acknowledge away
  // both the reliable spawn event and the snapshot row that first says the
  // Beachhead player is alive. Ordinary heartbeats continue, so migration
  // cannot accidentally mask the bug. The expired client countdown must ask
  // authority to replay the exact life and clear the death camera/HUD.
  await host.evaluate(guestId => {
    const game = window.__game;
    const sendTo = game.net.sendTo.bind(game.net);
    const hostResync = game._hostResync.bind(game);
    game._auditSendTo = sendTo;
    game._auditHostResync = hostResync;
    game._auditRespawnRepair = false;
    game._auditSuppressedSpawn = false;
    game._auditSuppressedLiveRow = false;
    game._hostResync = (id, scope, repair) => {
      if (id === guestId && scope === 'state' && repair?.dead)
        game._auditRespawnRepair = true;
      return hostResync(id, scope, repair);
    };
    game.net.sendTo = (id, message) => {
      if (id !== guestId || game._auditRespawnRepair) return sendTo(id, message);
      if (message?.t === 'e' && message.k === 'spawn') {
        game._auditSuppressedSpawn = true;
        return true;
      }
      if (message?.t === 's' && message.p?.some(row => row[0] === game.remote.get(id)?.ridx
          && row[6] === 1)) {
        game._auditSuppressedLiveRow = true;
        return sendTo(id, { ...message,
          p: message.p.filter(row => row[0] !== game.remote.get(id)?.ridx) });
      }
      return sendTo(id, message);
    };
  }, identity.id);
  await host.evaluate(() => {
    const game = window.__game;
    const remote = [...game.remote.values()][0];
    remote.protT = 0;
    game.damage(remote, 200, game.player, game.player.body.pos,
      { cause: 'rifle', ignoreProtection: true });
  });
  await guest.waitForFunction(() => !window.__game.player.alive,
    null, { timeout: syncTimeout });
  await guest.waitForFunction(() => window.__game.player.alive
    && window.__game._respawnRepairAt === Infinity
    && !document.getElementById('deathRecap')?.classList.contains('on'),
  null, { timeout: 12_000 });
  const repairedLife = await host.evaluate(() => {
    const game = window.__game;
    const remote = [...game.remote.values()][0];
    return { repair: game._auditRespawnRepair,
      spawn: game._auditSuppressedSpawn, row: game._auditSuppressedLiveRow,
      authoritativeLife: remote._life };
  });
  assert.deepEqual({ repair: repairedLife.repair, spawn: repairedLife.spawn,
    row: repairedLife.row }, { repair: true, spawn: true, row: true },
  'expired Beachhead death wait requests an authoritative respawn replay');
  assert.equal(await guest.evaluate(() => window.__game._serverLife),
    repairedLife.authoritativeLife, 'respawn repair restores the exact authoritative life');
  await host.evaluate(() => {
    const game = window.__game;
    game.net.sendTo = game._auditSendTo;
    game._hostResync = game._auditHostResync;
  });

  const intermissionClass = await guest.evaluate(() => {
    const game = window.__game;
    const current = game.player.gunClass;
    game.over = true;
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Digit3', bubbles: true }));
    const result = {
      current,
      equipped: game.player.gunClass,
      pending: game.player._pendingClass,
      endPicked: document.querySelector('#endClassOpts [data-cls="5"]')?.classList.contains('picked'),
      homePicked: document.querySelector('#startClassOpts [data-cls="5"]')?.classList.contains('picked'),
    };
    game.over = false;
    return result;
  });
  assert.equal(intermissionClass.pending, 5,
    '1/2/3 changes the pending class during results');
  assert.equal(intermissionClass.equipped, intermissionClass.current,
    'a results choice does not rewrite the completed-round weapon');
  assert.equal(intermissionClass.endPicked, true,
    'the results class control highlights the pending class');
  assert.equal(intermissionClass.homePicked, true,
    'all class controls stay visually synchronized');
  await host.waitForFunction(() => [...window.__game.remote.values()][0]?._pendingClass === 5,
    null, { timeout: syncTimeout });
  await guest.evaluate(previous => {
    window.__game.player.selectClass(previous);
  }, intermissionClass.current);
  await host.waitForFunction(previous => [...window.__game.remote.values()][0]?._pendingClass === previous,
    intermissionClass.current, { timeout: syncTimeout });

  await host.evaluate(() => { [...window.__game.remote.values()][0].alive = false; });
  await guest.evaluate(() => {
    const game = window.__game;
    game.player.alive = false;
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyB', bubbles: true }));
  });
  await host.waitForFunction(() => [...window.__game.remote.values()][0]?._spawnPreference === 'base',
    null, { timeout: syncTimeout });
  await guest.evaluate(() => { window.__game.player.alive = true; });
  await host.evaluate(() => { [...window.__game.remote.values()][0].alive = true; });

  // End Beachhead with a real final kill. This is the exact camera state a
  // player can mistake for a failed respawn: the results renderer switches
  // to a high three-quarter view while Game continues ticking networking.
  const finalDeath = await host.evaluate(() => {
    const game = window.__game;
    const victim = [...game.remote.values()][0];
    game.captures[game.player.team] = 49;
    game.respawnTimers.set(game.player, 0.01); // an older pending wave
    victim.protT = 0;
    game.damage(victim, 200, game.player, game.player.body.pos,
      { cause: 'rifle', ignoreProtection: true });
    return { over: game.over, victimAlive: victim.alive,
      pendingRespawns: game.respawnTimers.size };
  });
  assert.deepEqual(finalDeath, { over: true, victimAlive: false, pendingRespawns: 0 },
    'a final death enters results and cancels every pending respawn wave');
  await guest.waitForFunction(() => window.__game.over
    && window.__game._battleChoices.length === 3, null, { timeout: syncTimeout });
  const resultsState = await guest.evaluate(() => {
    const game = window.__game;
    const p = game.player, position = p.body.pos.clone();
    // A late spawn edge from a wave queued before the final score is stale.
    game._clientEvent({ t: 'e', k: 'spawn', x: position.x, y: position.y,
      z: position.z, yaw: p.yaw, life: Math.min(1e6, game._serverLife + 1) });
    return { alive: p.alive,
      resultsVisible: !document.getElementById('end').classList.contains('hidden'),
      recap: document.getElementById('deathRecap').className,
      countdown: getComputedStyle(document.getElementById('respawn')).opacity };
  });
  assert.deepEqual(resultsState,
    { alive: false, resultsVisible: true, recap: '', countdown: '0' },
    'the final-death aerial view is visibly results and rejects stale respawns');
  const frozenResults = await host.evaluate(() => {
    const game = window.__game, p = game.player;
    const bot = game.bots.find(candidate => candidate.alive);
    const before = { ammo: p.ammo[p.tool], fov: p.camera.fov,
      player: p.body.pos.clone(), bot: bot?.body.pos.clone() };
    p._aimToggled = true;
    p.controls.set('Mouse0', true);
    p.controls.set('Mouse2', true);
    p.update(0.5);
    game.update(0.5);
    const result = { ammo: p.ammo[p.tool], fov: p.camera.fov,
      playerMoved: p.body.pos.distanceTo(before.player) > 0.001,
      botMoved: bot ? bot.body.pos.distanceTo(before.bot) > 0.001 : false,
      pendingRespawns: game.respawnTimers.size };
    p._aimToggled = false;
    p.controls.clear();
    return { before: { ammo: before.ammo, fov: before.fov }, result };
  });
  assert.deepEqual(frozenResults.result, {
    ammo: frozenResults.before.ammo, fov: frozenResults.before.fov,
    playerMoved: false, botMoved: false, pendingRespawns: 0,
  }, 'results camera cannot zoom, fire, move combatants, or process respawns');
  await guest.evaluate(() => { window.__game.requestIntermissionReady(); });
  await host.waitForFunction(() => window.__game._intermissionReady.size === 1,
    null, { timeout: syncTimeout });
  await guest.waitForFunction(() => document.getElementById('readyBtn')?.textContent.includes('1/2'),
    null, { timeout: syncTimeout });
  await guest.evaluate(() => {
    window.__game.over = false;
    window.__game.winner = null;
    window.__game.captures = { green: 0, blue: 0 };
    window.__game._intermissionReady.clear();
    document.getElementById('end').classList.add('hidden');
  });
  await host.evaluate(() => {
    const game = window.__game;
    game.over = false;
    game.winner = null;
    game.captures = { green: 0, blue: 0 };
    game._rotateT = null;
    game._intermissionReady.clear();
    document.getElementById('end').classList.add('hidden');
    [...game.remote.values()][0].respawn();
  });
  await guest.waitForFunction(() => window.__game.player.alive,
    null, { timeout: syncTimeout });

  await guest.evaluate(() => { window.__game._sendT = 999; });
  const hostPosition = await host.evaluate(() => {
    const game = window.__game, p = [...game.remote.values()][0];
    p._movementBudget = null;
    p._lastPosT = game.time - 0.1;
    const pos = p.body.pos;
    return { x: pos.x, y: pos.y, z: pos.z };
  });
  const targetX = await guest.evaluate(position => {
    const game = window.__game, player = game.player;
    game.net.send({ t: 's', x: position.x + 0.1, y: position.y,
      z: position.z, yaw: player.yaw, tool: player.tool,
      c: player.crouched ? 1 : 0, life: game._serverLife, ts: performance.now() });
    return position.x + 0.1;
  }, hostPosition);
  await host.waitForFunction(x => {
    const remote = [...window.__game.remote.values()][0];
    return remote && Math.abs(remote.body.pos.x - x) < 0.025;
  }, targetX, { timeout: syncTimeout });

  await host.evaluate(() => window.__game.net.broadcast({
    t: 'e', k: 'msg', text: 'TWO BROWSER LINK', color: '#fff',
  }));
  await guest.waitForFunction(() => document.getElementById('msg')?.textContent
    ?.includes('TWO BROWSER LINK'), null, { timeout: syncTimeout });

  const liveSettings = await host.evaluate(() => {
    document.querySelector('#gfxOpts [data-gfx="low"]').click();
    document.querySelector('#colorOpts [data-value="accessible"]').click();
    const game = window.__game;
    let hiddenDetail = 0;
    const remote = [...game.remote.values()][0];
    remote.avatar.parts.group.traverse(object => {
      if (object.userData?.gfxMin !== 'low' && object.visible === false) hiddenDetail++;
    });
    return {
      ambience: game.world.ambience.count,
      debris: game.effects.maxDebris,
      block: game.player._blockMat.color.getHex(),
      team: game.player.team,
      hiddenDetail,
    };
  });
  assert.equal(liveSettings.ambience, 24);
  assert.equal(liveSettings.debris, 80);
  assert.equal(liveSettings.block,
    liveSettings.team === 'green' ? 0xe69f00 : 0x56b4e9);
  assert.ok(liveSettings.hiddenDetail > 0, 'existing soldiers update with the live graphics preset');

  const underwaterHud = await host.evaluate(() => {
    const hud = document.getElementById('hud');
    const air = document.getElementById('air');
    const chat = document.getElementById('chat');
    const line = document.createElement('div');
    line.textContent = 'CHAT CLEARANCE TEST';
    document.getElementById('chatlog').append(line);
    hud.classList.add('air-visible');
    air.classList.add('on');
    const chatRect = chat.getBoundingClientRect();
    const chatKeyRect = document.getElementById('chatkey').getBoundingClientRect();
    const vitalsRect = document.getElementById('vitals').getBoundingClientRect();
    line.remove();
    air.classList.remove('on');
    hud.classList.remove('air-visible');
    return { chatBottom: chatRect.bottom, chatKeyBottom: chatKeyRect.bottom,
      vitalsTop: vitalsRect.top };
  });
  assert.ok(underwaterHud.vitalsTop - underwaterHud.chatBottom >= 8,
    'the breathing meter keeps clear of chat text above it');
  assert.ok(underwaterHud.vitalsTop - underwaterHud.chatKeyBottom >= 8,
    'the breathing meter keeps clear of the chat and scoreboard hint');

  const damageArrowStyle = await host.evaluate(() => {
    const style = getComputedStyle(document.querySelector('#dmgDir .chevron'));
    return { clipPath: style.clipPath, backgroundImage: style.backgroundImage,
      borderRadius: style.borderRadius };
  });
  assert.ok(damageArrowStyle.clipPath.startsWith('polygon('),
    'damage direction uses a stepped voxel silhouette');
  assert.equal(damageArrowStyle.backgroundImage, 'none');
  assert.equal(damageArrowStyle.borderRadius, '0px');

  const chatDefault = await guest.evaluate(() => {
    window.__game.chat.open('all');
    const allOpen = window.__game.chat.isOpen;
    window.__game.chat.open('team');
    const teamOpen = window.__game.chat.isOpen;
    window.__game.chat.close();
    return { allOpen, teamOpen };
  });
  assert.deepEqual(chatDefault, { allOpen: false, teamOpen: true },
    'public chat is off while team chat remains available');

  await target.goto(`${base}&mp=join`, { waitUntil: 'domcontentloaded' });
  await target.waitForFunction(() => window.__game?.myId && window.__game?.myIdx != null,
    null, { timeout: 25_000 });
  await host.waitForFunction(() => window.__game?.remote?.size === 2,
    null, { timeout: 10_000 });
  const targetIndex = await target.evaluate(() => window.__game.myIdx);
  assert.equal(await host.evaluate(index => window.__game.requestVoteKick(index), targetIndex), true);
  await guest.evaluate(index => window.__game.requestVoteKick(index), targetIndex);
  await target.waitForFunction(() => document.getElementById('lobbyStatus')?.textContent
    ?.includes('voted to remove you'), null, { timeout: syncTimeout });
  await host.waitForFunction(() => window.__game?.remote?.size === 1,
    null, { timeout: syncTimeout });

  const currentClass = await host.evaluate(() => {
    const game = window.__game;
    game._roundEndReleasedMouse = false;
    const release = game.onRoundEnd;
    game.onRoundEnd = () => { game._roundEndReleasedMouse = true; release?.(); };
    game._end(game.player.team);
    return game.player._pendingClass;
  });
  const nextClass = currentClass === 5 ? 0 : 5;
  await host.locator(`#endClassOpts [data-cls="${nextClass}"]`).click();
  const resultsMouse = await host.evaluate(expected => ({
    released: window.__game._roundEndReleasedMouse,
    visible: !document.getElementById('end').classList.contains('hidden'),
    pending: window.__game.player._pendingClass,
  }), nextClass);
  assert.deepEqual(resultsMouse, { released: true, visible: true, pending: nextClass },
    'round end releases capture and its class buttons accept mouse input');
  await host.evaluate(() => { window.__game._rotateT = 0.05; });
  await host.waitForFunction(expected => !window.__game.over
    && window.__game.player.gunClass === expected
    && document.getElementById('end')?.classList.contains('hidden'),
  nextClass, { timeout: syncTimeout });
  await guest.waitForFunction(() => !window.__game.over, null, { timeout: syncTimeout });

  const voxelRoute = await host.evaluate(() => {
    const game = window.__game;
    game.gameMode = 'koth';
    game.rebuild(12345, 4);
    const protectedBefore = game.world.get(96, 28, 128);
    const protectedEdit = game.applyEdit(96, 28, 128, 0);
    const spanBefore = game.world.get(128, 28, 96);
    const revision = game.navRevision;
    const cut = game.applyEdit(128, 28, 96, 0);
    const opened = game.world.get(128, 28, 96) === 0;
    const rebuilt = game.applyEdit(128, 28, 96, 4)
      && game.world.get(128, 28, 96) === 4;
    return { protectedBefore, protectedEdit,
      protectedAfter: game.world.get(96, 28, 128),
      spanBefore, cut, opened, rebuilt, routeInvalidated: game.navRevision > revision };
  });
  assert.equal(voxelRoute.protectedEdit, false,
    'Crown fallback foundations reject destructive edits');
  assert.equal(voxelRoute.protectedAfter, voxelRoute.protectedBefore,
    'Crown fallback survives the attempted edit');
  assert.ok(voxelRoute.spanBefore && voxelRoute.cut && voxelRoute.opened
    && voxelRoute.rebuilt && voxelRoute.routeInvalidated,
  'Crown span can be cut and rebuilt while invalidating bot route caches');

  assert.deepEqual(faults, [], faults.join('\n'));
  console.log('multiplayer browsers: replication, live settings, results input, chat policy, vote-kick, and voxel-route edits passed');
} catch (error) {
  if (faults.length) error.message += `\n${faults.join('\n')}`;
  try {
    const state = await host.evaluate(() => ({
      hasGame: !!window.__game,
      mode: window.__game?.mode,
      hasNet: !!window.__net,
      peerOpen: window.__net?.peer?.open,
      lobby: document.getElementById('lobbyStatus')?.textContent,
      diagnostics: window.__spadefallDiagnostics?.faults,
    }));
    console.error('host state:', state);
  } catch { /* page may already be unavailable */ }
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
