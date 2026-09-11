// first-minute.js — optional, non-modal field orientation for one session.
//
// The guide teaches the smallest useful Spadefall loop without freezing play:
// move, fire, reshape one voxel, and communicate. It owns no DOM or gameplay
// state, so normal matches are identical when the feature flag is off.

export const FIRST_MINUTE_DURATION = 60;
export const FIRST_MINUTE_MOVE_DISTANCE = 3;

const ACTIONS = new Set(['shoot', 'dig', 'place', 'ping']);

export function firstMinuteObjective(mode) {
  if (mode === 'tdm') return 'OUTSCORE THE ENEMY TEAM';
  if (mode === 'koth') return 'OCCUPY THE HILL WITH YOUR SQUAD';
  return 'STEAL THEIR FLAG AND BRING IT HOME';
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
    this.mapIndex = Number.isInteger(mapIndex) && mapIndex >= 0 && mapIndex < 6
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
      terrain: this.actions.has('dig') || this.actions.has('place'),
      // Communication remains a useful optional shortcut, never a gate.
    };
    const complete = progress.move && progress.fire && progress.terrain;
    if (complete && this.completedAt == null) this.completedAt = elapsed;
    if (complete && elapsed - this.completedAt >= 4) {
      this.active = false;
      return { visible: false };
    }

    let prompt = 'MOVE AND FIRE';
    let hint = !progress.move ? 'WASD · FOLLOW THE GOLD ARROW'
      : !progress.fire ? 'LEFT MOUSE · RIGHT MOUSE AIM' : 'PUSH WITH YOUR SQUAD';
    if (progress.move && progress.fire && !progress.terrain) {
      prompt = 'RESHAPE THE FIGHT';
      hint = firstMinuteTerrainCue(this.mapIndex);
    } else if (complete) {
      prompt = 'FIELD READY';
      hint = 'TERRAIN IS A TOOL · MAKE THE PLAY';
    }

    return {
      visible: !!alive,
      prompt,
      hint,
      objective: firstMinuteObjective(this.mode),
      progress,
      complete,
    };
  }
}
