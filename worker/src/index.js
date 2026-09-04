// index.js — mints short-lived Cloudflare TURN credentials for Spadefall.
//
// Why this exists: the TURN key's API token is a long-lived secret that can
// mint unlimited relay credentials. Shipping it to the browser would let
// anyone lift it out of the bundle and relay their own traffic on our
// account, so it lives only in this Worker's secret store. Clients get
// credentials that expire instead.

const DEFAULT_TURN_KEY_ID = '0a266bb92241c6f8f68a8068f72e4c45';

// Longer than the longest match (CTF regulation is 12 minutes plus overtime)
// so a credential never expires mid-round, short enough that a leaked one is
// worth little.
const CREDENTIAL_TTL = 7200;

const ALLOWED_ORIGINS = new Set([
  'https://spadefall.io',
  'https://www.spadefall.io',
  'https://spadefall.pages.dev',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
]);

// Every Cloudflare Pages build also gets its own <hash>.spadefall.pages.dev
// host, so preview deployments are matched by suffix rather than enumerated.
// Without this the browser blocks the credential fetch and the game quietly
// falls back to STUN only — a relay that looks configured but never engages.
const PREVIEW_SUFFIX = '.spadefall.pages.dev';
export const originAllowed = origin =>
  typeof origin === 'string' && (ALLOWED_ORIGINS.has(origin)
  || (origin.startsWith('https://') && origin.endsWith(PREVIEW_SUFFIX)));

const corsHeaders = origin => ({
  'access-control-allow-origin': originAllowed(origin) ? origin : 'https://spadefall.io',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type, accept',
  'access-control-max-age': '86400',
  vary: 'origin',
});

const json = (body, status, origin) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(originAllowed(origin) ? corsHeaders(origin) : {}),
  },
});

async function mint(env, fetcher) {
  const keyId = env.TURN_KEY_ID || DEFAULT_TURN_KEY_ID;
  const endpoint = `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetcher(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.TURN_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ttl: CREDENTIAL_TTL }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`turn api ${res.status}`);
    const payload = await res.json();
    if (!Array.isArray(payload?.iceServers)) throw new Error('invalid turn response');
    return payload;
  } finally { clearTimeout(timer); }
}

export async function handleRequest(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin') ?? '';
  if (url.pathname !== '/ice') return json({ error: 'not found' }, 404, origin);
  if (!originAllowed(origin)) return json({ error: 'forbidden' }, 403, origin);
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== 'GET')
    return json({ error: 'method not allowed' }, 405, origin);
  if (!env.TURN_API_TOKEN || typeof env.TURN_RATE_LIMITER?.limit !== 'function')
    return json({ error: 'not configured' }, 500, origin);

  // A static public game cannot authenticate players without adding an
  // account service. Origin validation blocks accidental cross-site use, and
  // this platform-enforced per-address ceiling limits scripted minting. Each
  // accepted request gets its own credential, so one leak no longer exposes a
  // key shared by every player served by the isolate.
  const actor = request.headers.get('cf-connecting-ip') || 'unknown';
  let success = false;
  try { ({ success } = await env.TURN_RATE_LIMITER.limit({ key: actor })); }
  catch { return json({ error: 'rate limiter unavailable' }, 503, origin); }
  if (!success) {
    const response = json({ error: 'rate limited' }, 429, origin);
    response.headers.set('retry-after', '60');
    return response;
  }
  try {
    return json(await mint(env, fetcher), 200, origin);
  } catch {
    // The game plays on without a relay, so this is degraded connection
    // coverage rather than a game outage. Do not expose upstream details.
    return json({ error: 'credentials unavailable' }, 502, origin);
  }
}

export default { fetch: handleRequest };
