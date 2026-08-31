// selected-goals.js — one optional, player-chosen thread through a match.
//
// These are not quests, dailies, or an economy. A goal resets every round,
// awards nothing, and stores no history. It exists to let a player choose
// what kind of satisfying match they want to have right now.

export const SELECTED_GOALS = Object.freeze({
  vanguard: Object.freeze({
    id: 'vanguard', name: 'VANGUARD', menu: '3 KILLS', metric: 'kills', target: 3,
    description: 'Secure three eliminations',
  }),
  sapper: Object.freeze({
    id: 'sapper', name: 'SAPPER', menu: '12 EDITS', metric: 'terrain', target: 12,
    description: 'Make twelve direct voxel edits',
  }),
  wingman: Object.freeze({
    id: 'wingman', name: 'WINGMAN', menu: '3 TEAM PLAYS', metric: 'teamplay', target: 3,
    description: 'Earn assists or objective credit',
  }),
});

export const SELECTED_GOAL_IDS = Object.freeze(Object.keys(SELECTED_GOALS));
export const validSelectedGoal = value => SELECTED_GOAL_IDS.includes(value);

const safeTotal = value => Number.isFinite(value) ? Math.max(0, value) : 0;
const totals = value => ({
  kills: safeTotal(value?.kills),
  terrain: safeTotal(value?.terrain),
  teamplay: safeTotal(value?.teamplay),
});

export class SelectedGoalTracker {
  constructor(selection = 'sapper') {
    this.selection = validSelectedGoal(selection) ? selection : 'sapper';
    this.reset();
  }

  select(selection) {
    if (!validSelectedGoal(selection) || this.active) return false;
    this.selection = selection;
    return true;
  }

  reset() {
    this.active = false;
    this.baseline = totals();
    this.current = totals();
    this.progress = 0;
    this.completed = false;
    this.completedAt = null;
  }

  start(current = {}, at = 0) {
    if (this.active) return false;
    this.active = true;
    this.baseline = totals(current);
    this.current = { ...this.baseline };
    this.progress = 0;
    this.completed = false;
    this.completedAt = null;
    this.startedAt = safeTotal(at);
    return true;
  }

  observe(current = {}, at = 0) {
    if (!this.active) return false;
    const next = totals(current);
    for (const key of Object.keys(next)) this.current[key] = Math.max(this.current[key], next[key]);
    return this._refresh(at);
  }

  record(metric, amount = 1, at = 0) {
    if (!this.active || !['kills', 'terrain', 'teamplay'].includes(metric)
        || !Number.isFinite(amount) || amount <= 0) return false;
    this.current[metric] += Math.min(1000, amount);
    return this._refresh(at);
  }

  _refresh(at) {
    const goal = SELECTED_GOALS[this.selection];
    const raw = this.current[goal.metric] - this.baseline[goal.metric];
    this.progress = Math.min(goal.target, Math.max(this.progress, Math.floor(Math.max(0, raw))));
    if (this.completed || this.progress < goal.target) return false;
    this.completed = true;
    this.completedAt = safeTotal(at);
    return true;
  }

  view(at = 0, { alive = true, over = false } = {}) {
    if (!this.active || over || !alive) return null;
    const goal = SELECTED_GOALS[this.selection];
    if (this.completed && safeTotal(at) - this.completedAt > 5) return null;
    return {
      id: goal.id,
      name: goal.name,
      description: goal.description,
      progress: this.progress,
      target: goal.target,
      complete: this.completed,
    };
  }

  result() {
    if (!this.active) return null;
    const goal = SELECTED_GOALS[this.selection];
    return {
      id: goal.id,
      name: goal.name,
      progress: this.progress,
      target: goal.target,
      complete: this.completed,
    };
  }
}
