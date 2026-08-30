// pacing.js — pure round pacing rules shared by the game and headless tests.

export const RESPAWN_WAVE = Object.freeze({ ctf: 8, tdm: 6, koth: 7 });
export const MATCH_DURATION = Object.freeze({ ctf: 12 * 60, tdm: 9 * 60, koth: 10 * 60 });

export const modeWaveSeconds = mode => RESPAWN_WAVE[mode] ?? RESPAWN_WAVE.ctf;
export const modeMatchSeconds = mode => MATCH_DURATION[mode] ?? MATCH_DURATION.ctf;

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

// Score a terrain-valid dynamic spawn. Safety dominates; action distance and
// squad cohesion only decide among candidates that are not immediate traps.
export function tacticalSpawnScore(candidate, {
  enemies = [], allies = [], objective = null, visibleEnemies = 0,
} = {}) {
  const nearestEnemy = enemies.length
    ? Math.min(...enemies.map(e => distance2d(candidate, e))) : 70;
  if (nearestEnemy < 13) return -Infinity;

  const nearestAlly = allies.length
    ? Math.min(...allies.map(a => distance2d(candidate, a))) : 18;
  const actionDistance = objective ? distance2d(candidate, objective) : nearestEnemy;
  const idealAction = objective ? 34 : 38;
  const safety = Math.min(60, nearestEnemy) * 2.4;
  const exposure = Math.max(0, visibleEnemies) * 48;
  const action = Math.abs(actionDistance - idealAction) * 0.7;
  const cohesion = Math.abs(nearestAlly - 12) * 0.35;
  const crowding = nearestAlly < 3 ? 25 : 0;
  return safety - exposure - action - cohesion - crowding;
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
