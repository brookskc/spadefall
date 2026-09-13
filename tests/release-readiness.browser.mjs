// Explicit release smoke: real visible layout, tier application, and bounded
// runtime hooks. Headless rendering cannot certify a weak GPU; see the manual
// matrix in docs/RELEASE-READINESS-QA.md.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const mime = new Map([['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8']]);
const server = createServer(async (req, res) => {
  try {
    const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const path = normalize(join(root, relative === '/' ? 'index.html' : relative.slice(1)));
    if (!path.startsWith(root) || !(await stat(path)).isFile()) throw new Error('not found');
    res.writeHead(200, { 'content-type': mime.get(extname(path)) ?? 'application/octet-stream' });
    res.end(await readFile(path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.SPADEFALL_BROWSER ?? (existsSync(edge) ? edge : undefined) });
const origin = `http://127.0.0.1:${server.address().port}`;
const cases = [
  { viewport: { width: 360, height: 640 }, tier: 'auto', smoke: true },
  { viewport: { width: 1024, height: 576 }, tier: 'low' },
  { viewport: { width: 1366, height: 768 }, tier: 'medium' },
  { viewport: { width: 1920, height: 1080 }, tier: 'high' },
  { viewport: { width: 2560, height: 1440 }, tier: 'auto' },
];

try {
  for (const { viewport, tier, smoke = false } of cases) {
    const page = await browser.newPage({ viewport });
    const faults = [];
    page.on('pageerror', error => faults.push(error.message));
    await page.addInitScript(value => {
      if (value === 'auto') {
        localStorage.removeItem('tos.gfx');
        localStorage.setItem('tos.gfxMode', 'auto');
      } else {
        localStorage.setItem('tos.gfx', value);
        localStorage.setItem('tos.gfxMode', 'manual');
      }
    }, tier);
    await page.goto(`${origin}/?auto=1&map=0&mode=ctf`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__game && window.__renderer
      && window.__spadefallDiagnostics, null, { timeout: 15_000 });

    const lobby = await page.evaluate(() => {
      const visibleRect = id => {
        const el = document.getElementById(id);
        if (!el) return null;
        const style = getComputedStyle(el), rect = el.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden'
            || rect.width <= 0 || rect.height <= 0) return null;
        return rect.toJSON();
      };
      const horizontalFit = rect => rect && rect.left >= -1 && rect.right <= innerWidth + 1;
      const name = visibleRect('nameInput'), quick = visibleRect('quickBtn');
      const tabbable = [...document.querySelectorAll('button,input,select,a,[tabindex]')]
        .filter(el => el.tabIndex >= 0 && getComputedStyle(el).display !== 'none');
      return {
        name: horizontalFit(name),
        quick: horizontalFit(quick),
        quickCopy: document.getElementById('quickBtn')?.textContent.includes('PLAY NOW')
          && document.getElementById('quickMeta')?.textContent.includes('BOTS FILL EMPTY SEATS'),
        menuWidth: document.getElementById('menu').scrollWidth <= innerWidth + 1,
        keyboardQuick: tabbable.some(el => el.id === 'quickBtn'),
      };
    });
    // The 360px case is deliberately a non-supported smoke: its critical
    // entry controls must remain usable, but the desktop-only decorative
    // backdrop labels are not a mobile-support promise.
    assert.ok(lobby.name && lobby.quick && lobby.quickCopy && lobby.keyboardQuick && (smoke || lobby.menuWidth),
      `lobby layout ${tier} ${viewport.width}x${viewport.height}: ${JSON.stringify(lobby)}`);

    await page.evaluate(value => {
      if (value !== 'auto') window.__game.applyGraphics(value);
      document.getElementById('menu').classList.add('hidden');
      document.getElementById('hud').classList.add('on');
      const guide = window.__game.firstMinuteGuide;
      guide?.start({ mode: 'ctf', mapIndex: 0, matchSecond: 0, x: 0, z: 0 });
      const view = guide?.update({ x: 4, z: 0, matchSecond: 1, alive: true });
      if (view?.visible) window.__game.hud.firstMinute(view);
    }, tier);
    await page.waitForTimeout(400);
    const runtime = await page.evaluate(expectedTier => {
      const hud = document.getElementById('hud'), guide = document.getElementById('firstMinute');
      const hudStyle = getComputedStyle(hud), guideStyle = getComputedStyle(guide);
      const guideRect = guide.getBoundingClientRect();
      const visibleGuide = guideStyle.display !== 'none' && guideRect.width > 0 && guideRect.height > 0;
      const storedTier = localStorage.getItem('tos.gfx');
      return {
        hudVisible: Number(hudStyle.opacity) > 0.9,
        guideVisible: visibleGuide,
        guideFits: visibleGuide && guideRect.left >= -1 && guideRect.right <= innerWidth + 1
          && guideRect.top >= -1 && guideRect.bottom <= innerHeight + 1
          && guide.scrollWidth <= guide.clientWidth + 1,
        tierApplied: expectedTier === 'auto' ? localStorage.getItem('tos.gfxMode') === 'auto'
          : storedTier === expectedTier,
        resources: window.__game.runtimeCounts(),
      };
    }, tier);
    assert.ok(runtime.tierApplied && runtime.hudVisible,
      `runtime tier/HUD ${tier} ${viewport.width}x${viewport.height}: ${JSON.stringify(runtime)}`);
    if (!smoke) assert.ok(runtime.guideVisible && runtime.guideFits,
      `orientation layout ${tier} ${viewport.width}x${viewport.height}: ${JSON.stringify(runtime)}`);
    assert.ok(Number.isInteger(runtime.resources.chunks) && runtime.resources.chunks > 0
      && Number.isInteger(runtime.resources.sceneObjects) && runtime.resources.sceneObjects > 0
      && runtime.resources.particles >= 0, 'runtime counters are finite and bounded');
    assert.deepEqual(faults, [], `browser faults at ${viewport.width}x${viewport.height}`);
    await page.close();
  }
  console.log('release readiness: visible lobby/HUD and graphics-tier matrix passed');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
