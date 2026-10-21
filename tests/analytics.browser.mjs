// Serve the real production entry point offline; no test data reaches Cloudflare.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const browser = await chromium.launch({ headless: true });
const faults = [];
async function fixture({ dnt = false, gpc = false } = {}) {
  const context = await browser.newContext();
  const events = [];
  await context.addInitScript(({ dnt, gpc }) => {
    localStorage.setItem('tos.gfx', 'low'); localStorage.setItem('tos.gfxMode', 'manual');
    window.requestAnimationFrame = () => 0;
    Object.defineProperty(navigator, 'doNotTrack', { get: () => dnt ? '1' : null });
    Object.defineProperty(navigator, 'globalPrivacyControl', { get: () => gpc });
  }, { dnt, gpc });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === 'spadefall-turn.spadefall.workers.dev') {
      if (url.pathname === '/players' || url.pathname === '/gameplay') {
        if (request.method() === 'POST') events.push({ path: url.pathname, row: request.postDataJSON() });
        return route.fulfill({ status: 204, headers: {
          'access-control-allow-origin': 'https://spadefall.io',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type' } });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"iceServers":[]}' });
    }
    if (url.hostname !== 'spadefall.io') return route.abort();
    const path = resolve(root, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (!path.startsWith(root + sep)) return route.abort();
    try {
      return route.fulfill({ status: 200, body: await readFile(path),
        contentType: ({ '.html': 'text/html', '.js': 'text/javascript' })[extname(path)]
          ?? 'application/octet-stream' });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  const page = await context.newPage();
  page.on('pageerror', error => faults.push(error.message));
  const open = async search => {
    await page.goto(`https://spadefall.io/${search ?? ''}`);
    await page.waitForFunction(() => !!window.__game);
  };
  const play = () => page.evaluate(() => {
    const tracker = window.__game.engagement;
    tracker.beginMatch({ round: 1, mode: 'tdm', map: 0, network: 'solo', humans: 1, bots: 9 });
    tracker.beginMatch({ round: 1, mode: 'tdm', map: 0, network: 'solo', humans: 1, bots: 9 });
  });
  return { context, page, events, open, play };
}

try {
  const f = await fixture();
  await f.open();
  assert.equal(await f.page.evaluate(() => localStorage.getItem('tos.analytics-player')), null,
    'opening the menu does not create a player ID');
  await f.play();
  await f.page.waitForFunction(() => !!localStorage.getItem('tos.analytics-player'));
  const first = JSON.parse(await f.page.evaluate(() => localStorage.getItem('tos.analytics-player'))).id;
  await f.page.evaluate(() => window.__game.engagement.finishMatch({ duration: 1 }));
  await f.open();
  await f.play();
  await f.page.waitForLoadState('networkidle');
  const playerEvents = f.events.filter(event => event.path === '/players');
  assert.equal(playerEvents.length, 2, 'one play event per actual round, no duplicate start event');
  assert.ok(playerEvents.every(event => event.row.playerId === first), 'ID survives a real page reload');
  assert.ok(f.events.filter(event => event.path === '/gameplay')
    .every(event => !JSON.stringify(event.row).includes(first)), 'gameplay totals are not linked to IDs');
  await f.page.locator('#displayDrawer summary').click();
  await f.page.locator('#analyticsOpts [data-value="off"]').click();
  assert.equal(await f.page.evaluate(() => localStorage.getItem('tos.analytics-player')), null,
    'live opt-out erases the stored ID');
  const before = f.events.length;
  await f.page.evaluate(() => {
    const tracker = window.__game.engagement;
    tracker.finishMatch({ duration: 1 });
    tracker.beginMatch({ round: 2, mode: 'tdm', map: 0 });
    tracker.finishMatch({ duration: 1 });
  });
  await f.open(); await f.play();
  await f.page.waitForLoadState('networkidle');
  assert.equal(f.events.length, before, 'saved opt-out prevents both types of reports on reload');
  await f.context.close();

  for (const settings of [{ dnt: true }, { gpc: true }, { search: '?auto=1' }, { search: '?damageqa=1' }]) {
    const f = await fixture(settings);
    await f.open(settings.search); await f.play();
    await f.page.evaluate(() => window.__game.engagement.finishMatch({ duration: 1 }));
    await f.page.waitForLoadState('networkidle');
    assert.equal(await f.page.evaluate(() => localStorage.getItem('tos.analytics-player')), null,
      `privacy/QA suppression creates no identifier: ${JSON.stringify(settings)}`);
    assert.deepEqual(f.events, [], 'privacy/QA suppression sends no player or round reports');
    await f.context.close();
  }
  assert.deepEqual(faults, [], 'production integration has no page errors');
  console.log('Anonymous player analytics browser tests passed.');
} finally { await browser.close(); }
