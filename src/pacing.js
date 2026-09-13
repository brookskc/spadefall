// pacing.js — pure round pacing rules shared by the game and headless tests.

export const RESPAWN_WAVE = Object.freeze({ ctf: 7, tdm: 6, koth: 7 });
export const MATCH_DURATION = Object.freeze({ ctf: 12 * 60, tdm: 9 * 60, koth: 10 * 60 });
export const PUBLIC_MATCH_DURATION = Object.freeze({ ctf: 12 * 60, tdm: 330, koth: 360 });
export const FLAG_RETURN_TIME = 15;
export const CTF_SPAWN = Object.freeze({
  anchorGrace: 3,
  minProgress: 18,
  midfieldBuffer: 10,
  enemyClearance: 20,
  activeFlagClearance: 24,
  anchorSupportRadius: 22,
  behindFrontMin: 10,
  behindFrontMax: 18,
  defensePullback: 28,
});

// KOTH spawns are deliberately kept on the home-facing approach to the live
// point.  The cone is wide enough for a useful lateral route, while still
// making it impossible for a wave to appear on the hill's far side.
export const KOTH_SPAWN = Object.freeze({
  anchorGrace: 3,
  anchorSupportRadius: 24,
  anchorEnemyClearance: 20,
  pointClearance: 10,
  behindFrontMin: 10,
  behindFrontMax: 18,
  homeConeCos: 0.25,
});

// TDM waves should move with the squad without ever materializing in the
// opponent's half. Progress is measured from a team's base toward its enemy;
// the small midfield buffer keeps floating-point/map-edge cases out of the
// neutral strip while leaving a useful 25%-49% combat band.
export const TDM_SPAWN = Object.freeze({
  minProgress: 0.25,
  maxProgress: 0.49,
  midfieldBuffer: 4,
  behindFrontMin: 10,
  behindFrontMax: 20,
  anchorGrace: 5,
  anchorSupportRadius: 22,
  anchorEnemyClearance: 20,
});
// Public quick-play shortens only the safe setback behind a qualified allied
// front. Its own-half, midfield buffer, LOS, support, and recent-death checks
// remain those of TDM_SPAWN; private/solo keeps the established 10–20m band.
export const PUBLIC_TDM_SPAWN = Object.freeze({
  behindFrontMin: 6,
  behindFrontMax: 14,
});

export const modeWaveSeconds = mode => RESPAWN_WAVE[mode] ?? RESPAWN_WAVE.ctf;
export const modeMatchSeconds = (mode, { publicRoom = false, override = null } = {}) => {
  if (Number.isFinite(override)) return override;
  return (publicRoom ? PUBLIC_MATCH_DURATION : MATCH_DURATION)[mode]
    ?? MATCH_DURATION.ctf;
};

// Deaths land on shared round-time boundaries instead of starting isolated
// countdowns. A tiny grace window avoids a visually confusing instant
// redeploy when somebody dies on the exact frame a wave breaks.
export function respawnWaveDelay(mode, elapsed, grace = 0.6) {
  const wave = modeWaveSeconds(mode);
  const time = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  const into = time % wave;
  let delay = into < 1e-6 ? wave : wave - into;
  if (delay < grace) delay += wave;
  return delay;
}

const distance2d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// CTF can redeploy a wave near its own frontline, but never across midfield
// or directly into a live fight. The rendered controller supplies terrain
// and line-of-sight facts; this pure boundary keeps the mode rules testable.
export function ctfFrontlineAllowed(candidate, {
  ownX, enemyX, enemies = [], activeFlags = [], visibleEnemies = 0, frontlineBonus = 0,
} = {}) {
  if (!candidate || !Number.isFinite(candidate.x) || !Number.isFinite(candidate.z)
      || !Number.isFinite(ownX) || !Number.isFinite(enemyX) || ownX === enemyX
      || visibleEnemies !== 0) return false;
  const dir = Math.sign(enemyX - ownX);
  const halfField = Math.abs(enemyX - ownX) / 2;
  const progress = (candidate.x - ownX) * dir;
  const bonus = Math.max(0, Math.min(8, Number(frontlineBonus) || 0));
  if (progress < CTF_SPAWN.minProgress
      || progress > halfField - CTF_SPAWN.midfieldBuffer + bonus) return false;
  const near = (point, distance) => point && Number.isFinite(point.x)
    && Number.isFinite(point.z) && distance2d(candidate, point) < distance;
  if (enemies.some(enemy => near(enemy, CTF_SPAWN.enemyClearance))) return false;
  if (activeFlags.some(flag => near(flag, CTF_SPAWN.activeFlagClearance))) return false;
  return true;
}

