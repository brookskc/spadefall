// Content ready for public matchmaking. Keep this apart from MAPS so private
// development and QA can still exercise every generated map.
export const PRIVATE_CONTENT_FEATURE = 'privateContent';
export const PUBLIC_MODES = Object.freeze(['tdm', 'koth']);
// DUNES and CROWN are retained for private development rooms. Keep indices
// stable: the appended public maps are FOUNDRY=6 and FAULTLINE=7.
export const PRIVATE_MAP_INDEXES = Object.freeze([3, 4]);

export const publicContentAvailable = (mode, mapIndex) =>
  PUBLIC_MODES.includes(mode) && !PRIVATE_MAP_INDEXES.includes(mapIndex);

// Private hosting follows the release catalogue unless development explicitly
// opts into private content through the URL feature mechanism.
export function contentAvailable(mode, mapIndex, {
  publicOnly = false,
  // Keep mapsForMode(mode) backwards-compatible for internals and tests;
  // public callers and the selector pass an explicit release policy.
  privateContent = true,
} = {}) {
  return publicContentAvailable(mode, mapIndex) || (!publicOnly && privateContent);
}
