// protocol.js — bounded structural validation for every network trust boundary.
import { finiteVector, isRecord, parseSpawnRow } from './multiplayer.js';

const finite = Number.isFinite;
const team = value => value === 'green' || value === 'blue';
const shortString = (value, max) => typeof value === 'string' && value.length <= max;
const finiteArray = (value, length) =>
  Array.isArray(value) && value.length === length && value.every(finite);
const rows = (value, width, max) =>
  Array.isArray(value) && value.length <= max
    && value.every(row => Array.isArray(row) && row.length >= width
      && row.slice(0, width).every(finite));

export function validRoster(value) {
  return isRecord(value)
    && Array.isArray(value.p) && value.p.length <= 10
    && value.p.every(r => Array.isArray(r) && r.length >= 4 && finite(r[0])
      && shortString(String(r[1] ?? ''), 64) && team(r[2]) && shortString(String(r[3] ?? ''), 128))
    && Array.isArray(value.b) && value.b.length <= 10
    && value.b.every(r => Array.isArray(r) && r.length >= 3 && finite(r[0])
      && shortString(String(r[1] ?? ''), 64) && team(r[2]));
}

export function validEditLog(value) {
  return Array.isArray(value) && value.length <= 100000 && value.every(e => {
    if (!Array.isArray(e)) return false;
    if (e[0] === 'b') return e.length >= 5 && e.slice(1, 5).every(finite);
    return e.length >= 4 && e.slice(0, 4).every(finite);
  });
}

export function validClientMessage(d) {
  if (!isRecord(d) || !shortString(d.t, 8)) return false;
  if (d.t === 'ping') return true;
  if (d.t === 'hi') return shortString(String(d.name ?? ''), 64)
    // PeerJS/BinaryPack may preserve an omitted optional value as null.
    // Both null and undefined mean AUTO; named teams still need validation.
    && (d.team == null || team(d.team));
  if (d.t === 's') return [d.x, d.y, d.z, d.yaw].every(finite)
    && Number.isInteger(d.tool) && (d.ts === undefined || finite(d.ts))
    && (d.strike === undefined || (isRecord(d.strike) && finite(d.strike.x) && finite(d.strike.z)));
  if (d.t !== 'a' || !shortString(d.k, 16)) return false;
  if (d.k === 'chat') return shortString(String(d.text ?? ''), 512)
    && (d.scope === 'all' || d.scope === 'team');
  if (d.k === 'class') return Number.isInteger(d.cls);
  if (d.k === 'strike') return finite(d.x) && finite(d.z) && finite(d.yaw);
  if (d.k === 'overcharge') return true;
  return ['shoot', 'dig', 'place', 'nade'].includes(d.k)
    && finiteVector(d.d) && (d.o === undefined || finiteVector(d.o));
}

function validSnapshot(d) {
  if (!rows(d.p, 12, 10) || !rows(d.b, 9, 10)) return false;
  if (!finiteArray(d.c, 2)) return false;
  if (!Array.isArray(d.g) || d.g.length > 16 || !d.g.every(v => finiteArray(v, 3))) return false;
  if (d.a !== undefined && (!Array.isArray(d.a) || d.a.length > 10
      || !d.a.every(v => finiteArray(v, 7) && Number.isInteger(v[0]) && v[0] >= 0
        && Number.isInteger(v[5]) && v[5] >= 0 && v[5] <= 5000
        && Number.isInteger(v[6]) && v[6] >= 0))) return false;
  if (d.f !== null && d.f !== undefined && (!isRecord(d.f)
      || !finiteArray(d.f.g, 5) || !finiteArray(d.f.b, 5))) return false;
  if (d.h !== null && d.h !== undefined && (!Array.isArray(d.h) || d.h.length < 4
      || !(d.h[0] === null || team(d.h[0])) || !finite(d.h[1])
      || !(d.h[3] === null || team(d.h[3])))) return false;
  if (d.rm !== undefined && (!isRecord(d.rm)
      || (d.rm.p !== undefined && (!Array.isArray(d.rm.p) || d.rm.p.length > 10 || !d.rm.p.every(finite)))
      || (d.rm.b !== undefined && (!Array.isArray(d.rm.b) || d.rm.b.length > 10 || !d.rm.b.every(finite)))))
    return false;
  return true;
}

