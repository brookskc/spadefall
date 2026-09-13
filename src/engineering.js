// engineering.js — authoritative, bounded terrain-consequence policy.
//
// An edit is not an engineering contribution by itself. The host supplies a
// concrete consequence (a route became passable, a teammate's sightline was
// blocked, or a teammate used a fresh route); this module only applies the
// shared dedupe/cooldown policy so callers cannot accidentally turn volume
// into score.

export const ENGINEERING_KINDS = Object.freeze([
  'breach', 'cover', 'sightline', 'collapse', 'route',
]);
export const ENGINEERING_COOLDOWN = 15;
export const ENGINEERING_CAP_PER_KIND = 8;

export function engineeringDisposition({ kind, consequence = false, now = 0,
  lastAt = -Infinity, count = 0, site = '', usedSites = new Set() } = {}) {
  if (!ENGINEERING_KINDS.includes(kind) || !consequence || !Number.isFinite(now))
    return { credit: false, reason: 'not-consequential' };
  if (now - lastAt < ENGINEERING_COOLDOWN)
    return { credit: false, reason: 'cooldown' };
  if (!Number.isFinite(count) || count >= ENGINEERING_CAP_PER_KIND)
    return { credit: false, reason: 'cap' };
  if (site && usedSites?.has?.(site)) return { credit: false, reason: 'duplicate' };
  return { credit: true, reason: 'credited' };
}

export class EngineeringLedger {
  constructor() { this.reset(); }

  reset() {
    this.last = new Map();
    this.count = new Map();
    this.sites = new Set();
  }

  tryCredit(actor, kind, now, site = '', consequence = true) {
    if (actor == null) return null;
    const key = String(actor);
    const lastAt = this.last.get(`${key}:${kind}`) ?? -Infinity;
    const count = this.count.get(`${key}:${kind}`) ?? 0;
    const decision = engineeringDisposition({ kind, consequence, now, lastAt, count,
      site: site ? `${key}:${kind}:${site}` : '', usedSites: this.sites });
    if (!decision.credit) return null;
    this.last.set(`${key}:${kind}`, now);
    this.count.set(`${key}:${kind}`, count + 1);
    if (site) this.sites.add(`${key}:${kind}:${site}`);
    return { actor, kind, at: now, site };
  }
}
