// Captions deliberately accept a completed spatial mix, never raw positions.
// This prevents a caption from becoming an extra enemy-detection channel.
export function captionFromMix(name, mix, mode = 'off', now = 0, previous = null) {
  if (mode === 'off' || !mix) return null;
  const critical = new Set(['explosion', 'airstrikeImpact', 'missile', 'missileLaunch',
    'telegraph', 'danger', 'hurt', 'capture', 'drop', 'lose']);
  if (mode === 'critical' && !critical.has(name)) return null;
  if (previous?.name === name && now - previous.at < 450) return null;
  const side = mix.pan < -0.2 ? 'LEFT' : mix.pan > 0.2 ? 'RIGHT' : 'AHEAD';
  const vertical = mix.pitch > 1.03 ? ' ABOVE' : mix.pitch < .97 ? ' BELOW' : '';
  return { name, at: now, text: `${side}${vertical} · ${name.replace(/([A-Z])/g, ' $1').toUpperCase()}` };
}