const pacingPoint = value => value?.body?.pos ?? value?.pos ?? value;

// CTF anchors are stricter than ordinary tactical candidates.  A carrier is
// excluded by the caller too, but keeping that rule here makes this pure
// predicate safe to use in headless authority tests.
export function ctfAnchorAllowed(anchor, {
  ownX, enemyX, now = 0, enemies = [], nearbyAllies = [], visibleEnemies = 0,
  combatGrace = CTF_SPAWN.anchorGrace,
  supportRadius = CTF_SPAWN.anchorSupportRadius,
  enemyClearance = CTF_SPAWN.enemyClearance,
} = {}) {
  const point = pacingPoint(anchor);
  const progress = tdmForwardProgress(point, { ownX, enemyX });
  const distance = Number.isFinite(ownX) && Number.isFinite(enemyX)
    ? Math.abs(enemyX - ownX) : NaN;
  const max = distance / 2 - CTF_SPAWN.midfieldBuffer;
  if (!point || progress === null || !Number.isFinite(distance)
      || progress < 0 || progress > max / distance
      || anchor?.alive === false || anchor?.carrier
      || !Number.isFinite(now)
      || now - (anchor?._spawnedAt ?? -Infinity) < combatGrace
      || now - (anchor?._combatAt ?? -Infinity) < combatGrace
      || visibleEnemies !== 0) return false;
  const near = (other, radius) => {
    const p = pacingPoint(other);
    return p && Number.isFinite(p.x) && Number.isFinite(p.z)
      && distance2d(point, p) < radius;
  };
  if (enemies.some(enemy => near(enemy, enemyClearance))) return false;
  return nearbyAllies.some(ally => ally !== anchor && ally?.alive !== false
    && near(ally, supportRadius));
}

// Median allied progress is normalized like the TDM equivalent, but only
// considers living own-side/frontline rows. One unsupported deep flanker is
// therefore unable to pull a CTF wave into an attacker's position.
export function ctfMedianForwardProgress(points = [], { ownX, enemyX } = {}) {
  if (!Number.isFinite(ownX) || !Number.isFinite(enemyX) || ownX === enemyX)
    return null;
  const distance = Math.abs(enemyX - ownX);
  const max = distance / 2 - CTF_SPAWN.midfieldBuffer;
  const values = points.map(point => tdmForwardProgress(pacingPoint(point), { ownX, enemyX }))
    .filter(value => value !== null && Number.isFinite(value)
      && value >= 0 && value <= max / distance)
    .sort((a, b) => a - b);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle]
    : (values[middle - 1] + values[middle]) / 2;
}

// Project a CTF wave behind the median front.  `frontProgress` is normalized
// (0..1), while the returned value is metres from own base, matching
// ctfFrontlineAllowed.  A missing own flag materially pulls the wave homeward.
export function ctfWaveProgress(frontProgress, {
  ownX, enemyX, behind, defending = false, defensePullback = CTF_SPAWN.defensePullback,
  frontlineBonus = 0,
} = {}) {
  if (!Number.isFinite(ownX) || !Number.isFinite(enemyX) || ownX === enemyX
      || !Number.isFinite(frontProgress)) return null;
  const distance = Math.abs(enemyX - ownX);
  const max = distance / 2 - CTF_SPAWN.midfieldBuffer
    + Math.max(0, Math.min(8, Number(frontlineBonus) || 0));
  const offset = Number.isFinite(behind) ? Math.max(0, behind)
    : (CTF_SPAWN.behindFrontMin + CTF_SPAWN.behindFrontMax) / 2;
  // Accept metres as well as normalized progress for resilient test fixtures.
  const front = Math.abs(frontProgress) <= 1
    ? frontProgress * distance : frontProgress;
  const pullback = defending && Number.isFinite(defensePullback)
    ? Math.max(0, defensePullback) : 0;
  return Math.max(CTF_SPAWN.minProgress, Math.min(max, front - offset - pullback));
}

