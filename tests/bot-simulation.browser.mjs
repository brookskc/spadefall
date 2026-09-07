// Seeded, accelerated bot-room regression. It intentionally drives a
// real browser build: bot movement, raycasts, terrain edits, objectives and
// missile effects all stay on the same authority path used by a hosted game.
//
// `npm run test:bot-sim` runs 12 valid mode/map pairings with two seeds each.
// Use SPADE_BOT_SIM_SECONDS=300 for a longer local investigation.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const mime = new Map([['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'], ['.svg', 'image/svg+xml']]);
const seconds = Math.max(60, Math.min(720, Number(process.env.SPADE_BOT_SIM_SECONDS) || 180));
const step = 0.05;
const requestedModes = new Set((process.env.SPADE_BOT_SIM_MODES ?? 'ctf,tdm,koth').split(','));
const cases = [
  ...[0, 1, 2].map(map => ['ctf', map]),
  ...[0, 1, 2, 3, 4, 5].map(map => ['tdm', map]),
  ...[3, 4, 5].map(map => ['koth', map]),
].filter(([mode]) => requestedModes.has(mode))
  .flatMap(([mode, map]) => [0x1a2b3c4d, 0x5e6f7788].map(seed => ({ mode, map, seed })));

const server = createServer(async (req, res) => {
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
const origin = `http://127.0.0.1:${server.address().port}`;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.SPADEFALL_BROWSER ?? (process.platform === 'win32' && existsSync(edge) ? edge : undefined),
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--mute-audio'] });
const rows = [];
const browserFaults = [];

try {
  for (const scenario of cases) {
    // A fresh page resets module-level bot IDs, names, clocks, listeners, and
    // instrumented methods. Reusing one Game made later cases inherit wrapper
    // layers and undermined the promise that a seed was reproducible.
    const page = await browser.newPage();
    const faults = [];
    page.on('pageerror', error => faults.push(error.message));
    page.on('console', message => {
      // The game may attempt anonymous diagnostics while this deliberately
      // offline harness runs. A denied external request is not a game fault;
      // JavaScript exceptions and every other console error still fail.
      if (message.type() === 'error'
          && !/404 \(Not Found\)|net::ERR_NETWORK_ACCESS_DENIED/.test(message.text()))
        faults.push(message.text());
    });
    // Do not let visual rAF race the fixed-step driver below.
    await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
    await page.goto(`${origin}/?auto=1&map=${scenario.map}&mode=${scenario.mode}`,
      { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__game?.world);
    const row = await page.evaluate(({ scenario, seconds, step }) => {
      // Seed every game-side random decision, including bot class and patrol
      // noise.  The LCG is simple, reproducible and local to this test page.
      let state = scenario.seed >>> 0;
      Math.random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000);
      const g = window.__game;
      g.mode = 'solo';
      g.gameMode = scenario.mode;
      // Game time is deliberately monotonic in production (for presentation
      // scheduling). Keep each simulation round's measurements local.
      const beganAt = g.time;
      g.rebuild(scenario.seed, scenario.map);
      // A normal solo rebuild has one immobile local player plus 4v5 bots.
      // Remove that player from combat and fill its seat so every measured
      // engagement is an even 5v5 bot room.
      g.player.alive = false;
      g.player.vmRoot.visible = false;
      g.bots.push(g._newBot('green'));
      const m = { deaths: 0, spawnDeaths: 0, edits: 0, digs: 0, builds: 0,
        stuck: 0, contacts: [], reengage: [], deathsByClass: {}, killsByClass: {},
        pickups: 0, returns: 0, captures: 0, flagTransitions: 0, hillOccupied: 0,
        hillContested: 0, strikes: 0, impacts: 0, strikeKills: 0, errors: [] };
      const awaitingContact = new Map();
      const className = gun => gun === 0 ? 'rifle' : gun === 1 ? 'smg'
        : gun === 5 ? 'sniper' : 'unknown';
      const oldDeath = g.onDeath.bind(g);
      g.onDeath = (victim, killer) => {
        if (victim?.id !== undefined) {
          m.deaths++;
          // A protected spawn lasts at most three seconds (and drains faster
          // once moving); count only deaths in that actual safety window.
          if (g.time - (victim._spawnedAt ?? -Infinity) <= 3) m.spawnDeaths++;
          if (victim._deathCause === 'airstrike') m.strikeKills++;
          const key = className(victim.gunClass);
          m.deathsByClass[key] = (m.deathsByClass[key] ?? 0) + 1;
          if (killer?.id !== undefined) {
            const kk = className(killer.gunClass);
            m.killsByClass[kk] = (m.killsByClass[kk] ?? 0) + 1;
          }
          awaitingContact.set(victim.id, g.time);
        }
        return oldDeath(victim, killer);
      };
      const oldEdit = g.applyEdit.bind(g);
      g.applyEdit = (x, y, z, value, who) => {
        const ok = oldEdit(x, y, z, value, who);
        if (ok && who?.id !== undefined) { m.edits++; if (value) m.builds++; else m.digs++; }
        return ok;
      };
      const oldStrike = g._confirmAirstrike.bind(g);
      g._confirmAirstrike = (...args) => { if (args[0]?.id !== undefined) m.strikes++; return oldStrike(...args); };
      const oldImpact = g._airstrikeImpact.bind(g);
      g._airstrikeImpact = (...args) => { if (args[1]?.id !== undefined) m.impacts++; return oldImpact(...args); };
      const oldFlags = g._updateFlags.bind(g);
      g._updateFlags = dt => {
        const before = Object.fromEntries(Object.entries(g.flags).map(([team, f]) => [team, f.state]));
        const scoreBefore = (g.captures.green ?? 0) + (g.captures.blue ?? 0);
        oldFlags(dt);
        m.captures += Math.max(0,
          (g.captures.green ?? 0) + (g.captures.blue ?? 0) - scoreBefore);
        for (const [team, f] of Object.entries(g.flags)) if (f.state !== before[team]) {
          m.flagTransitions++;
          if (before[team] !== 'carried' && f.state === 'carried') m.pickups++;
          if (before[team] === 'dropped' && f.state === 'home') m.returns++;
        }
      };
      const oldHill = g._updateHill.bind(g);
      g._updateHill = dt => { oldHill(dt); const h = g.hill; if (h?.contested) m.hillContested += dt;
        else if ((h?.presence.green ?? 0) + (h?.presence.blue ?? 0) > 0) m.hillOccupied += dt; };
      const sample = () => {
        const alive = g.bots.filter(b => b.alive);
        for (const b of alive) m.stuck += b.telemetry?.stuckRecoveries ?? 0;
        // telemetry is cumulative; reset after each sample to avoid multiplying it.
        for (const b of alive) if (b.telemetry) b.telemetry.stuckRecoveries = 0;
        let contact = false;
        for (const a of alive) {
          const engaged = alive.some(b => a.team !== b.team
            && Math.hypot(a.body.pos.x - b.body.pos.x, a.body.pos.z - b.body.pos.z) < 30);
          if (!engaged) continue;
          contact = true;
          if (awaitingContact.has(a.id)) {
            m.reengage.push(g.time - awaitingContact.get(a.id));
            awaitingContact.delete(a.id);
          }
        }
        if (contact) m.contacts.push(g.time);
      };
      let sampleAt = 1;
      for (let i = 0, n = Math.round(seconds / step); i < n; i++) {
        try { g.update(step); } catch (error) { m.errors.push(String(error)); break; }
        if (g.time - beganAt >= sampleAt) { sample(); sampleAt += 1; }
        if (g.over) break;
      }
      const sorted = values => values.slice().sort((a, b) => a - b);
      const percentile = (values, p) => values.length ? values[Math.min(values.length - 1,
        Math.floor((values.length - 1) * p))] : null;
      const botById = new Map(g.bots.map(b => [b.id, b]));
      const kd = [...g.kd].filter(([key]) => key.startsWith('b')).map(([key, r]) => {
        const bot = botById.get(Number(key.slice(1)));
        return { name: r.name, class: bot?.gunClass ?? null, k: r.k, d: r.d };
      });
      return { ...scenario, elapsed: g.matchElapsed, score: g.captures, over: g.over,
        ...m, contacts: m.contacts.length,
        firstContact: m.contacts.length ? m.contacts[0] - beganAt : null,
        reengageMedian: percentile(sorted(m.reengage), .5), reengageP90: percentile(sorted(m.reengage), .9),
        botLives: g.bots.length, botKd: kd,
        editsPerMatch: m.edits, telemetry: g.botTelemetry(), faults: window.__spadefallDiagnostics?.faults ?? [] };
    }, { scenario, seconds, step });
    row.browserFaults = faults;
    browserFaults.push(...faults);
    rows.push(row);
    console.log(`${row.mode}/${row.map}/${row.seed.toString(16)} score ${row.score.green}-${row.score.blue}`
      + ` deaths ${row.deaths} spawn ${row.spawnDeaths} edits ${row.edits} stuck ${row.stuck}`
      + ` contact ${row.firstContact?.toFixed(0) ?? '-'}s p90 ${row.reengageP90?.toFixed(0) ?? '-'}s`
      + ` flags ${row.pickups}/${row.captures}`);
    await page.close();
  }
  const blank = () => ({ rounds: 0, deaths: 0, spawnDeaths: 0, edits: 0,
    stuck: 0, contacts: 0, hillOccupied: 0, hillContested: 0, strikes: 0,
    impacts: 0, pickups: 0, returns: 0, captures: 0, killsByClass: {}, deathsByClass: {} });
  const add = (a, r) => {
    a.rounds++; a.deaths += r.deaths; a.spawnDeaths += r.spawnDeaths;
    a.edits += r.edits; a.stuck += r.stuck; a.contacts += r.contacts;
    a.hillOccupied += r.hillOccupied; a.hillContested += r.hillContested;
    a.strikes += r.strikes; a.impacts += r.impacts; a.pickups += r.pickups;
    a.returns += r.returns; a.captures += r.captures;
    for (const [key, value] of Object.entries(r.killsByClass))
      a.killsByClass[key] = (a.killsByClass[key] ?? 0) + value;
    for (const [key, value] of Object.entries(r.deathsByClass))
      a.deathsByClass[key] = (a.deathsByClass[key] ?? 0) + value;
    return a;
  };
  const aggregate = rows.reduce(add, blank());
  assert.ok(rows.length > 0, 'no bot simulation cases selected');
  const byMode = Object.fromEntries(['ctf', 'tdm', 'koth'].map(mode =>
    [mode, rows.filter(row => row.mode === mode).reduce(add, blank())]));
  const report = { seconds, rounds: rows.length, aggregate, byMode,
    spawnDeathRate: aggregate.deaths ? aggregate.spawnDeaths / aggregate.deaths : 0,
    averageEdits: aggregate.edits / Math.max(1, rows.length),
    worstFirstContact: Math.max(...rows.map(row => row.firstContact ?? Infinity)),
    worstReengageP90: Math.max(...rows.map(row => row.reengageP90 ?? 0)) };
  console.log('BOT_SIM_REPORT=' + JSON.stringify(
    process.env.SPADE_BOT_SIM_VERBOSE ? { ...report, cases: rows } : report));
  assert.deepEqual(browserFaults, [], browserFaults.join('\n'));
  assert.ok(rows.every(r => !r.errors.length && !r.faults.length), JSON.stringify(rows.filter(r => r.errors.length || r.faults.length)));
  assert.ok(report.spawnDeathRate < .15, `spawn deaths ${report.spawnDeathRate.toFixed(3)}`);
  assert.ok(report.averageEdits < 1000, `terrain edits ${report.averageEdits.toFixed(1)}/round`);
  assert.ok(report.worstFirstContact <= 90, `first contact ${report.worstFirstContact.toFixed(1)}s`);
  if (byMode.koth.rounds) assert.ok(byMode.koth.hillOccupied >= 60,
    'KOTH bots rarely reached an objective');
  assert.equal(aggregate.impacts, aggregate.strikes, 'confirmed bot strikes did not all impact');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