function validEvent(d) {
  if (!shortString(d.k, 20)) return false;
  switch (d.k) {
    case 'edit': return [d.x, d.y, d.z, d.v].every(finite);
    case 'boom': return [d.x, d.y, d.z, d.r].every(finite)
      && (d.strikeId === undefined || (Number.isInteger(d.strikeId) && d.strikeId >= 0));
    case 'telegraph': return [d.x, d.y, d.z, d.yaw, d.remaining, d.owner].every(finite)
      && Number.isInteger(d.id) && d.id >= 0 && Number.isInteger(d.owner) && d.owner >= 0
      && d.remaining >= 0 && d.remaining <= 5;
    case 'overcharge': case 'died': return true;
    case 'envdmg': return d.cause === 'fell' || d.cause === 'drowned';
    case 'col': return Array.isArray(d.cells) && d.cells.length <= 12000 && d.cells.every(finite);
    case 'shot': return finiteVector(d.f) && finiteVector(d.e) && finite(d.hex)
      && shortString(String(d.gun ?? ''), 32);
    case 'feed': return shortString(String(d.html ?? ''), 1200);
    case 'msg': return shortString(String(d.text ?? ''), 500)
      && shortString(String(d.color ?? ''), 32) && (d.team === undefined || team(d.team));
    case 'hit': return true;
    case 'dmgdir': return finite(d.x) && finite(d.z);
    case 'chat': return shortString(String(d.name ?? ''), 64)
      && shortString(String(d.text ?? ''), 512) && team(d.team);
    case 'spawn': return [d.x, d.y, d.z].every(finite) && (d.yaw === undefined || finite(d.yaw));
    case 'corr': return [d.x, d.y, d.z].every(finite);
    case 'kd': return Array.isArray(d.rows) && d.rows.length <= 20
      && d.rows.every(r => Array.isArray(r) && r.length >= 5 && shortString(String(r[0] ?? ''), 16)
        && shortString(String(r[1] ?? ''), 64) && team(r[2]) && finite(r[3]) && finite(r[4]));
    case 'end': return team(d.winner);
    case 'restart': return finite(d.seed) && Number.isInteger(d.map) && d.map >= 0 && d.map < 6;
    default: return false;
  }
}

export function validServerMessage(d) {
  if (!isRecord(d) || !shortString(d.t, 8)) return false;
  if (d.t === 'full') return true;
  if (d.t === 'r') return validRoster(d);
  if (d.t === 'w') return shortString(String(d.id ?? ''), 128) && team(d.team)
    && finite(d.seed) && Number.isInteger(d.map) && d.map >= 0 && d.map < 6
    && Number.isInteger(d.me) && validEditLog(d.log ?? []) && validRoster(d.r)
    && (d.reset === undefined || d.reset === 0 || d.reset === 1)
    && (d.migrated || parseSpawnRow(d.spawn))
    && (!d.reset || parseSpawnRow(d.spawn));
  if (d.t === 's') return validSnapshot(d);
  if (d.t === 'e') return validEvent(d);
  return false;
}

export function validPong(d) {
  return isRecord(d) && d.t === 'pong'
    && Number.isInteger(d.humans) && Number.isInteger(d.max)
    && d.humans >= 0 && d.max >= 1 && d.humans <= d.max
    && Number.isInteger(d.map) && d.map >= 0 && d.map < 6
    && ['ctf', 'tdm', 'koth'].includes(d.mode)
    && finite(d.g) && finite(d.b)
    && Array.isArray(d.names) && d.names.length <= 10
    && d.names.every(n => shortString(String(n ?? ''), 64));
}
