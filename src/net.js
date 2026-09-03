// net.js — PeerJS wrapper. Host-authoritative star topology over WebRTC.
// Signaling rides the free PeerJS cloud; gameplay is pure browser-to-browser.
// ?ns=name scopes all peer ids — tests and events get their own universe.
import { isRecord } from './multiplayer.js';
import { PROTOCOL_VERSION, validPong, validServerMessage } from './protocol.js';
const ns = new URLSearchParams(typeof location === 'undefined' ? '' : location.search)
  .get('ns')?.replace(/[^\w-]/g, '').slice(0, 16); // guarded for headless import
const PREFIX = 'spadefall-' + (ns ? ns + '-' : '');
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// Quick-match rendezvous: deterministic public room ids. Private codes are
// drawn from an alphabet without digits, so 'PUB0'…'PUB15' can never collide.
// Slots are scanned one page at a time: quiet hours cost one 8-slot probe,
// peak hours spill into the next page instead of bouncing players off a cap.
export const PUBLIC_SLOTS = 8;   // slots per scan page
export const PUBLIC_PAGES = 8;   // 64 rooms = 512–640 concurrent quick-matchers
export const PUBLIC_ROOMS = PUBLIC_SLOTS * PUBLIC_PAGES;
export const slotCode = i => 'PUB' + i;
export const publicPageSlots = page => {
  if (!Number.isInteger(page) || page < 0 || page >= PUBLIC_PAGES) return [];
  const start = page * PUBLIC_SLOTS;
  return Array.from({ length: PUBLIC_SLOTS }, (_, i) => start + i);
};
export const STATE_BUFFER_LIMIT = 64 * 1024;
export const INBOUND_RATE = 120;
export const INBOUND_BURST = 180;
export const CLIENT_MESSAGE_BYTES = 2048;
export const SERVER_MESSAGE_BYTES = 2 * 1024 * 1024;
export const SNAPSHOT_MESSAGE_BYTES = 64 * 1024;
export const EVENT_MESSAGE_BYTES = 128 * 1024;

// --- ICE configuration ------------------------------------------------------
// Direct browser-to-browser still wins wherever it can: STUN is tried first
// and the relay only carries players who cannot connect any other way —
// symmetric NAT and locked-down corporate networks, which is exactly where a
// browser game played on a work laptop lands. Credentials are minted by a
// Worker so the long-lived TURN API token never ships to a client.
//
// Net.host and Net.join are synchronous factories, so the fetch is primed once
// at boot and read from cache when a peer is built. A cold or failed cache is
// not fatal: peers fall back to PeerJS's default STUN-only configuration,
// which is what every build before this one shipped.
const ICE_ENDPOINT = new URLSearchParams(typeof location === 'undefined' ? '' : location.search)
  .get('ice') || ''; // TURN is opt-in via ?ice= until the probe fix is proven
const ICE_CACHE_MS = 60 * 60 * 1000;
let iceServers = null, iceExpiresAt = 0, icePending = null;

// Validate what the credential service returned before handing it to
// RTCPeerConnection, which throws on a malformed entry. Cloudflare returns an
// array; a bare object is accepted too so a different provider can be dropped
// in without touching call sites.
export function usableIceServers(payload) {
  const list = payload?.iceServers;
  const entries = Array.isArray(list) ? list : isRecord(list) ? [list] : [];
  const clean = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const urls = typeof entry.urls === 'string' ? [entry.urls]
      : Array.isArray(entry.urls) ? entry.urls.filter(u => typeof u === 'string' && u) : [];
    if (!urls.length) continue;
    const server = { urls };
    if (typeof entry.username === 'string') server.username = entry.username;
    if (typeof entry.credential === 'string') server.credential = entry.credential;
    clean.push(server);
  }
  return clean;
}

// Options for every Peer we construct. undefined means "PeerJS defaults",
// which is the pre-TURN behaviour.
export const peerOptions = () => iceServers ? { config: { iceServers } } : undefined;

export function resetIce() { iceServers = null; iceExpiresAt = 0; icePending = null; }

