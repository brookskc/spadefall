// bot-rules.js — pure tactical helpers for the host-side bot controller.
// Kept free of DOM and Three.js so formation and targeting decisions can be
// regression-tested without constructing the rendered game.

// Stable posts inside the capture radius keep a team controlling the same
// objective without stacking every soldier at one exact coordinate. Opposing
// teams use interleaved rings, producing a readable skirmish around the point.
export function hillPost(hill, id, team) {
  if (!hill || ![hill.x, hill.z, hill.r].every(Number.isFinite) || hill.r <= 0)
    return null;
  const slot = Math.abs(Number.isInteger(id) ? id : 0) % 5;
  const radius = Math.min(4.5, Math.max(1.5, hill.r * 0.55));
  const offset = team === 'blue' ? Math.PI / 5 : 0;
  const angle = slot / 5 * Math.PI * 2 + offset;
  return { x: hill.x + Math.cos(angle) * radius,
    z: hill.z + Math.sin(angle) * radius };
}

// Lower is better. A modest current-target bonus creates hysteresis: bots do
// not reset their reaction timer because another enemy became a fraction of a
// block closer, but a flag carrier or badly wounded target can still earn a
// deliberate switch.
export function botTargetScore(distance, health = 100, carrier = false,
  current = false) {
  if (![distance, health].every(Number.isFinite)) return Infinity;
  return distance - (carrier ? 20 : 0) - Math.max(0, 100 - health) * 0.15
    - (current ? 5 : 0);
}

// Repulsion direction for nearby allies. The caller blends this with its
// tactical movement vector; returning zero means no separation is needed.
export function botSeparation(position, allies, selfId, radius = 2.4) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)
      || !Array.isArray(allies) || !Number.isFinite(radius) || radius <= 0)
    return { x: 0, z: 0 };
  let x = 0, z = 0;
  for (const ally of allies) {
    if (!ally || ally.id === selfId || ally.alive === false
        || !Number.isFinite(ally.x) || !Number.isFinite(ally.z)) continue;
    let dx = position.x - ally.x, dz = position.z - ally.z;
    let d = Math.hypot(dx, dz);
    if (d >= radius) continue;
    if (d < 1e-4) {
      const angle = ((Number(selfId) || 0) * 2.399963 + (Number(ally.id) || 0)) % (Math.PI * 2);
      dx = Math.cos(angle); dz = Math.sin(angle); d = 1;
    }
    const weight = (radius - d) / radius;
    x += dx / d * weight; z += dz / d * weight;
  }
  const length = Math.hypot(x, z);
  return length > 1e-6 ? { x: x / length, z: z / length } : { x: 0, z: 0 };
}
