// bot-combat.js — sensory targeting and combat-engineering helpers.
// These routines operate on a Bot-like context and deliberately do not import
// Bot, keeping combat policy reusable without creating a module cycle.
import { botTargetScore } from './bot-rules.js';

// The flag thief gets no psychic outline: he is seen by the same eyes as
// everyone else — in front of you, or close enough to hear.
export function acquireTarget(bot, profile, { THREE }) {
  const to = new THREE.Vector3();
  let best = null, bestScore = Infinity;
  for (const f of bot.game.foesOf(bot.team)) {
    if (!f.alive) continue;
    const d = bot.body.pos.distanceTo(f.body.pos);
    if (d >= profile.vision) continue;
    if (f !== bot.target) { // a target already being tracked stays tracked
      to.subVectors(f.body.pos, bot.body.pos).setY(0).normalize();
      if (d > 7 && bot.face.dot(to) < 0.26) continue; // outside the ~150° cone
    }
    // Distance is the baseline, but a flag carrier or someone already hurt
    // is worth reaching past a merely-nearer foe for — press an advantage
    // instead of restarting the fight on whoever's a step closer.
    const score = botTargetScore(d, f.health, f.carrier, f === bot.target);
    if (score >= bestScore) continue;
    if (bot.game.losClear(bot.body.eye(), f.body.eye())) { best = f; bestScore = score; }
  }
  return best;
}

// Shovel a single voxel (debris, edit log, network sync all handled inside).
export function digVoxel(bot, x, y, z) {
  if (bot.game.world.solid(x, y, z)) bot.game.digVoxel(bot, x, y, z);
}

// Knee-high cover already standing between us and the foe?
export function hasCover(bot, toFoe) {
  const w = bot.game.world, b = bot.body, fy = Math.floor(b.pos.y);
  for (const reach of [1.2, 2.2, 3.2]) {
    const px = Math.floor(b.pos.x + toFoe.x * reach);
    const pz = Math.floor(b.pos.z + toFoe.z * reach);
    if (w.solid(px, fy, pz)) return true;
  }
  return false;
}

// A three-wide knee wall two paces toward the threat: tall enough to hide a
// crouch, low enough to shoot over standing. Follows the ground one step
// down so walls on a downhill slope don't float.
export function buildCover(bot, toFoe, { THREE }) {
  const b = bot.body, fy = Math.floor(b.pos.y), w = bot.game.world;
  const perp = new THREE.Vector3(-toFoe.z, 0, toFoe.x);
  const placed = [];
  for (const off of [-1, 0, 1]) {
    const cx = Math.floor(b.pos.x + toFoe.x * 2.2 + perp.x * off);
    const cz = Math.floor(b.pos.z + toFoe.z * 2.2 + perp.z * off);
    const gy = w.solid(cx, fy - 1, cz) ? fy : w.solid(cx, fy - 2, cz) ? fy - 1 : null;
    if (gy !== null && bot.game.tryBuild(bot, cx, gy, cz)) placed.push([cx, cz]);
  }
  if (placed.length) {
    bot.buildT = 9; bot.coverT = 6;
    const now = bot.game.time;
    bot._cover = bot._cover.filter(c => now - c.t < 8)
      .concat(placed.map(([x, z]) => ({ x, z, t: now })));
  }
}
