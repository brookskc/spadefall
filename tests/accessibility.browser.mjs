// Keyboard, rebinding, and live accessibility smoke coverage in real Chromium.
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
  ['.png', 'image/png'],
]);
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const path = normalize(join(root, relative));
    if (!path.startsWith(root) || !(await stat(path)).isFile()) throw new Error('not found');
    response.writeHead(200, { 'content-type': mime.get(extname(path))
      ?? 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(await readFile(path));
  } catch {
    response.writeHead(404); response.end('not found');
  }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const executablePath = process.env.SPADEFALL_BROWSER
  ?? (process.platform === 'win32' && existsSync(edge) ? edge : undefined);
const browser = await chromium.launch({ headless: true, executablePath });
const faults = [];
// Hosted runners render WebGL in software. Keyboard/focus assertions do not
// need an animated battlefield or a running intermission clock underneath.
const context = await browser.newContext();
await context.addInitScript(() => {
  localStorage.setItem('tos.gfx', 'low');
  localStorage.setItem('tos.gfxMode', 'manual');
  window.requestAnimationFrame = () => 0;
});
context.setDefaultTimeout(process.env.CI ? 60_000 : 30_000);

try {
  const page = await context.newPage();
  page.on('pageerror', error => faults.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.player?.controls);

  assert.deepEqual(await page.evaluate(() => ({
    mode: document.getElementById('modePref').value,
    ctfVisible: [...document.getElementById('modePref').options].some(option => option.value === 'ctf'),
  })), { mode: 'tdm', ctfVisible: false }, 'fresh selector defaults to flagship TDM');
  const privatePage = await context.newPage();
  await privatePage.goto(`http://127.0.0.1:${port}/?features=privateContent`,
    { waitUntil: 'domcontentloaded' });
  await privatePage.waitForFunction(() => window.__game?.player?.controls);
  assert.equal(await privatePage.evaluate(() => [...document.getElementById('modePref').options]
    .some(option => option.value === 'ctf')), true, 'private feature exposes CTF for development');
  await privatePage.close();

  const drawer = page.locator('#displayDrawer summary');
  await drawer.focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#displayDrawer').evaluate(node => node.open), true,
    'display drawer opens without a mouse');

  await page.locator('#analyticsOpts [data-value="off"]').click();
  assert.equal(await page.evaluate(() => localStorage.getItem('tos.analytics')), 'off',
    'players can opt out of anonymous gameplay summaries');

  const hud120 = page.locator('#hudScaleOpts [data-value="120"]');
  await hud120.focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => localStorage.getItem('tos.hudScale')), '120');
  assert.equal(await hud120.evaluate(node => node.classList.contains('picked')), true);

  const objectiveHigh = page.locator('#objectiveContrastOpts [data-value="high"]');
  await objectiveHigh.focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('body').getAttribute('data-objective-contrast'), 'high');

  await page.locator('#controlsBindings [data-action="moveForward"]').click();
  await page.keyboard.press('ArrowUp');
  assert.deepEqual(await page.evaluate(() => window.__game.player.controls.bindings.moveForward),
    ['ArrowUp']);

  await page.locator('#controlsBindings [data-action="moveBack"]').click();
  await page.keyboard.press('ArrowUp');
  assert.match(await page.locator('#bindStatus').textContent(), /CONFLICT: MOVE FORWARD/);
  assert.deepEqual(await page.evaluate(() => window.__game.player.controls.bindings.moveBack),
    ['KeyS']);

  await page.locator('#controlsBindings [data-action="ping"]').click();
  await page.mouse.down({ button: 'middle' });
  await page.mouse.up({ button: 'middle' });
  assert.deepEqual(await page.evaluate(() => window.__game.player.controls.bindings.ping),
    ['Mouse1']);

  const inaccessible = await page.evaluate(() => [...document.querySelectorAll(
    '#menu .opt, #menu .plink, #menu .play')].filter(node => {
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && !node.matches('button,a,input,select,summary') && node.tabIndex < 0;
    }).length);
  assert.equal(inaccessible, 0, 'visible legacy controls remain keyboard reachable');
  assert.deepEqual(faults, [], `page errors: ${faults.join('; ')}`);
  await page.close();

  const report = await context.newPage();
  report.on('pageerror', error => faults.push(error.message));
  await report.goto(`http://127.0.0.1:${port}/?reportqa=victory&auto=1`, {
    waitUntil: 'domcontentloaded',
  });
  await report.waitForSelector('#end:not(.hidden)');
  assert.equal(await report.evaluate(() => window.__game.over), true,
    'report fixture completed the actual round-end transition');
  for (const selector of ['#readyBtn', '#shareResultBtn', '#endClassOpts [data-cls="1"]']) {
    const target = report.locator(selector);
    await target.focus();
    assert.equal(await target.evaluate(node => document.activeElement === node), true,
      `${selector} is keyboard focusable`);
  }
  assert.deepEqual(faults, [], `page errors: ${faults.join('; ')}`);
  await report.close();
  console.log('Accessibility browser smoke passed.');
} catch (error) {
  // Previously a boot exception was collected but hidden by a later timeout.
  // Include it in the job log so CI points at the actual failure.
  console.error(`Accessibility browser failed (${browser.version()}): ${error.message}`);
  console.error(`Page errors: ${faults.join('; ') || 'none'}`);
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