// Fetch relay credentials once and cache them. Never throws: every failure
// path — offline, CORS, a 502 from the Worker — resolves to an empty list and
// leaves the game on STUN only.
export function primeIce(opts = {}) {
  const endpoint = opts.endpoint ?? ICE_ENDPOINT;
  const doFetch = opts.fetch ?? (typeof fetch === 'function' ? fetch : null);
  const now = opts.now ?? Date.now();
  if (!doFetch || !endpoint) return Promise.resolve([]);
  if (iceServers && now < iceExpiresAt) return Promise.resolve(iceServers);
  if (icePending) return icePending;
  icePending = (async () => {
    try {
      const res = await doFetch(endpoint, { headers: { accept: 'application/json' } });
      if (!res.ok) return [];
      const clean = usableIceServers(await res.json());
      if (clean.length) { iceServers = clean; iceExpiresAt = now + ICE_CACHE_MS; }
      return clean;
    } catch { return []; } finally { icePending = null; }
  })();
  return icePending;
}

export function wireBytes(obj) {
  try { return new TextEncoder().encode(JSON.stringify(obj)).byteLength; }
  catch { return 0; }
}

export function wireBudget(obj, serverMessage = false) {
  if (!serverMessage) return CLIENT_MESSAGE_BYTES;
  if (obj?.t === 's') return SNAPSHOT_MESSAGE_BYTES;
  if (obj?.t === 'e') return EVENT_MESSAGE_BYTES;
  return SERVER_MESSAGE_BYTES;
}

export function withinWireBudget(obj, serverMessage = false) {
  const bytes = wireBytes(obj);
  return bytes > 0 && bytes <= wireBudget(obj, serverMessage);
}

// Exactly one open data channel owns a peer id. A replacement wins and the
// old channel is closed immediately; late data/close events from that old
// object are ignored by the identity checks in the host handlers below.
export function claimPeerChannel(connections, conn) {
  if (!(connections instanceof Map) || !conn?.peer) return null;
  const previous = connections.get(conn.peer);
  if (previous === conn) return previous;
  connections.set(conn.peer, conn);
  if (previous?.open) {
    try { previous.close(); } catch { /* already closing */ }
  }
  return previous ?? null;
}

// Position reports are superseded by the next one. Once a reliable WebRTC
// channel is congested, queuing more of them only makes the eventual state
// older and delays important actions behind stale movement. Other messages
// remain reliable and are never dropped by this policy.
export function shouldSend(conn, obj, limit = STATE_BUFFER_LIMIT) {
  if (!conn?.open) return false;
  if (obj?.t !== 's') return true;
  return (conn.dataChannel?.bufferedAmount ?? 0) <= limit;
}

// Host-side packet budget. An honest client normally sends 30 movement
// reports/sec plus a handful of actions; this budget tolerates four times
// that sustained rate and a large burst while preventing a patched peer from
// driving unbounded validation/gameplay work. The channel remains connected
// and naturally recovers as tokens refill, avoiding false-positive kicks.
export function allowInbound(conn, now = performance.now(), rate = INBOUND_RATE,
  burst = INBOUND_BURST) {
  if (!conn || !Number.isFinite(now) || rate <= 0 || burst <= 0) return false;
  const bucket = conn._inboundBucket ??= { tokens: burst, at: now };
  const elapsed = Math.max(0, Math.min(5, (now - bucket.at) / 1000));
  bucket.tokens = Math.min(burst, bucket.tokens + elapsed * rate);
  bucket.at = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens--;
  return true;
}

// Only a real signaling failure means "the matchmaking service is
// unreachable". A WebRTC/ICE error means this one connection could not be
// established, which with a relay configured happens routinely while probing
// empty slots. Probes share a single guest peer, so every probe's error
// handler sees every peer-level error — classifying an ICE failure as 'down'
// failed all eight probes at once and reported the service as offline.
export const SIGNALING_ERROR_TYPES = new Set([
  'network', 'server-error', 'socket-error', 'socket-closed',
  'ssl-unavailable', 'disconnected', 'browser-incompatible',
]);

export const probeErrorKind = type =>
  type === 'peer-unavailable' ? 'unavailable'
    : SIGNALING_ERROR_TYPES.has(type) ? 'down' : 'dead';

