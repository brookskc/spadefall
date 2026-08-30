// social.js — small, pure rules shared by the multiplayer social layer.
// Keeping the limits here makes the host's trust boundary and the UI agree.
export const TEAM_PING_RANGE = 80;
export const TEAM_PING_TTL = 6;
export const TEAM_PING_COOLDOWN = 2;
export const TEAM_PING_LIMIT = 4;
export const TEAM_PING_KINDS = ['MOVE', 'ATTACK', 'DEFEND', 'HILL', 'SUPPLY'];

export function rematchVotesNeeded(humans) {
  const n = Math.max(1, Math.floor(Number(humans) || 0));
  return Math.floor(n / 2) + 1;
}

export function validPingDirection(value) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) return false;
  const length = Math.hypot(...value);
  return length > 0.5 && length < 1.5;
}
