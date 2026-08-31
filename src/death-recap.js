// death-recap.js — bounded, authoritative facts shown during the respawn wave.
//
// Recaps contain no free-form server text. The host sends a small validated
// fact record and every client turns it into the same fixed local wording.

export const DEATH_RECAP_CAUSES = Object.freeze([
  'rifle', 'smg', 'sniper', 'spade', 'grenade', 'airstrike', 'collapse',
  'fell', 'drowned', 'void', 'unknown',
]);

const CAUSES = new Set(DEATH_RECAP_CAUSES);
const TEAM = new Set(['green', 'blue']);
const WEAPON_LABEL = Object.freeze({
  rifle: 'RIFLE',
  smg: 'SMG',
  sniper: 'SNIPER',
  spade: 'SPADE',
  grenade: 'GRENADE',
  airstrike: 'AIRSTRIKE',
  collapse: 'FALLING VOXELS',
});

const boundedInteger = (value, min, max) => Number.isInteger(value)
  && value >= min && value <= max;

export function validDeathRecap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!CAUSES.has(value.cause) || typeof value.self !== 'boolean'
      || typeof value.headshot !== 'boolean') return false;
  if (!(value.attacker === null || (typeof value.attacker === 'string'
      && value.attacker.length >= 1 && value.attacker.length <= 24))) return false;
  if (!(value.team === null || TEAM.has(value.team))) return false;
  if (!(value.distance === null || boundedInteger(value.distance, 0, 256))) return false;
  if (!(value.health === null || boundedInteger(value.health, 0, 100))) return false;
  if (value.self && value.attacker !== null) return false;
  if (value.attacker === null && value.team !== null) return false;
  if (value.attacker === null && value.health !== null) return false;
  if (!['rifle', 'smg', 'sniper'].includes(value.cause) && value.headshot) return false;
  return true;
}

export function makeDeathRecap({
  cause = 'unknown', attacker = null, team = null, distance = null,
  health = null, headshot = false, self = false,
} = {}) {
  const cleanCause = CAUSES.has(cause) ? cause : 'unknown';
  const cleanSelf = !!self;
  const cleanAttacker = cleanSelf || attacker == null
    ? null : String(attacker).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24) || null;
  const cleanTeam = cleanAttacker && TEAM.has(team) ? team : null;
  const cleanDistance = Number.isFinite(distance)
    ? Math.max(0, Math.min(256, Math.round(distance))) : null;
  const cleanHealth = cleanAttacker && Number.isFinite(health)
    ? Math.max(0, Math.min(100, Math.round(health))) : null;
  const recap = {
    cause: cleanCause,
    attacker: cleanAttacker,
    team: cleanTeam,
    distance: cleanDistance,
    health: cleanHealth,
    headshot: ['rifle', 'smg', 'sniper'].includes(cleanCause) && !!headshot,
    self: cleanSelf,
  };
  return validDeathRecap(recap) ? recap : null;
}

export function deathRecapCopy(recap) {
  if (!validDeathRecap(recap)) return null;
  if (recap.cause === 'fell') return {
    label: 'DEATH RECAP', title: 'FALL DAMAGE', detail: 'WATCH THE LANDING', team: null,
  };
  if (recap.cause === 'drowned') return {
    label: 'DEATH RECAP', title: 'DROWNED', detail: 'SURFACE BEFORE AIR RUNS OUT', team: null,
  };
  if (recap.cause === 'void') return {
    label: 'DEATH RECAP', title: 'OUT OF BOUNDS', detail: 'WATCH THE MAP EDGE', team: null,
  };

  const facts = [];
  facts.push(WEAPON_LABEL[recap.cause] ?? 'ELIMINATED');
  if (recap.headshot) facts.push('HEADSHOT');
  if (recap.distance !== null) facts.push(`${recap.distance}m`);
  if (recap.health !== null) facts.push(`${recap.health} HP LEFT`);

  if (recap.self) return {
    label: 'DEATH RECAP', title: 'SELF-INFLICTED', detail: facts.join(' · '), team: null,
  };
  if (recap.attacker) return {
    label: 'KILLED BY', title: recap.attacker, detail: facts.join(' · '), team: recap.team,
  };
  if (recap.cause === 'collapse') return {
    label: 'DEATH RECAP', title: 'CRUSHED', detail: facts.join(' · '), team: null,
  };
  return {
    label: 'DEATH RECAP', title: 'ELIMINATED', detail: facts.join(' · '), team: null,
  };
}
