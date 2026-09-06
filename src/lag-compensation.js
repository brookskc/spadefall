// Host-owned latency compensation. Clients may echo a snapshot sequence, but
// they never choose the measured RTT, rewind duration, shot origin, or target
// pose. The host resolves all of those from packets it actually sent.
export const MAX_REWIND_SECONDS = 0.25;
export const RENDER_DELAY_SECONDS = 0.09;
export const HISTORY_SECONDS = 0.45;
export const HISTORY_SAMPLES = 32;

export function rewindSecondsForRtt(rttSeconds) {
  const rtt = Number.isFinite(rttSeconds) ? Math.max(0, rttSeconds) : 0;
  // The target sample crossed the network toward the shooter, then the shot
  // crossed back. Rewind by the measured round trip plus the avatar's local
  // interpolation buffer, not merely one leg of that trip.
  return Math.min(MAX_REWIND_SECONDS, rtt + RENDER_DELAY_SECONDS);
}

export function recordPose(history, time, body) {
  if (!Array.isArray(history) || !Number.isFinite(time) || !body?.pos || !body?.half)
    return history;
  const row = { t: time, x: body.pos.x, y: body.pos.y, z: body.pos.z, h: body.half.h };
  const last = history[history.length - 1];
  if (last && time <= last.t) history[history.length - 1] = row;
  else history.push(row);
  while (history.length > HISTORY_SAMPLES || (history[1] && time - history[1].t > HISTORY_SECONDS))
    history.shift();
  return history;
}

export function samplePose(history, time) {
  if (!Array.isArray(history) || !history.length || !Number.isFinite(time)) return null;
  if (time <= history[0].t) return { ...history[0] };
  const last = history[history.length - 1];
  if (time >= last.t) return { ...last };
  for (let i = 1; i < history.length; i++) {
    const b = history[i];
    if (b.t < time) continue;
    const a = history[i - 1];
    const k = Math.max(0, Math.min(1, (time - a.t) / Math.max(1e-6, b.t - a.t)));
    return { t: time, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k,
      z: a.z + (b.z - a.z) * k, h: a.h + (b.h - a.h) * k };
  }
  return { ...last };
}

export function observeSnapshotRtt(sentAt, echoedSequence, now, previousRtt = null) {
  if (!(sentAt instanceof Map) || !Number.isSafeInteger(echoedSequence)
      || !Number.isFinite(now) || !sentAt.has(echoedSequence)) return previousRtt;
  const then = sentAt.get(echoedSequence);
  const sample = Math.max(0, Math.min(0.5, now - then));
  for (const seq of sentAt.keys()) if (seq <= echoedSequence) sentAt.delete(seq);
  return Number.isFinite(previousRtt) ? previousRtt + 0.2 * (sample - previousRtt) : sample;
}