export function makeCode() {
  return Array.from({ length: 4 }, () =>
    CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
}

export class Net {
  // Handlers live on the instance so the lobby can rewire a connection after
  // the matchmaking handshake (e.g. attach the game once a room accepts us).
  constructor() {
    this.handlers = {};
    this.telemetry = {
      startedAt: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      sentPackets: 0, sentBytes: 0, recvPackets: 0, recvBytes: 0,
      droppedState: 0, droppedInbound: 0, droppedOversize: 0,
      duplicateChannels: 0, peakBuffered: 0,
    };
  }

  _record(direction, obj, conn, bytes = wireBytes(obj)) {
    const t = this.telemetry;
    if (direction === 'sent') { t.sentPackets++; t.sentBytes += bytes; }
    else { t.recvPackets++; t.recvBytes += bytes; }
    t.peakBuffered = Math.max(t.peakBuffered, conn?.dataChannel?.bufferedAmount ?? 0);
  }

  stats(now = typeof performance !== 'undefined' ? performance.now() : Date.now()) {
    const t = this.telemetry;
    const seconds = Math.max(0.001, (now - t.startedAt) / 1000);
    return { ...t, seconds,
      sentBytesPerSecond: t.sentBytes / seconds,
      recvBytesPerSecond: t.recvBytes / seconds };
  }

  _sendConn(conn, obj) {
    const bytes = wireBytes(obj);
    if (!bytes || bytes > wireBudget(obj, this.isHost)) {
      this.telemetry.droppedOversize++;
      return false;
    }
    if (!shouldSend(conn, obj)) {
      if (conn?.open && obj?.t === 's') this.telemetry.droppedState++;
      return false;
    }
    conn.send(obj);
    this._record('sent', obj, conn, bytes);
    return true;
  }

  // Replay anything that arrived before handlers existed. Call right after
  // assigning this.handlers on a host Net that came from _claim.
  flushPending() {
    const q = this._pending;
    this._pending = null;
    if (!q || !this.handlers.onData) return;
    for (const [id, d] of q) this.handlers.onData(id, d);
  }

  // ---------------- host ----------------
  static host(code, handlers) {
    const net = new Net();
    net.isHost = true;
    net.id = 'HOST';
    net.conns = new Map(); // peerId -> DataConnection
    net.handlers = handlers;
    net.peer = new Peer(PREFIX + code, peerOptions());
    window.__net = net; // debug handle
    net.peer.on('open', () => net.handlers.onOpen?.());
    net.peer.on('error', e => net.handlers.onError?.(e));
    net.peer.on('connection', conn => {
      console.debug(`[net] incoming conn from ${conn.peer} (have ${net.conns.get(conn.peer)?.open})`);
      conn.on('open', () => {
        console.debug(`[net] conn open ${conn.peer}`);
        // An open channel is proof of life — claim the map slot. A zombie
        // channel from an abandoned knock never opens, so it can never
        // steal the slot; whichever live channel opens last rightfully wins.
        if (claimPeerChannel(net.conns, conn)) net.telemetry.duplicateChannels++;
      });
      conn.on('data', d => {
        if (net.conns.get(conn.peer) !== conn) return;
        const bytes = wireBytes(d);
        if (!bytes || bytes > wireBudget(d, false)) {
          net.telemetry.droppedOversize++;
          return;
        }
        net._record('recv', d, conn, bytes);
        if (!allowInbound(conn)) { net.telemetry.droppedInbound++; return; }
        // A claimed room exists before its handlers do: _claim builds the Net
        // with {} and adoption attaches onData a beat later. A survivor whose
        // 'hi' lands in that window used to be answered with silence, and it
        // then sat out its full knock timeout before retrying. Buffer instead
        // and replay on attach — a frozen world for 15s was never worth it.
        if (!net.handlers.onData) {
          (net._pending ??= []).push([conn.peer, d]);
          if (net._pending.length > 64) net._pending.shift();
          return;
        }
        net.handlers.onData(conn.peer, d);
      });
      const drop = () => {
        console.debug(`[net] conn drop ${conn.peer}`);
        // Delete only if WE are the mapped connection: a zombie channel from
        // an abandoned knock may outlive its replacement, and its late close
        // must not evict the live one.
        if (net.conns.get(conn.peer) === conn && net.conns.delete(conn.peer))
          net.handlers.onLeave?.(conn.peer);
      };
      conn.on('close', () => { console.debug(`[net] conn close ${conn.peer}`); drop(); });
      conn.on('error', e => { console.debug(`[net] conn error ${conn.peer} ${e?.type ?? e}`); drop(); });
      conn.on('iceStateChanged', s => console.debug(`[net] ice ${conn.peer} ${s}`));
      // No eager conns.set here: claiming the slot before 'open' let a
      // zombie channel (abandoned knock, never opens) evict the live one.
    });
    return net;
  }

  // ---------------- client ----------------
  static join(code, handlers) {
    const net = new Net();
    net.isHost = false;
    net.handlers = handlers;
    net.peer = new Peer(peerOptions());
    window.__net = net; // debug handle
    net.peer.on('error', e => net.handlers.onError?.(e));
    net.peer.on('open', () => {
      net.conn = net.peer.connect(PREFIX + code, { reliable: true });
      net.conn.on('open', () => net.handlers.onOpen?.());
      net.conn.on('data', d => {
        const bytes = wireBytes(d);
        if (!bytes || bytes > wireBudget(d, true)) { net.telemetry.droppedOversize++; return; }
        net._record('recv', d, net.conn, bytes); net.handlers.onData?.(d);
      });
      net.conn.on('close', () => net.handlers.onClose?.());
      net.conn.on('error', () => net.handlers.onClose?.());
    });
    return net;
  }

  // Knock on one room with an existing anon peer. Resolves:
  //   { kind: 'join', conn, welcome } — welcomed in; adopt the connection
  //   { kind: 'full' }  — room answered but is at capacity
  //   { kind: 'dead' }  — no such room / wedged / refused mid-knock
  //   { kind: 'down' }  — signaling unreachable
  static _knock(peer, code, name, team, timeoutMs) {
    return new Promise(resolve => {
      let settled = false;
      const done = v => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer.off('error', onErr);
        // A failed knock must close its channel deterministically: an
        // abandoned one can still complete the handshake later and shambling
        // into the room as a zombie — half-open, never welcomed, and wedging
        // the host's connection map entry for our peer id.
        if (v.kind !== 'join') conn.close();
        resolve(v);
      };
      const timer = setTimeout(() => done({ kind: 'dead' }), timeoutMs);
      const onErr = e => done({ kind: e.type === 'peer-unavailable' ? 'dead' : 'down' });
      peer.on('error', onErr); // the broker reports unknown room ids on the peer
      const conn = peer.connect(PREFIX + code, { reliable: true });
      // team is the player's own OPTIONAL side preference (undefined when
      // they never set one) — the host honors it if given, falls back to
      // its own balance pick otherwise. See Game#_hostAddPlayer.
      conn.on('open', () => conn.send({ t: 'hi', v: PROTOCOL_VERSION, name, team }));
      conn.on('data', d => {
        if (!isRecord(d)) return;
        // Do not adopt a channel on a merely welcome-shaped packet. A stale
        // or incompatible host used to make matchmaking report success, then
        // Game rejected the packet and left the player in a frozen limbo.
        if (d.t === 'w' && validServerMessage(d)) done({ kind: 'join', conn, welcome: d });
        else if (d.t === 'full') done({ kind: 'full' });
        else if (d.t === 'version') done({ kind: 'version', v: d.v });
      });
      conn.on('close', () => done({ kind: 'dead' }));
      conn.on('error', () => done({ kind: 'dead' }));
    });
  }

  // Claim a public slot id as host. Resolves { kind: 'host', net } — real
  // handlers attach on adoption — or { kind: 'taken' } / { kind: 'down' }.
  static _claim(code, timeoutMs) {
    return new Promise(resolve => {
      let settled = false;
      const net = Net.host(code, {});
      const done = v => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v); // settle FIRST: if destroy() throws on a half-dead peer,
        try { if (v.kind !== 'host') net.destroy(); } catch { /* already gone */ }
      };
      const timer = setTimeout(() => done({ kind: 'down' }), timeoutMs);
      net.peer.on('open', () => done({ kind: 'host', net }));
      net.peer.on('error', e =>
        done({ kind: e.type === 'unavailable-id' ? 'taken' : 'down' }));
    });
  }

  // Wrap a welcomed knock connection as a client Net for adoption.
  static adoptGuest(peer, conn) {
    const net = new Net();
    net.isHost = false;
    net.peer = peer;
    net.conn = conn;
    window.__net = net; // debug handle
    peer.on('error', e => net.handlers.onError?.(e));
    conn.on('data', d => {
      const bytes = wireBytes(d);
      if (!bytes || bytes > wireBudget(d, true)) { net.telemetry.droppedOversize++; return; }
      net._record('recv', d, conn, bytes); net.handlers.onData?.(d);
    });
    conn.on('close', () => { console.debug(`[net] guest conn close`); net.handlers.onClose?.(); });
    conn.on('error', e => { console.debug(`[net] guest conn error ${e?.type ?? e}`); net.handlers.onClose?.(); });
    conn.on('iceStateChanged', s => console.debug(`[net] guest ice ${s}`));
    return net;
  }

  // Peek at one room without joining: resolves { kind: 'room', humans, max },
  // { kind: 'dead' } (nobody home), or { kind: 'down' } (signaling broken).
  // Probes run concurrently on ONE peer, and the broker reports a dead target
  // as a peer-level 'peer-unavailable' error naming that target — so a miss
  // for slot N must not sink the probe still talking to slot M.
  static _probe(peer, code, timeoutMs) {
    return new Promise(resolve => {
      const target = PREFIX + code;
      let settled = false;
      const done = v => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer.off('error', onErr);
        conn.close();
        resolve(v);
      };
      const timer = setTimeout(() => done({ kind: 'dead' }), timeoutMs);
      const onErr = e => {
        const kind = probeErrorKind(e.type);
        if (kind === 'unavailable') {
          if (String(e.message).includes(target)) done({ kind: 'dead' });
          return; // somebody else's miss — not ours
        }
        done({ kind });
      };
      peer.on('error', onErr);
      const conn = peer.connect(target, { reliable: true });
      conn.on('open', () => conn.send({ t: 'ping' }));
      conn.on('data', d => {
        if (validPong(d))
          done({ kind: 'room', humans: d.humans, max: d.max, map: d.map,
                 mode: d.mode, g: d.g, b: d.b, names: d.names ?? [] });
      });
      conn.on('close', () => done({ kind: 'dead' }));
      conn.on('error', () => done({ kind: 'dead' }));
    });
  }

  // Quick match over ONE anon guest peer — the broker throttles IPs that open
  // many signaling sockets, so the whole scan multiplexes over a single socket.
  // All slots are probed concurrently (data connections are cheap; sockets are
  // not), then we join the FULLEST room that still has space (ties break to
  // the lowest slot) so strangers pile into the same games. Only if nobody
  // has room do we claim a dead slot and host it ourselves.
  // Resolves { kind: 'host'|'join', net, slot, welcome? }
  //      or  { kind: 'full-all' } | { kind: 'down' }.
  // overallMs bounds the WHOLE search. Individual probes/knocks/claims are
  // each timed at timeoutMs, but they used to chain with nothing capping
  // the total: a page of rooms that all look open but answer slowly could
  // walk through up to 8 sequential knocks and 8 sequential claim+knock
  // pairs, twice over for two pages — technically finite, but on the order
  // of minutes. Nobody waits minutes; they conclude the game is broken and
  // leave. The deadline is checked only before each SEQUENTIAL step (the
  // concurrent probe phase is already bounded by timeoutMs on its own).
  static async quickScan(name, team, timeoutMs = 9000, overallMs = 20000) {
    const guest = new Peer(peerOptions());
    const ready = new Promise((res, rej) => {
      guest.on('open', res);
      guest.on('error', rej); // pre-open error = broker unreachable
    });
    try { await ready; } catch { guest.destroy(); return { kind: 'down' }; }
    const deadline = Date.now() + overallMs;
    const outOfTime = () => Date.now() > deadline;
    try {
      // Page through the slots: later pages are only probed once every
      // earlier room is full, so ordinary load costs one cheap page.
      for (let page = 0; page < PUBLIC_PAGES; page++) {
        if (outOfTime()) break;
        const results = await Promise.all(publicPageSlots(page)
          .map(i => Net._probe(guest, slotCode(i), timeoutMs).then(p => ({ slot: i, p }))));
        const open = [], dead = [];
        for (const { slot, p } of results) {
          console.debug(`[qm] probe ${slotCode(slot)} -> ${p.kind}${p.kind === 'room' ? ` ${p.humans}/${p.max}` : ''}`);
          if (p.kind === 'room') { if (p.humans < p.max) open.push({ slot, humans: p.humans }); }
          else if (p.kind === 'dead') dead.push(slot);
          else { guest.destroy(); return { kind: 'down' }; }
        }
        // Fullest first, ties to the lowest slot number.
        open.sort((a, b) => b.humans - a.humans || a.slot - b.slot);
        for (const room of open) {
          if (outOfTime()) { guest.destroy(); return { kind: 'timeout' }; }
          const k = await Net._knock(guest, slotCode(room.slot), name, team, timeoutMs);
          console.debug(`[qm] knock ${slotCode(room.slot)} -> ${k.kind}`);
          if (k.kind === 'join')
            return { kind: 'join', net: Net.adoptGuest(guest, k.conn), slot: room.slot, welcome: k.welcome };
          if (k.kind === 'version') { guest.destroy(); return k; }
          if (k.kind === 'down') { guest.destroy(); return { kind: 'down' }; }
          // 'full'/'dead': lost a race — try the next room
        }
        for (const i of dead) {
          if (outOfTime()) { guest.destroy(); return { kind: 'timeout' }; }
          const c = await Net._claim(slotCode(i), timeoutMs);
          console.debug(`[qm] claim ${slotCode(i)} -> ${c.kind}`);
          if (c.kind === 'host') { guest.destroy(); return { kind: 'host', net: c.net, slot: i }; }
          if (c.kind === 'down') { guest.destroy(); return { kind: 'down' }; }
          // 'taken': the probe said dead but the id is registered — the broker
          // never lies about that, so the probe was a false negative (slow net).
          // Give a proven-live room one direct knock before moving on.
          if (outOfTime()) { guest.destroy(); return { kind: 'timeout' }; }
          const k = await Net._knock(guest, slotCode(i), name, team, timeoutMs);
          console.debug(`[qm] knock ${slotCode(i)} (taken) -> ${k.kind}`);
          if (k.kind === 'join')
            return { kind: 'join', net: Net.adoptGuest(guest, k.conn), slot: i, welcome: k.welcome };
          if (k.kind === 'version') { guest.destroy(); return k; }
          if (k.kind === 'down') { guest.destroy(); return { kind: 'down' }; }
          // 'full'/'dead': genuinely unavailable — try the next dead slot
        }
        // Every room on this page was full — fall through to the next page.
      }
      guest.destroy();
      return outOfTime() ? { kind: 'timeout' } : { kind: 'full-all' };
    } catch (e) {
      guest.destroy();
      return { kind: 'down' };
    }
  }

  // Room browser: probe one eight-room page over one anon guest peer and
  // report what's live, fullest first. Unlike quickScan this never joins and
  // never claims — the guest peer stays open so the caller can knock on the
  // room the player picks (and must destroy it if nobody picks anything).
  // Keeping this paged matters now that the public pool has 64 rooms: opening
  // a temporary RTC connection to every room just to draw a list would turn
  // discovery into the most expensive networking action in the game.
  // Resolves { kind: 'rooms', guest, rooms: [{ slot, humans, max, map, mode,
  // g, b, names }], page, pages } or { kind: 'down' }.
  static async roomScan(page = 0, timeoutMs = 9000) {
    const slots = publicPageSlots(page);
    if (!slots.length) return { kind: 'invalid-page' };
    const guest = new Peer(peerOptions());
    const ready = new Promise((res, rej) => {
      guest.on('open', res);
      guest.on('error', rej);
    });
    try { await ready; } catch { guest.destroy(); return { kind: 'down' }; }
    const results = await Promise.all(slots.map(i =>
      Net._probe(guest, slotCode(i), timeoutMs).then(p => ({ slot: i, p }))));
    const rooms = [];
    for (const { slot, p } of results) {
      if (p.kind === 'room') rooms.push({ slot, ...p });
      else if (p.kind === 'down') { guest.destroy(); return { kind: 'down' }; }
    }
    rooms.sort((a, b) => b.humans - a.humans || a.slot - b.slot);
    return { kind: 'rooms', guest, rooms, page, pages: PUBLIC_PAGES };
  }

  get clientIds() { return [...this.conns.keys()]; }

  broadcast(obj) {
    for (const c of this.conns.values()) this._sendConn(c, obj);
  }
  sendTo(id, obj) {
    const c = this.conns.get(id);
    return this._sendConn(c, obj);
  }
  kick(id, delay = 250) {
    const c = this.conns?.get(id);
    if (!c) return false;
    setTimeout(() => {
      if (this.conns?.get(id) !== c) return;
      try { c.close(); } catch { /* already closing */ }
    }, Math.max(0, Math.min(1000, Number(delay) || 0)));
    return true;
  }
  send(obj) { // client -> host
    return this._sendConn(this.conn, obj);
  }
  destroy() { this.peer?.destroy(); }
}
