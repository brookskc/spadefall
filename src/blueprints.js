// blueprints.js — deterministic shapes for ordinary block placement.
// The returned offsets are integer cells. No durability, inventory, or
// authority lives here; Game owns preflight and mutation.

export const BLUEPRINT_KINDS = Object.freeze([
  'SINGLE', 'LOW_WALL', 'FIRING_STEP', 'RAMP',
]);

const SHAPES = Object.freeze({
  SINGLE: Object.freeze([[0, 0, 0]]),
  LOW_WALL: Object.freeze([[-1, 0, 0], [0, 0, 0], [1, 0, 0]]),
  // A low forward foot plus a supported raised rear block: compact cover
  // which can be climbed rather than a floating ledge.
  FIRING_STEP: Object.freeze([[0, 0, 0], [1, 0, 0], [0, 1, 0]]),
  // Ground block, then a one-block rise in the facing direction. The top
  // block is supported by the middle cell and is traversable from behind.
  RAMP: Object.freeze([[0, 0, 0], [1, 0, 0], [1, 1, 0]]),
});

export function validBlueprintKind(kind) {
  return BLUEPRINT_KINDS.includes(kind);
}

export function cycleBlueprint(kind = 'SINGLE', direction = 1) {
  const index = Math.max(0, BLUEPRINT_KINDS.indexOf(kind));
  const step = direction < 0 ? -1 : 1;
  return BLUEPRINT_KINDS[(index + step + BLUEPRINT_KINDS.length) % BLUEPRINT_KINDS.length];
}

function facingAxis(direction = {}) {
  const x = Number(direction.x ?? direction[0]) || 0;
  const z = Number(direction.z ?? direction[2]) || 0;
  if (Math.abs(x) >= Math.abs(z)) return [x < 0 ? -1 : 1, 0];
  return [0, z < 0 ? -1 : 1];
}

export function blueprintOffsets(kind = 'SINGLE', direction = {}) {
  const shape = SHAPES[validBlueprintKind(kind) ? kind : 'SINGLE'];
  const [fx, fz] = facingAxis(direction);
  // Right vector in the game's x/-z yaw convention. Wall width is lateral;
  // step/ramp advance away from the player in the faced direction.
  const rx = -fz, rz = fx;
  return shape.map(([x, y, z]) => {
    if (kind === 'LOW_WALL') return { x: rx * x, y, z: rz * x };
    return { x: fx * x + rx * z, y, z: fz * x + rz * z };
  });
}

export function blueprintCells(kind, anchor = {}, direction = {}) {
  return blueprintOffsets(kind, direction).map(offset => ({
    x: Math.floor(Number(anchor.x) || 0) + offset.x,
    y: Math.floor(Number(anchor.y) || 0) + offset.y,
    z: Math.floor(Number(anchor.z) || 0) + offset.z,
  }));
}

export function blueprintCost(kind = 'SINGLE') {
  return blueprintOffsets(kind).length;
}
