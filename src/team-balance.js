// team-balance.js — deterministic, between-round human team assignments.
//
// This is intentionally not engagement matchmaking. It uses only the match
// that just ended, runs only before the next round, and treats every explicit
// "stay as squad" group as indivisible. Ordinary green/blue side rotation is
// the preferred baseline; a reassignment has to improve the projected gap by
// enough to justify disrupting two players.

export const TEAM_REASSIGNMENT_COST = 150;
export const TEAM_RATING_CAP = 2000;
export const BOT_PROFILE_CHANGE_COST = 100;
export const BOT_PROFILE_WEIGHT = Object.freeze({ easy: 0.85, normal: 1, hard: 1.15 });

const other = team => team === 'green' ? 'blue' : 'green';
const validTeam = team => team === 'green' || team === 'blue';

const normalizedPlayers = players => {
  const out = [], seen = new Set();
  for (const row of players ?? []) {
    if (!row || typeof row.key !== 'string' || !row.key || seen.has(row.key)
        || !validTeam(row.team)) continue;
    seen.add(row.key);
    out.push({ key: row.key, team: row.team,
      rating: Math.min(TEAM_RATING_CAP, Math.max(0, Number(row.rating) || 0)) });
  }
  return out;
};

function atomicUnits(players, squads, teamSize) {
  const byKey = new Map(players.map(p => [p.key, p]));
  const grouped = new Set(), units = [];
  for (const raw of squads ?? []) {
    if (!Array.isArray(raw)) continue;
    const members = [...new Set(raw)].map(key => byKey.get(key))
      .filter(p => p && !grouped.has(p.key));
    if (members.length < 2 || members.length > teamSize) continue;
    for (const p of members) grouped.add(p.key);
    units.push(members);
  }
  for (const p of players) if (!grouped.has(p.key)) units.push([p]);
  return units.map(members => ({
    members,
    size: members.length,
    rating: members.reduce((sum, p) => sum + p.rating, 0),
  }));
}

const better = (a, b) => !b
  || a.sizeGap < b.sizeGap
  || (a.sizeGap === b.sizeGap && a.cost < b.cost)
  || (a.sizeGap === b.sizeGap && a.cost === b.cost && a.moved < b.moved)
  || (a.sizeGap === b.sizeGap && a.cost === b.cost && a.moved === b.moved
    && a.signature < b.signature);

export function balanceHumanTeams(rawPlayers, squads = [], teamSize = 5,
    botRating = 0) {
  const players = normalizedPlayers(rawPlayers);
  const cap = Math.max(1, Math.floor(Number(teamSize) || 1));
  const bot = Math.min(TEAM_RATING_CAP, Math.max(0, Number(botRating) || 0));
  if (!players.length) return { assignments: {}, moved: 0, sizeGap: 0,
    ratingGap: 0, groups: 0 };
  const units = atomicUnits(players, squads, cap);
  let best = null;
  const combinations = 2 ** units.length;
  for (let mask = 0; mask < combinations; mask++) {
    const assignments = {};
    let greenSize = 0, blueSize = 0, greenRating = 0, blueRating = 0, moved = 0;
    for (let i = 0; i < units.length; i++) {
      const unit = units[i], team = mask & (1 << i) ? 'blue' : 'green';
      if (team === 'green') {
        greenSize += unit.size; greenRating += unit.rating;
      } else {
        blueSize += unit.size; blueRating += unit.rating;
      }
      for (const p of unit.members) {
        assignments[p.key] = team;
        if (team !== other(p.team)) moved++;
      }
    }
    if (greenSize > cap || blueSize > cap) continue;
    if (players.length > 1 && (!greenSize || !blueSize)) continue;
    const greenPower = greenRating + (cap - greenSize) * bot;
    const bluePower = blueRating + (cap - blueSize) * bot;
    const ratingGap = Math.abs(greenPower - bluePower);
    const candidate = {
      assignments,
      moved,
      sizeGap: Math.abs(greenSize - blueSize),
      ratingGap,
      cost: ratingGap + moved * TEAM_REASSIGNMENT_COST,
      signature: Object.keys(assignments).filter(key => assignments[key] === 'green')
        .sort().join(','),
      groups: units.filter(unit => unit.size > 1).length,
    };
    if (better(candidate, best)) best = candidate;
  }
  return best ?? { assignments: Object.fromEntries(players.map(p => [p.key, other(p.team)])),
    moved: 0, sizeGap: players.length, ratingGap: 0, groups: 0 };
}

// Pick one stable cognition profile per team's bot contingent for the whole
// next round. This is not live rubber-banding: the only inputs are the round
// that just ended and the already-decided next-round human teams. Health,
// damage, movement, and weapon stats never enter this policy.
export function planBotDirector(rawPlayers, teamSize = 5, priorBotRating = 0) {
  const players = normalizedPlayers(rawPlayers);
  const cap = Math.max(1, Math.floor(Number(teamSize) || 1));
  const byTeam = { green: [], blue: [] };
  for (const p of players) byTeam[p.team].push(p.rating);
  const humanAverage = players.length
    ? players.reduce((sum, p) => sum + p.rating, 0) / players.length : 400;
  const bot = Math.min(TEAM_RATING_CAP, Math.max(50,
    Number(priorBotRating) > 0 ? Number(priorBotRating) : humanAverage || 400));
  const slots = {
    green: Math.max(0, cap - byTeam.green.length),
    blue: Math.max(0, cap - byTeam.blue.length),
  };
  const humanPower = {
    green: byTeam.green.reduce((sum, n) => sum + n, 0),
    blue: byTeam.blue.reduce((sum, n) => sum + n, 0),
  };
  let best = null;
  for (const green of Object.keys(BOT_PROFILE_WEIGHT)) {
    for (const blue of Object.keys(BOT_PROFILE_WEIGHT)) {
      const greenProfile = slots.green > 0 ? green : 'normal';
      const blueProfile = slots.blue > 0 ? blue : 'normal';
      const projected = {
        green: humanPower.green + slots.green * bot * BOT_PROFILE_WEIGHT[greenProfile],
        blue: humanPower.blue + slots.blue * bot * BOT_PROFILE_WEIGHT[blueProfile],
      };
      const gap = Math.abs(projected.green - projected.blue);
      const changes = Number(greenProfile !== 'normal') + Number(blueProfile !== 'normal');
      const candidate = { green: greenProfile, blue: blueProfile, gap, changes,
        cost: gap + changes * BOT_PROFILE_CHANGE_COST,
        projected, slots, baseline: bot };
      if (!best || candidate.cost < best.cost
          || (candidate.cost === best.cost && candidate.changes < best.changes)
          || (candidate.cost === best.cost && candidate.changes === best.changes
            && `${greenProfile},${blueProfile}` < `${best.green},${best.blue}`)) best = candidate;
    }
  }
  return { ...best, adjusted: best.green !== 'normal' || best.blue !== 'normal' };
}