const kothHomeVector = ({ home, hill, team, ownX } = {}) => {
  const h = pacingPoint(hill), b = pacingPoint(home);
  const fallbackX = Number.isFinite(ownX) ? ownX : team === 'blue' ? h?.x + 1 : h?.x - 1;
  const dx = (b?.x ?? fallbackX) - (h?.x ?? 0);
  const dz = (b?.z ?? h?.z ?? 0) - (h?.z ?? 0);
  const len = Math.hypot(dx, dz);
  return h && Number.isFinite(h.x) && Number.isFinite(h.z) && len > 1e-6
    ? { h, r: Number.isFinite(hill?.r) ? hill.r : (h.r ?? 0),
        dx: dx / len, dz: dz / len, len } : null;
};

// Signed distance from the active hill toward home. Positive is the only
// valid side for a KOTH anchor/candidate; this is intentionally directional,
// not an x-only test, so north/south hills retain a recognizable approach.
export function kothApproachDepth(point, { home, hill, team, ownX } = {}) {
  const p = pacingPoint(point), v = kothHomeVector({ home, hill, team, ownX });
  if (!p || !v || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
  return (p.x - v.h.x) * v.dx + (p.z - v.h.z) * v.dz;
}

export function kothMedianApproachDepth(points = [], options = {}) {
  const values = points.map(point => kothApproachDepth(pacingPoint(point), options))
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle]
    : (values[middle - 1] + values[middle]) / 2;
}

export function kothCandidateDirectionalAllowed(candidate, {
  home, hill, team, ownX, pointClearance = KOTH_SPAWN.pointClearance,
  coneCos = KOTH_SPAWN.homeConeCos,
} = {}) {
  const p = pacingPoint(candidate), v = kothHomeVector({ home, hill, team, ownX });
  if (!p || !v || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return false;
  const dx = p.x - v.h.x, dz = p.z - v.h.z, depth = dx * v.dx + dz * v.dz;
  const radial = Math.hypot(dx, dz);
  return depth > 0 && radial >= v.r + pointClearance
    && depth / radial >= Math.max(0, Math.min(1, coneCos));
}

// Alias kept descriptive for callers that only need the directional rule.
export const kothCandidateAllowed = kothCandidateDirectionalAllowed;

export function kothAnchorAllowed(anchor, {
  home, hill, team, ownX, now = 0, enemies = [], nearbyAllies = [], visibleEnemies = 0,
  combatGrace = KOTH_SPAWN.anchorGrace,
  supportRadius = KOTH_SPAWN.anchorSupportRadius,
  enemyClearance = KOTH_SPAWN.anchorEnemyClearance,
  pointClearance = KOTH_SPAWN.pointClearance,
} = {}) {
  const point = pacingPoint(anchor);
  if (!kothCandidateDirectionalAllowed(point, {
    home, hill, team, ownX, pointClearance })) return false;
  if (anchor?.alive === false || !Number.isFinite(now)
      || now - (anchor?._spawnedAt ?? -Infinity) < combatGrace
      || now - (anchor?._combatAt ?? -Infinity) < combatGrace
      || visibleEnemies !== 0) return false;
  const near = (other, radius) => {
    const p = pacingPoint(other);
    return p && Number.isFinite(p.x) && Number.isFinite(p.z)
      && distance2d(point, p) < radius;
  };
  if (enemies.some(enemy => near(enemy, enemyClearance))) return false;
  return nearbyAllies.some(ally => ally !== anchor && ally?.alive !== false
    && near(ally, supportRadius));
}

export function kothWaveApproachDepth(medianDepth, {
  behind, minDepth = KOTH_SPAWN.pointClearance, maxDepth = Infinity,
} = {}) {
  if (!Number.isFinite(medianDepth)) return null;
  const offset = Number.isFinite(behind) ? Math.max(0, behind)
    : (KOTH_SPAWN.behindFrontMin + KOTH_SPAWN.behindFrontMax) / 2;
  return Math.max(minDepth, Math.min(maxDepth, medianDepth + offset));
}

// Return normalized forward progress (0 at own base, 1 at enemy base). This
// is intentionally pure so tests can prove the territorial boundary without
// constructing a THREE/DOM Game.
export function tdmForwardProgress(point, { ownX, enemyX } = {}) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(ownX)
      || !Number.isFinite(enemyX) || ownX === enemyX) return null;
  return (point.x - ownX) * Math.sign(enemyX - ownX) / Math.abs(enemyX - ownX);
}

