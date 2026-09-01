// Callsigns cross the multiplayer trust boundary, so every peer uses the
// same compact normalization and the host applies it again on arrival.
const MAX_CALLSIGN = 12;

const WORDS = new Set([
  'asshole', 'bastard', 'bitch', 'cunt', 'dick', 'fag', 'faggot', 'fuck',
  'motherfucker', 'nigga', 'nigger', 'piss', 'pussy', 'retard', 'shit', 'slut',
  'whore',
]);

// These are specific enough to catch decorated/compounded slurs without
// rejecting innocent names such as "Scunthorpe" or "Dickens".
const SEVERE_FRAGMENTS = ['faggot', 'motherfucker', 'nigger'];
const COMPOUND_EDGES = ['fuck', 'shit', 'cunt', 'nigga', 'nigger', 'faggot'];
const LEET = Object.freeze({ '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b' });

export function normalizeCallsign(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 _-]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_CALLSIGN);
}

export function callsignHasProfanity(value) {
  const normalized = normalizeCallsign(value).toLowerCase()
    .replace(/[0134578]/g, char => LEET[char] ?? char);
  const words = normalized.split(/[\s_-]+/).filter(Boolean);
  if (words.some(word => WORDS.has(word))) return true;
  const compact = normalized.replace(/[^a-z]/g, '');
  return WORDS.has(compact) || SEVERE_FRAGMENTS.some(fragment => compact.includes(fragment))
    || COMPOUND_EDGES.some(fragment => compact.startsWith(fragment) || compact.endsWith(fragment));
}

export function callsignIssue(value) {
  const name = normalizeCallsign(value);
  if (!name) return 'empty';
  return callsignHasProfanity(name) ? 'profanity' : null;
}

export function sanitizeCallsign(value, fallback = 'Player') {
  const name = normalizeCallsign(value);
  return name && !callsignHasProfanity(name) ? name : normalizeCallsign(fallback) || 'Player';
}
