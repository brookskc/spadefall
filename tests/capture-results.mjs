// Captures the deterministic real results composition for visual review.
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const output = join(root, 'docs', 'screenshots');
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
    response.writeHead(200, { 'content-type': mime.get(extname(path)) ?? 'application/octet-stream',
      'cache-control': 'no-store' });
    response.end(await readFile(path));
  } catch {
    response.writeHead(404); response.end('not found');
  }
});

await mkdir(output, { recursive: true });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const executablePath = process.env.SPADEFALL_BROWSER
  ?? (process.platform === 'win32' && existsSync(edge) ? edge : undefined);
const browser = await chromium.launch({ headless: true, executablePath });

try {
  for (const shot of [
    { name: 'postmatch-battlefield-victory-1440x900.png', width: 1440, height: 900, result: 'victory' },
    { name: 'postmatch-battlefield-defeat-900x700.png', width: 900, height: 700, result: 'defeat' },
    { name: 'postmatch-battlefield-compact-600x800.png', width: 600, height: 800, result: 'victory' },
  ]) {
    const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height } });
    await page.goto(`http://127.0.0.1:${port}/?reportqa=${shot.result}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('#end:not(.hidden)');
    await page.waitForTimeout(250);
    const state = await page.evaluate(() => {
      const box = id => document.querySelector(id)?.getBoundingClientRect();
      return {
        map: document.querySelector('#end')?.dataset.map,
        groups: [...document.querySelectorAll('#endBoard .teamGroup')]
          .map(row => row.textContent.trim()),
        player: document.querySelector('#endBoard tr.me td:first-child')?.textContent.trim(),
        playerMarkers: document.querySelectorAll('#endBoard .playerMarker').length,
        impact: [...document.querySelectorAll('#endImpactMetrics b')]
          .map(node => Number(node.textContent)),
        battleCards: document.querySelectorAll('#nextBattles .battleCard').length,
        ready: document.querySelector('#readyBtn')?.textContent,
        done: document.querySelector('#doneBtn')?.textContent,
        share: document.querySelector('#shareResultBtn')?.textContent,
        countdownDisplay: getComputedStyle(document.querySelector('#endProgress')).display,
        intermissionTop: box('#endIntermission')?.top,
        boardTop: box('#endBoardLabel')?.top,
        fieldGoalsPresent: !!document.querySelector('#selectedGoal, #startGoalPick, #endGoal, #endFieldwork'),
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    if (state.map !== 'island' || state.groups.join('|') !== 'GREEN FORCE|BLUE FORCE'
        || state.player !== 'You' || state.playerMarkers !== 0
        || state.impact.join(',') !== '0,52,18,34,1'
        || state.battleCards !== 3 || state.countdownDisplay !== 'none'
        || !state.ready?.startsWith('PLAY ANOTHER')
        || !state.done?.startsWith('DONE') || state.share !== 'COPY RESULT'
        || state.fieldGoalsPresent
        || state.horizontalOverflow)
      throw new Error(`${shot.name}: invalid results composition ${JSON.stringify(state)}`);
    if (shot.width <= 760 && !(state.intermissionTop < state.boardTop))
      throw new Error(`${shot.name}: next deployment must precede the mobile scoreboard`);
    await page.screenshot({ path: join(output, shot.name) });
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
