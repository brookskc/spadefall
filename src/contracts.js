// contracts.js — small, client-local terrain contract policy.
//
// Contracts are cosmetic progression only.  This module intentionally has no
// game, network, or DOM dependencies so progress and callsign decoration can
// be tested without constructing a renderer or a match.

export const TERRAIN_CONTRACTS = Object.freeze([
  Object.freeze({ id: 'route', action: 'dig', target: 10,
    name: 'ROUTE RUNNER', copy: 'SUCCESSFUL DIGS', badge: '[BR]' }),
  Object.freeze({ id: 'cover', action: 'place', target: 10,
    name: 'FORTIFY', copy: 'SUCCESSFUL BUILDS', badge: '[BD]' }),
  Object.freeze({ id: 'reshape', action: 'terrain', target: 30,
    name: 'RESHAPER', copy: 'SUCCESSFUL TERRAIN EDITS', badge: '[VX]' }),
]);

const IDS = new Set(TERRAIN_CONTRACTS.map(contract => contract.id));
const BADGES = new Set(TERRAIN_CONTRACTS.map(contract => contract.badge));
const progressKey = contract => contract.id === 'route' ? 'dig'
  : contract.id === 'cover' ? 'place' : 'terrain';
const clampInt = (value, max) => Math.max(0, Math.min(max,
  Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 0));

export function normalizeContractProgress(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  // `terrain` is the persisted total-edit counter. `edits` is accepted as a
  // migration alias so an interrupted/older client cannot lose its progress.
  return {
    dig: clampInt(source.dig, 10),
    place: clampInt(source.place ?? source.build, 10),
    terrain: clampInt(source.terrain ?? source.edits,
      TERRAIN_CONTRACTS.find(c => c.id === 'reshape').target),
  };
}

export function applyTerrainAction(progress, action) {
  const before = normalizeContractProgress(progress);
  const next = { ...before };
  if (action === 'dig') {
    next.dig = clampInt(next.dig + 1, 10);
    next.terrain = clampInt(next.terrain + 1, 30);
  } else if (action === 'place') {
    next.place = clampInt(next.place + 1, 10);
    next.terrain = clampInt(next.terrain + 1, 30);
  } else return { progress: next, completed: [], unlocked: [] };

  const completed = TERRAIN_CONTRACTS.filter(contract => {
    const key = progressKey(contract);
    return before[key] < contract.target && next[key] >= contract.target;
  });
  return { progress: next, completed, unlocked: completed.map(contract => contract.badge) };
}

export function contractSnapshot(progress, unlocked = []) {
  const current = normalizeContractProgress(progress);
  const validUnlocked = new Set([...unlocked].filter(badge => BADGES.has(badge)));
  return TERRAIN_CONTRACTS.map(contract => ({
    ...contract,
    current: current[progressKey(contract)],
    complete: current[progressKey(contract)] >= contract.target,
    unlocked: validUnlocked.has(contract.badge)
      || current[progressKey(contract)] >= contract.target,
  }));
}

export function normalizeBadges(raw, progress = {}) {
  const completed = new Set(contractSnapshot(progress).filter(c => c.complete).map(c => c.badge));
  const source = Array.isArray(raw) ? raw : [];
  return [...new Set(source.filter(badge => BADGES.has(badge)).filter(badge => completed.has(badge)))]
    .concat([...completed].filter(badge => !source.includes(badge)));
}

export function normalizeSelectedBadge(selected, unlocked = []) {
  return unlocked.includes(selected) && BADGES.has(selected) ? selected : null;
}

export function decorateCallsign(raw, badge = null) {
  const name = String(raw ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 _-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12) || 'Player';
  const tag = BADGES.has(badge) ? badge : '';
  // The raw callsign remains capped at 12; even the longest fixed tag leaves
  // a generous margin below the 64-character wire/name bound.
  return tag ? `${tag} ${name}` : name;
}

export function validContractId(id) { return IDS.has(id); }
export function validBadge(badge) { return BADGES.has(badge); }
