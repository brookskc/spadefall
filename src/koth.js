// koth.js — pure occupied-scoring and hill-rotation rules.

export const HILL_ACTIVE_TIME = 45;
export const HILL_MOVE_WARNING = 8;

export function occupiedScoringTeam(owner, presence = {}) {
  if (owner !== 'green' && owner !== 'blue') return null;
  const enemy = owner === 'green' ? 'blue' : 'green';
  return (presence[owner] ?? 0) > 0 && (presence[enemy] ?? 0) === 0 ? owner : null;
}

export function nextHillIndex(index, count) {
  if (!Number.isInteger(count) || count < 1) return 0;
  return ((Number.isInteger(index) ? index : 0) + 1) % count;
}

export function stepHillCapture(state = {}, sole, contested, dt, capTime = 6) {
  let owner = state.owner === 'green' || state.owner === 'blue' ? state.owner : null;
  let capTeam = state.capTeam === 'green' || state.capTeam === 'blue' ? state.capTeam : null;
  let progress = Number.isFinite(state.progress) ? Math.max(0, state.progress) : 0;
  const active = sole === 'green' || sole === 'blue' ? sole : null;
  const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  let captured = null;

  // Progress is not transferable: a different team taking the floor starts
  // its own bar at zero instead of inheriting the previous team's work.
  if (active && active !== capTeam) { capTeam = active; progress = 0; }
  if (active && active !== owner) {
    progress += step;
    if (progress >= capTime) { owner = active; progress = 0; captured = active; }
  } else if (!contested && progress > 0) {
    progress = Math.max(0, progress - step * 1.5);
  }
  return { owner, capTeam, progress, captured };
}

// The host owns this clock. Overtime freezes the active point so the deciding
// fight cannot be escaped by a relocation halfway through it.
export function stepHillRotation(remaining, dt, overtime = false,
  activeTime = HILL_ACTIVE_TIME, warningTime = HILL_MOVE_WARNING) {
  const before = Number.isFinite(remaining) ? Math.max(0, remaining) : activeTime;
  if (overtime || !Number.isFinite(dt) || dt <= 0)
    return { remaining: before, warn: false, rotate: false };
  const after = before - dt;
  if (after <= 0) return { remaining: activeTime, warn: false, rotate: true };
  return { remaining: after, warn: before > warningTime && after <= warningTime,
    rotate: false };
}
