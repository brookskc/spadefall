import { HILL_ACTIVE_TIME } from './koth.js';

const query = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
const boundedParam = (key, fallback, min, max = Infinity) => {
  const value = Number.parseInt(query.get(key), 10);
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
};

export const WIN_SCORE = 3;
export const KILL_LIMIT = boundedParam('killcap', 30, 2);
export const HOLD_LIMIT = boundedParam('kothtime', 120, 10);
export const CAP_TIME = 6;
export const HILL_CYCLE = boundedParam('hillcycle', HILL_ACTIVE_TIME, 12, 120);
export const MATCH_TIME_OVERRIDE = query.has('matchtime')
  ? boundedParam('matchtime', null, 5, 3600) : null;

export const holdClock = seconds =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export function modeScoreLimit(mode) {
  return mode === 'tdm' ? KILL_LIMIT : mode === 'koth' ? HOLD_LIMIT : WIN_SCORE;
}
