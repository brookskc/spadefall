// audio.js — a deliberately synthetic, "voxel-sized" WebAudio palette.
// Short stepped envelopes and a small set of square/triangle voices keep the
// sound language as chunky as the art. No sampled firearms or realistic foley.
let ctx = null, master = null;

export function initAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    return;
  }
  const AudioCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioCtor) return;
  ctx = new AudioCtor();
  master = ctx.createGain();
  master.gain.value = 0.48;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -9;
  limiter.knee.value = 2;
  limiter.ratio.value = 10;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  master.connect(limiter).connect(ctx.destination);
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
}

function ready() {
  if (!ctx || !master) return false;
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  return true;
}

// One reusable buffer keeps automatic fire and footsteps allocation-free.
let _noise = null;
function noiseBuffer() {
  if (_noise) return _noise;
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 2), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return (_noise = buf);
}

let listener = null; // { x, y, z, rx, rz } — position + unit right vector
let _pan = 0, _scale = 1;
export function setListener(l) { listener = l; }

function route(node) {
  if (_pan) {
    const p = ctx.createStereoPanner();
    p.pan.value = _pan;
    node.connect(p).connect(master);
  } else node.connect(master);
}

// A few audible volume ledges instead of a perfectly smooth fade are the
// palette's core: fast enough not to click, discrete enough to feel built.
function steppedEnvelope(param, t0, peak, dur, steps = 4, attack = 0.002) {
  param.setValueAtTime(0.0001, t0);
  param.linearRampToValueAtTime(Math.max(0.0001, peak * _scale), t0 + attack);
  const body = Math.max(0.001, dur - attack);
  for (let i = 1; i < steps; i++) {
    const at = t0 + attack + body * i / steps;
    const prior = peak * _scale * (1 - (i - 1) / steps);
    const level = peak * _scale * (1 - i / steps);
    param.setValueAtTime(Math.max(0.0001, prior), Math.max(t0 + attack, at - 0.003));
    param.linearRampToValueAtTime(Math.max(0.0001, level), at);
  }
  param.setValueAtTime(Math.max(0.0001, peak * _scale / steps),
    Math.max(t0 + attack, t0 + dur - 0.003));
  param.exponentialRampToValueAtTime(0.0001, t0 + dur);
}

function burst({ dur = 0.12, freq = 1100, q = 0.8, gain = 0.35,
  decaySteps = 4, filter = 'lowpass', delay = 0 }) {
  if (!ready()) return;
  const t0 = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer();
  const f = ctx.createBiquadFilter();
  f.type = filter; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain();
  steppedEnvelope(g.gain, t0, gain, dur, decaySteps);
  src.connect(f).connect(g); route(g);
  src.start(t0, Math.random() * 0.4);
  src.stop(t0 + dur + 0.03);
}

function tone({ freq = 440, end = freq, dur = 0.1, type = 'square',
  gain = 0.16, steps = 3, delay = 0 }) {
  if (!ready()) return;
  const t0 = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(Math.max(30, freq), t0);
  if (end !== freq) o.frequency.exponentialRampToValueAtTime(Math.max(30, end), t0 + dur);
  const g = ctx.createGain();
  steppedEnvelope(g.gain, t0, gain, dur, steps);
  o.connect(g); route(g);
  o.start(t0); o.stop(t0 + dur + 0.03);
}

function metalTick(freq = 760, gain = 0.1, delay = 0) {
  tone({ freq, end: freq * 0.72, dur: 0.035, type: 'square', gain, steps: 2, delay });
  tone({ freq: freq * 1.48, dur: 0.018, type: 'triangle', gain: gain * 0.55,
    steps: 2, delay: delay + 0.012 });
}

// Numeric values match world.js's stable block IDs. Keeping the mapping here
// avoids an audio <-> world import cycle and gives tests a pure seam.
export function voxelSurface(v) {
  if (v === 3) return 'sand';
  if (v === 4) return 'stone';
  if (v === 5 || v === 6) return 'built';
  if (v === 1 || v === 7) return 'soft';
  return 'earth';
}

const SURFACE = {
  soft:  { noise: 720,  knock: 105, gain: 0.13 },
  earth: { noise: 520,  knock: 88,  gain: 0.15 },
  sand:  { noise: 1250, knock: 72,  gain: 0.11 },
  stone: { noise: 1650, knock: 190, gain: 0.14 },
  built: { noise: 1150, knock: 245, gain: 0.14 },
};
const profile = v => SURFACE[voxelSurface(v)];
const reloadPitch = kind => kind === 'smg' ? 860 : kind === 'sniper' ? 610 : 720;

