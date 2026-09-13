import { HILL_ACTIVE_TIME } from './koth.js';

const query = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
const boundedParam = (key, fallback, min, max = Infinity) => {
  const value = Number.parseInt(query.get(key), 10);
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
};

export const WIN_SCORE = 3;
// Keep the parsed override separate from the private/solo defaults.  Public
// quick-play has a deliberately shorter policy, but an explicit QA query must
// remain authoritative in either room context (including `killcap=50`).
export const KILL_LIMIT_OVERRIDE = query.has('killcap')
  ? boundedParam('killcap', 50, 2) : null;
export const HOLD_LIMIT_OVERRIDE = query.has('kothtime')
  ? boundedParam('kothtime', 120, 10) : null;
export const KILL_LIMIT = KILL_LIMIT_OVERRIDE ?? 50;
export const HOLD_LIMIT = HOLD_LIMIT_OVERRIDE ?? 120;
export const PUBLIC_KILL_LIMIT = 35;
export const PUBLIC_HOLD_LIMIT = 90;
export const CAP_TIME = 6;
export const HILL_CYCLE = boundedParam('hillcycle', HILL_ACTIVE_TIME, 12, 120);
export const MATCH_TIME_OVERRIDE = query.has('matchtime')
  ? boundedParam('matchtime', null, 5, 3600) : null;

export const holdClock = seconds =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export function modeScoreLimit(mode, { publicRoom = false } = {}) {
  if (mode === 'tdm') return publicRoom && KILL_LIMIT_OVERRIDE === null
    ? PUBLIC_KILL_LIMIT : KILL_LIMIT;
  if (mode === 'koth') return publicRoom && HOLD_LIMIT_OVERRIDE === null
    ? PUBLIC_HOLD_LIMIT : HOLD_LIMIT;
  return WIN_SCORE;
}
