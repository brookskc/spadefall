// Deterministic browser regressions for authority and round transitions.
// Real game methods and validated packets, without public signaling dependency.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const server = createServer(async (req, res) => {
  try {
    const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const path = resolve(root, relative === '/' ? 'index.html' : relative.slice(1));
    if (!path.startsWith(root + sep)) throw new Error('outside root');
    res.setHeader('content-type', ({ '.html': 'text/html', '.js': 'text/javascript',
      '.css': 'text/css' })[extname(path)] ?? 'application/octet-stream');
    res.end(await readFile(path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.SPADEFALL_BROWSER ?? (existsSync(edge) ? edge : undefined) });
const faults = [];
try {
  const host = await browser.newPage();
  const guest = await browser.newPage();
  for (const page of [host, guest]) {
    page.on('pageerror', error => faults.push(error.message));
    // Own all ticks so no bot/clock can race a lifecycle assertion.
    await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
    await page.goto(`http://127.0.0.1:${server.address().port}/?auto=1&map=1&mode=tdm`);
    await page.waitForFunction(() => !!window.__game);
  }

  const sights = await host.evaluate(() => {
    const p = window.__game.player;
    const visible = () => ['scopeOverlay', 'scopeNotches'].map(id =>
      document.getElementById(id).classList.contains('on'));
    p.tool = 5; p.aimK = 1;
    p._updateScopeNotches(true);
    const sniper = visible();
    p.tool = 0;
    p._updateScopeNotches(true);
    const rifle = visible();
    p.tool = 5;
    p._updateScopeNotches(true);
    p.resetZoom();
    const reset = visible();
    p.tool = p.gunClass; p.aimK = 0;
    return { sniper, rifle, reset };
  });
  assert.deepEqual(sights, { sniper: [true, true], rifle: [false, false],
    reset: [false, false] }, 'sniper reticle clears on gun switch and camera reset');
  for (const reducedMotion of ['no-preference', 'reduce']) {
    await host.emulateMedia({ reducedMotion });
    for (const killed of [false, true]) {
      await host.evaluate(killed => window.__game.hud.hitmark(killed), killed);
      await host.waitForFunction(() => {
        const mark = document.getElementById('hitmark');
        return mark.getAnimations().every(animation => animation.playState === 'finished')
          && getComputedStyle(mark).opacity === '0';
      }, null, { polling: 50 });
    }
  }

  // Drive actual score/clock boundaries without waiting fifteen wall minutes.
  const pacingPage = await browser.newPage();
  pacingPage.on('pageerror', error => faults.push(error.message));
  await pacingPage.addInitScript(() => { window.requestAnimationFrame = () => 0; });
  await pacingPage.goto(`http://127.0.0.1:${server.address().port}/?auto=1&map=1&mode=tdm`);
  await pacingPage.waitForFunction(() => !!window.__game);
  const pacing = await pacingPage.evaluate(() => {
    const g = window.__game;
    const rows = [];
    for (const publicRoom of [false, true]) {
      for (const mode of ['tdm', 'koth']) {
        g.publicRoom = publicRoom; g.gameMode = mode;
        g.rebuild(g.seed, mode === 'koth' ? 7 : 1);
        const clock = g.matchRemaining;
        const team = g.player.team;
        if (mode === 'tdm') {
          const victim = g.bots.find(bot => bot.team !== team);
          g.captures[team] = publicRoom ? 34 : 49;
          g.onDeath(victim, g.player);
        } else {
          g.player.body.pos.copy(g.hill.pos);
          g.player.body.pos.y += 1;
          g.bots.forEach(bot => { bot.alive = false; });
          g.hill.owner = team;
          g.captures[team] = publicRoom ? 89.9 : 119.9;
          g._updateHill(0.2);
        }
        const passedOldCap = !g.over;
        // The score leader wins at regulation even below the new score cap.
        g._updateMatchClock(899);
        const beforeRegulation = !g.over && g.matchRemaining === 1;
        g._updateMatchClock(1);
        rows.push({ publicRoom, mode, clock, passedOldCap, beforeRegulation,
          over: g.over, winner: g.winner === team });
      }
    }
    g.publicRoom = false; g.gameMode = 'tdm'; g.rebuild(g.seed, 1);
    return rows;
  });
  for (const row of pacing) assert.deepEqual(row, {
    publicRoom: row.publicRoom, mode: row.mode, clock: 900, passedOldCap: true, beforeRegulation: true,
    over: true, winner: true,
  }, 'solo/private and public rounds survive old caps and finish at regulation');

  await pacingPage.goto(`http://127.0.0.1:${server.address().port}/?auto=1&map=1&mode=tdm&killcap=50&kothtime=120&matchtime=17`);
  await pacingPage.waitForFunction(() => !!window.__game);
  assert.deepEqual(await pacingPage.evaluate(async () => {
    const { modeScoreLimit } = await import('/src/match-modes.js');
    return { clock: window.__game.matchRemaining,
      kills: modeScoreLimit('tdm', { publicRoom: true }),
      hold: modeScoreLimit('koth', { publicRoom: true }) };
  }), { clock: 17, kills: 50, hold: 120 }, 'explicit QA clock/score overrides still work');
  await pacingPage.close();

  const protection = await host.evaluate(async () => {
    const { RemotePlayer } = await import('/src/remote-player.js');
    const g = window.__game;
    g.net = { sendTo() {}, broadcast() {} };
    const p = new RemotePlayer(g, 'guest', 'Guest', g.enemyOf(g.player.team));
    p.ridx = 1;
    g.remote.set(p.id, p);
    const protectedHit = g.damage(p, 25, g.player, g.player.body.pos);
    const protectedHealth = p.health;
    p.protT = 0;
    const normalHit = g.damage(p, 25, g.player, g.player.body.pos);
    return { protectedHit, protectedHealth, normalHit, health: p.health };
  });
  assert.deepEqual(protection, { protectedHit: false, protectedHealth: 100,
    normalHit: true, health: 75 }, 'initial remote spawn has real, expiring protection');

  const packets = await host.evaluate(async () => {
    const { PROTOCOL_VERSION, validServerMessage } = await import('/src/protocol.js');
    const g = window.__game;
    const old = g.remote.get('guest');
    const row = g.snapshot().p.find(row => row[0] === old.ridx).slice(1);
    row[4] = 0; row[5] = 0;
    old.avatar.dispose();
    const p = g._restoreProxy('guest', 'Guest', 1, old.team, row);
    const sent = [];
    const conn = { open: false };
    g.net = { conns: new Map([['guest', conn]]), broadcast() {},
      sendTo(id, packet) { if (!conn.open) return false; sent.push(packet); return true; } };
    // Promoted host's wave expires BEFORE the survivor has reconnected.
    p.respawn();
    g.respawnTimers.delete(p);
    conn.open = true;
    g._migRoster = new Map([['guest', {}]]);
    g.hostOnData('guest', { t: 'hi', v: PROTOCOL_VERSION, name: 'Guest' });
    g._broadcastSnapshot();
    const welcome = sent.find(p => p.t === 'w');
    const snapshot = sent.find(p => p.t === 's');
    return { welcome, snapshot, valid: sent.every(validServerMessage), life: p._life };
  });
  assert.equal(packets.valid, true, 'generated migration packets pass the wire validator');
  assert.equal(packets.welcome.reset, 0);
  assert.equal(packets.life, 2);
  const recovery = await guest.evaluate(({ welcome, snapshot }) => {
    const g = window.__game;
    g.mode = 'client';
    g.net = { send() {} };
    g.onWelcome = () => {};
    g._clientDied(1);
    g.clientOnData(welcome);
    const before = { life: g._serverLife, alive: g.player.alive };
    g.clientOnData(snapshot);
    const after = { life: g._serverLife, alive: g.player.alive };
    return { before, after };
  }, packets);
  assert.deepEqual(recovery, { before: { life: 2, alive: false },
    after: { life: 2, alive: true } }, 'snapshot repairs death without inventing another life');
  const accepted = await host.evaluate(life => {
    const g = window.__game, p = g.remote.get('guest');
    p.ammo[p.gunClass] = 0;
    g.hostOnData('guest', { t: 'a', k: 'reload', n: 1, life });
    return { sequence: p._lastActionSeq, reloading: p._reloadUntil > g.time };
  }, recovery.after.life);
  assert.deepEqual(accepted, { sequence: 1, reloading: true },
    'recovered guest actions are accepted by the host');

  const steering = await host.evaluate(() => {
    const g = window.__game, p = g.remote.get('guest');
    const bots = g.bots;
    const guide = bots.find(b => b.team === p.team);
    const foes = [g.player, bots.find(b => b.team !== p.team)];
    g.bots = [guide, foes[1]];
    for (const [i, e] of foes.entries()) {
      e.body.pos.set(100 + i * 2, 60, 100); e.body.vel.set(0, 0, 0);
    }
    p.body.pos.set(30, 60, 30); guide.body.pos.set(30, 60, 30);
    const strike = (attacker, id) => ({ attacker, id, owner: 1, yaw: 0, t: 2,
      pos: g.player.body.pos.clone().set(50, 60, 50) });
    const human = strike(p, 10), bot = strike(guide, 11);
    g._pendingStrikes = [human, bot];
    g.update(0.016);
    g.bots = bots;
    g._pendingStrikes = [];
    return { human: [human.pos.x, human.pos.z], bot: [bot.pos.x, bot.pos.z] };
  });
  assert.deepEqual(steering.human, [50, 50], 'host does not auto-steer human guests');
  assert.notDeepEqual(steering.bot, [50, 50], 'actual bot strikes still receive guidance');

  const end = await host.evaluate(async () => {
    const { modeScoreLimit } = await import('/src/match-modes.js');
    const g = window.__game, victim = g.remote.get('guest');
    g.captures[g.player.team] = modeScoreLimit('tdm', {
      publicRoom: g.publicRoom }) - 1;
    victim.protT = 0; victim.health = 100;
    victim.body.pos.set(100, 65, 100);
    g.player.body.pos.set(150, 65, 150);
    const bots = g.bots; g.bots = [];
    const strike = (id, t) => ({ id, t, attacker: g.player, owner: g._hostIdx,
      yaw: 0, pos: victim.body.pos.clone() });
    g._pendingStrikes = [strike(20, 2), strike(21, 0)];
    g.update(0.016); // actual explosion, damage, final kill, and _end
    g.bots = bots;
    return { over: g.over, alive: victim.alive, pending: g._pendingStrikes.length };
  });
  assert.deepEqual(end, { over: true, alive: false, pending: 0 },
    'winning airstrike safely cancels the remaining strike queue');
  await host.locator('#endClassOpts .opt').first().click();
  await host.waitForTimeout(100); // allow asynchronous pointerlockchange to fire
  assert.deepEqual(await host.evaluate(() => ({
    locked: !!document.pointerLockElement,
    results: !document.getElementById('end').classList.contains('hidden'),
  })), { locked: false, results: true }, 'results class picker leaves mouse available');
  assert.deepEqual(faults, [], 'no browser exceptions');
  console.log('lifecycle browsers: sights, hit-marker fading, fifteen-minute pacing, migration repair, spawn protection, human/bot strikes, round end, results cursor passed');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
