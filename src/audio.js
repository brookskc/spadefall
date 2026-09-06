// audio.js — a synthetic, "voxel-sized" WebAudio palette. Filtered noise and
// compact sine/triangle bodies keep it tactile and stylized without drifting
// into either realistic sample-pack foley or thin chiptune square-wave chirps.
let ctx = null, master = null;
let masterLevel = 1, muted = false;
const applyMaster = () => {
  if (master) master.gain.value = 0.48 * masterLevel * (muted ? 0 : 1);
};

export function setMasterVolume(value) {
  const n = Number(value);
  masterLevel = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
  applyMaster();
}

export function setAudioMuted(value) { muted = !!value; applyMaster(); }
export function isAudioMuted() { return muted; }

export function initAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    return;
  }
  const AudioCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioCtor) return;
  ctx = new AudioCtor();
  master = ctx.createGain();
  applyMaster();
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

let listener = null; // { x, y, z, rx, rz, occluded?(pos, name) }
let _pan = 0, _scale = 1, _spatialPitch = 1, _occlusionHz = 0;
export function setListener(l) { listener = l; }
export function spatialVerticality(dy, distance) {
  const ratio = Number.isFinite(dy) && Number.isFinite(distance) && distance > 0
    ? Math.max(-1, Math.min(1, dy / distance)) : 0;
  return { pitch: 1 + ratio * .16, vertical: ratio > .22 ? 'above' : ratio < -.22 ? 'below' : 'level' };
}

