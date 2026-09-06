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

  const health = await Promise.all(pages.map(page => page.evaluate(() => ({
    faults: window.__spadefallDiagnostics?.faults ?? [],
    mode: window.__game?.mode,
    net: window.__net?.stats?.(),
  }))));
  assert.ok(health.every(row => row.net?.recvPackets > 0 || row.mode === 'host'));
  assert.deepEqual(faults, [], faults.join('\n'));
  assert.ok(health.every(row => row.faults.length === 0), JSON.stringify(health));
  console.log(`full-room browsers: ${count} players, ${seconds}s traffic, reload reclaim passed`);
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
