// mastery.js — contribution-based, cosmetic-only long-term progression.
// Bands are neutral metal details on the local first-person weapon model;
// they confer no stat, hitbox, or networking advantage.
export const MASTERY_TIERS = [
  { points: 0,     name: 'RECRUIT', bands: 0 },
  { points: 1000,  name: 'FIELD',   bands: 1 },
  { points: 5000,  name: 'VETERAN', bands: 2 },
  { points: 15000, name: 'ELITE',   bands: 3 },
  { points: 40000, name: 'LEGEND',  bands: 4 },
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
