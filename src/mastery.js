// mastery.js — contribution-based long-term rank progression.
// Ranks are a record of match contribution only; they confer no gameplay,
// hitbox, weapon-model, or networking advantage.
export const MASTERY_TIERS = [
  { points: 0,     name: 'RECRUIT' },
  { points: 1000,  name: 'FIELD' },
  { points: 5000,  name: 'VETERAN' },
  { points: 15000, name: 'ELITE' },
  { points: 40000, name: 'LEGEND' },
];

export function masteryProgress(value) {
  const raw = Number(value);
  const points = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  let index = 0;
  for (let i = 1; i < MASTERY_TIERS.length; i++) {
    if (points < MASTERY_TIERS[i].points) break;
    index = i;
  }
  const tier = MASTERY_TIERS[index];
  const next = MASTERY_TIERS[index + 1] ?? null;
  return { points, index, tier, next, remaining: next ? next.points - points : 0 };
}
