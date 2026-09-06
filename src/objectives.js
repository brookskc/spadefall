/** CTF interaction precedence, independent of world and scoring side effects. */
export function ctfFlagInteraction(entity, own, enemy, distance) {
  if (!entity?.alive) return null;
  if (enemy.state !== 'carried' && distance(entity, enemy.pos) < 1.9)
    return 'pickup';
  if (own.state === 'dropped' && distance(entity, own.pos) < 1.9)
    return 'return';
  if (entity.carrier && own.state === 'home' && distance(entity, own.home) < 3.2)
    return 'capture';
  return null;
}
