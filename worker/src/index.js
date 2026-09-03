// index.js — mints short-lived Cloudflare TURN credentials for Spadefall.
//
// Why this exists: the TURN key's API token is a long-lived secret that can
// mint unlimited relay credentials. Shipping it to the browser would let
// anyone lift it out of the bundle and relay their own traffic on our
// account, so it lives only in this Worker's secret store. Clients get
// credentials that expire instead.

const TURN_KEY_ID = '0a266bb92241c6f8f68a8068f72e4c45';
const TURN_API = `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`;

// Longer than the longest match (CTF regulation is 12 minutes plus overtime)
// so a credential never expires mid-round, short enough that a leaked one is
// worth little.
const CREDENTIAL_TTL = 7200;

// One credential is reused by every player the isolate serves until it nears
// expiry. Credentials are not per-player secrets — they authorize relay use,
// not identity — so sharing them costs nothing and spares us an upstream API
// call per page load. Isolates are short-lived, so this is a cheap win, not a
// cache we depend on.
const CACHE_MARGIN_MS = 10 * 60 * 1000;
let cached = null;
let cachedUntil = 0;

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
const originAllowed = origin =>
  ALLOWED_ORIGINS.has(origin)
  || (origin.startsWith('https://') && origin.endsWith(PREVIEW_SUFFIX));

const corsHeaders = origin => ({
  'access-control-allow-origin': originAllowed(origin) ? origin : 'https://spadefall.io',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type, accept',
  'access-control-max-age': '86400',
  vary: 'origin',
});

const json = (body, status, origin) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
});

async function mint(env, now) {
  if (cached && now < cachedUntil) return cached;
  const res = await fetch(TURN_API, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.TURN_API_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ttl: CREDENTIAL_TTL }),
  });
  if (!res.ok) throw new Error(`turn api ${res.status}`);
  const payload = await res.json();
  cached = payload;
  cachedUntil = now + CREDENTIAL_TTL * 1000 - CACHE_MARGIN_MS;
  return payload;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') ?? '';
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== 'GET')
      return json({ error: 'method not allowed' }, 405, origin);
    if (!env.TURN_API_TOKEN)
      return json({ error: 'not configured' }, 500, origin);
    try {
      const payload = await mint(env, Date.now());
      return json(payload, 200, origin);
    } catch (err) {
      // The game plays on without a relay, so a failure here is a degraded
      // connection rate rather than an outage. Say so plainly and let the
      // client fall back.
      return json({ error: 'credentials unavailable', detail: String(err.message ?? err) }, 502, origin);
    }
  },
};
