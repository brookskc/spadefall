// Read-only report retrieval. The credential stays outside the repository.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const account = '50b433a53c0e03c712e74f23fa3c180b';
const tokenPath = process.env.SPADEFALL_ANALYTICS_TOKEN_FILE
  ?? fileURLToPath(new URL('../../work/.spadefall-analytics-token', import.meta.url));
try {
  const token = (await readFile(tokenPath, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('The analytics credential file is invalid.');
  const sql = (await readFile(new URL('../docs/analytics-weekly.sql', import.meta.url), 'utf8'))
    .split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
    body: sql + '\nFORMAT JSON', signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Analytics query failed (HTTP ${response.status}); check the read token and dataset.`);
  const payload = await response.json();
  if (!Array.isArray(payload.data)) throw new Error('Cloudflare did not return report rows.');
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), windowDays: 7,
    source: 'Cloudflare Analytics Engine', dataset: 'spadefall_game_health',
    schema: 'human-v1', rows: payload.data }, null, 2));
} catch (error) {
  console.error(error?.code === 'ENOENT'
    ? 'Analytics credential or query file is missing. Complete the private read-token setup.'
    : error?.message ?? 'Analytics query failed.');
  process.exitCode = 1;
}
