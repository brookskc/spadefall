// One authored cue timeline for local soldiers and bots.
export const RELOAD_CUES = Object.freeze([
  ['reloadEject', .24], ['reloadInsert', .62], ['reloadChamber', .86],
]);
export function nextReloadCue(stage, progress) {
  const cue = RELOAD_CUES[stage - 1];
  return cue && progress >= cue[1] ? { name: cue[0], stage: stage + 1 } : null;
}
