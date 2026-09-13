// first-minute.js — optional, non-modal field orientation for one session.
//
// The guide teaches the smallest useful Spadefall loop without freezing play:
// move, fire, and reshape one voxel. It owns no DOM or gameplay
// state, so normal matches are identical when the feature flag is off.

export const FIRST_MINUTE_DURATION = 60;
export const FIRST_MINUTE_MOVE_DISTANCE = 3;

const ACTIONS = new Set(['shoot', 'dig', 'place', 'ping']);

// Terrain lesson acknowledgements are deliberately tiny pure helpers so the
// client cannot credit an input before the ordered, actor-scoped edit arrives.
export function consumeTerrainAck(pending, event, actorIdx) {
  if (!Number.isSafeInteger(event?.aid) || !Number.isSafeInteger(event?.actor)
      || !Number.isSafeInteger(actorIdx) || event.actor !== actorIdx) return null;
  const action = pending.get(event.aid);
  if (!action) return null;
  pending.delete(event.aid);
  return (event.v === 0 && action === 'dig')
    || (event.v !== 0 && action === 'place') ? action : null;
}

export function clearAckedTerrainActions(pending, ack) {
  if (!Number.isSafeInteger(ack)) return 0;
  let cleared = 0;
  for (const seq of pending.keys()) {
    if (seq <= ack) { pending.delete(seq); cleared++; }
  }
  return cleared;
}

export function firstMinuteObjective(mode) {
  if (mode === 'tdm') return 'OUTSCORE THE ENEMY TEAM';
  if (mode === 'koth') return 'OCCUPY THE HILL WITH YOUR SQUAD';
  return 'STEAL THEIR FLAG AND BRING IT HOME';
}

export function firstMinuteMoveHint(mode) {
  return mode === 'tdm'
    ? 'WASD · MOVE WITH YOUR TEAM TOWARD MIDFIELD'
    : 'WASD · FOLLOW THE GOLD OBJECTIVE ARROW';
}

// One terse, map-specific line makes the authored voxel decision visible in
// the first match without adding another marker or permanent HUD panel.
export function firstMinuteTerrainCue(mapIndex) {
  return [
    'CUT A NEW DOOR THROUGH THE MIDFIELD BELT',
    'BREACH THE DAMAGED SEAWALL OR USE THE TRENCH',
    'FINISH THE BROKEN BRIDGE OR USE THE STONE FORD',
    'DROP AN ARCH OR BUILD A NEW FIRING STEP',
    'CUT OR REBUILD THE NORTH/SOUTH SPANS',
    'OPEN A SHORT PATH THROUGH A BASALT GATE',
    'CROSS THE CONVEYOR OR BREACH A SLAG WALL',
    'FOLLOW THE NORTH/WEST/SOUTH/EAST FAULT LOOP',
  ][mapIndex] ?? 'DIG A ROUTE OR BUILD NEW COVER';
}

const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;

export class FirstMinuteGuide {
  constructor({ duration = FIRST_MINUTE_DURATION,
    moveDistance = FIRST_MINUTE_MOVE_DISTANCE } = {}) {
    this.duration = Math.max(10, finite(duration));
    this.moveDistance = Math.max(1, finite(moveDistance));
    this.hasRun = false;
    this.active = false;
    this.actions = new Set();
  }

  start({ mode = 'ctf', mapIndex = 0, matchSecond = 0, x = 0, z = 0 } = {}) {
    if (this.hasRun) return false;
    this.hasRun = true;
    this.active = true;
    this.mode = ['ctf', 'tdm', 'koth'].includes(mode) ? mode : 'ctf';
    this.mapIndex = Number.isInteger(mapIndex) && mapIndex >= 0 && mapIndex < 8
      ? mapIndex : 0;
    this.startedAtSecond = Math.max(0, finite(matchSecond));
    this.origin = { x: finite(x), z: finite(z) };
    this.actions.clear();
    this.completedAt = null;
    return true;
  }

  mark(action) {
    if (!this.active || !ACTIONS.has(action)) return false;
    this.actions.add(action);
    return true;
  }

  stop() {
    const wasActive = this.active;
    this.active = false;
    return wasActive;
  }

  update({ matchSecond = 0, x = 0, z = 0, alive = true, over = false } = {}) {
    if (!this.active) return { visible: false };
    const elapsed = Math.max(0, finite(matchSecond) - this.startedAtSecond);
    if (over || elapsed >= this.duration) {
      this.active = false;
      return { visible: false };
    }

    const dx = finite(x) - this.origin.x;
    const dz = finite(z) - this.origin.z;
    if (dx * dx + dz * dz >= this.moveDistance * this.moveDistance)
      this.actions.add('move');

    const progress = {
      move: this.actions.has('move'),
      fire: this.actions.has('shoot'),
      dig: this.actions.has('dig'),
      place: this.actions.has('place'),
      // Communication remains a useful optional shortcut, never a gate.
    };
    progress.terrain = progress.dig || progress.place;
    const complete = progress.move && progress.fire && progress.terrain;
    if (complete && this.completedAt == null) this.completedAt = elapsed;
    if (complete && elapsed - this.completedAt >= 4) {
      this.active = false;
      return { visible: false };
    }

    let prompt = 'MOVE AND FIRE';
    let hint = !progress.move ? firstMinuteMoveHint(this.mode)
      : !progress.fire ? 'LEFT MOUSE · RIGHT MOUSE AIM' : 'PUSH WITH YOUR SQUAD';
    if (progress.move && progress.fire && !progress.terrain) {
      prompt = 'RESHAPE THE FIGHT';
      hint = '2 / SPADE TO DIG · 3 / BLOCKS TO BUILD';
    } else if (complete) {
      prompt = 'FIELD READY';
      hint = 'TERRAIN IS A TOOL · MAKE THE PLAY';
    }

    return {
      visible: !!alive,
      prompt,
      hint,
      objective: firstMinuteObjective(this.mode),
      terrainCue: firstMinuteTerrainCue(this.mapIndex),
      progress,
      complete,
    };
  }
}
