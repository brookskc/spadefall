// combat-flow.js — small, deterministic combat-flow policy.
// These rules deliberately only select cues, spawn preferences and cosmetic
// recognition. They never reveal an unperceived enemy or alter damage.

export const CONTACT_IDLE_SECONDS = 11;
export const CONTACT_COOLDOWN = 18;

export function autoSprint({ forward = false, strafe = false, back = false,
  aiming = false, crouched = false, grounded = false, held = 0, shift = false } = {}) {
  if (aiming || crouched || !grounded || !forward || back) return false;
  // Keep deliberate diagonal Shift-sprinting. Only the hands-free assist asks
  // for a clean forward hold, so it never accelerates strafing gunfights.
  return shift || (!strafe && held >= 0.25);
}

export function contactCue(state = {}, now = 0, candidates = []) {
  if (!state.alive || now - (state.lastAction ?? now) < CONTACT_IDLE_SECONDS
      || now - (state.lastCue ?? -Infinity) < CONTACT_COOLDOWN) return null;
  // Candidates must already be public: an objective, team mark, or a heard/
  // seen intel point. Never manufacture a live enemy coordinate here.
  const cue = candidates.find(c => c && ['objective', 'mark', 'intel'].includes(c.kind)
    && Number.isFinite(c.x) && Number.isFinite(c.z));
  return cue ? { ...cue, label: cue.kind === 'objective' ? 'OBJECTIVE ACTIVE' : 'CONTACT REPORTED' } : null;
}

export function ctfEscalation(state = {}, now = 0, flagLive = false) {
  const progressAt = Number.isFinite(state.progressAt) ? state.progressAt : now;
  const active = !!state.active;
  if (flagLive) return { active: false, returnTime: 15, frontlineBonus: 0 };
  if (!active && now - progressAt >= 82) return { active: true, returnTime: 12, frontlineBonus: 8 };
  return { active, returnTime: active ? 12 : 15, frontlineBonus: active ? 8 : 0 };
}

export function usefulVoxelAction({ type, changedPassability = false, changedLos = false,
  bridgedGap = false, tactical = false, blockedThreat = false } = {}) {
  if (type === 'dig' && (changedPassability || changedLos)) return 'PATH CLEARED';
  if (type === 'build' && bridgedGap) return 'ROUTE BUILT';
  if (type === 'build' && tactical && blockedThreat) return 'COVER SAVE';
  return null;
}

export function intensityCue({ mode, green = 0, blue = 0, remaining = Infinity,
  escalation = false, fired = [] } = {}) {
  const seen = new Set(fired);
  if (mode === 'tdm' && Math.max(green, blue) >= 40 && !seen.has('final-ten'))
    return { id: 'final-ten', text: 'FINAL TEN' };
  if (mode === 'tdm' && green === blue && green >= 45 && !seen.has('deadlock'))
    return { id: 'deadlock', text: 'DEADLOCK' };
  if (mode === 'koth' && remaining <= 30 && !seen.has('last-thirty'))
    return { id: 'last-thirty', text: 'THIRTY SECONDS' };
  if (mode === 'ctf' && escalation && !seen.has('frontline'))
    return { id: 'frontline', text: 'FRONT LINES ADVANCING' };
  return null;
}

export function nextBotDifficulty(current = 'normal', { margin = 0, humanScore = 0,
  medianScore = 0 } = {}) {
  const levels = ['easy', 'normal', 'hard'];
  let i = Math.max(0, levels.indexOf(current));
  // A single between-round step only. No hidden mid-fight health, damage,
  // speed or aim changes; the next round merely selects another authored
  // cognition profile after an unmistakably one-sided result.
  if (margin >= 350 && humanScore > medianScore * 1.2) i++;
  else if (margin <= -350 && humanScore < medianScore * 0.65) i--;
  return levels[Math.max(0, Math.min(levels.length - 1, i))];
}

export const SPECIALTIES = Object.freeze(['rifle', 'smg', 'sniper', 'objective', 'terrain']);
export function normalizeSpecialties(value = {}) {
  return Object.fromEntries(SPECIALTIES.map(key => [key,
    Math.max(0, Math.min(999999, Math.floor(Number(value[key]) || 0)))]));
}
export function topSpecialty(value = {}) {
  const row = normalizeSpecialties(value);
  return SPECIALTIES.reduce((best, key) => row[key] > row[best] ? key : best, 'rifle');
}
