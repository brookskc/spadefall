// field-stations.js — rules for the neutral voxel supply landmarks.
// Kept independent of THREE/DOM so the capture, contest, and anti-farming
// behavior can be exercised by the headless regression suite.

export const FIELD_STATION_RADIUS = 4.25;
export const FIELD_STATION_NOTICE_RADIUS = 13;
export const FIELD_STATION_CAPTURE_TIME = 2;
export const FIELD_STATION_COOLDOWN = 30;
export const FIELD_STATION_BLOCK_GRANT = 20;
export const FIELD_STATION_BLOCK_CAP = 50;
export const FIELD_STATION_NADE_GRANT = 1;
export const FIELD_STATION_NADE_CAP = 3;

export function stationCanSupply(e) {
  if (!e?.alive || e.carrier) return false;
  const nades = Number.isFinite(e.grenades) ? e.grenades : (e.nades ?? 0);
  return (e.blocks ?? 0) < FIELD_STATION_BLOCK_CAP || nades < FIELD_STATION_NADE_CAP;
}

export function inFieldStation(station, e, radius = FIELD_STATION_RADIUS) {
  if (!station || !e?.body?.pos) return false;
  const p = e.body.pos;
  return Math.hypot(p.x - station.x, p.z - station.z) <= radius
    && Math.abs(p.y - station.y) <= 5;
}

export function nearestFieldStation(stations, pos, maxDistance = Infinity) {
  let best = null, bestD = maxDistance;
  for (const station of stations ?? []) {
    const d = Math.hypot(pos.x - station.x, pos.z - station.z);
    if (d < bestD) { best = station; bestD = d; }
  }
  return best ? { station: best, distance: bestD } : null;
}

// One neutral cache can be fought over by either side. Any living body in
// the ring contests it, while at least one under-supplied non-carrier is
// required to make capture progress. Progress belongs to a team and resets
// on a side switch; a successful use starts one shared cooldown.
export function stepFieldStation(station, occupants, dt) {
  const next = {
    cooldown: Math.max(0, (station.cooldown ?? 0) - Math.max(0, dt)),
    progress: Math.max(0, station.progress ?? 0),
    team: station.team ?? null,
    contested: false,
  };
  if (next.cooldown > 0) {
    next.progress = 0; next.team = null;
    return { ...next, activated: null };
  }

  const teams = new Set((occupants ?? []).filter(e => e?.alive).map(e => e.team));
  if (teams.size > 1) return { ...next, progress: 0, team: null,
    contested: true, activated: null };
  const team = teams.values().next().value ?? null;
  const eligible = team && occupants.some(e => e.team === team && stationCanSupply(e));
  if (!team || !eligible) return { ...next, progress: 0, team: null, activated: null };
  if (next.team !== team) { next.team = team; next.progress = 0; }
  next.progress = Math.min(FIELD_STATION_CAPTURE_TIME, next.progress + Math.max(0, dt));
  if (next.progress < FIELD_STATION_CAPTURE_TIME) return { ...next, activated: null };
  return { cooldown: FIELD_STATION_COOLDOWN, progress: 0, team: null,
    contested: false, activated: team };
}

export function applyFieldSupply(e) {
  if (!stationCanSupply(e)) return { blocks: 0, nades: 0 };
  const beforeBlocks = e.blocks ?? 0;
  const nadeKey = Number.isFinite(e.grenades) ? 'grenades' : 'nades';
  const beforeNades = e[nadeKey] ?? 0;
  e.blocks = Math.min(FIELD_STATION_BLOCK_CAP,
    beforeBlocks + FIELD_STATION_BLOCK_GRANT);
  e[nadeKey] = Math.min(FIELD_STATION_NADE_CAP,
    beforeNades + FIELD_STATION_NADE_GRANT);
  return { blocks: e.blocks - beforeBlocks, nades: e[nadeKey] - beforeNades };
}
