// protocol.js — bounded structural validation for every network trust boundary.
import { finiteVector, isRecord, parseSpawnRow } from './multiplayer.js';
import { TEAM_PING_KINDS, validPingDirection } from './social.js';
import { SECURED_ACTIONS } from './security.js';
import { validVoxelStoryMetrics } from './voxel-stories.js';
import { validDeathRecap } from './death-recap.js';
import { validOperationRow } from './operations.js';

export const PROTOCOL_VERSION = 11;

const finite = Number.isFinite;
const team = value => value === 'green' || value === 'blue';
const shortString = (value, max) => typeof value === 'string' && value.length <= max;
const finiteArray = (value, length) =>
  Array.isArray(value) && value.length === length && value.every(finite);
const operation = value => value === null || validOperationRow(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const exactKeys = (value, allowed, required = []) => {
  const set = new Set(allowed);
  return Object.keys(value).every(key => set.has(key))
    && required.every(key => own(value, key));
};
const rows = (value, width, max) =>
  Array.isArray(value) && value.length <= max
    && value.every(row => Array.isArray(row) && row.length === width
      && row.every(finite));

export function validRoster(value) {
  return isRecord(value)
    && exactKeys(value, ['t', 'p', 'b'], ['p', 'b'])
    && (value.t === undefined || value.t === 'r')
    && Array.isArray(value.p) && value.p.length <= 10
    && value.p.every(r => Array.isArray(r) && r.length === 4 && finite(r[0])
      && shortString(r[1], 64) && team(r[2]) && shortString(r[3], 128))
    && Array.isArray(value.b) && value.b.length <= 10
    && value.b.every(r => Array.isArray(r) && r.length === 3 && finite(r[0])
      && shortString(r[1], 64) && team(r[2]));
}

export function validEditLog(value) {
  return Array.isArray(value) && value.length <= 100000 && value.every(e => {
    if (!Array.isArray(e)) return false;
    if (e[0] === 'b') return e.length === 5 && e.slice(1).every(finite);
    return e.length === 4 && e.every(finite);
  });
}

export function validClientMessage(d) {
  if (!isRecord(d) || !shortString(d.t, 8)) return false;
  if (d.t === 'ping') return exactKeys(d, ['t'], ['t']);
  if (d.t === 'hi') return exactKeys(d, ['t', 'v', 'name', 'team'], ['t', 'v', 'name'])
    && d.v === PROTOCOL_VERSION && shortString(d.name, 64)
    // PeerJS/BinaryPack may preserve an omitted optional value as null.
    // Both null and undefined mean AUTO; named teams still need validation.
    && (d.team == null || team(d.team));
  if (d.t === 's') return exactKeys(d,
    ['t', 'x', 'y', 'z', 'yaw', 'tool', 'c', 'ts', 'strike'],
    ['t', 'x', 'y', 'z', 'yaw', 'tool', 'c'])
    && [d.x, d.y, d.z, d.yaw].every(finite)
    && Number.isInteger(d.tool) && (d.c === 0 || d.c === 1)
    && (d.ts === undefined || finite(d.ts))
    && (d.strike === undefined || (isRecord(d.strike) && finite(d.strike.x) && finite(d.strike.z)));
  if (d.t !== 'a' || !shortString(d.k, 16)) return false;
  if (SECURED_ACTIONS.includes(d.k)
      && (!Number.isSafeInteger(d.n) || d.n < 1)) return false;
  const actionKeys = {
    chat: ['t', 'k', 'text', 'scope'], class: ['t', 'k', 'cls'],
    strike: ['t', 'k', 'n', 'x', 'z', 'yaw'], overcharge: ['t', 'k', 'n'],
    mark: ['t', 'k', 'd'], rematch: ['t', 'k'], squad: ['t', 'k'],
    votekick: ['t', 'k', 'target'],
    resync: ['t', 'k', 'scope'], reload: ['t', 'k', 'n'],
    shoot: ['t', 'k', 'n', 'd', 'o'], dig: ['t', 'k', 'n', 'd', 'o'],
    place: ['t', 'k', 'n', 'd', 'o'], nade: ['t', 'k', 'n', 'd', 'o'],
  };
  if (!actionKeys[d.k] || !exactKeys(d, actionKeys[d.k], ['t', 'k'])) return false;
  if (d.k === 'chat') return shortString(d.text, 512)
    && (d.scope === 'all' || d.scope === 'team');
  if (d.k === 'class') return Number.isInteger(d.cls);
  if (d.k === 'strike') return finite(d.x) && finite(d.z) && finite(d.yaw);
  if (d.k === 'overcharge') return true;
  if (d.k === 'mark') return validPingDirection(d.d);
  if (d.k === 'rematch') return true;
  if (d.k === 'squad') return true;
  if (d.k === 'votekick') return Number.isInteger(d.target) && d.target >= 0 && d.target <= 10000;
  if (d.k === 'resync') return d.scope === 'state' || d.scope === 'world';
  if (d.k === 'reload') return true;
  return ['shoot', 'dig', 'place', 'nade'].includes(d.k)
    && finiteVector(d.d) && (d.o === undefined || finiteVector(d.o));
}

function validSnapshot(d) {
  if (!exactKeys(d, ['t', 'p', 'b', 'q', 'full', 'ack', 'wr', 'wh', 'c', 'm',
      'op', 'mb', 'tb', 'bd', 'w', 'g', 'a', 'u', 'l', 'f', 'h', 'rm', 'o', 'ts'],
      ['t', 'p', 'b', 'c', 'g'])) return false;
  if (!rows(d.p, 15, 10) || !rows(d.b, 10, 10)) return false;
  if (!d.p.every(r => Number.isInteger(r[12]) && r[12] >= 0 && r[12] <= 30
      && Number.isInteger(r[13]) && r[13] >= 0 && r[13] <= 3000
      && (r[14] === 0 || r[14] === 1 || r[14] === 5))) return false;
  if (!d.b.every(r => Number.isInteger(r[9]) && r[9] >= 0 && r[9] <= 2)) return false;
  if ((d.q !== undefined && (!Number.isSafeInteger(d.q) || d.q < 1))
      || (d.full !== undefined && d.full !== 0 && d.full !== 1)
      || (d.ack !== undefined && (!Number.isSafeInteger(d.ack) || d.ack < 0))
      || (d.wr !== undefined && (!Number.isSafeInteger(d.wr) || d.wr < 0))
      || (d.wh !== undefined && (!Number.isInteger(d.wh) || d.wh < 0 || d.wh > 0xffffffff))) return false;
  if (!finiteArray(d.c, 2)) return false;
  if (d.m !== undefined && (!finiteArray(d.m, 3) || d.m[0] < 0 || d.m[0] > 36000
      || (d.m[1] !== 0 && d.m[1] !== 1) || d.m[2] < 0)) return false;
  if (d.op !== undefined && !operation(d.op)) return false;
  if (d.mb !== undefined && (!finiteArray(d.mb, 3)
      || (d.mb[0] !== 0 && d.mb[0] !== 1)
      || !Number.isInteger(d.mb[1]) || d.mb[1] < 0 || d.mb[1] > 100
      || !Number.isInteger(d.mb[2]) || d.mb[2] < 0 || d.mb[2] > 100)) return false;
  if (d.tb !== undefined && d.tb !== 0 && d.tb !== 1) return false;
  if (d.bd !== undefined && (!finiteArray(d.bd, 3)
      || (d.bd[0] !== 0 && d.bd[0] !== 1)
      || !Number.isInteger(d.bd[1]) || d.bd[1] < 0 || d.bd[1] > 2
      || !Number.isInteger(d.bd[2]) || d.bd[2] < 0 || d.bd[2] > 2)) return false;
  if (d.w !== undefined && d.w !== null && !team(d.w)) return false;
  if (!Array.isArray(d.g) || d.g.length > 16 || !d.g.every(v => finiteArray(v, 3))) return false;
  if (d.a !== undefined && (!Array.isArray(d.a) || d.a.length > 10
      || !d.a.every(v => finiteArray(v, 7) && Number.isInteger(v[0]) && v[0] >= 0
        && Number.isInteger(v[5]) && v[5] >= 0 && v[5] <= 5000
        && Number.isInteger(v[6]) && v[6] >= 0))) return false;
  if (d.u !== undefined && (!Array.isArray(d.u) || d.u.length > 10
      || !d.u.every(v => finiteArray(v, 4) && Number.isInteger(v[0]) && v[0] >= 0
        && Number.isInteger(v[1]) && v[1] >= 0 && v[1] <= 1000
        && Number.isInteger(v[2]) && v[2] >= 0 && v[2] <= 20
        && Number.isInteger(v[3]) && v[3] >= 0 && v[3] <= 150))) return false;
  if (d.l !== undefined && (!Array.isArray(d.l) || d.l.length > 8
      || !d.l.every(v => finiteArray(v, 5) && Number.isInteger(v[0]) && v[0] >= 0 && v[0] < 8
        && Number.isInteger(v[1]) && v[1] >= 0 && v[1] <= 300
        && Number.isInteger(v[2]) && v[2] >= 0 && v[2] <= 20
        && Number.isInteger(v[3]) && v[3] >= 0 && v[3] <= 2
        && (v[4] === 0 || v[4] === 1)))) return false;
  if (d.f !== null && d.f !== undefined && (!isRecord(d.f)
      || !finiteArray(d.f.g, 5) || !finiteArray(d.f.b, 5))) return false;
  if (d.h !== null && d.h !== undefined && (!Array.isArray(d.h)
      || ![4, 6, 8].includes(d.h.length)
      || !(d.h[0] === null || team(d.h[0])) || !finite(d.h[1])
      || d.h[1] < 0 || d.h[1] > 60 || (d.h[2] !== 0 && d.h[2] !== 1)
      || !(d.h[3] === null || team(d.h[3]))
      || (d.h.length >= 6 && (!Number.isInteger(d.h[4]) || d.h[4] < 0 || d.h[4] > 7
        || !finite(d.h[5]) || d.h[5] < 0 || d.h[5] > 120))
      || (d.h.length === 8 && (!Number.isInteger(d.h[6]) || d.h[6] < 0 || d.h[6] > 10
        || !Number.isInteger(d.h[7]) || d.h[7] < 0 || d.h[7] > 10)))) return false;
  if (d.rm !== undefined && (!isRecord(d.rm)
      || (d.rm.p !== undefined && (!Array.isArray(d.rm.p) || d.rm.p.length > 10 || !d.rm.p.every(finite)))
      || (d.rm.b !== undefined && (!Array.isArray(d.rm.b) || d.rm.b.length > 10 || !d.rm.b.every(finite)))))
    return false;
  return true;
}

function validEvent(d) {
  if (!shortString(d.k, 20)) return false;
  const eventKeys = {
    edit: ['t', 'k', 'x', 'y', 'z', 'v', 'wr', 'wh'],
    boom: ['t', 'k', 'x', 'y', 'z', 'r', 'strikeId', 'wr', 'wh'],
    telegraph: ['t', 'k', 'x', 'y', 'z', 'yaw', 'remaining', 'owner', 'id'],
    overcharge: ['t', 'k', 'owner', 'phase', 'remaining'],
    died: ['t', 'k', 'rt', 'recap'], envdmg: ['t', 'k', 'cause'],
    col: ['t', 'k', 'cells', 'wr', 'wh'],
    shot: ['t', 'k', 'sid', 'f', 'e', 'hit', 'hex', 'gun'],
    feed: ['t', 'k', 'html'], msg: ['t', 'k', 'text', 'color', 'team'],
    supply: ['t', 'k', 'blocks', 'nades'], hit: ['t', 'k', 'kill', 'tier'],
    dmgdir: ['t', 'k', 'x', 'z'],
    chat: ['t', 'k', 'name', 'text', 'team', 'scope'],
    mark: ['t', 'k', 'id', 'name', 'team', 'x', 'y', 'z', 'kind'],
    rematch: ['t', 'k', 'voters', 'needed'], squad: ['t', 'k', 'voters'],
    votekick: ['t', 'k', 'active', 'target', 'name', 'voters', 'needed', 'remaining'],
    spawn: ['t', 'k', 'x', 'y', 'z', 'yaw'], corr: ['t', 'k', 'x', 'y', 'z'],
    kick: ['t', 'k', 'reason'], kd: ['t', 'k', 'rows'],
    end: ['t', 'k', 'winner', 'story', 'op'],
    restart: ['t', 'k', 'seed', 'map', 'mode', 'op'],
  };
  if (!eventKeys[d.k] || !exactKeys(d, eventKeys[d.k], ['t', 'k'])) return false;
  if (['edit', 'boom', 'col'].includes(d.k)
      && ((d.wr !== undefined && (!Number.isSafeInteger(d.wr) || d.wr < 1))
        || (d.wh !== undefined && (!Number.isInteger(d.wh) || d.wh < 0 || d.wh > 0xffffffff)))) return false;
  switch (d.k) {
    case 'edit': return [d.x, d.y, d.z, d.v].every(finite);
    case 'boom': return [d.x, d.y, d.z, d.r].every(finite)
      && (d.strikeId === undefined || (Number.isInteger(d.strikeId) && d.strikeId >= 0));
    case 'telegraph': return [d.x, d.y, d.z, d.yaw, d.remaining, d.owner].every(finite)
      && Number.isInteger(d.id) && d.id >= 0 && Number.isInteger(d.owner) && d.owner >= 0
      && d.remaining >= 0 && d.remaining <= 5;
    case 'overcharge': return Number.isInteger(d.owner) && d.owner >= 0
      && ['windup', 'active', 'end'].includes(d.phase)
      && finite(d.remaining) && d.remaining >= 0 && d.remaining <= 15;
    case 'died': return (d.rt === undefined || (finite(d.rt) && d.rt >= 0 && d.rt <= 9))
      && (d.recap === undefined || validDeathRecap(d.recap));
    case 'envdmg': return d.cause === 'fell' || d.cause === 'drowned';
    case 'col': return Array.isArray(d.cells) && d.cells.length % 3 === 0
      && d.cells.length <= 12000 && d.cells.every(finite);
    case 'shot': return finiteVector(d.f) && finiteVector(d.e) && finite(d.hex)
      && shortString(d.sid, 128) && typeof d.hit === 'boolean' && shortString(d.gun, 32);
    case 'feed': return shortString(d.html, 1200);
    case 'msg': return shortString(d.text, 500)
      && shortString(d.color, 32) && (d.team === undefined || team(d.team));
    case 'supply': return Number.isInteger(d.blocks) && d.blocks >= 0 && d.blocks <= 20
      && Number.isInteger(d.nades) && d.nades >= 0 && d.nades <= 1;
    case 'hit': return typeof d.kill === 'boolean'
      && (d.tier === null || d.tier === undefined || ['double', 'triple', 'multi'].includes(d.tier));
    case 'dmgdir': return finite(d.x) && finite(d.z);
    case 'chat': return shortString(d.name, 64)
      && shortString(d.text, 512) && team(d.team)
      && (d.scope === 'all' || d.scope === 'team');
    case 'mark': return Number.isInteger(d.id) && d.id >= 0 && d.id <= 1e9
      && shortString(d.name, 64) && team(d.team)
      && [d.x, d.y, d.z].every(finite) && d.x >= 0 && d.x <= 256
      && d.y >= -4 && d.y <= 72 && d.z >= 0 && d.z <= 256
      && TEAM_PING_KINDS.includes(d.kind);
    case 'rematch': return Array.isArray(d.voters) && d.voters.length <= 10
      && d.voters.every(v => shortString(v, 16))
      && new Set(d.voters).size === d.voters.length
      && Number.isInteger(d.needed) && d.needed >= 1 && d.needed <= 10;
    case 'squad': return Array.isArray(d.voters) && d.voters.length <= 10
      && d.voters.every(v => shortString(v, 16))
      && new Set(d.voters).size === d.voters.length;
    case 'votekick': return d.active === false
      ? exactKeys(d, ['t', 'k', 'active'], ['t', 'k', 'active'])
      : d.active === true && Number.isInteger(d.target) && d.target >= 0 && d.target <= 10000
        && shortString(d.name, 12) && Array.isArray(d.voters) && d.voters.length <= 10
        && d.voters.every(v => shortString(v, 16))
        && new Set(d.voters).size === d.voters.length
        && Number.isInteger(d.needed) && d.needed >= 2 && d.needed <= 9
        && Number.isInteger(d.remaining) && d.remaining >= 0 && d.remaining <= 30;
    case 'spawn': return [d.x, d.y, d.z].every(finite) && (d.yaw === undefined || finite(d.yaw));
    case 'corr': return [d.x, d.y, d.z].every(finite);
    case 'kick': return d.reason === 'integrity' || d.reason === 'vote';
    case 'kd': return Array.isArray(d.rows) && d.rows.length <= 20
      && d.rows.every(r => Array.isArray(r) && r.length === 8 && shortString(r[0], 16)
        && shortString(r[1], 64) && team(r[2]) && r.slice(3).every(finite));
    case 'end': return team(d.winner)
      && (d.story === undefined || validVoxelStoryMetrics(d.story))
      && (d.op === undefined || operation(d.op));
    case 'restart': return finite(d.seed) && Number.isInteger(d.map) && d.map >= 0 && d.map < 6
      && ['ctf', 'tdm', 'koth'].includes(d.mode)
      && (d.op === undefined || operation(d.op));
    default: return false;
  }
}

export function validServerMessage(d) {
  if (!isRecord(d) || !shortString(d.t, 8)) return false;
  if (d.t === 'full') return exactKeys(d, ['t'], ['t']);
  if (d.t === 'version') return exactKeys(d, ['t', 'v'], ['t', 'v'])
    && Number.isInteger(d.v) && d.v >= 1 && d.v <= 1000;
  if (d.t === 'r') return validRoster(d);
  if (d.t === 'w') return exactKeys(d, ['t', 'id', 'team', 'seed', 'map', 'mode', 'me',
      'log', 'r', 'reset', 'migrated', 'spawn', 'wr', 'wh', 'op', 'mb', 'tb', 'bd'],
      ['t', 'id', 'team', 'seed', 'map', 'mode', 'me', 'log', 'r'])
    && shortString(d.id, 128) && team(d.team)
    && finite(d.seed) && Number.isInteger(d.map) && d.map >= 0 && d.map < 6
    && ['ctf', 'tdm', 'koth'].includes(d.mode)
    && Number.isInteger(d.me) && validEditLog(d.log ?? []) && validRoster(d.r)
    && (d.reset === undefined || d.reset === 0 || d.reset === 1)
    && (d.migrated || parseSpawnRow(d.spawn))
    && (!d.reset || parseSpawnRow(d.spawn))
    && (d.wr === undefined || (Number.isSafeInteger(d.wr) && d.wr === d.log.length))
    && (d.wh === undefined || (Number.isInteger(d.wh) && d.wh >= 0 && d.wh <= 0xffffffff))
    && (d.op === undefined || operation(d.op))
    && (d.mb === undefined || (finiteArray(d.mb, 3)
      && (d.mb[0] === 0 || d.mb[0] === 1)
      && Number.isInteger(d.mb[1]) && d.mb[1] >= 0 && d.mb[1] <= 100
      && Number.isInteger(d.mb[2]) && d.mb[2] >= 0 && d.mb[2] <= 100))
    && (d.tb === undefined || d.tb === 0 || d.tb === 1)
    && (d.bd === undefined || (finiteArray(d.bd, 3)
      && (d.bd[0] === 0 || d.bd[0] === 1)
      && Number.isInteger(d.bd[1]) && d.bd[1] >= 0 && d.bd[1] <= 2
      && Number.isInteger(d.bd[2]) && d.bd[2] >= 0 && d.bd[2] <= 2));
  if (d.t === 'sync') return exactKeys(d, ['t', 'seed', 'map', 'log', 'wr', 'wh'],
      ['t', 'seed', 'map', 'log', 'wr', 'wh']) && finite(d.seed)
    && Number.isInteger(d.map) && d.map >= 0 && d.map < 6
    && validEditLog(d.log)
    && Number.isSafeInteger(d.wr) && d.wr === d.log.length
    && Number.isInteger(d.wh) && d.wh >= 0 && d.wh <= 0xffffffff;
  if (d.t === 's') return validSnapshot(d);
  if (d.t === 'e') return validEvent(d);
  return false;
}

export function validPong(d) {
  return isRecord(d) && exactKeys(d,
    ['t', 'humans', 'max', 'map', 'mode', 'g', 'b', 'names'],
    ['t', 'humans', 'max', 'map', 'mode', 'g', 'b', 'names']) && d.t === 'pong'
    && Number.isInteger(d.humans) && Number.isInteger(d.max)
    && d.humans >= 0 && d.max >= 1 && d.humans <= d.max
    && Number.isInteger(d.map) && d.map >= 0 && d.map < 6
    && ['ctf', 'tdm', 'koth'].includes(d.mode)
    && finite(d.g) && finite(d.b)
    && Array.isArray(d.names) && d.names.length <= 10
    && d.names.every(n => shortString(n, 64));
}
