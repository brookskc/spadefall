// controls.js — small, versioned action bindings.  It intentionally stores
// browser `code` values so layouts do not silently turn WASD into characters.
export const BINDINGS_VERSION = 1;
export const DEFAULT_BINDINGS = Object.freeze({
  moveForward: ['KeyW'], moveBack: ['KeyS'], moveLeft: ['KeyA'], moveRight: ['KeyD'],
  sprint: ['ShiftLeft', 'ShiftRight'], crouch: ['ControlLeft', 'ControlRight'],
  aim: ['Mouse2'], fire: ['Mouse0'], reload: ['KeyR'], jump: ['Space'],
  tool1: ['Digit1'], tool2: ['Digit2'], tool3: ['Digit3'], tool4: ['Digit4'],
  previousTool: ['KeyQ'], nextTool: ['KeyE'], ping: ['KeyG'], scoreboard: ['Tab'],
  ability: ['KeyF'], spawnBase: ['KeyB'], teamChat: ['KeyY'], roomChat: ['KeyT'],
  mute: ['KeyM'],
});

export const BINDING_LABELS = Object.freeze({
  moveForward: 'MOVE FORWARD', moveBack: 'MOVE BACK', moveLeft: 'MOVE LEFT',
  moveRight: 'MOVE RIGHT', sprint: 'SPRINT', crouch: 'CROUCH', aim: 'AIM',
  fire: 'FIRE / USE', reload: 'RELOAD', jump: 'JUMP', tool1: 'WEAPON',
  tool2: 'SPADE', tool3: 'BLOCKS', tool4: 'GRENADE', previousTool: 'PREVIOUS TOOL',
  nextTool: 'NEXT TOOL', ping: 'SQUAD PING', scoreboard: 'SCOREBOARD',
  ability: 'AIRSTRIKE / FRONT SPAWN', spawnBase: 'BASE SPAWN',
  teamChat: 'TEAM CHAT', roomChat: 'ROOM CHAT', mute: 'MUTE',
});

export const validBindingCode = code => typeof code === 'string' && code.length <= 32
  && (/^Mouse[0-4]$/.test(code)
    || /^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|Arrow(?:Up|Down|Left|Right)|Numpad[A-Za-z0-9]+|(?:Shift|Control|Alt)(?:Left|Right)|Space|Tab|Enter|Backspace|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/.test(code));

export function normalizeBindings(value) {
  const input = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const [action, defaults] of Object.entries(DEFAULT_BINDINGS)) {
    const values = Array.isArray(input[action]) ? input[action] : defaults;
    out[action] = [...new Set(values.filter(validBindingCode))];
    if (!out[action].length) out[action] = [...defaults];
  }
  return out;
}

export function bindingConflicts(bindings, action, code) {
  return Object.entries(normalizeBindings(bindings)).filter(([name, codes]) => name !== action && codes.includes(code)).map(([name]) => name);
}

export function loadBindings(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage?.getItem('tos.controls') || 'null');
    return normalizeBindings(saved?.version === BINDINGS_VERSION ? saved.bindings : null);
  } catch { return normalizeBindings(); }
}
export function saveBindings(bindings, storage = globalThis.localStorage) {
  const normalized = normalizeBindings(bindings);
  try { storage?.setItem('tos.controls', JSON.stringify({ version: BINDINGS_VERSION, bindings: normalized })); } catch { /* best effort */ }
  return normalized;
}

export class Controls {
  constructor(bindings = loadBindings()) { this.bindings = normalizeBindings(bindings); this.downCodes = new Set(); }
  set(code, down) { if (down) this.downCodes.add(code); else this.downCodes.delete(code); }
  clear() { this.downCodes.clear(); }
  matches(action, code) { return (this.bindings[action] || []).includes(code); }
  down(action) { return (this.bindings[action] || []).some(code => this.downCodes.has(code)); }
  rebind(action, code) {
    if (!(action in DEFAULT_BINDINGS) || !validBindingCode(code)) return { ok: false, conflicts: [] };
    const conflicts = bindingConflicts(this.bindings, action, code);
    if (conflicts.length) return { ok: false, conflicts };
    this.bindings[action] = [code]; saveBindings(this.bindings); return { ok: true, conflicts: [] };
  }
  release(action) { for (const code of this.bindings[action] || []) this.downCodes.delete(code); }
  reset() { this.bindings = saveBindings(DEFAULT_BINDINGS); return this.bindings; }
}
