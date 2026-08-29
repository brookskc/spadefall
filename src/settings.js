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
  low:    { pixelRatio: 1,   antialias: false, tracers: 16, flashes: 16, debris: 80,
    ambience: 24, foam: false, spray: 0, casings: 0 },
  medium: { pixelRatio: 1.5, antialias: true,  tracers: 32, flashes: 32, debris: 180,
    ambience: 72, foam: true, spray: 0, casings: 16 },
  high:   { pixelRatio: 2,   antialias: true,  tracers: 48, flashes: 48, debris: 320,
    ambience: 144, foam: true, spray: 32, casings: 32 },
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
  try { localStorage.setItem('tos.gfx', level); } catch { /* best effort */ }
}

export function gfxPreset(level = getGfxLevel()) {
  return GFX_PRESETS[level];
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
export const FOV_LEVELS = ['75', '85', '95'];
export const MOTION_LEVELS = ['full', 'reduced'];
export const COLOR_MODES = ['standard', 'accessible'];
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
export const getBaseFov = () => Number(choice('fov', FOV_LEVELS, '75'));
export const setBaseFov = value => saveChoice('fov', value, FOV_LEVELS);
export const getMotionScale = () => choice('motion', MOTION_LEVELS, 'full') === 'reduced' ? 0.25 : 1;
export const getMotionLevel = () => choice('motion', MOTION_LEVELS, 'full');
export const setMotionLevel = value => saveChoice('motion', value, MOTION_LEVELS);
export const getColorMode = () => choice('colors', COLOR_MODES, 'standard');
export const setColorMode = value => saveChoice('colors', value, COLOR_MODES);
export const teamHex = (team, mode = getColorMode()) =>
  TEAM_PALETTES[mode]?.[team] ?? TEAM_PALETTES.standard[team] ?? 0xffffff;
