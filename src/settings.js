// settings.js — persisted graphics/display preferences. Same 'tos.' key
// prefix the existing lobby prefs (tos.mode, tos.map, tos.class, tos.team)
// already use, and the same try/catch-for-private-browsing discipline
// stats.js already established: a broken localStorage means it doesn't
// persist, never a broken read.
//
// Three real, honest performance levers, and deliberately nothing else:
// - pixelRatio: the single biggest lever on a high-DPI display, where the
//   default can mean rendering at 2-3x the logical resolution.
// - antialias: a genuine, if smaller, GPU cost. Fixed at WebGL context
//   creation, though — cannot be changed on a live renderer, so a change
//   here needs a page reload to actually take effect. Callers should
//   surface that rather than let it look like a live-applying setting.
// - tracers/flashes/debris: pool capacities for the existing particle
//   systems. A modest lever, but genuine — fewer simultaneous instances
//   to update during a chaotic firefight, which is exactly when frame
//   drops are most noticeable on weak hardware.
//
// Deliberately NOT here: draw/render distance, chunk visibility, or
// anything else that would change what terrain or players are actually
// visible. This is a competitive PVP game — a lower graphics tier should
// never mean seeing less of the map than someone on a higher one.
const GFX_PRESETS = {
  // Atmosphere is intentionally cadence-limited: these effects are ambient
  // decoration, not gameplay state, so updating them at display refresh is
  // wasted CPU/GPU work. Keep High at 30 Hz, with progressively cheaper
  // tiers for weaker hardware while leaving terrain/player visibility alone.
  low:    { pixelRatio: 1,   antialias: false, tracers: 16, flashes: 16, debris: 80,
    ambience: 24, atmosphereHz: 15, foam: false, spray: 0, casings: 0 },
  medium: { pixelRatio: 1.5, antialias: true,  tracers: 32, flashes: 32, debris: 180,
    ambience: 72, atmosphereHz: 24, foam: true, spray: 0, casings: 16 },
  high:   { pixelRatio: 2,   antialias: true,  tracers: 48, flashes: 48, debris: 320,
    ambience: 144, atmosphereHz: 30, foam: true, spray: 32, casings: 32 },
};

export function getGfxLevel() {
  try {
    const v = localStorage.getItem('tos.gfx');
    if (v && v in GFX_PRESETS) return v;
  } catch { /* best effort */ }
  return 'high'; // matches this game's actual pre-existing behavior, so nobody's experience silently changes just from this feature shipping
}

export function setGfxLevel(level) {
  if (!(level in GFX_PRESETS)) return;
  try {
    localStorage.setItem('tos.gfx', level);
    localStorage.setItem('tos.gfxMode', 'manual');
  } catch { /* best effort */ }
}

export function getGfxMode() {
  try {
    const explicit = localStorage.getItem('tos.gfxMode');
    if (explicit === 'auto' || explicit === 'manual') return explicit;
    return localStorage.getItem('tos.gfx') ? 'manual' : 'auto';
  } catch { return 'auto'; }
}

export function requestAutomaticGfx() {
  try {
    localStorage.setItem('tos.gfxMode', 'auto');
    localStorage.removeItem('tos.gfxBenchmark');
  } catch { /* best effort */ }
}

export function automaticGfxNeeded(version) {
  if (getGfxMode() !== 'auto') return false;
  try { return localStorage.getItem('tos.gfxBenchmark') !== String(version); }
  catch { return true; }
}

export function saveAutomaticGfxLevel(level, version) {
  if (!(level in GFX_PRESETS)) return false;
  try {
    localStorage.setItem('tos.gfx', level);
    localStorage.setItem('tos.gfxMode', 'auto');
    localStorage.setItem('tos.gfxBenchmark', String(version));
  } catch { /* best effort */ }
  return true;
}

export function gfxPreset(level = getGfxLevel()) {
  return GFX_PRESETS[level];
}

/** Seconds between ambient water/sky updates for a graphics tier. */
export function atmosphereCadence(level = getGfxLevel()) {
  const hz = gfxPreset(level).atmosphereHz;
  return 1 / Math.max(1, hz || 30);
}

export function getShowFps() {
  try { return localStorage.getItem('tos.showFps') === 'on'; } catch { return false; }
}

export function setShowFps(on) {
  try { localStorage.setItem('tos.showFps', on ? 'on' : 'off'); } catch { /* best effort */ }
}

function choice(key, allowed, fallback) {
  try {
    const value = localStorage.getItem('tos.' + key);
    return allowed.includes(value) ? value : fallback;
  } catch { return fallback; }
}

