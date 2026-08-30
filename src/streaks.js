// streaks.js — pure contribution-streak economy and Overcharge timing.

export const OVERCHARGE_COST = 500;
export const AIRSTRIKE_COST = 1000;
export const STREAK_CAP = AIRSTRIKE_COST;
export const OVERCHARGE_WINDUP = 1.25;
export const OVERCHARGE_DURATION = 12;
export const OVERCHARGE_OUTGOING = 1.35;
export const OVERCHARGE_INCOMING = 1.25;

export function gainStreak(current, contribution) {
  const value = Number.isFinite(current) ? Math.max(0, current) : 0;
  const gain = Number.isFinite(contribution) ? Math.max(0, contribution) : 0;
  return Math.min(STREAK_CAP, value + gain);
}

export function spendStreak(current, cost) {
  const value = Number.isFinite(current) ? Math.max(0, current) : 0;
  const price = Number.isFinite(cost) ? Math.max(0, cost) : Infinity;
  return value >= price ? value - price : null;
}

export function availableStreakAbility(points, charging = 0, active = 0) {
  if (charging > 0 || active > 0) return null;
  if (points >= AIRSTRIKE_COST) return 'airstrike';
  if (points >= OVERCHARGE_COST) return 'overcharge';
  return null;
}

export function stepOvercharge(charging, active, dt,
  windup = OVERCHARGE_WINDUP, duration = OVERCHARGE_DURATION) {
  let charge = Number.isFinite(charging) ? Math.max(0, charging) : 0;
  let live = Number.isFinite(active) ? Math.max(0, active) : 0;
  let step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  let started = false, ended = false;
  if (charge > 0) {
    if (step >= charge) {
      step -= charge;
      charge = 0;
      live = duration;
      started = true;
    } else {
      charge -= step;
      step = 0;
    }
  }
  if (live > 0 && step > 0) {
    live = Math.max(0, live - step);
    ended = live === 0;
  }
  return { charging: charge, active: live, started, ended };
}

export function overchargeDamage(amount, attackerActive, victimActive) {
  let out = Number(amount);
  if (!Number.isFinite(out)) return 0;
  if (attackerActive) out *= OVERCHARGE_OUTGOING;
  if (victimActive) out *= OVERCHARGE_INCOMING;
  return out;
}
