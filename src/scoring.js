// scoring.js — pure contribution values and assist attribution.

export const CONTRIBUTION = Object.freeze({
  kill: 100,
  collapseKill: 50,
  assist: 50,
  flagPickup: 25,
  flagReturn: 75,
  flagCapture: 250,
  carrierStop: 75,
  objectiveDefense: 50,
  carrierEscort: 50,
  hillCapture: 100,
  hillHoldPerSecond: 2,
});

export const ASSIST_WINDOW = 8;
export const ASSIST_MIN_DAMAGE = 10;

// A victim ledger is Map<attacker,{ damage, at }>. Return every recent,
// meaningful contributor except the credited killer. Multiple assists are
// valid in a team fight; tiny chip damage and old encounters are not.
export function assistCreditors(ledger, killer, now,
  window = ASSIST_WINDOW, minimum = ASSIST_MIN_DAMAGE) {
  if (!ledger || !Number.isFinite(now)) return [];
  const out = [];
  for (const [attacker, hit] of ledger) {
    if (!attacker || attacker === killer) continue;
    if (!Number.isFinite(hit?.damage) || hit.damage < minimum) continue;
    if (!Number.isFinite(hit.at) || now - hit.at > window) continue;
    out.push(attacker);
  }
  return out;
}

export function contributionRow(row = {}) {
  return {
    name: row.name ?? '',
    team: row.team === 'blue' ? 'blue' : 'green',
    score: Number(row.score) || 0,
    k: Number(row.k) || 0,
    d: Number(row.d) || 0,
    a: Number(row.a) || 0,
    objective: Number(row.objective) || 0,
  };
}

export function rankContributionRows(entries) {
  return [...entries].sort((a, b) => {
    const ar = contributionRow(a[1]), br = contributionRow(b[1]);
    return br.score - ar.score || br.objective - ar.objective || br.k - ar.k
      || ar.d - br.d || ar.name.localeCompare(br.name);
  });
}
