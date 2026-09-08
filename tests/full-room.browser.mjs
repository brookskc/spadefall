// Real full-room WebRTC smoke/soak. Defaults to a short CI pass; pre-release:
//   SPADE_STRESS_SECONDS=3600 npm run test:stress
// Against production TURN only:
//   SPADE_STRESS_BASE_URL=https://spadefall.io SPADE_STRESS_RELAY_ONLY=1 npm run test:stress
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const mime = new Map([['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.png', 'image/png']]);
let server = null;
let origin = process.env.SPADE_STRESS_BASE_URL;
if (!origin) {
  server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const path = normalize(join(root, pathname === '/' ? 'index.html' : pathname.slice(1)));
      if (!path.startsWith(root) || !(await stat(path)).isFile()) throw new Error('not found');
      res.writeHead(200, { 'content-type': mime.get(extname(path)) ?? 'application/octet-stream',
        'cache-control': 'no-store' });
      res.end(await readFile(path));
    } catch { res.writeHead(404); res.end('not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
}

const seconds = Math.max(5, Math.min(3600, Number(process.env.SPADE_STRESS_SECONDS) || 10));
const count = Math.max(2, Math.min(10, Number(process.env.SPADE_STRESS_CLIENTS) || 10));
const namespace = `full${Date.now().toString(36)}`.slice(-16);
const relay = process.env.SPADE_STRESS_RELAY_ONLY === '1' ? '&relayonly=1' : '';
const base = `${origin.replace(/\/$/, '')}/?auto=1&code=LOAD&ns=${namespace}&map=0&mode=tdm${relay}`;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const executablePath = process.env.SPADEFALL_BROWSER
  ?? (process.platform === 'win32' && existsSync(edge) ? edge : undefined);
const browser = await chromium.launch({ headless: true, executablePath, args: [
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
] });
const pages = [];
const faults = [];

try {
  for (let i = 0; i < count; i++) {
    const page = await browser.newPage();
    pages.push(page);
    await page.addInitScript(index => {
      localStorage.setItem('tos.gfx', 'low');
      localStorage.setItem('tos.callsign', `LOAD${index}`);
    }, i);
    page.on('pageerror', error => faults.push(`p${i}: ${error.message}`));
    page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (response.status() >= 400 && path !== '/favicon.ico' && !path.endsWith('.map'))
        faults.push(`p${i}: ${response.status()} ${path}`);
    });
    await page.goto(`${base}&mp=${i ? 'join' : 'host'}`, { waitUntil: 'domcontentloaded' });
    if (!i) {
      await page.waitForFunction(() => window.__net?.peer?.open === true,
        null, { timeout: 25_000 });
      await page.evaluate(() => {
        window.__integrityTrace = [];
        const game = window.__game, original = game._securityViolation.bind(game);
        game._securityViolation = (player, kind, severity, correct) => {
          window.__integrityTrace.push({ name: player?.name, kind, severity,
            x: player?.body?.pos?.x, y: player?.body?.pos?.y, z: player?.body?.pos?.z });
          return original(player, kind, severity, correct);
        };
      });
    }
    else {
      await page.waitForFunction(() => window.__game?.myIdx != null,
        null, { timeout: 30_000 });
      await pages[0].bringToFront();
      await pages[0].waitForFunction(expected => window.__game?.remote?.size === expected,
        i, { timeout: 30_000 });
    }
  }

  const host = pages[0];
  await host.waitForFunction(expected => window.__game?.remote?.size === expected - 1,
    count, { timeout: 30_000 });
  await Promise.all(pages.slice(1).map(page => page.waitForFunction(expected =>
    window.__game?._rosterP?.size === expected, count, { timeout: 15_000 })));

  // A duplicate browser tab carrying a live soldier's resume token must
  // rebind that seat instead of creating a second remote. The old page is
  // retired by an explicit kick, so it must not enter migration.
  const hostRemoteCount = await host.evaluate(() => window.__game.remote.size);
  const retired = pages[1];
  const originalIdentity = await retired.evaluate(() => ({
    id: window.__game.myId, idx: window.__game.myIdx,
    token: sessionStorage.getItem('spadefall.resume'),
  }));
  assert.ok(originalIdentity.token, 'live guest has a resume token');
  const openOverlap = async (token, label) => {
    const page = await browser.newPage();
    await page.addInitScript(({ token: value, name }) => {
      sessionStorage.setItem('spadefall.resume', value);
      localStorage.setItem('tos.gfx', 'low');
      localStorage.setItem('tos.callsign', `OVERLAP${name}`);
    }, { token, name: label });
    page.on('pageerror', error => faults.push(`${label}: ${error.message}`));
    page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (response.status() >= 400 && path !== '/favicon.ico' && !path.endsWith('.map'))
        faults.push(`${label}: ${response.status()} ${path}`);
    });
    await page.goto(`${base}&mp=join`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__game?.myIdx != null,
      null, { timeout: 30_000 });
    return page;
  };
  const assertOverlap = async (page, oldId, expectedIdx, label) => {
    const identity = await page.evaluate(() => ({
      id: window.__game.myId, idx: window.__game.myIdx,
    }));
    assert.equal(identity.idx, expectedIdx, `${label} preserved roster index`);
    assert.notEqual(identity.id, oldId, `${label} received a new peer id`);
    await host.waitForFunction(({ oldId: stale, id, idx, count: expected }) => {
      const game = window.__game;
      const rows = [...game.remote.entries()].filter(([, player]) => player.ridx === idx);
      return game.remote.size === expected && rows.length === 1 && rows[0][0] === id
        && !game.net.conns.has(stale) && game._reconnectReservations.size === 0;
    }, { oldId, id: identity.id, idx: expectedIdx, count: hostRemoteCount },
    { timeout: 30_000 });
    return identity;
  };
  const overlapOne = await openOverlap(originalIdentity.token, 'overlap1');
  const overlapIdentity = await assertOverlap(overlapOne, originalIdentity.id,
    originalIdentity.idx, 'first overlap');
  await new Promise(resolve => setTimeout(resolve, 1_100));
  await retired.waitForFunction(() => window.__game?.mode === 'solo'
    && window.__game?.net == null && /resumed/i.test(
      document.getElementById('lobbyStatus')?.textContent ?? ''),
  null, { timeout: 10_000 });
  await retired.close();

  // Repeat after a full second: the replacement itself must remain the one
  // live seat, with no delayed reservation or stale connection resurrection.
  const overlapTwo = await openOverlap(originalIdentity.token, 'overlap2');
  await assertOverlap(overlapTwo, overlapIdentity.id, originalIdentity.idx, 'second overlap');
  await new Promise(resolve => setTimeout(resolve, 1_100));
  await overlapOne.waitForFunction(() => window.__game?.mode === 'solo'
    && window.__game?.net == null && /resumed/i.test(
      document.getElementById('lobbyStatus')?.textContent ?? ''),
  null, { timeout: 10_000 });
  await overlapOne.close();
  pages[1] = overlapTwo;

  // Let snapshots, input uplinks, bots, collision, and HUD all run together.
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    await host.evaluate(() => window.__game.net.broadcast({
      t: 'e', k: 'msg', text: 'FULL ROOM HEARTBEAT', color: '#fff',
    }));
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  await host.waitForFunction(() => [...window.__game.remote.values()]
    .every(player => Number.isFinite(player._rttSeconds)), null, { timeout: 10_000 });

  // Reload one real guest. sessionStorage survives; the host's temporary bot
  // covers the body and the returning page must reclaim its roster/score key.
  const reconnect = pages[1];
  const before = await reconnect.evaluate(() => ({ idx: window.__game.myIdx,
    token: sessionStorage.getItem('spadefall.resume') }));
  await host.evaluate(idx => {
    const row = window.__game.kd.get('p' + idx);
    if (row) { row.score = 777; window.__game._scoreDirty = true; }
  }, before.idx);
  await reconnect.reload({ waitUntil: 'domcontentloaded' });
  await reconnect.waitForFunction(() => window.__game?.myIdx != null, null, { timeout: 30_000 });
  const after = await reconnect.evaluate(() => ({ idx: window.__game.myIdx,
    token: sessionStorage.getItem('spadefall.resume') }));
  assert.deepEqual(after, before, 'reload reclaimed the same token and roster index');
  await host.waitForFunction(({ idx, score }) => window.__game.remote.size === score - 1
    && window.__game.kd.get('p' + idx)?.score >= 777, { idx: before.idx, score: count },
  { timeout: 15_000 });

  // Make one visible, authoritative world change before the baton pass. The
  // scan picks a deterministic topmost solid voxel outside every protected
  // area instead of hard-coding a map coordinate that authored terrain might
  // later occupy. It exercises the replicated edit log used for migration and
  // late joins without disturbing a stand, spawn, or the base foundation.
  const migrationState = await host.evaluate(() => {
    const game = window.__game;
    let edit = null;
    for (let x = 72; x <= 184 && !edit; x += 4) for (let z = 72; z <= 184; z += 4) {
      const y = game.world.surface(x, z);
      if (y <= 1 || !game.world.solid(x, y, z) || game.world.solid(x, y + 1, z)) continue;
      if (game._protectedVoxelReason(x, y, z)) continue;
      if (game.applyEdit(x, y, z, 0)) { edit = { x, y, z }; break; }
    }
    if (!edit) throw new Error('no safe editable terrain voxel found');
    game.captures.green = 13;
    game.captures.blue = 8;
    return { edit, score: { green: game.captures.green, blue: game.captures.blue } };
  });
  await Promise.all(pages.slice(1).map(page => page.waitForFunction(state => {
    const game = window.__game;
    return game?.captures?.green === state.score.green && game.captures.blue === state.score.blue
      && game.world?.get(state.edit.x, state.edit.y, state.edit.z) === 0;
  }, migrationState, { timeout: 30_000 })));

  const originalHostHealth = await host.evaluate(() => ({
    faults: window.__spadefallDiagnostics?.faults ?? [], net: window.__net?.stats?.(),
  }));
  const survivors = pages.slice(1);
  // A reload briefly removes its old channel before reclaiming the reserved
  // soldier. Do not pull the host out from under a guest that has seen the
  // score/edit but has not yet received the final post-reclaim roster.
  await Promise.all(survivors.map(page => page.waitForFunction(expected =>
    window.__game?._rosterP?.size === expected, count, { timeout: 30_000 })));
  const survivorIdentity = await Promise.all(survivors.map(page => page.evaluate(() => ({
    id: window.__game.myId, idx: window.__game.myIdx,
  }))));
  await host.close(); // Exercise main.js/Net's real host-drop election path.

  const promotedIndex = await Promise.any(survivors.map((page, index) => page
    .waitForFunction(() => window.__game?.mode === 'host' && window.__game?.migGen === 1,
      null, { timeout: 90_000 }).then(() => index)));
  const migratedHost = survivors[promotedIndex];
  const migratedClients = survivors.filter((_, index) => index !== promotedIndex);
  await Promise.all(migratedClients.map(page => page.waitForFunction(() =>
    window.__game?.mode === 'client' && window.__game?.migGen === 1 && window.__net?.conn?.open,
  null, { timeout: 90_000 })));
  await Promise.all(survivors.map(page => page.waitForFunction(expected => {
    const game = window.__game;
    return game?.mode === 'host'
      ? game._rosterMsg().p.length === expected
      : game?._rosterP?.size === expected;
  }, count - 1, { timeout: 30_000 })));
  await Promise.all(survivors.map(page => page.waitForFunction(state => {
    const game = window.__game;
    return game?.captures?.green === state.score.green
      && game?.captures?.blue === state.score.blue
      && game?.world?.get(state.edit.x, state.edit.y, state.edit.z) === 0;
  }, migrationState, { timeout: 30_000 })));
  const migrationHealth = await Promise.all(survivors.map(page => page.evaluate(() => ({
    mode: window.__game?.mode, generation: window.__game?.migGen,
    remotes: window.__game?.remote?.size, roster: window.__game?._rosterP?.size,
    authoritativeRoster: window.__game?._rosterMsg?.().p.length,
    id: window.__game?.myId, idx: window.__game?.myIdx,
    score: window.__game?.captures,
    faults: window.__spadefallDiagnostics?.faults ?? [],
  }))));
  assert.equal(migrationHealth.filter(row => row.mode === 'host').length, 1,
    'exactly one survivor became the migrated host');
  // The elected peer deliberately adopts the transport id `HOST`; its stable
  // roster index is the player identity that must survive the handoff.
  assert.ok(migrationHealth.every((row, index) => row.idx === survivorIdentity[index].idx),
    `migration changed survivor identity ${JSON.stringify({ survivorIdentity, migrationHealth })}`);
  assert.ok(migrationHealth.every(row => row.generation === 1),
    `migration generation mismatch ${JSON.stringify(migrationHealth)}`);
  assert.ok(migrationHealth.every(row => row.score.green === migrationState.score.green
    && row.score.blue === migrationState.score.blue),
  `migration score mismatch ${JSON.stringify(migrationHealth)}`);
  assert.ok(migrationHealth.every(row => row.mode === 'host'
    ? row.authoritativeRoster === count - 1 : row.roster === count - 1),
  `migration roster mismatch ${JSON.stringify(migrationHealth)}`);
  assert.equal(migrationHealth[promotedIndex].remotes, count - 2,
    'migrated host retained every other survivor');
  // Migration constructs new Net instances, so compare traffic with counters
  // captured after adoption rather than with the retired room's totals.
  const migratedPacketCounts = await Promise.all(survivors.map(page => page.evaluate(() =>
    window.__net?.stats?.().recvPackets ?? 0)));
  await migratedHost.evaluate(() => window.__game.net.broadcast({
    t: 'e', k: 'msg', text: 'MIGRATION HEARTBEAT', color: '#fff',
  }));
  await Promise.all(migratedClients.map(page => {
    const index = survivors.indexOf(page);
    return page.waitForFunction(beforePackets =>
      (window.__net?.stats?.().recvPackets ?? 0) > beforePackets,
    migratedPacketCounts[index], { timeout: 20_000 });
  }));
  await migratedHost.waitForFunction(beforePackets =>
    (window.__net?.stats?.().recvPackets ?? 0) > beforePackets,
  migratedPacketCounts[promotedIndex], { timeout: 20_000 });

  // A newcomer must receive the promoted host's migrated edit log and score,
  // not just a live snapshot from its own fresh map.
  const late = await browser.newPage();
  pages.push(late);
  await late.addInitScript(() => {
    localStorage.setItem('tos.gfx', 'low');
    localStorage.setItem('tos.callsign', 'LATEJOIN');
  });
  late.on('pageerror', error => faults.push(`late: ${error.message}`));
  late.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (response.status() >= 400 && path !== '/favicon.ico' && !path.endsWith('.map'))
      faults.push(`late: ${response.status()} ${path}`);
  });
  const migratedBase = base.replace('code=LOAD', 'code=LOAD-M1');
  await late.goto(`${migratedBase}&mp=join`, { waitUntil: 'domcontentloaded' });
  await late.waitForFunction(() => window.__game?.myIdx != null, null, { timeout: 45_000 });
  await late.waitForFunction(state => window.__game?.captures?.green === state.score.green
    && window.__game.captures.blue === state.score.blue
    && window.__game.world?.get(state.edit.x, state.edit.y, state.edit.z) === 0,
  migrationState, { timeout: 30_000 });
  await migratedHost.waitForFunction(expected => window.__game?.remote?.size === expected,
    count - 1, { timeout: 30_000 });
  await late.waitForFunction(expected => window.__game?._rosterP?.size === expected,
    count, { timeout: 30_000 });

  const health = await Promise.all(survivors.concat(late).map(page => page.evaluate(() => ({
    faults: window.__spadefallDiagnostics?.faults ?? [],
    mode: window.__game?.mode,
    net: window.__net?.stats?.(),
  }))));
  assert.ok(originalHostHealth.net?.recvPackets > 0,
    'the original host received real guest traffic before migration');
  assert.ok(health.every(row => row.net?.recvPackets > 0 || row.mode === 'host'));
  assert.deepEqual(faults, [], faults.join('\n'));
  assert.ok(originalHostHealth.faults.length === 0 && health.every(row => row.faults.length === 0),
    JSON.stringify({ originalHostHealth, health }));
  console.log(`full-room browsers: ${count} players, ${seconds}s traffic, reload reclaim, migration, late join passed`);
} catch (error) {
  const states = [];
  for (let i = 0; i < pages.length; i++) {
    try {
      states.push(await pages[i].evaluate(index => ({ index,
        mode: window.__game?.mode, myIdx: window.__game?.myIdx,
        remotes: window.__game?.remote?.size, roster: window.__game?._rosterP?.size,
        lobby: document.getElementById('lobbyStatus')?.textContent,
        integrity: window.__integrityTrace,
        faults: window.__spadefallDiagnostics?.faults,
      }), i));
    } catch { states.push({ index: i, closed: true }); }
  }
  console.error('full-room states:', JSON.stringify(states), JSON.stringify(faults));
  error.message += `\n${JSON.stringify(states)}\n${faults.join('\n')}`;
  throw error;
} finally {
  await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
