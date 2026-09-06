// social.js — small, pure rules shared by the multiplayer social layer.
// Keeping the limits here makes the host's trust boundary and the UI agree.
export const TEAM_PING_RANGE = 80;
export const TEAM_PING_TTL = 6;
export const TEAM_PING_COOLDOWN = 2;
export const TEAM_PING_LIMIT = 4;
export const TEAM_PING_KINDS = ['MOVE', 'ATTACK', 'DEFEND', 'HILL', 'ENEMY'];
export const VOTE_KICK_DURATION = 30;
export const VOTE_KICK_COOLDOWN = 90;

// The target never votes. A ballot is unavailable with fewer than three
// humans; after that it requires a strict majority of the eligible voters.
export function voteKickVotesNeeded(humans) {
  const eligible = Math.max(0, Math.floor(Number(humans) || 0) - 1);
  return eligible < 2 ? 0 : Math.floor(eligible / 2) + 1;
}

const rosterRows = roster => Array.isArray(roster)
  ? roster.filter(row => Array.isArray(row) && typeof row[0] === 'string'
      && (row[1] === 'green' || row[1] === 'blue')) : [];

export function staySquadState(roster, voters, viewer) {
  const rows = rosterRows(roster);
  const mine = rows.find(row => row[0] === viewer);
  const valid = new Set(Array.isArray(voters) ? voters.filter(v =>
    typeof v === 'string' && rows.some(row => row[0] === v)) : []);
  if (!mine) return { available: false, voted: false, formed: false,
    teammates: 0, ready: 0 };
  const teammates = rows.filter(row => row[1] === mine[1]).map(row => row[0]);
  const ready = teammates.filter(key => valid.has(key)).length;
  return {
    available: teammates.length > 1,
    voted: valid.has(viewer),
    formed: valid.has(viewer) && ready >= 2,
    teammates: teammates.length,
    ready,
  };
}

// Host-side handoff for the later between-round balancer: same-team players
// who mutually signal readiness become one small atomic group. Solo votes do
// not create a group, and malformed/duplicate voter ids disappear.
export function staySquadGroups(roster, voters) {
  const rows = rosterRows(roster);
  const valid = new Set(Array.isArray(voters) ? voters : []);
  const groups = [];
  for (const team of ['green', 'blue']) {
    const group = rows.filter(row => row[1] === team && valid.has(row[0]))
      .map(row => row[0]).sort();
    if (group.length >= 2) groups.push(group);
  }
  return groups;
}

export function validPingDirection(value) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) return false;
  const length = Math.hypot(...value);
  return length > 0.5 && length < 1.5;
}
