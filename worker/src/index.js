/* global console */
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
  'access-control-allow-methods': 'GET, POST, OPTIONS',
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

const DIAGNOSTIC_ENUMS = Object.freeze({
  connection_failure: { stage: ['signaling', 'ice', 'turn', 'welcome', 'reconnect', 'other'],
    reason: ['timeout', 'down', 'unavailable', 'closed', 'protocol', 'network', 'other'],
    relay: ['yes', 'no', 'unknown'] },
  crash: { kind: ['error', 'rejection', 'other'] },
  frame_budget: { tier: ['medium', 'high'], result: ['pass', 'fail'] },
  migration: { outcome: ['success', 'failure'],
    reason: ['timeout', 'closed', 'protocol', 'network', 'other'] },
  match_abandon: { reason: ['pagehide', 'network', 'menu', 'other'] },
});

const exactKeys = (value, required, optional = []) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every(key => keys.includes(key))
    && keys.every(key => required.includes(key) || optional.includes(key));
};

export function validDiagnosticsEnvelope(value) {
  if (!exactKeys(value, ['v', 'build', 'events']) || value.v !== 1
      || typeof value.build !== 'string' || !/^[A-Za-z0-9._-]{1,24}$/.test(value.build)
      || !Array.isArray(value.events) || !value.events.length || value.events.length > 12)
    return false;
  return value.events.every(event => {
    const schema = DIAGNOSTIC_ENUMS[event?.type];
    if (!schema) return false;
    const extras = event.type === 'crash' ? ['fingerprint']
      : event.type === 'frame_budget' ? ['frame', 'long']
        : event.type === 'match_abandon' ? ['time'] : [];
    if (!exactKeys(event, ['type', ...Object.keys(schema), ...extras])) return false;
    if (!Object.entries(schema).every(([key, allowed]) => allowed.includes(event[key])))
      return false;
    if (event.type === 'crash' && !/^[a-f0-9]{8}$/.test(event.fingerprint)) return false;
    if (event.type === 'frame_budget'
        && (![event.frame, event.long].every(n => Number.isInteger(n) && n >= 0 && n <= 4)))
      return false;
    return event.type !== 'match_abandon'
      || (Number.isInteger(event.time) && event.time >= 0 && event.time <= 4);
  });
}

async function acceptDiagnostics(request, env, origin) {
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, origin);
  if (!env.GAME_ANALYTICS || typeof env.DIAGNOSTICS_RATE_LIMITER?.limit !== 'function')
    return json({ error: 'not configured' }, 503, origin);
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 4096)
    return json({ error: 'payload too large' }, 413, origin);
  const raw = await request.text();
  if (raw.length > 4096) return json({ error: 'payload too large' }, 413, origin);
  let payload;
  try { payload = JSON.parse(raw); }
  catch { return json({ error: 'invalid payload' }, 400, origin); }
  if (!validDiagnosticsEnvelope(payload)) return json({ error: 'invalid payload' }, 400, origin);
  const actor = request.headers.get('cf-connecting-ip') || 'unknown';
  let success = false;
  try { ({ success } = await env.DIAGNOSTICS_RATE_LIMITER.limit({ key: actor })); }
  catch { return json({ error: 'rate limiter unavailable' }, 503, origin); }
  if (!success) return json({ error: 'rate limited' }, 429, origin);
  for (const event of payload.events) {
    const fields = Object.entries(event).filter(([key]) => key !== 'type');
    env.GAME_ANALYTICS.writeDataPoint({
      indexes: [event.type],
      blobs: [payload.build, ...fields.filter(([, value]) => typeof value === 'string')
        .map(([key, value]) => `${key}:${value}`)],
      doubles: fields.filter(([, value]) => typeof value === 'number')
        .map(([, value]) => value),
    });
  }
  return new Response(null, { status: 204, headers: {
    ...corsHeaders(origin), 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  } });
}

export async function handleRequest(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin') ?? '';
  if (!originAllowed(origin)) return json({ error: 'forbidden' }, 403, origin);
  if (url.pathname === '/diagnostics') return acceptDiagnostics(request, env, origin);
  if (url.pathname !== '/ice') return json({ error: 'not found' }, 404, origin);
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
  } catch (error) {
    console.error('TURN credential mint failed',
      error instanceof Error ? error.message : 'unknown error');
    // The game plays on without a relay, so this is degraded connection
    // coverage rather than a game outage. Do not expose upstream details.
    return json({ error: 'credentials unavailable' }, 502, origin);
  }
}

// Cloudflare invokes module handlers as (request, env, executionContext).
// Keep the injectable fetcher on handleRequest for tests, but do not forward
// the runtime's execution context into that slot.
export default {
  fetch(request, env) { return handleRequest(request, env); },
};
