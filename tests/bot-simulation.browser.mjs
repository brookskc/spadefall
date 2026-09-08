// Seeded, accelerated bot-room regression. It intentionally drives a
// real browser build: bot movement, raycasts, terrain edits, objectives and
// missile effects all stay on the same authority path used by a hosted game.
//
// `npm run test:bot-sim` runs 12 valid mode/map pairings with two seeds each.
// Use SPADE_BOT_SIM_SECONDS=300 for a longer local investigation.
// Narrow a diagnostic with SPADE_BOT_SIM_MODES=koth and SPADE_BOT_SIM_MAPS=4.
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
const requestedMaps = new Set((process.env.SPADE_BOT_SIM_MAPS ?? '0,1,2,3,4,5')
  .split(',').map(Number).filter(Number.isInteger));
const cases = [
  ...[0, 1, 2].map(map => ['ctf', map]),
  ...[0, 1, 2, 3, 4, 5].map(map => ['tdm', map]),
  ...[3, 4, 5].map(map => ['koth', map]),
].filter(([mode, map]) => requestedModes.has(mode) && requestedMaps.has(map))
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
const validDiagnosticPoint = point => point
  && [point.x, point.y, point.z].every(Number.isFinite);

try {
  for (const scenario of cases) {
    // A fresh page resets module-level bot IDs, names, clocks, listeners, and
    // instrumented methods. Reusing one Game made later cases inherit wrapper
    // layers and undermined the promise that a seed was reproducible.
    const page = await browser.newPage();
    const faults = [];
    // This is a deterministic offline gameplay harness, not an edge-service
    // integration test. Avoid contacting production and give primeIce the
    // same valid empty fallback it would receive after an unavailable relay.
    await page.route('https://spadefall-turn.spadefall.workers.dev/ice', route => route.fulfill({
      status: 200, contentType: 'application/json', body: '{"iceServers":[]}',
    }));
    page.on('pageerror', error => faults.push(error.message));
    page.on('console', message => {
      // The game may attempt anonymous diagnostics while this deliberately
      // offline harness runs. A denied external request is not a game fault;
      // JavaScript exceptions and every other console error still fail.
      if (message.type() === 'error'
          && !/404 \(Not Found\)|net::ERR_NETWORK_ACCESS_DENIED/.test(message.text()))
        faults.push(message.text());
    });
    // Install deterministic randomness before any game module executes. Doing
    // this inside page.evaluate() is too late: auto-start has already created
    // most bots, so their classes, cooldowns, lanes, and individual traits
    // would differ between otherwise identical simulation runs.
    // Do not let visual rAF race the fixed-step driver below either.
    await page.addInitScript(seed => {
      let state = seed >>> 0;
      Math.random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0)
        / 0x100000000);
      window.requestAnimationFrame = () => 0;
    }, scenario.seed);
    await page.goto(`${origin}/?auto=1&map=${scenario.map}&mode=${scenario.mode}`,
      { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__game?.world);
    const row = await page.evaluate(({ scenario, seconds, step }) => {
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
        stuck: 0, contacts: [], firstDeathAt: null, reengage: [], deathsByClass: {}, killsByClass: {},
        pickups: 0, returns: 0, captures: 0, flagTransitions: 0, hillOccupied: 0,
        hillContested: 0, strikes: 0, impacts: 0, strikeKills: 0, errors: [],
        ctfRuns: [], navStuckSamples: [], ctfApproach: {
          green: { entries48: 0, entries24: 0, first48At: null, first24At: null },
          blue: { entries48: 0, entries24: 0, first48At: null, first24At: null },
          approachSamples: [],
          preFirstPickupDeaths: { total: 0, byTeam: { green: 0, blue: 0 }, byRole: {}, samples: [] },
        } };
      // CTF approach telemetry is intentionally bounded and sampled once per
      // second. Per-bot band state prevents a bot circling a threshold from
      // inflating entries, while the fixed sample caps keep CI output small.
      const ctfBandState = new Map();
      const ctfPickupSeen = new Set();
      const awaitingContact = new Map();
      // Keep this deliberately test-local.  Flag methods remain unmodified so
      // the bot room follows precisely the same authority path as production.
      const activeRun = new Map();
      const pendingReturn = new Map();
      let nextRunId = 1;
      const point = p => p ? { x: p.x, y: p.y, z: p.z } : null;
      const distance = (a, b) => a && b ? Math.hypot(a.x - b.x, a.z - b.z) : null;
      const finishRun = (run, outcome, extra = {}) => {
        if (!run || run.outcome) return;
        run.outcome = outcome;
        run.endedAt = g.time - beganAt;
        run.duration = run.endedAt - run.startedAt;
        Object.assign(run, extra);
        activeRun.delete(run.flagTeam);
        if (outcome === 'death_drop' || outcome === 'drop') pendingReturn.set(run.flagTeam, run);
      };
      const startRun = (flagTeam, carrier) => {
        if (!carrier?.body) return null;
        const home = g.standOf(carrier.team);
        const startHomeDistance = distance(carrier.body.pos, home);
        const run = { id: nextRunId++, flagTeam, carrierId: carrier.id, carrierTeam: carrier.team,
          startedAt: g.time - beganAt, startPosition: point(carrier.body.pos),
          homePosition: point(home), startHomeDistance, closestHomeDistance: startHomeDistance,
          closestHomeAt: g.time - beganAt, escortSeconds: 0, closestEscortDistance: null,
          timeToFirstEscort: null, lastProgressAt: g.time - beganAt,
          noProgressDuration: 0, maxNoProgressDuration: 0,
          obstructionSamples: [], stuckSamples: [], approachedHome: false,
          ownFlagStateAtApproach: null, returnAssociation: null, captureAssociation: null,
          outcome: null, endedAt: null, duration: null };
        m.ctfRuns.push(run);
        activeRun.set(flagTeam, run);
        return run;
      };
      const sampleCarrier = (run, carrier, dt) => {
        if (!run || !carrier?.body?.pos || !carrier.alive) return;
        const home = g.standOf(run.carrierTeam);
        const homeDistance = distance(carrier.body.pos, home);
        if (homeDistance != null && homeDistance < run.closestHomeDistance) {
          run.closestHomeDistance = homeDistance;
          run.closestHomeAt = g.time - beganAt;
          run.lastProgressAt = g.time - beganAt;
        }
        const now = g.time - beganAt;
        run.noProgressDuration = Math.max(0, now - run.lastProgressAt);
        run.maxNoProgressDuration = Math.max(run.maxNoProgressDuration, run.noProgressDuration);
        if (!run.approachedHome && homeDistance != null && homeDistance <= 16) {
          run.approachedHome = true;
          run.ownFlagStateAtApproach = g.flags?.[run.carrierTeam]?.state ?? null;
        }
        const escorts = g.bots.filter(bot => bot !== carrier && bot.alive && bot.team === run.carrierTeam);
        const escortDistance = escorts.length ? Math.min(...escorts.map(bot => distance(bot.body.pos, carrier.body.pos))) : null;
        if (escortDistance != null) {
          run.closestEscortDistance = run.closestEscortDistance == null
            ? escortDistance : Math.min(run.closestEscortDistance, escortDistance);
          if (escortDistance <= 12) {
            run.escortSeconds += dt;
            if (run.timeToFirstEscort == null) run.timeToFirstEscort = now - run.startedAt;
          }
        }
        // These are bounded, sparse snapshots: enough to diagnose a bad route
        // without dumping every 50ms physics tick into normal CI output.
        if (run.stuckSamples.length < 12 && (carrier.stuck > 0 || carrier.telemetry?.stuckRecoveries > 0))
          run.stuckSamples.push({ t: g.time - beganAt, stuck: carrier.stuck ?? 0,
            recoveries: carrier.telemetry?.stuckRecoveries ?? 0, position: point(carrier.body.pos) });
        if (run.obstructionSamples.length < 12 && carrier.routeT > 0)
          run.obstructionSamples.push({ t: g.time - beganAt, routeT: carrier.routeT,
            route: point(carrier.route), position: point(carrier.body.pos) });
      };
      const className = gun => gun === 0 ? 'rifle' : gun === 1 ? 'smg'
        : gun === 5 ? 'sniper' : 'unknown';
      const roleName = bot => bot?.tacticalRole ?? bot?.role ?? 'unknown';
      const isDefenderRole = role => ['defend', 'recover'].includes(role);
      const ctfContext = (bot, flagDistance) => {
        const allies = g.bots.filter(ally => ally.alive && ally.team === bot.team);
        const nearestSupport = allies.filter(ally => ally !== bot)
          .reduce((nearest, ally) => Math.min(nearest, distance(ally.body.pos, bot.body.pos)), Infinity);
        const attackerCount = allies.filter(ally => !isDefenderRole(roleName(ally))).length;
        return { team: bot.team, role: roleName(bot), flagDistance,
          aliveAttackers: attackerCount, aliveDefenders: allies.length - attackerCount,
          nearestSupportDistance: Number.isFinite(nearestSupport) ? nearestSupport : null };
      };
      const recordApproach = (bot, band, flagDistance) => {
        const team = m.ctfApproach[bot.team];
        if (!team) return;
        const field = band === 48 ? 'entries48' : 'entries24';
        const first = band === 48 ? 'first48At' : 'first24At';
        team[field]++;
        if (team[first] == null) team[first] = g.time - beganAt;
        if (m.ctfApproach.approachSamples.length < 8)
          m.ctfApproach.approachSamples.push({ t: g.time - beganAt, band,
            ...ctfContext(bot, flagDistance) });
      };
      const sampleCtfApproach = () => {
        if (scenario.mode !== 'ctf') return;
        for (const bot of g.bots) {
          if (!bot.alive || !bot.body?.pos) continue;
          const enemyFlag = g.flags?.[g.enemyOf(bot.team)];
          const flagDistance = distance(bot.body.pos, enemyFlag?.home);
          if (!Number.isFinite(flagDistance)) continue;
          const prior = ctfBandState.get(bot.id) ?? { band48: false, band24: false };
          const band48 = flagDistance <= 48, band24 = flagDistance <= 24;
          if (band48 && !prior.band48) recordApproach(bot, 48, flagDistance);
          if (band24 && !prior.band24) recordApproach(bot, 24, flagDistance);
          ctfBandState.set(bot.id, { band48, band24 });
        }
      };
      const oldDeath = g.onDeath.bind(g);
      g.onDeath = (victim, killer) => {
        if (victim?.id !== undefined) {
          m.deaths++;
          if (m.firstDeathAt == null) m.firstDeathAt = g.time;
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
          if (scenario.mode === 'ctf' && !ctfPickupSeen.has(victim.team)) {
            const enemyFlag = g.flags?.[g.enemyOf(victim.team)];
            const flagDistance = distance(victim.body?.pos, enemyFlag?.home);
            const role = roleName(victim);
            const deaths = m.ctfApproach.preFirstPickupDeaths;
            deaths.total++;
            deaths.byTeam[victim.team] = (deaths.byTeam[victim.team] ?? 0) + 1;
            deaths.byRole[role] = (deaths.byRole[role] ?? 0) + 1;
            if (deaths.samples.length < 8)
              deaths.samples.push({ t: g.time - beganAt, ...ctfContext(victim, flagDistance) });
          }
          if (victim.carrier && g.flags) {
            const flagTeam = g.enemyOf(victim.team);
            const run = activeRun.get(flagTeam);
            finishRun(run, 'death_drop', { deathCause: victim._deathCause ?? null,
              terminalPosition: point(victim.body.pos), ownFlagStateAtTerminal: g.flags[victim.team]?.state ?? null,
              dropPosition: point(victim.body.pos) });
          }
          ctfBandState.set(victim.id, { band48: false, band24: false });
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
        const carriersBefore = Object.fromEntries(Object.entries(g.flags).map(([team, f]) => [team, f.carrier]));
        const returnersBefore = Object.fromEntries(Object.entries(g.flags).map(([team, f]) => {
          const nearby = g.bots.filter(bot => bot.alive && bot.team === team)
            .map(bot => ({ bot, d: distance(bot.body.pos, f.pos) }))
            .filter(row => row.d != null && row.d <= 3).sort((a, b) => a.d - b.d);
          return [team, nearby[0]?.bot ?? null];
        }));
        const capturesBefore = { ...g.captures };
        const scoreBefore = (g.captures.green ?? 0) + (g.captures.blue ?? 0);
        oldFlags(dt);
        m.captures += Math.max(0,
          (g.captures.green ?? 0) + (g.captures.blue ?? 0) - scoreBefore);
        for (const [team, f] of Object.entries(g.flags)) if (f.state !== before[team]) {
          m.flagTransitions++;
          if (before[team] !== 'carried' && f.state === 'carried') {
            m.pickups++;
            if (f.carrier?.team) ctfPickupSeen.add(f.carrier.team);
            startRun(team, f.carrier);
          }
          if (before[team] === 'dropped' && f.state === 'home') {
            m.returns++;
            const run = pendingReturn.get(team);
            if (run) {
              run.returnAssociation = { returnedAt: g.time - beganAt,
                returnedBy: returnersBefore[team]?.id ?? null };
              pendingReturn.delete(team);
            }
          }
          if (before[team] === 'carried' && f.state === 'dropped')
            finishRun(activeRun.get(team), 'drop', { terminalPosition: point(f.pos) });
          if (before[team] === 'carried' && f.state === 'home') {
            const carrier = carriersBefore[team];
            const run = activeRun.get(team);
            const captured = carrier && (g.captures[carrier.team] ?? 0) > (capturesBefore[carrier.team] ?? 0);
            finishRun(run, captured ? 'capture' : 'other', { terminalPosition: point(f.pos),
              ownFlagStateAtTerminal: carrier ? g.flags[carrier.team]?.state ?? null : null,
              captureAssociation: captured ? { capturedAt: g.time - beganAt, team: carrier.team,
                carrierId: carrier.id } : null });
          }
        }
        for (const [team, run] of activeRun) sampleCarrier(run, g.flags[team]?.carrier, dt);
      };
      const oldHill = g._updateHill.bind(g);
      g._updateHill = dt => { oldHill(dt); const h = g.hill; if (h?.contested) m.hillContested += dt;
        else if ((h?.presence.green ?? 0) + (h?.presence.blue ?? 0) > 0) m.hillOccupied += dt; };
      const sample = () => {
        sampleCtfApproach();
        const alive = g.bots.filter(b => b.alive);
        for (const b of alive) {
          const recoveries = b.telemetry?.stuckRecoveries ?? 0;
          m.stuck += recoveries;
          // Keep a small location trace for map-specific navigation audits.
          // This is emitted only in verbose reports and does not affect bot
          // decisions, timing, or the normal compact CI report.
          if (recoveries > 0 && m.navStuckSamples.length < 24)
            m.navStuckSamples.push({ t: g.time - beganAt, id: b.id, team: b.team,
              role: roleName(b), recoveries, targetVisible: !!b.targetVisible,
              position: point(b.body?.pos), goal: point(b.cachedGoal) });
        }
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
      for (const [team, run] of activeRun)
        finishRun(run, 'other', { terminalPosition: point(g.flags[team]?.carrier?.body?.pos),
          ownFlagStateAtTerminal: g.flags[run.carrierTeam]?.state ?? null, simulationEnded: true });
      const sorted = values => values.slice().sort((a, b) => a - b);
      const percentile = (values, p) => values.length ? values[Math.min(values.length - 1,
        Math.floor((values.length - 1) * p))] : null;
      const botById = new Map(g.bots.map(b => [b.id, b]));
      const kd = [...g.kd].filter(([key]) => key.startsWith('b')).map(([key, r]) => {
        const bot = botById.get(Number(key.slice(1)));
        return { name: r.name, class: bot?.gunClass ?? null, k: r.k, d: r.d };
      });
      const pendingStrikes = g._pendingStrikes.filter(s => s.attacker?.id !== undefined).length;
      return { ...scenario, elapsed: g.matchElapsed, score: g.captures, over: g.over,
        ...m, contacts: m.contacts.length,
        pendingStrikes,
        // Long-range fire can produce a real firefight before opposing bodies
        // come within the 30-block proximity sampler. Treat the first bot
        // death as contact too, so a productive sniper opening is not reported
        // as more than a minute of inactivity.
        firstContact: m.contacts.length || m.firstDeathAt != null
          ? Math.min(m.contacts[0] ?? Infinity, m.firstDeathAt ?? Infinity) - beganAt : null,
        reengageMedian: percentile(sorted(m.reengage), .5), reengageP90: percentile(sorted(m.reengage), .9),
        botLives: g.bots.length, botKd: kd, ctfRuns: m.ctfRuns,
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
    impacts: 0, pendingStrikes: 0, pickups: 0, returns: 0, captures: 0,
    killsByClass: {}, deathsByClass: {} });
  const add = (a, r) => {
    a.rounds++; a.deaths += r.deaths; a.spawnDeaths += r.spawnDeaths;
    a.edits += r.edits; a.stuck += r.stuck; a.contacts += r.contacts;
    a.hillOccupied += r.hillOccupied; a.hillContested += r.hillContested;
    a.strikes += r.strikes; a.impacts += r.impacts; a.pendingStrikes += r.pendingStrikes;
    a.pickups += r.pickups;
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
  const ctfRuns = rows.filter(row => row.mode === 'ctf').flatMap(row => row.ctfRuns);
  const ctfApproach = {
    green: { entries48: 0, entries24: 0, first48At: null, first24At: null },
    blue: { entries48: 0, entries24: 0, first48At: null, first24At: null },
    approachSamples: [],
    preFirstPickupDeaths: { total: 0, byTeam: { green: 0, blue: 0 }, byRole: {}, samples: [] },
  };
  for (const row of rows.filter(candidate => candidate.mode === 'ctf')) {
    for (const team of ['green', 'blue']) {
      const source = row.ctfApproach[team], target = ctfApproach[team];
      target.entries48 += source.entries48;
      target.entries24 += source.entries24;
      for (const field of ['first48At', 'first24At'])
        if (source[field] != null && (target[field] == null || source[field] < target[field]))
          target[field] = source[field];
    }
    ctfApproach.approachSamples.push(...row.ctfApproach.approachSamples);
    ctfApproach.approachSamples.length = Math.min(8, ctfApproach.approachSamples.length);
    const sourceDeaths = row.ctfApproach.preFirstPickupDeaths;
    const targetDeaths = ctfApproach.preFirstPickupDeaths;
    targetDeaths.total += sourceDeaths.total;
    for (const team of ['green', 'blue']) targetDeaths.byTeam[team] += sourceDeaths.byTeam[team] ?? 0;
    for (const [role, count] of Object.entries(sourceDeaths.byRole))
      targetDeaths.byRole[role] = (targetDeaths.byRole[role] ?? 0) + count;
    targetDeaths.samples.push(...sourceDeaths.samples);
    targetDeaths.samples.length = Math.min(8, targetDeaths.samples.length);
  }
  const ctfOutcomes = Object.fromEntries(['capture', 'death_drop', 'drop', 'other']
    .map(outcome => [outcome, ctfRuns.filter(run => run.outcome === outcome).length]));
  const report = { seconds, rounds: rows.length, aggregate, byMode,
    ctf: { runs: ctfRuns.length, outcomes: ctfOutcomes,
      approachedHome: ctfRuns.filter(run => run.approachedHome).length,
      returnedDrops: ctfRuns.filter(run => run.returnAssociation).length,
      averageEscortSeconds: ctfRuns.reduce((total, run) => total + run.escortSeconds, 0)
        / Math.max(1, ctfRuns.length),
      closestHomeDistance: ctfRuns.length
        ? Math.min(...ctfRuns.map(run => run.closestHomeDistance)) : null,
      approach: ctfApproach },
    spawnDeathRate: aggregate.deaths ? aggregate.spawnDeaths / aggregate.deaths : 0,
    averageEdits: aggregate.edits / Math.max(1, rows.length),
    worstFirstContact: Math.max(...rows.map(row => row.firstContact ?? Infinity)),
    worstReengageP90: Math.max(...rows.map(row => row.reengageP90 ?? 0)) };
  console.log('BOT_SIM_REPORT=' + JSON.stringify(
    process.env.SPADE_BOT_SIM_VERBOSE ? { ...report, cases: rows } : report));
  assert.deepEqual(browserFaults, [], browserFaults.join('\n'));
  assert.ok(rows.every(r => !r.errors.length && !r.faults.length), JSON.stringify(rows.filter(r => r.errors.length || r.faults.length)));
  assert.ok(rows.every(row => Array.isArray(row.navStuckSamples)
    && row.navStuckSamples.length <= 24
    && row.navStuckSamples.every(sample => Number.isFinite(sample.t)
      && Number.isInteger(sample.id) && ['green', 'blue'].includes(sample.team)
      && typeof sample.role === 'string' && Number.isInteger(sample.recoveries)
      && sample.recoveries > 0 && validDiagnosticPoint(sample.position)
      && (sample.goal == null || validDiagnosticPoint(sample.goal)))),
  'invalid bounded navigation-stall telemetry');
  const ctfRows = rows.filter(row => row.mode === 'ctf');
  assert.ok(ctfRows.every(row => {
    const approach = row.ctfApproach;
    if (!approach || !Array.isArray(approach.approachSamples)
        || approach.approachSamples.length > 8) return false;
    if (!approach.preFirstPickupDeaths || !Array.isArray(approach.preFirstPickupDeaths.samples)
        || approach.preFirstPickupDeaths.samples.length > 8
        || !Number.isInteger(approach.preFirstPickupDeaths.total)
        || approach.preFirstPickupDeaths.total < 0) return false;
    return ['green', 'blue'].every(team => {
      const bands = approach[team];
      return bands && Number.isInteger(bands.entries48) && bands.entries48 >= 0
        && Number.isInteger(bands.entries24) && bands.entries24 >= 0
        && (bands.first48At == null || Number.isFinite(bands.first48At))
        && (bands.first24At == null || Number.isFinite(bands.first24At));
    });
  }), 'invalid CTF approach telemetry shape');
  assert.ok(ctfRows.every(row => row.ctfApproach.approachSamples.every(sample =>
    ['green', 'blue'].includes(sample.team) && [24, 48].includes(sample.band)
    && Number.isFinite(sample.t) && Number.isFinite(sample.flagDistance)
    && Number.isInteger(sample.aliveAttackers) && sample.aliveAttackers >= 0
    && Number.isInteger(sample.aliveDefenders) && sample.aliveDefenders >= 0
    && (sample.nearestSupportDistance == null || Number.isFinite(sample.nearestSupportDistance))
  ) && row.ctfApproach.preFirstPickupDeaths.samples.every(sample =>
    ['green', 'blue'].includes(sample.team) && typeof sample.role === 'string'
    && Number.isFinite(sample.flagDistance)
    && Number.isInteger(sample.aliveAttackers) && sample.aliveAttackers >= 0
    && Number.isInteger(sample.aliveDefenders) && sample.aliveDefenders >= 0
    && (sample.nearestSupportDistance == null || Number.isFinite(sample.nearestSupportDistance)))),
  'invalid CTF approach sample telemetry');
  // These check the diagnostic contract, not whether the current bot tactics
  // happen to produce a capture on a particular map/seed.
  assert.ok(ctfRuns.every(run => Number.isInteger(run.id) && run.carrierId != null
    && ['green', 'blue'].includes(run.flagTeam) && ['green', 'blue'].includes(run.carrierTeam)
    && Number.isFinite(run.startedAt) && Number.isFinite(run.duration)
    && Number.isFinite(run.closestHomeDistance) && Number.isFinite(run.startHomeDistance)
    && Number.isFinite(run.maxNoProgressDuration)
    && (run.timeToFirstEscort == null || Number.isFinite(run.timeToFirstEscort))
    && run.startPosition && run.homePosition
    && ['capture', 'death_drop', 'drop', 'other'].includes(run.outcome)
    && Array.isArray(run.stuckSamples) && Array.isArray(run.obstructionSamples)),
  `invalid CTF telemetry ${JSON.stringify(ctfRuns)}`);
  assert.equal(ctfRuns.length, byMode.ctf.pickups,
    'each CTF pickup should produce exactly one carrier diagnostic run');
  assert.ok(report.spawnDeathRate < .15, `spawn deaths ${report.spawnDeathRate.toFixed(3)}`);
  assert.ok(report.averageEdits < 1000, `terrain edits ${report.averageEdits.toFixed(1)}/round`);
  assert.ok(report.worstFirstContact <= 90, `first contact ${report.worstFirstContact.toFixed(1)}s`);
  if (seconds >= 600 && byMode.ctf.rounds && ctfRuns.length) {
    const progressed = ctfRuns.filter(run => run.startHomeDistance - run.closestHomeDistance >= 16);
    assert.ok(progressed.length >= Math.max(1, Math.ceil(ctfRuns.length * 0.5)),
      `CTF carriers made insufficient homeward progress ${progressed.length}/${ctfRuns.length}`);
  }
  if (byMode.koth.rounds) assert.ok(byMode.koth.hillOccupied >= 60,
    'KOTH bots rarely reached an objective');
  assert.equal(aggregate.impacts + aggregate.pendingStrikes, aggregate.strikes,
    'a confirmed bot strike was neither pending nor impacted');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
