// runtime-health.js — small, testable release budgets and rolling diagnostics.

export const RELEASE_BUDGETS = Object.freeze({
  frameP95Ms: 33.4,
  longFrameRate: 0.05,
  drawCalls: 900,
  triangles: 1_200_000,
  particles: 1800,
  networkBytesPerSecond: 128 * 1024,
});

export function percentile(values, fraction) {
  if (!values?.length) return 0;
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * fraction)))];
}

export function evaluateReleaseBudgets(sample, budgets = RELEASE_BUDGETS) {
  const checks = {
    frameP95Ms: (sample.frameP95Ms ?? 0) <= budgets.frameP95Ms,
    longFrameRate: (sample.longFrameRate ?? 0) <= budgets.longFrameRate,
    drawCalls: (sample.drawCalls ?? 0) <= budgets.drawCalls,
    triangles: (sample.triangles ?? 0) <= budgets.triangles,
    particles: (sample.particles ?? 0) <= budgets.particles,
    networkBytesPerSecond: (sample.networkBytesPerSecond ?? 0)
      <= budgets.networkBytesPerSecond,
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

export class RuntimeHealth {
  constructor(capacity = 240) {
    this.capacity = Math.max(30, capacity | 0);
    this.frames = [];
    this.totalFrames = 0;
    this.longFrames = 0;
  }

  frame(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
    this.frames.push(milliseconds);
    if (this.frames.length > this.capacity) this.frames.shift();
    this.totalFrames++;
    if (milliseconds > 50) this.longFrames++;
  }

  snapshot(extra = {}) {
    const sample = {
      frameP95Ms: percentile(this.frames, 0.95),
      frameP99Ms: percentile(this.frames, 0.99),
      longFrameRate: this.frames.length
        ? this.frames.filter(ms => ms > 50).length / this.frames.length : 0,
      lifetimeLongFrameRate: this.totalFrames ? this.longFrames / this.totalFrames : 0,
      sampledFrames: this.frames.length,
      totalFrames: this.totalFrames,
      ...extra,
    };
    return { ...sample, budget: evaluateReleaseBudgets(sample) };
  }
}

export function resourceDrift(baseline, current) {
  const keys = new Set([...Object.keys(baseline ?? {}), ...Object.keys(current ?? {})]);
  const drift = {};
  for (const key of keys) drift[key] = (current?.[key] ?? 0) - (baseline?.[key] ?? 0);
  return drift;
}
