export const RECONNECT_GRACE_MS = 20_000;

export const validResumeToken = value =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{22,48}$/.test(value);

export function reservationMatches(reservation, token, now = performance.now()) {
  return !!reservation && validResumeToken(token) && reservation.token === token
    && Number.isFinite(reservation.expiresAt) && now <= reservation.expiresAt;
}

export function createResumeToken(cryptoApi = globalThis.crypto) {
  const bytes = new Uint8Array(18);
  cryptoApi?.getRandomValues?.(bytes);
  if (!bytes.some(Boolean)) {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  if (typeof btoa === 'function') return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 36);
}