export const sfx = {
  // Each gun shares a noise face, pitched body, and mechanical pixel. The
  // proportions—not realistic recordings—communicate weapon weight.
  rifle: () => {
    burst({ dur: 0.18, freq: 980, gain: 0.58, decaySteps: 4 });
    tone({ freq: 135, end: 72, dur: 0.11, type: 'square', gain: 0.2, steps: 3 });
    metalTick(920, 0.065, 0.055);
  },
  smg: () => {
    burst({ dur: 0.075, freq: 1550, gain: 0.38, decaySteps: 3 });
    tone({ freq: 205, end: 125, dur: 0.052, type: 'square', gain: 0.1, steps: 2 });
    metalTick(1120, 0.04, 0.03);
  },
  sniper: () => {
    burst({ dur: 0.34, freq: 680, gain: 0.78, decaySteps: 5 });
    burst({ dur: 0.075, freq: 2600, gain: 0.32, decaySteps: 2 });
    tone({ freq: 92, end: 48, dur: 0.26, type: 'square', gain: 0.3, steps: 5 });
    metalTick(650, 0.085, 0.14);
  },

  // Animation-driven stages mean swapping tools or dying cancels the rest.
  reloadStart: (kind) => metalTick(reloadPitch(kind) * 0.8, 0.07),
  reloadEject: (kind) => {
    const p = reloadPitch(kind);
    metalTick(p, 0.1);
    tone({ freq: p * 0.45, end: p * 0.32, dur: 0.065, type: 'triangle', gain: 0.07 });
  },
  reloadInsert: (kind) => {
    const p = reloadPitch(kind);
    tone({ freq: p * 0.38, end: p * 0.66, dur: 0.075, type: 'square', gain: 0.085, steps: 2 });
    metalTick(p * 1.08, 0.085, 0.045);
  },
  reloadChamber: (kind) => {
    const p = reloadPitch(kind);
    metalTick(p * 1.35, 0.11);
    metalTick(p * 0.82, 0.08, 0.055);
  },

  // Air is a light whoosh; terrain adds a material crunch and low voxel knock.
  swing: () => {
    burst({ dur: 0.11, freq: 1750, q: 1.2, gain: 0.13, decaySteps: 3, filter: 'bandpass' });
    tone({ freq: 330, end: 180, dur: 0.09, type: 'triangle', gain: 0.045, steps: 3 });
  },
  dig: (surface = 2) => {
    const p = profile(surface);
    burst({ dur: 0.1, freq: p.noise, gain: p.gain * 2.5, decaySteps: 3 });
    tone({ freq: p.knock, end: p.knock * 0.72, dur: 0.085, type: 'square', gain: 0.13, steps: 3 });
    metalTick(p.knock * 3.2, 0.04, 0.025);
  },
  spadeHit: () => {
    burst({ dur: 0.095, freq: 360, gain: 0.32, decaySteps: 3 });
    tone({ freq: 118, end: 75, dur: 0.09, type: 'triangle', gain: 0.13 });
  },
  crumble: () => {
    for (let i = 0; i < 4; i++) {
      burst({ dur: 0.16, freq: 260 + i * 90, gain: 0.22, decaySteps: 3, delay: i * 0.065 });
      tone({ freq: 105 - i * 8, dur: 0.1, type: 'square', gain: 0.055, delay: i * 0.065 });
    }
  },
  place: () => {
    tone({ freq: 235, end: 360, dur: 0.07, type: 'square', gain: 0.13, steps: 2 });
    metalTick(620, 0.06, 0.025);
  },

  hit: () => tone({ freq: 920, end: 760, dur: 0.045, type: 'square', gain: 0.16, steps: 2 }),
  kill: () => {
    tone({ freq: 1040, dur: 0.09, type: 'triangle', gain: 0.2 });
    tone({ freq: 1560, dur: 0.13, type: 'triangle', gain: 0.17, delay: 0.065 });
  },
  multiKill: (notes) => {
    for (let i = 0; i < notes; i++)
      tone({ freq: 980 + i * 220, dur: 0.1, type: 'triangle', gain: 0.19, delay: i * 0.07 });
  },
  hurt: () => {
    tone({ freq: 215, end: 82, dur: 0.16, type: 'square', gain: 0.24, steps: 4 });
    burst({ dur: 0.08, freq: 420, gain: 0.16, decaySteps: 2 });
  },
  throw_: () => {
    metalTick(1050, 0.08);
    burst({ dur: 0.12, freq: 1800, gain: 0.09, decaySteps: 3, filter: 'bandpass', delay: 0.035 });
  },
  explosion: () => {
    burst({ dur: 0.62, freq: 580, gain: 0.8, decaySteps: 6 });
    tone({ freq: 82, end: 43, dur: 0.5, type: 'square', gain: 0.4, steps: 6 });
    burst({ dur: 0.28, freq: 1500, gain: 0.22, decaySteps: 4, delay: 0.07 });
  },
  airstrikeImpact: () => {
    burst({ dur: 0.95, freq: 650, gain: 1.0, decaySteps: 8 });
    tone({ freq: 68, end: 32, dur: 0.82, type: 'square', gain: 0.58, steps: 8 });
    for (let i = 0; i < 4; i++)
      burst({ dur: 0.18, freq: 1350 - i * 190, gain: 0.2, decaySteps: 3, delay: 0.08 + i * 0.09 });
  },

  // Repeating short cells animate the aircraft and missile at the same coarse
  // resolution as their models, without a realistic engine recording.
  drone: (progress = 0) => {
    const p = Math.max(0, Math.min(1, progress));
    tone({ freq: 56 + p * 8, end: 48 + p * 7, dur: 0.14, type: 'square', gain: 0.09, steps: 3 });
    burst({ dur: 0.105, freq: 330, q: 1.4, gain: 0.075, decaySteps: 3, filter: 'bandpass' });
  },
  missileLaunch: () => {
    metalTick(510, 0.11);
    burst({ dur: 0.28, freq: 1450, q: 0.7, gain: 0.24, decaySteps: 5, filter: 'highpass', delay: 0.045 });
    tone({ freq: 260, end: 610, dur: 0.24, type: 'triangle', gain: 0.08, steps: 5, delay: 0.04 });
  },
  missile: (progress = 0) => {
    const p = Math.max(0, Math.min(1, progress));
    burst({ dur: 0.19, freq: 1250 + p * 1500, q: 1.1, gain: 0.055 + p * 0.13,
      decaySteps: 4, filter: 'bandpass' });
    tone({ freq: 620 + p * 760, end: 760 + p * 920, dur: 0.17,
      type: 'triangle', gain: 0.035 + p * 0.07, steps: 4 });
  },
  telegraph: () => {
    for (let i = 0; i < 3; i++) {
      tone({ freq: 1280, dur: 0.1, type: 'square', gain: 0.23, steps: 2, delay: i * 0.24 });
      tone({ freq: 920, dur: 0.08, type: 'square', gain: 0.1, steps: 2, delay: i * 0.24 + 0.08 });
    }
  },

  overcharge: () => tone({ freq: 210, end: 620, dur: 0.52, type: 'square', gain: 0.25, steps: 7 }),
  pickup: () => {
    tone({ freq: 520, dur: 0.08, type: 'triangle', gain: 0.19 });
    tone({ freq: 780, dur: 0.11, type: 'triangle', gain: 0.19, delay: 0.08 });
  },
  drop: () => {
    tone({ freq: 500, dur: 0.08, type: 'triangle', gain: 0.17 });
    tone({ freq: 315, dur: 0.11, type: 'triangle', gain: 0.17, delay: 0.08 });
  },
  capture: () => [523, 659, 784, 1046].forEach((f, i) =>
    tone({ freq: f, dur: 0.14, type: 'triangle', gain: 0.23, delay: i * 0.095 })),
  lose: () => [392, 330, 262].forEach((f, i) =>
    tone({ freq: f, dur: 0.2, type: 'triangle', gain: 0.21, delay: i * 0.13 })),
  respawn: () => {
    tone({ freq: 390, end: 620, dur: 0.12, type: 'square', gain: 0.13, steps: 3 });
    metalTick(880, 0.055, 0.08);
  },
  click: () => metalTick(690, 0.065),
  step: (scale = 1, surface = 1) => {
    const p = profile(surface);
    const jitter = 0.94 + Math.random() * 0.12;
    burst({ dur: 0.065, freq: p.noise * jitter, gain: p.gain * scale, decaySteps: 3 });
    tone({ freq: p.knock * jitter, end: p.knock * 0.82, dur: 0.045,
      type: 'triangle', gain: 0.045 * scale, steps: 2 });
  },
  slide: (surface = 1) => {
    const p = profile(surface);
    burst({ dur: 0.31, freq: p.noise, q: 0.75, gain: 0.24, decaySteps: 7, filter: 'bandpass' });
    tone({ freq: p.knock, end: p.knock * 0.62, dur: 0.25, type: 'triangle', gain: 0.055, steps: 6 });
  },

  // Additional arguments survive positional routing (material/progress).
  at(name, pos, ...args) {
    if (!ctx || !listener || !this[name] || !pos) return;
    const QUIET = { step: 24, dig: 30, spadeHit: 28, reloadStart: 26,
      reloadEject: 26, reloadInsert: 26, reloadChamber: 26 };
    const FAR = { rifle: 95, smg: 82, sniper: 115, explosion: 100,
      airstrikeImpact: 130, drone: 110, missile: 110, missileLaunch: 110 };
    const cutoff = QUIET[name] ?? FAR[name] ?? 70;
    const dx = pos.x - listener.x, dy = (pos.y ?? listener.y) - listener.y,
          dz = pos.z - listener.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > cutoff) return;
    _pan = d < 1.5 ? 0 : Math.max(-0.9, Math.min(0.9,
      (dx * listener.rx + dz * listener.rz) / d));
    const falloff = QUIET[name] ? 0.16 : name === 'drone' || name === 'missile' ? 0.045 : 0.075;
    _scale = 1 / (1 + d * falloff);
    this[name](...args);
    _pan = 0; _scale = 1;
  },
};