// Absolute progress band for ordinary TDM waves. The max is both below the
// authored midfield and capped at the requested 49% ideal so this remains a
// narrow neutral buffer even when bases are unusually close.
export function tdmSpawnProgressBand({ ownX, enemyX } = {}) {
  if (!Number.isFinite(ownX) || !Number.isFinite(enemyX) || ownX === enemyX)
    return null;
  const distance = Math.abs(enemyX - ownX);
  return {
    min: distance * TDM_SPAWN.minProgress,
    max: Math.min(distance * TDM_SPAWN.maxProgress,
      distance * 0.5 - TDM_SPAWN.midfieldBuffer),
  };
}

export function tdmTerritoryAllowed(candidate, { ownX, enemyX } = {}) {
  const progress = tdmForwardProgress(candidate, { ownX, enemyX });
  const band = tdmSpawnProgressBand({ ownX, enemyX });
  if (progress === null || !band) return false;
  const absolute = progress * Math.abs(enemyX - ownX);
  return absolute >= band.min && absolute <= band.max;
}

// Project a wave behind the median allied front and keep it inside the valid
// own-half band. Callers may provide a deterministic offset for test vectors;
// gameplay supplies a random value between the 10m and 20m rules above.
export function tdmWaveProgress(frontProgress, { ownX, enemyX, behind } = {}) {
  const band = tdmSpawnProgressBand({ ownX, enemyX });
  if (!band || !Number.isFinite(frontProgress)) return null;
  const offset = Number.isFinite(behind) ? behind
    : (TDM_SPAWN.behindFrontMin + TDM_SPAWN.behindFrontMax) / 2;
  const absoluteFront = frontProgress * Math.abs(enemyX - ownX);
  return Math.max(band.min, Math.min(band.max, absoluteFront - offset));
}

// A median is less sensitive than max/mean to one deep flanker or one player
// still rotating out of base. Inputs are positions or {x,z} rows.
export function tdmMedianForwardProgress(points = [], { ownX, enemyX } = {}) {
  const values = points.map(point => tdmForwardProgress(point, { ownX, enemyX }))
    .filter(value => value !== null && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle]
    : (values[middle - 1] + values[middle]) / 2;
}

// Anchor qualification is deliberately stricter than candidate scoring:
// an anchor must be on its own side, quiet for a grace interval, unseen by a
// foe, and have a nearby living teammate. `_combatAt` is updated for both
// dealt and taken damage by the authoritative game, so one timestamp covers
// either direction of the recent fight check.
export function tdmAnchorAllowed(anchor, {
  ownX, enemyX, now = 0, enemies = [], nearbyAllies = [], visibleEnemies = 0,
  combatGrace = TDM_SPAWN.anchorGrace,
  supportRadius = TDM_SPAWN.anchorSupportRadius,
  enemyClearance = TDM_SPAWN.anchorEnemyClearance,
} = {}) {
  const point = anchor?.body?.pos ?? anchor?.pos ?? anchor;
  const progress = tdmForwardProgress(point, { ownX, enemyX });
  const distance = Math.abs(enemyX - ownX);
  if (progress === null || !Number.isFinite(progress) || !Number.isFinite(distance)
      || progress < 0 || progress > 0.5 - TDM_SPAWN.midfieldBuffer / distance)
    return false;
  if (visibleEnemies > 0 || !Number.isFinite(now)
      || now - (anchor?._combatAt ?? -Infinity) < combatGrace) return false;
  const near = (other, radius) => {
    const p = other?.body?.pos ?? other?.pos ?? other;
    return p && Number.isFinite(p.x) && Number.isFinite(p.z)
      && distance2d(point, p) < radius;
  };
  if (enemies.some(enemy => near(enemy, enemyClearance))) return false;
  return nearbyAllies.some(ally => ally !== anchor && near(ally, supportRadius));
}

