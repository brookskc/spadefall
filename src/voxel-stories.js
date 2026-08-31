// voxel-stories.js — bounded, factual summaries of terrain play.
//
// This deliberately selects from fixed copy backed by integer counters. It
// accepts no names or free-form text, creates no reward, and cannot affect a
// running match. The result is one honest post-match memory, or nothing when
// the terrain did not meaningfully change.

export const VOXEL_STORY_FIELDS = Object.freeze([
  'built', 'removed', 'blasts', 'blastRemoved',
  'airstrikes', 'collapses', 'collapsed', 'collapseKills',
]);

const boundedCount = value => Math.max(0, Math.min(1_000_000,
  Math.floor(Number(value) || 0)));

export function normalizeVoxelStoryMetrics(value = {}) {
  return Object.freeze(Object.fromEntries(
    VOXEL_STORY_FIELDS.map(field => [field, boundedCount(value?.[field])])))
}

export function validVoxelStoryMetrics(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && VOXEL_STORY_FIELDS.every(field => Number.isInteger(value[field])
      && value[field] >= 0 && value[field] <= 1_000_000);
}

const noun = (count, singular, plural = singular + 'S') =>
  `${count} ${count === 1 ? singular : plural}`;

export function voxelBattleStory(value) {
  const m = normalizeVoxelStoryMetrics(value);
  const changed = m.built + m.removed;
  if (m.collapseKills > 0) return {
    kind: 'collapse-kill',
    title: 'THE GROUND FOUGHT BACK',
    detail: `${noun(m.collapsed, 'VOXEL')} FELL · ${noun(m.collapseKills, 'SOLDIER')} CRUSHED`,
    metrics: m,
  };
  if (m.collapsed >= 16) return {
    kind: 'collapse',
    title: 'STRUCTURE DOWN',
    detail: `${noun(m.collapsed, 'VOXEL')} LOST SUPPORT AND FELL`,
    metrics: m,
  };
  if (m.airstrikes > 0 && m.blastRemoved >= 8) return {
    kind: 'airstrike',
    title: 'AIRSTRIKE SCAR',
    detail: `${noun(m.blastRemoved, 'VOXEL')} BLASTED FROM THE FIELD`,
    metrics: m,
  };
  if (m.built >= 12 && m.removed >= 12) return {
    kind: 'rewritten',
    title: 'BATTLEFIELD REWRITTEN',
    detail: `${m.built} BUILT · ${m.removed} REMOVED`,
    metrics: m,
  };
  if (m.blastRemoved >= 12) return {
    kind: 'blast',
    title: 'GROUND SHATTERED',
    detail: `${noun(m.blastRemoved, 'VOXEL')} REMOVED BY ${noun(m.blasts, 'BLAST')}`,
    metrics: m,
  };
  if (m.built >= 12) return {
    kind: 'built',
    title: 'FORTIFIED',
    detail: `${noun(m.built, 'TEAM VOXEL')} PLACED`,
    metrics: m,
  };
  if (m.removed >= 12) return {
    kind: 'dug',
    title: 'NEW ROUTES OPENED',
    detail: `${noun(m.removed, 'VOXEL')} REMOVED`,
    metrics: m,
  };
  if (changed >= 8) return {
    kind: 'changed',
    title: 'THE MAP DID NOT STAY STILL',
    detail: `${m.built} BUILT · ${m.removed} REMOVED`,
    metrics: m,
  };
  return null;
}

export class VoxelStoryTracker {
  constructor() { this.reset(); }

  reset() {
    this.data = Object.fromEntries(VOXEL_STORY_FIELDS.map(field => [field, 0]));
  }

  recordEdit(before, after) {
    const from = boundedCount(before), to = boundedCount(after);
    if (from === to) return false;
    if (to > 0) this.data.built++;
    else if (from > 0) this.data.removed++;
    return true;
  }

  recordBlast(removed, { airstrike = false } = {}) {
    const count = boundedCount(removed);
    this.data.blasts++;
    this.data.blastRemoved += count;
    this.data.removed += count;
    if (airstrike) this.data.airstrikes++;
  }

  recordCollapse(removed) {
    const count = boundedCount(removed);
    if (!count) return false;
    this.data.collapses++;
    this.data.collapsed += count;
    this.data.removed += count;
    return true;
  }

  recordCollapseKill() { this.data.collapseKills++; }

  metrics() { return normalizeVoxelStoryMetrics(this.data); }
  story() { return voxelBattleStory(this.data); }
}
