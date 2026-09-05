// streaks.js — pure contribution meter for the airstrike reward.

export const AIRSTRIKE_COST = 700;
export const STREAK_CAP = AIRSTRIKE_COST;

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

export function availableStreakAbility(points) {
  return points >= AIRSTRIKE_COST ? 'airstrike' : null;
}
