// environment.js — pure tuning and state transitions for environmental harm.
// Kept free of DOM/Three dependencies so the same rules can be tested headlessly
// and used by the authoritative host for local players, guests, and bots.

export const FALL_SAFE_SPEED = 13;
export const FALL_FATAL_SPEED = 33;

// Small drops stay free, medium drops sting, and a roughly 18-block fall is
// fatal from full health. The eased curve keeps ordinary voxel traversal from
// feeling punitive while making tall towers and blasted shafts genuinely risky.
export function fallDamageForImpact(speed) {
  if (!Number.isFinite(speed) || speed <= FALL_SAFE_SPEED) return 0;
  const t = Math.min(1, (speed - FALL_SAFE_SPEED) / (FALL_FATAL_SPEED - FALL_SAFE_SPEED));
  return Math.max(1, Math.round(100 * t * t));
}

// Remote players report positions rather than vertical velocity. Reconstruct
// the equivalent impact speed from the host-observed peak-to-landing distance.
export function impactSpeedForFallDistance(distance, gravity = 30) {
  if (!Number.isFinite(distance) || distance <= 0) return 0;
  return Math.sqrt(2 * gravity * distance);
}

export const BREATH_MAX = 12;
export const BREATH_RECOVERY_RATE = 4;
export const DROWN_INTERVAL = 1;
export const DROWN_DAMAGE = 10;

export function resetEnvironmentalState(entity) {
  entity._breath = BREATH_MAX;
  entity._drownClock = DROWN_INTERVAL;
  entity._fallPeakY = null;
  entity._remoteSupported = true;
  if (entity.body) entity.body.landedSpeed = 0;
}

// Returns the new breath state and however much damage became due during this
// tick. Damage starts one second after air reaches zero and then pulses once a
// second. Surfacing restores air over time instead of instantly, preventing
// rapid surface-dipping from resetting the entire danger window.
export function stepBreath(breath, drownClock, submerged, dt) {
  breath = Number.isFinite(breath) ? Math.max(0, Math.min(BREATH_MAX, breath)) : BREATH_MAX;
  drownClock = Number.isFinite(drownClock) && drownClock > 0 ? drownClock : DROWN_INTERVAL;
  dt = Number.isFinite(dt) ? Math.max(0, dt) : 0;

  if (!submerged) {
    return {
      breath: Math.min(BREATH_MAX, breath + dt * BREATH_RECOVERY_RATE),
      drownClock: DROWN_INTERVAL,
      damage: 0,
    };
  }

  const airUsed = Math.min(breath, dt);
  breath -= airUsed;
  let withoutAir = dt - airUsed;
  let ticks = 0;
  if (breath <= 0 && withoutAir > 0) {
    drownClock -= withoutAir;
    if (drownClock <= 0) {
      ticks = 1 + Math.floor(-drownClock / DROWN_INTERVAL);
      drownClock += ticks * DROWN_INTERVAL;
    }
  }
  return { breath, drownClock, damage: ticks * DROWN_DAMAGE };
}