// The local objective cue should always point at the action required to make
// a capture possible. Recovering your missing flag outranks another attack.
export function ctfObjectiveKind({ carrier = false, ownState = 'home',
  enemyState = 'home' } = {}) {
  if (carrier) return 'return';
  if (ownState !== 'home') return 'recover';
  if (enemyState === 'carried') return 'escort';
  if (enemyState === 'dropped') return 'secure';
  return 'attack';
}

// Score a terrain-valid dynamic spawn. Safety dominates; action distance and
// squad cohesion only decide among candidates that are not immediate traps.
export function tacticalSpawnScore(candidate, {
  enemies = [], allies = [], objective = null, visibleEnemies = 0,
  recentDeaths = [], mode = 'tdm', upcomingObjective = null,
} = {}) {
  const nearestEnemy = enemies.length
    ? Math.min(...enemies.map(e => distance2d(candidate, e))) : 70;
  if (nearestEnemy < 13 || visibleEnemies > 0) return -Infinity;

  const nearestAlly = allies.length
    ? Math.min(...allies.map(a => distance2d(candidate, a))) : 18;
  const actionDistance = objective ? distance2d(candidate, objective) : nearestEnemy;
  const idealAction = mode === 'tdm' ? 32 : objective ? 34 : 38;
  const safety = Math.min(60, nearestEnemy) * 2.4;
  const exposure = Math.max(0, visibleEnemies) * 48;
  const action = Math.abs(actionDistance - idealAction) * 0.7;
  const cohesion = Math.abs(nearestAlly - 12) * 0.35;
  const crowding = nearestAlly < 3 ? 25 : 0;
  // A death lane remains dangerous longer than a direct enemy sample: it may
  // be held by a sniper beyond immediate visibility. Reject its core rather
  // than merely allowing action-distance scoring to win it back.
  if (recentDeaths.some(d => distance2d(candidate, d) < 24)) return -Infinity;
  const hotspot = recentDeaths.some(d => distance2d(candidate, d) < 34) ? 110 : 0;
  // A mild pull toward the next KOTH approach lane, never onto the point.
  const upcomingDistance = upcomingObjective ? distance2d(candidate, upcomingObjective) : 0;
  const upcoming = upcomingObjective && upcomingDistance >= 22
    ? Math.max(0, 42 - upcomingDistance) * 0.35 : 0;
  return safety - exposure - action - cohesion - crowding - hotspot + upcoming;
}

export const scoreLeader = scores => {
  const green = Number(scores?.green) || 0, blue = Number(scores?.blue) || 0;
  return green === blue ? null : green > blue ? 'green' : 'blue';
};

// Decide what happens when regulation reaches zero. CTF protects a live flag
// play, TDM ties become sudden death, and KOTH lets the trailing side keep the
// round alive while it still has a body contesting the objective.
export function regulationDecision(mode, scores, {
  flagsLive = false, losingTeamOnHill = false,
} = {}) {
  const leader = scoreLeader(scores);
  if (mode === 'ctf' && (flagsLive || !leader)) return { overtime: true, winner: null };
  if (mode === 'tdm' && !leader) return { overtime: true, winner: null };
  if (mode === 'koth' && (!leader || losingTeamOnHill)) return { overtime: true, winner: null };
  return { overtime: false, winner: leader };
}
