// device-support.js — capability checks used before starting a match.

// Touch laptops can expose both coarse and fine pointers and remain usable;
// only block devices with touch/coarse input and no fine pointer at all.
export function keyboardMouseUnsupported({ navigatorLike = globalThis.navigator,
  matchMediaLike = globalThis.matchMedia } = {}) {
  const touchPoints = Number(navigatorLike?.maxTouchPoints ?? 0);
  if (!(touchPoints > 0)) return false;
  if (typeof matchMediaLike !== 'function') return true;
  const coarse = !!matchMediaLike('(pointer: coarse)')?.matches
    || !!matchMediaLike('(hover: none)')?.matches;
  const fine = !!matchMediaLike('(pointer: fine)')?.matches;
  // maxTouchPoints is the reliable fallback when a browser omits pointer
  // media-query support; coarse/hover is still sampled for diagnostics and
  // future device-specific policies.
  return !fine && (coarse || touchPoints > 0);
}
