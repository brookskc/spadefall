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
  low:    { pixelRatio: 1,   antialias: false, tracers: 16, flashes: 16, debris: 80 },
  medium: { pixelRatio: 1.5, antialias: true,  tracers: 32, flashes: 32, debris: 180 },
  high:   { pixelRatio: 2,   antialias: true,  tracers: 48, flashes: 48, debris: 320 },
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