function route(node) {
  let output = node;
  if (_occlusionHz) {
    const wall = ctx.createBiquadFilter();
    wall.type = 'lowpass';
    wall.frequency.value = _occlusionHz;
    wall.Q.value = 0.7;
    output.connect(wall);
    output = wall;
  }
  if (_pan) {
    const p = ctx.createStereoPanner();
    p.pan.value = _pan;
    output.connect(p).connect(master);
  } else output.connect(master);
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

// Tonal layers use a rounded contour. The noise transients above retain a
// handful of audible ledges for the voxel character, while pitch no longer
// stair-steps in volume like an 8-bit sound effect.
function roundedEnvelope(param, t0, peak, dur, attack = 0.004) {
  const level = Math.max(0.0001, peak * _scale);
  param.setValueAtTime(0.0001, t0);
  param.linearRampToValueAtTime(level, t0 + Math.min(attack, dur * 0.25));
  param.exponentialRampToValueAtTime(Math.max(0.0001, level * 0.42),
    t0 + Math.max(attack + 0.001, dur * 0.52));
  param.exponentialRampToValueAtTime(0.0001, t0 + dur);
}

function burst({ dur = 0.12, freq = 1100, q = 0.8, gain = 0.35,
  decaySteps = 4, filter = 'lowpass', delay = 0 }) {
  if (!ready()) return;
  const t0 = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer();
  const f = ctx.createBiquadFilter();
  f.type = filter; f.frequency.value = freq * _spatialPitch; f.Q.value = q;
  const g = ctx.createGain();
  steppedEnvelope(g.gain, t0, gain, dur, decaySteps);
  src.connect(f).connect(g); route(g);
  src.start(t0, Math.random() * 0.4);
  src.stop(t0 + dur + 0.03);
}

function tone({ freq = 440, end = freq, dur = 0.1, type = 'triangle',
  gain = 0.16, steps = 3, delay = 0 }) {
  if (!ready()) return;
  const t0 = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(Math.max(30, freq * _spatialPitch), t0);
  if (end !== freq) o.frequency.exponentialRampToValueAtTime(Math.max(30, end * _spatialPitch), t0 + dur);
  const g = ctx.createGain();
  roundedEnvelope(g.gain, t0, gain, dur, Math.min(0.006, dur * 0.18));
  o.connect(g); route(g);
  o.start(t0); o.stop(t0 + dur + 0.03);
}

function metalTick(freq = 300, gain = 0.1, delay = 0) {
  tone({ freq, end: freq * 0.62, dur: 0.052, type: 'triangle', gain, delay });
  burst({ dur: 0.028, freq: Math.min(1450, freq * 3), q: 1.4,
    gain: gain * 0.34, decaySteps: 3, filter: 'bandpass', delay: delay + 0.008 });
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
// Mechanical pitch, not a musical note: the compact SMG is a little lighter,
// the sniper bolt heavier, and none lives in the piercing 600–1200Hz range.
export const reloadPitch = kind => kind === 'smg' ? 330 : kind === 'sniper' ? 235 : 275;

const QUIET_SPACE = Object.freeze({ step: 24, dig: 30, spadeHit: 28,
  reloadStart: 26, reloadEject: 26, reloadInsert: 26, reloadChamber: 26 });
const FAR_SPACE = Object.freeze({ rifle: 95, smg: 82, sniper: 115,
  explosion: 100, airstrikeImpact: 130, drone: 110, missile: 110,
  missileLaunch: 110 });

// Pure spatial mix seam used by the runtime and tests. Occlusion changes
// timbre more than loudness: a weapon behind a ridge remains actionable, but
// loses the brittle high-frequency edge that falsely reads as line-of-sight.
export function spatialAudioMix(name, pos, ear, occluded = false) {
  if (!pos || !ear || ![pos.x, pos.z, ear.x, ear.y, ear.z, ear.rx, ear.rz]
    .every(Number.isFinite)) return null;
  const cutoff = QUIET_SPACE[name] ?? FAR_SPACE[name] ?? 70;
  const dx = pos.x - ear.x, dy = (Number.isFinite(pos.y) ? pos.y : ear.y) - ear.y;
  const dz = pos.z - ear.z, distance = Math.hypot(dx, dy, dz);
  if (distance > cutoff) return null;
  const quiet = Object.hasOwn(QUIET_SPACE, name);
  const falloff = quiet ? 0.16
    : name === 'drone' || name === 'missile' ? 0.045 : 0.075;
  const blockedGain = !occluded ? 1
    : name === 'explosion' || name === 'airstrikeImpact' ? 0.78
      : quiet ? 0.46 : 0.58;
  return {
    distance,
    pan: distance < 1.5 ? 0 : Math.max(-0.9, Math.min(0.9,
      (dx * ear.rx + dz * ear.rz) / distance)),
    pitch: name === 'step' ? spatialVerticality(dy, distance).pitch : 1,
    scale: blockedGain / (1 + distance * falloff),
    occlusionHz: occluded ? (quiet ? 720 : 980) : 0,
  };
}

export const sfx = {
  // Each gun shares a noise face, pitched body, and mechanical pixel. The
  // proportions—not realistic recordings—communicate weapon weight.
  rifle: () => {
    burst({ dur: 0.19, freq: 760, gain: 0.57, decaySteps: 5 });
    tone({ freq: 128, end: 68, dur: 0.13, type: 'sine', gain: 0.22 });
    metalTick(365, 0.055, 0.06);
  },
  smg: () => {
    burst({ dur: 0.085, freq: 1120, gain: 0.36, decaySteps: 4 });
    tone({ freq: 185, end: 108, dur: 0.065, type: 'triangle', gain: 0.085 });
    metalTick(410, 0.035, 0.035);
  },
  sniper: () => {
    burst({ dur: 0.36, freq: 540, gain: 0.76, decaySteps: 6 });
    burst({ dur: 0.085, freq: 1750, gain: 0.24, decaySteps: 3, filter: 'bandpass' });
    tone({ freq: 88, end: 44, dur: 0.29, type: 'sine', gain: 0.32 });
    metalTick(285, 0.075, 0.15);
  },

  // Animation-driven stages mean swapping tools or dying cancels the rest.
  reloadStart: (kind) => {
    const p = reloadPitch(kind);
    burst({ dur: 0.055, freq: 620, q: 0.8, gain: 0.04, decaySteps: 4, filter: 'lowpass' });
    metalTick(p * 0.82, 0.055, 0.008);
  },
  reloadEject: (kind) => {
    const p = reloadPitch(kind);
    metalTick(p, 0.075);
    tone({ freq: p * 0.48, end: p * 0.34, dur: 0.085, type: 'sine', gain: 0.065 });
    burst({ dur: 0.045, freq: 470, q: 0.7, gain: 0.04, decaySteps: 3,
      filter: 'lowpass', delay: 0.025 });
  },
  reloadInsert: (kind) => {
    const p = reloadPitch(kind);
    burst({ dur: 0.075, freq: 390, q: 0.7, gain: 0.085, decaySteps: 4,
      filter: 'lowpass' });
    tone({ freq: p * 0.42, end: p * 0.58, dur: 0.09, type: 'sine', gain: 0.075 });
    metalTick(p * 0.96, 0.065, 0.05);
  },
  reloadChamber: (kind) => {
    const p = reloadPitch(kind);
    metalTick(p * 1.08, 0.08);
    metalTick(p * 0.76, 0.065, 0.065);
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
    metalTick(p.knock * 1.75, 0.035, 0.025);
  },
  spadeHit: () => {
    burst({ dur: 0.095, freq: 360, gain: 0.32, decaySteps: 3 });
    tone({ freq: 118, end: 75, dur: 0.09, type: 'triangle', gain: 0.13 });
  },
  crumble: () => {
    for (let i = 0; i < 4; i++) {
      burst({ dur: 0.16, freq: 260 + i * 90, gain: 0.22, decaySteps: 3, delay: i * 0.065 });
      tone({ freq: 105 - i * 8, dur: 0.1, type: 'sine', gain: 0.055, delay: i * 0.065 });
    }
  },
  place: () => {
    tone({ freq: 190, end: 285, dur: 0.085, type: 'triangle', gain: 0.11 });
    metalTick(280, 0.05, 0.03);
  },

  hit: () => tone({ freq: 760, end: 620, dur: 0.055, type: 'sine', gain: 0.15 }),
  kill: () => {
    tone({ freq: 820, dur: 0.1, type: 'sine', gain: 0.19 });
    tone({ freq: 1160, dur: 0.14, type: 'triangle', gain: 0.15, delay: 0.07 });
  },
  headshot: (killed = false) => {
    metalTick(520, .08);
    tone({ freq: killed ? 720 : 610, end: killed ? 980 : 760,
      dur: .09, type: 'triangle', gain: .13, delay: .025 });
  },
  radio: () => {
    burst({ dur: .06, freq: 680, gain: .055, decaySteps: 3, filter: 'bandpass' });
    tone({ freq: 245, end: 285, dur: .08, type: 'triangle', gain: .06, delay: .035 });
  },
  danger: () => {
    tone({ freq: 180, end: 145, dur: .08, type: 'triangle', gain: .13 });
    tone({ freq: 180, end: 145, dur: .08, type: 'triangle', gain: .13, delay: .13 });
  },
  multiKill: (notes) => {
    for (let i = 0; i < notes; i++)
      tone({ freq: 720 + i * 170, dur: 0.11, type: 'triangle', gain: 0.17, delay: i * 0.075 });
  },
  hurt: () => {
    tone({ freq: 190, end: 72, dur: 0.18, type: 'triangle', gain: 0.22 });
    burst({ dur: 0.08, freq: 420, gain: 0.16, decaySteps: 2 });
  },
  throw_: () => {
    metalTick(390, 0.065);
    burst({ dur: 0.12, freq: 1800, gain: 0.09, decaySteps: 3, filter: 'bandpass', delay: 0.035 });
  },
  explosion: () => {
    burst({ dur: 0.62, freq: 580, gain: 0.8, decaySteps: 6 });
    tone({ freq: 82, end: 43, dur: 0.5, type: 'sine', gain: 0.4 });
    burst({ dur: 0.28, freq: 1500, gain: 0.22, decaySteps: 4, delay: 0.07 });
  },
  airstrikeImpact: () => {
    burst({ dur: 0.95, freq: 650, gain: 1.0, decaySteps: 8 });
    tone({ freq: 68, end: 32, dur: 0.82, type: 'sine', gain: 0.58 });
    for (let i = 0; i < 4; i++)
      burst({ dur: 0.18, freq: 1350 - i * 190, gain: 0.2, decaySteps: 3, delay: 0.08 + i * 0.09 });
  },

  // Repeating short cells animate the aircraft and missile at the same coarse
  // resolution as their models, without a realistic engine recording.
  drone: (progress = 0) => {
    const p = Math.max(0, Math.min(1, progress));
    tone({ freq: 56 + p * 8, end: 48 + p * 7, dur: 0.14, type: 'sine', gain: 0.09 });
    burst({ dur: 0.105, freq: 330, q: 1.4, gain: 0.075, decaySteps: 3, filter: 'bandpass' });
  },
  missileLaunch: () => {
    metalTick(260, 0.09);
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
      tone({ freq: 920, dur: 0.11, type: 'triangle', gain: 0.2, delay: i * 0.24 });
      tone({ freq: 650, dur: 0.09, type: 'sine', gain: 0.09, delay: i * 0.24 + 0.08 });
    }
  },

  pickup: () => {
    tone({ freq: 520, dur: 0.08, type: 'triangle', gain: 0.19 });
    tone({ freq: 780, dur: 0.11, type: 'triangle', gain: 0.19, delay: 0.08 });
  },
  ping: () => {
    tone({ freq: 420, dur: 0.075, type: 'triangle', gain: 0.11 });
    tone({ freq: 630, dur: 0.1, type: 'sine', gain: 0.13, delay: 0.075 });
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
    tone({ freq: 330, end: 520, dur: 0.14, type: 'triangle', gain: 0.12 });
    metalTick(340, 0.045, 0.09);
  },
  click: () => metalTick(280, 0.055),
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
    const dx = pos.x - listener.x, dy = (pos.y ?? listener.y) - listener.y,
      dz = pos.z - listener.z;
    const distance = Math.hypot(dx, dy, dz);
    const occluded = distance > 4 && typeof listener.occluded === 'function'
      ? !!listener.occluded(pos, name) : false;
    const mix = spatialAudioMix(name, pos, listener, occluded);
    if (!mix) return;
    _pan = mix.pan;
    _spatialPitch = mix.pitch;
    _scale = mix.scale;
    _occlusionHz = mix.occlusionHz;
    this[name](...args);
    _pan = 0; _scale = 1; _spatialPitch = 1; _occlusionHz = 0;
  },
};
