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
const base = `http://127.0.0.1:${port}/?auto=1&code=TEST&ns=${namespace}&map=0&mode=ctf`;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const executablePath = process.env.SPADEFALL_BROWSER
  ?? (process.platform === 'win32' && existsSync(edge) ? edge : undefined);
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
    null, { timeout: 5_000 });
  await guest.evaluate(previous => {
    window.__game.player.selectClass(previous);
  }, intermissionClass.current);
  await host.waitForFunction(previous => [...window.__game.remote.values()][0]?._pendingClass === previous,
    intermissionClass.current, { timeout: 5_000 });

  const hostPosition = await host.evaluate(() => {
    const p = [...window.__game.remote.values()][0].body.pos;
    return { x: p.x, y: p.y, z: p.z };
  });
  const targetX = await guest.evaluate(position => {
    const game = window.__game, player = game.player;
    game._sendT = 999;
    game.net.send({ t: 's', x: position.x + 0.1, y: position.y,
      z: position.z, yaw: player.yaw, tool: player.tool,
      c: player.crouched ? 1 : 0, ts: performance.now() });
    return position.x + 0.1;
  }, hostPosition);
  await host.waitForFunction(x => {
    const remote = [...window.__game.remote.values()][0];
    return remote && Math.abs(remote.body.pos.x - x) < 0.025;
  }, targetX, { timeout: 5_000 });

  await host.evaluate(() => window.__game.net.broadcast({
    t: 'e', k: 'msg', text: 'TWO BROWSER LINK', color: '#fff',
  }));
  await guest.waitForFunction(() => document.getElementById('msg')?.textContent
    ?.includes('TWO BROWSER LINK'), null, { timeout: 5_000 });

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
    ?.includes('voted to remove you'), null, { timeout: 8_000 });
  await host.waitForFunction(() => window.__game?.remote?.size === 1,
    null, { timeout: 8_000 });

  assert.deepEqual(faults, [], faults.join('\n'));
  console.log('multiplayer browsers: replication, live settings, chat policy, and vote-kick passed');
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
