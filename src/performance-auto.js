// performance-auto.js — one-shot, first-session graphics selection.
// It never changes quality during a match.  The renderer supplies only
// foreground, post-warmup frames so loading and background-tab stalls cannot
// permanently downgrade a player.

export const AUTO_GFX_BENCHMARK_VERSION = 1;
export const AUTO_GFX_WARMUP_FRAMES = 90;
export const AUTO_GFX_SAMPLE_FRAMES = 180;

export function automaticGraphicsLevel(sample = {}) {
  if ((sample.sampledFrames ?? 0) < 120) return null;
  const healthy = (sample.frameP95Ms ?? Infinity) <= 20.5
    && (sample.longFrameRate ?? Infinity) <= 0.015
    && (sample.drawCalls ?? Infinity) <= 750
    && (sample.triangles ?? Infinity) <= 900_000;
  return healthy ? 'high' : 'medium';
}

export class FirstSessionGraphicsBenchmark {
  constructor({ warmup = AUTO_GFX_WARMUP_FRAMES,
    samples = AUTO_GFX_SAMPLE_FRAMES } = {}) {
    this.warmup = Math.max(0, warmup | 0);
    this.capacity = Math.max(120, samples | 0);
    this.seen = 0;
    this.frames = [];
    this.maxDrawCalls = 0;
    this.maxTriangles = 0;
  }

  frame(milliseconds, { eligible = true, drawCalls = 0, triangles = 0 } = {}) {
    if (!eligible || !Number.isFinite(milliseconds) || milliseconds <= 0) return null;
    this.seen++;
    if (this.seen <= this.warmup) return null;
    this.frames.push(milliseconds);
    this.maxDrawCalls = Math.max(this.maxDrawCalls, Number(drawCalls) || 0);
    this.maxTriangles = Math.max(this.maxTriangles, Number(triangles) || 0);
    return this.frames.length >= this.capacity ? this.result() : null;
  }

  result() {
    if (!this.frames.length) return null;
    const sorted = [...this.frames].sort((a, b) => a - b);
    const percentile = fraction => sorted[Math.min(sorted.length - 1,
      Math.floor((sorted.length - 1) * fraction))];
    const sample = {
      sampledFrames: this.frames.length,
      frameP95Ms: percentile(0.95),
      longFrameRate: this.frames.filter(ms => ms > 33.4).length / this.frames.length,
      drawCalls: this.maxDrawCalls,
      triangles: this.maxTriangles,
    };
    return { level: automaticGraphicsLevel(sample), sample };
  }
}
