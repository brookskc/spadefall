// network-sync.js — pure ordering, drift, and impairment rules.
// Kept free of DOM/WebRTC/Three.js so the network contract can be exercised
// deterministically in the headless suite.

export const WORLD_HASH_SEED = 0x811c9dc5;

const fnvByte = (hash, byte) => Math.imul((hash ^ byte) >>> 0, 0x01000193) >>> 0;

// A stable rolling digest of the authoritative edit log. Structured-clone
// preserves these finite number arrays exactly, so their JSON form is the
// same on host and guests. This is not a security primitive; it is a cheap
// desync alarm that rides snapshots as one 32-bit integer.
export function advanceWorldHash(hash, entry) {
  let out = Number.isInteger(hash) ? hash >>> 0 : WORLD_HASH_SEED;
  const text = JSON.stringify(entry);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out = fnvByte(out, code & 255);
    out = fnvByte(out, code >>> 8);
  }
  return out >>> 0;
}

export function worldLogHash(log) {
  let hash = WORLD_HASH_SEED;
  for (const entry of log ?? []) hash = advanceWorldHash(hash, entry);
  return hash >>> 0;
}

// Decide whether an ordered state packet is safe to merge. A delta after a
// gap cannot be applied because omitted rows mean "unchanged from the packet
// you missed". A full checkpoint is self-contained and repairs any gap.
export function snapshotDisposition(last, seq, full = false) {
  if (!Number.isSafeInteger(seq) || seq < 1) return { accept: false, reason: 'invalid' };
  if (last == null) return full
    ? { accept: true, reason: 'initial-full' }
    : { accept: false, reason: 'initial-delta', resync: true };
  if (seq <= last) return { accept: false, reason: 'stale' };
  if (seq !== last + 1 && !full) return { accept: false, reason: 'gap', resync: true };
  return { accept: true, reason: full ? 'repair-full' : 'next' };
}

// World events are an ordered append-only stream. `count` is larger than one
// for a structural collapse because one packet appends several voxel edits.
export function worldEventDisposition(localRevision, remoteRevision, count = 1) {
  if (!Number.isSafeInteger(localRevision) || localRevision < 0
      || !Number.isSafeInteger(remoteRevision) || remoteRevision < 0
      || !Number.isSafeInteger(count) || count < 1)
    return { accept: false, reason: 'invalid' };
  if (remoteRevision <= localRevision) return { accept: false, reason: 'stale' };
  if (remoteRevision !== localRevision + count)
    return { accept: false, reason: 'gap', resync: true };
  return { accept: true, reason: 'next' };
}

// Seeded packet impairment for regression/soak harnesses. It deliberately
// models at the application layer: payloads are not cloned or mutated, and
// every run with the same options produces the same delivery schedule.
export function impairPackets(packets, {
  seed = 1, dropRate = 0, duplicateRate = 0, reorderWindow = 1,
} = {}) {
  let state = (seed >>> 0) || 1;
  const rnd = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  dropRate = Math.min(1, Math.max(0, Number(dropRate) || 0));
  duplicateRate = Math.min(1, Math.max(0, Number(duplicateRate) || 0));
  reorderWindow = Math.max(1, Math.floor(Number(reorderWindow) || 1));
  const staged = [];
  for (const packet of packets ?? []) {
    if (rnd() < dropRate) continue;
    staged.push(packet);
    if (rnd() < duplicateRate) staged.push(packet);
  }
  if (reorderWindow <= 1) return staged;
  const out = [];
  for (let start = 0; start < staged.length; start += reorderWindow) {
    const chunk = staged.slice(start, start + reorderWindow);
    for (let i = chunk.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [chunk[i], chunk[j]] = [chunk[j], chunk[i]];
    }
    out.push(...chunk);
  }
  return out;
}