function saveChoice(key, value, allowed) {
  if (!allowed.includes(String(value))) return;
  try { localStorage.setItem('tos.' + key, String(value)); } catch { /* best effort */ }
}

export const HUD_SCALES = ['80', '100', '120'];
export const HUD_OPACITIES = ['75', '100'];
export const MOTION_LEVELS = ['full', 'reduced'];
export const COLOR_MODES = ['standard', 'accessible'];
export const MOUSE_SENSITIVITIES = ['60', '80', '100', '120', '140'];
export const MASTER_VOLUMES = ['0', '50', '75', '100'];
export const AUDIO_VOLUMES = MASTER_VOLUMES;
export const CAPTION_MODES = ['off', 'critical', 'full'];
export const TOGGLE_MODES = ['hold', 'toggle'];
export const CONTRAST_MODES = ['standard', 'high'];
const TEAM_PALETTES = {
  standard: { green: 0x4a9e4a, blue: 0x4a6cd4 },
  // Okabe-Ito inspired orange/sky pairing: distinct under the common red/
  // green deficiencies while staying equally bright in the voxel world.
  accessible: { green: 0xe69f00, blue: 0x56b4e9 },
};

export const getHudScale = () => Number(choice('hudScale', HUD_SCALES, '100')) / 100;
export const setHudScale = value => saveChoice('hudScale', value, HUD_SCALES);
export const getHudOpacity = () => Number(choice('hudOpacity', HUD_OPACITIES, '100')) / 100;
export const setHudOpacity = value => saveChoice('hudOpacity', value, HUD_OPACITIES);
export const getMotionScale = () => choice('motion', MOTION_LEVELS, 'full') === 'reduced' ? 0.25 : 1;
export const getMotionLevel = () => choice('motion', MOTION_LEVELS, 'full');
export const setMotionLevel = value => saveChoice('motion', value, MOTION_LEVELS);
export const getColorMode = () => choice('colors', COLOR_MODES, 'standard');
export const setColorMode = value => saveChoice('colors', value, COLOR_MODES);
export const getMouseSensitivity = () => Number(choice('mouseSensitivity', MOUSE_SENSITIVITIES, '100')) / 100;
export const setMouseSensitivity = value => saveChoice('mouseSensitivity', value, MOUSE_SENSITIVITIES);
export const getMasterVolume = () => Number(choice('masterVolume', MASTER_VOLUMES, '100')) / 100;
export const setMasterVolume = value => saveChoice('masterVolume', value, MASTER_VOLUMES);
export const getEffectsVolume = () => Number(choice('effectsVolume', AUDIO_VOLUMES, '100')) / 100;
export const setEffectsVolume = value => saveChoice('effectsVolume', value, AUDIO_VOLUMES);
export const getAmbienceVolume = () => Number(choice('ambienceVolume', AUDIO_VOLUMES, '100')) / 100;
export const setAmbienceVolume = value => saveChoice('ambienceVolume', value, AUDIO_VOLUMES);
export const getUiVolume = () => Number(choice('uiVolume', AUDIO_VOLUMES, '100')) / 100;
export const setUiVolume = value => saveChoice('uiVolume', value, AUDIO_VOLUMES);
export const getCaptionMode = () => choice('captions', CAPTION_MODES, 'off');
export const setCaptionMode = value => saveChoice('captions', value, CAPTION_MODES);
export const getCrouchMode = () => choice('crouchMode', TOGGLE_MODES, 'hold');
export const setCrouchMode = value => saveChoice('crouchMode', value, TOGGLE_MODES);
export const getAimMode = () => choice('aimMode', TOGGLE_MODES, 'hold');
export const setAimMode = value => saveChoice('aimMode', value, TOGGLE_MODES);
export const getObjectiveContrast = () => choice('objectiveContrast', CONTRAST_MODES, 'standard');
export const setObjectiveContrast = value => saveChoice('objectiveContrast', value, CONTRAST_MODES);
export const getDamageContrast = () => choice('damageContrast', CONTRAST_MODES, 'standard');
export const setDamageContrast = value => saveChoice('damageContrast', value, CONTRAST_MODES);
export function getMuted() {
  try { return localStorage.getItem('tos.muted') === 'on'; } catch { return false; }
}
export function setMuted(on) {
  try { localStorage.setItem('tos.muted', on ? 'on' : 'off'); } catch { /* best effort */ }
}
export const teamHex = (team, mode = getColorMode()) =>
  TEAM_PALETTES[mode]?.[team] ?? TEAM_PALETTES.standard[team] ?? 0xffffff;
