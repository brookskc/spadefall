// security.js — pure authority and measured-enforcement rules.
// Honest jitter is corrected; only sustained impossible input disconnects.

export const SECURED_ACTIONS = Object.freeze(
  ['shoot', 'reload', 'dig', 'place', 'nade', 'strike']);

export function actionSequenceDisposition(last, sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 1)
    return { accept: false, reason: 'invalid' };
  if (Number.isSafeInteger(last) && sequence <= last)
    return { accept: false, reason: 'replay' };
  return { accept: true, reason: sequence > (last ?? 0) + 1 ? 'gap' : 'next' };
}

export function aimYawDelta(modelYaw, direction) {
  if (!Number.isFinite(modelYaw) || !Array.isArray(direction) || direction.length !== 3
      || !direction.every(Number.isFinite)) return Infinity;
  const horizontal = Math.hypot(direction[0], direction[2]);
  if (horizontal < 1e-5) return 0; // straight up/down has no meaningful yaw
  const actual = Math.atan2(-direction[2], direction[0]);
  const expected = modelYaw + Math.PI / 2;
  return Math.abs(Math.atan2(Math.sin(actual - expected), Math.cos(actual - expected)));
}

export function authorizeWeaponFire(state, spec, now, cadenceSlack = 0.6) {
  const current = {
    ammo: Math.max(0, state?.ammo | 0),
    reloadUntil: Number.isFinite(state?.reloadUntil) ? state.reloadUntil : 0,
    lastShotAt: Number.isFinite(state?.lastShotAt) ? state.lastShotAt : -Infinity,
  };
  if (!spec?.mag || !spec?.interval || !Number.isFinite(now))
    return { ok: false, reason: 'invalid', state: current };
  if (current.reloadUntil > now) return { ok: false, reason: 'reloading', state: current };
  if (current.ammo <= 0) return { ok: false, reason: 'empty', state: current };
  if (now - current.lastShotAt < spec.interval * cadenceSlack)
    return { ok: false, reason: 'cadence', state: current };
  return { ok: true, reason: 'fired', state: {
    ammo: current.ammo - 1, reloadUntil: 0, lastShotAt: now,
  } };
}

export function authorizeReload(state, spec, now) {
  const current = {
    ammo: Math.max(0, state?.ammo | 0),
    reloadUntil: Number.isFinite(state?.reloadUntil) ? state.reloadUntil : 0,
    lastShotAt: Number.isFinite(state?.lastShotAt) ? state.lastShotAt : -Infinity,
  };
  if (!spec?.mag || !spec?.reload || !Number.isFinite(now))
    return { ok: false, reason: 'invalid', state: current };
  if (current.reloadUntil > now) return { ok: false, reason: 'already-reloading', state: current };
  if (current.ammo >= spec.mag) return { ok: false, reason: 'full', state: current };
  return { ok: true, reason: 'started', state: {
    ...current, reloadUntil: now + spec.reload,
  } };
}

export function settleReload(state, spec, now) {
  if (!state || !spec?.mag || !Number.isFinite(now) || !(state.reloadUntil > 0)
      || now < state.reloadUntil) return { ...state };
  return { ...state, ammo: spec.mag, reloadUntil: 0 };
}

export function recordIntegrityViolation(previous, kind, severity = 1, now = 0) {
  const old = previous ?? {};
  const elapsed = Math.max(0, Math.min(60, now - (old.at ?? now)));
  const score = Math.max(0, (old.score ?? 0) - elapsed * 0.75)
    + Math.max(0.1, Math.min(5, Number(severity) || 1));
  const total = (old.total ?? 0) + 1;
  const kinds = { ...(old.kinds ?? {}) };
  kinds[kind] = (kinds[kind] ?? 0) + 1;
  // A high score alone is insufficient: require a sustained series too.
  // This makes one ugly lag spike a correction, never an ejection.
  const action = score >= 20 && total >= 12 ? 'disconnect'
    : score >= 5 || severity >= 2 ? 'correct' : 'observe';
  return { score, total, kinds, at: now, action, last: kind };
}

export function integritySummary(players) {
  const rows = [...(players ?? [])].map(p => p?._integrity).filter(Boolean);
  return {
    flagged: rows.filter(r => r.score >= 5).length,
    disconnected: rows.filter(r => r.action === 'disconnect').length,
    violations: rows.reduce((n, r) => n + r.total, 0),
    peakScore: rows.reduce((n, r) => Math.max(n, r.score), 0),
  };
}
