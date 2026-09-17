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

  const end = await host.evaluate(() => {
    const g = window.__game, victim = g.remote.get('guest');
    g.captures[g.player.team] = 49;
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
  console.log('lifecycle browsers: migration repair, spawn protection, human/bot strikes, round end, results cursor passed');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
