// bots.js — AI soldiers: they hunt intel (gunfire, sightings, kills), patrol
// when the trail is cold, advance in lanes, group up past midfield, crouch-fire
// at range, lob frags over cover, undermine towers, and dig through walls.
import * as THREE from 'three';
import { Body, CROUCH_HEIGHT, EYE_INSET, STAND_HEIGHT,
  makeSoldier, makeNametag, animateSoldier, animateDeath, resetDeath,
  setCrouch, setSoldierTool, placeShadow } from './entities.js';
import { SEA, SX, SZ, BLOCK } from './world.js';
import { TOOLS, GUN_CLASSES } from './player.js';
import { sfx } from './audio.js';
import { nextReloadCue } from './reload-timeline.js';
import { teamHex } from './settings.js';
import { resetEnvironmentalState } from './environment.js';
import { botDifficulty, botSeparation, botTerrainEditAllowed, rememberedEnemyPosition,
  smgClosingIntent, BOT_EDIT_REFILL_SECONDS, BOT_LIFE_EDIT_BUDGET } from './bot-rules.js';
import { clampToEnvelope, mapEnvelope } from './mapgen.js';
import { authoredRouteGoal, goal as botGoal, hasOverhead,
  planLocalRoute } from './bot-navigation.js';
import { acquireTarget, buildCover, digVoxel, hasCover } from './bot-combat.js';

const NAMES = {
  blue:  ['Vex', 'Havoc', 'Irons', 'Dagger', 'Rook', 'Frost'],
  green: ['Sarge', 'Pine', 'Moss', 'Flint', 'Clover', 'Briar'],
};
// Bots now fire the same rifle/smg/sniper a player would (see gunClass
// below), not their own separately-tuned weapon — a deliberate rebalance,
// not an oversight: the custom weapon this used to be existed specifically
// to give bots a fair fight against a player's real guns, and that tuning
// is gone now that they carry one of those same three guns instead.
const randomClass = () => GUN_CLASSES[Math.floor(Math.random() * GUN_CLASSES.length)];

// How a bot fights, keyed by which of the three guns it's carrying this
// life. Rifle is the existing baseline (every number here is what the
// engagement logic already used, unparameterized) — sniper and smg pull
// away from it toward "long-range specialist" and "close-quarters
// aggressor" rather than every bot fighting identically regardless of
// what's in its hands.
//   hold: foeD above which a bot holds position and crouch-fires, instead
//     of closing. 999 effectively disables holding — smg never plants its
//     feet at range, it closes or strafes.
//   strafe: foeD below which a bot weaves side to side in a firefight
//     instead of standing and trading. Low for sniper (only as an
//     absolute last resort with someone already on top of it), high for
//     smg (readily fights, and moves, at closer range than rifle would).
//   retreatHealth: health that triggers falling back toward home.
//   closeRetreat: sniper-only — falls back if a target closes inside this
//     range regardless of health, since CQB is bad for it no matter how
//     healthy it is. null for rifle/smg: they don't disengage on range.
//   speedMul: in-combat movement speed multiplier (patrol/advance speed is
//     unaffected — this is specifically "how fast do I move once I'm in a
//     fight," not a general athleticism stat).
//   groupRange: how close a teammate has to be, past midfield with no
//     target, to NOT go cautious (see the "Group up" comment below). Small
//     for sniper (rarely satisfied — won't push forward alone), large for
//     smg (almost always satisfied — rushes ahead of the pack readily).
const CLASS_PROFILE = {
  0: { hold: 18, strafe: 14, retreatHealth: 35, closeRetreat: null, speedMul: 1.0, groupRange: 18, vision: 60 },
  1: { hold: 999, strafe: 24, retreatHealth: 20, closeRetreat: null, speedMul: 1.18, groupRange: 40, vision: 64, fireRange: 32 },
  5: { hold: 30, strafe: 8, retreatHealth: 45, closeRetreat: 14, speedMul: 0.92, groupRange: 8, vision: 90 },
};

// Difficulty affects perception and decision quality only. Damage, health,
// movement, weapon stats and line-of-sight rules remain identical.
const QUERY = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
const BOTQ = botDifficulty(QUERY.get('botq'));
const NAV_CONTEXT = Object.freeze({ THREE, SEA, SX, SZ, BLOCK, mapEnvelope, clampToEnvelope });
const COMBAT_CONTEXT = Object.freeze({ THREE });

let n = 0;        // name rotation
let nextId = 0;   // stable identity for network snapshots

// Host migration restores bots under their OLD ids (clients key avatars by
// them); make sure a future spawn never reissues one.
export function reserveBotId(idx) { if (idx >= nextId) nextId = idx + 1; }

export class Bot {
  constructor(game, team, name = null, difficultyKey = null) {
    this.game = game;
    this.team = team;
    this.id = nextId++;
    // Host migration restores fallen bots by name so their tags survive.
    this.name = name ?? NAMES[team][n++ % NAMES[team].length];
    const p = game.spawnPoint(team);
    this.body = new Body(game.world, p.x, p.y, p.z);
    this.parts = makeSoldier(teamHex(team));
    // Callsigns for your own side only — an enemy tag rides above the helmet
    // and gives away a man who is otherwise fully behind cover.
    if (team === game.player?.team) this.parts.group.add(makeNametag(this.name, team));
    game.scene.add(this.parts.group);
    this.health = 100;
    this.alive = true;
    this._spawnedAt = game.time;
    resetEnvironmentalState(this);
    this.carrier = false;
    this.heading = team === 'blue' ? -1 : 1; // general advance direction
    this.state = 'advance';
    this.target = null;        // enemy entity currently engaged
    this.aimT = 0;             // reaction timer after acquiring target
    this.cooldown = Math.random();
    this.gunClass = randomClass(); // one of rifle/smg/sniper, rerolled each life
    setSoldierTool(this.parts, this.gunClass);
    this.ammo = TOOLS[this.gunClass].mag;
    this.reloading = 0;
    this.reloadStage = 0;
    this.stuck = 0;            // consecutive motionless samples
    this.sampleT = 0.4;        // displacement sampling timer
    this.lastPos = this.body.pos.clone();
    this.wander = new THREE.Vector3();
    this.wanderT = 0;
    this.exit = null;          // committed dry-land column while swimming
    this.wetT = 0;             // grace timer: recently-in-water → keep seeking dry
    this.digT = 0;             // tunneling swing cooldown
    this.lastDig = -9;         // last shovel swing, game time
    this._editBudget = BOT_LIFE_EDIT_BUDGET;
    this._editTokens = this._editBudget;
    this._terrainEdits = 0;
    this.blocks = 16;          // combat engineering inventory (cover + bridges)
    this._cover = [];          // recently self-built columns: {x,z,t} — don't shovel our own wall
    this.buildT = 0;           // cooldown between throwing up cover
    this.coverT = 0;           // hold-and-fight timer behind fresh cover
    this.duckT = 0;            // duck rhythm: reloads and burst pauses
    this.bridgeT = 0;          // plank-laying cooldown
    this.lastBridge = -9;      // last plank placed, game time
    this.face = new THREE.Vector3(this.heading, 0, 0); // where the head points
    this.memoryT = 0;          // confidence clock for the last visible position
    this.memoryPos = new THREE.Vector3();
    this.memorySeenAt = -Infinity;
    this.targetVisible = false;
    this.responding = false;   // rushing to recover our dropped flag?
    this.deadT = -1;           // corpse tumble timer, while dead
    this.difficulty = difficultyKey == null ? BOTQ : botDifficulty(difficultyKey);
    this.skill = 0.9 + Math.random() * 0.2; // mild individual variation only
    this._reactJitter = 0.8 + Math.random() * 0.5; // re-rolled per engagement (see update()); initialized here too so reactT is never NaN before the first target acquisition
    this.nextThink = game.time + (this.id % 5) * this.difficulty.thinkInterval / 5;
    this.cachedGoal = null;
    this.navRevision = game.navRevision ?? 0;
    this.tacticalRole = 'attack';
    this.ctfStageAt = -Infinity; // final-approach support wait; see bot-rules
    this.orderId = null;
    this.telemetry = { thinkMs: 0, thinkSamples: 0, stuckRecoveries: 0,
      objectiveSeconds: 0, decisions: 0 };
    this.lane = ((this.id % 3) - 1) * 18; // advance on a front, not a file
    this.role = 'attack';      // ctf only: defend | mid | attack (recomputed)
    this.patrol = null;        // current roam waypoint when there's no intel
    this.patrolT = 0;
    this.retreatT = 0;         // backing off to lick wounds
    this.retreatCd = 0;
    this.route = new THREE.Vector3(); // short committed detour around an obstacle
    this._routeGoal = new THREE.Vector3(); // authored waypoint scratch; not retained
    this._separation = { x: 0, z: 0 };
    this.routeT = 0;
    this.nades = 1;            // one frag per life
    this.nadeT = 0;
    this.crouched = false;     // mirrors the duck posture for fireHitscan
  }

  // Navigation and combat helpers live in their own modules. Keeping these
  // calls at the orchestration boundary makes update()'s sequencing explicit.
  goal() { return botGoal(this, NAV_CONTEXT); }

  update(dt) {
    if (!this.alive) { // corpse: tumble where it fell, then vanish
      if (this.deadT >= 0 && this.deadT <= 1.4) {
        this.deadT += dt;
        animateDeath(this.parts, this.deadT);
      }
      return;
    }
    const g = this.game, b = this.body;
    const editRefill = b.inWater ? 1 : 1 / BOT_EDIT_REFILL_SECONDS;
    this._editTokens = Math.min(this._editBudget, this._editTokens + dt * editRefill);
    const profile = CLASS_PROFILE[this.gunClass];
    const onObjective = g.hill
      ? b.pos.distanceToSquared(g.hill.pos) <= (g.hill.r + 2) ** 2
      : g.flags && (this.carrier || ['defend', 'recover', 'escort'].includes(this.tacticalRole));
    if (onObjective) this.telemetry.objectiveSeconds += dt;

    // Expensive perception, role goals, and route decisions run on a staggered
    // host budget. Physics, weapon timers, and animation still update every
    // frame, so the budget cannot make movement choppy.
    const thinks = !g._botThinkSet || g._botThinkSet.has(this.id);
    if (thinks) {
      const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const seen = acquireTarget(this, profile, COMBAT_CONTEXT);
      if (seen !== this.target || (seen && !this.targetVisible)) {
        this.aimT = 0;    // fresh eyes: reaction time
        this._reactJitter = 0.8 + Math.random() * 0.5;
      }
      if (seen) {
        // New eyes on an enemy: report it. Teammates investigate this sighting,
        // but a bot that loses LOS retains only this frozen position.
        if (seen !== this.target) g.pingIntel(seen.body.pos, seen.team, 'sight');
        this.target = seen;
        this.targetVisible = true;
        this.memoryPos.copy(seen.body.pos);
        this.memorySeenAt = g.time;
        this.memoryT = this.difficulty.memory * this.skill;
      } else this.targetVisible = false;
      this.cachedGoal = botGoal(this, NAV_CONTEXT).clone();
      const cadenceJitter = 0.9 + (this.id % 3) * 0.1;
      this.nextThink = g.time + this.difficulty.thinkInterval * cadenceJitter;
      const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started;
      this.telemetry.thinkMs += elapsed;
      this.telemetry.thinkSamples++;
      this.telemetry.decisions++;
      this.telemetry.lastThinkMs = elapsed;
    }
    if (this.target && !this.target.alive) { this.target = null; this.targetVisible = false; }
    if (!this.targetVisible && this.target && (this.memoryT -= dt) <= 0) this.target = null;
    if (this.target) this.aimT += dt;
    // Base raised from 0.35 -> 0.55: 0.35s (300-410ms at normal skill) is
    // at the very fast edge of human visual reaction time even before
    // accounting for actually aiming, not just noticing — landing closer
    // to "sees you and is already on target" than "reacts like a person."
    // Combined with the per-engagement jitter above, normal difficulty
    // now spans roughly 0.38-0.84s bot to bot and encounter to encounter,
    // instead of a near-fixed ~0.3-0.4s every single time.
    const reactT = 0.55 * this._reactJitter * this.difficulty.reaction / this.skill;

    const recalled = this.target && !this.targetVisible
      ? rememberedEnemyPosition({ x: this.memoryPos.x, y: this.memoryPos.y,
          z: this.memoryPos.z, t: this.memorySeenAt }, g.time,
        this.difficulty.memory * this.skill, this.id)
      : null;
    const targetPoint = this.target
      ? (this.targetVisible ? this.target.body.pos : recalled) : null;
    const targetEye = targetPoint && this.target
      ? new THREE.Vector3(targetPoint.x,
        targetPoint.y + this.target.body.half.h - EYE_INSET, targetPoint.z) : null;

    // --- movement ---
    const goal = authoredRouteGoal(this, this.cachedGoal ?? this.goal(),
      NAV_CONTEXT, this._routeGoal);
    this.wanderT -= dt;
    this.patrolT -= dt; // patrol waypoints go stale even if never reached
    if (this.wanderT <= 0) {
      this.wanderT = 1.5 + Math.random() * 2;
      this.wander.set((Math.random() - .5) * 8, 0, (Math.random() - .5) * 8);
    }
    // Responders beeline; so do bridgelayers — a wander wobble over an open
    // ravine walks the bot off the side of its own deck. Swimmers mostly
    // beeline too — a full-strength wander vector in the water just yanks a
    // climbing bot off its staircase and back into the channel (the old
    // creek-bobbing loop).
    // Rim check ahead in the goal direction: a wander wobble near a
    // drop-off staggers the bot down the face or off the side of its own
    // deck, so near a bridgeable rim the beeline wins. Deep scan — a tall
    // deck over a gorge must read the true bottom, not four blocks down.
    let rimAhead = false;
    if (b.onGround && !b.inWater && this.blocks > 0) {
      const rx = goal.x - b.pos.x, rz = goal.z - b.pos.z;
      const rl = Math.hypot(rx, rz);
      if (rl > 2) {
        const gx = Math.floor(b.pos.x + rx / rl * 1.4);
        const gz = Math.floor(b.pos.z + rz / rl * 1.4);
        const fy = Math.floor(b.pos.y);
        let drop = 0;
        for (let y = fy - 1; y >= fy - 16 && !g.world.solid(gx, y, gz); y--) drop++;
        rimAhead = drop >= 3 && goal.y > fy - drop;
      }
    }
    const bridging = g.time - this.lastBridge < 0.9;
    // Responders, bridgelayers, and rim-climbers beeline on purpose (see the
    // comment above) — the new obstacle-routing below leaves them alone and
    // lets them walk (or dig) straight at their target, same as always.
    const beeline = this.responding || this.carrier
      || bridging || rimAhead;
    const dest = beeline ? goal.clone() : goal.clone().add(
      b.inWater ? this.wander.clone().multiplyScalar(0.25) : this.wander);

    // Dry-land seeking: swimming or wading the shelf, steer for the nearest
    // dry column — cheap exit first, goal-ward as the tiebreak. A creek that
    // runs roughly parallel to the goal direction otherwise becomes an
    // 80-block swim along the channel (the Pinefall bob). Dry means solid at
    // SEA+1: probing surface() would read tree canopies over the channel as
    // dry land and march the bot straight back in.
    // Engage on recency, not altitude: a tunneler working LOW dry ground
    // (below SEA+1) must not have its dest hijacked toward a "dry column" —
    // only bots that have actually been swimming get the exit scan. The 2s
    // grace carries the commitment through the wading half-steps where the
    // bot bounces in and out of the inWater flag on the shelf.
    this.wetT = b.inWater ? 2 : Math.max(0, this.wetT - dt);
    if (this.wetT > 0) {
      // Commit to the chosen exit column until standing on dry land:
      // re-picking every frame just hops the dest a few blocks goal-ward
      // along the bank, and the bot outswims its own shovel without ever
      // clearing a ledge (the Pinefall bob).
      let exit = this.exit;
      // Validity degrades gracefully: the dig-climb clears the exit column's
      // SEA+1 ledge block as its FIRST swing, so re-testing only SEA+1 would
      // invalidate the commitment mid-climb and restart the scan every swing.
      // Solid at SEA still means "one hop from dry" — keep climbing.
      if (!exit || (!g.world.solid(exit[0], SEA, exit[1]) && !g.world.solid(exit[0], SEA + 1, exit[1]))) {
        let best = null, bestCost = Infinity;
        for (const ring of [5, 9, 13]) {
          for (let a = 0; a < 12; a++) {
            const ang = a / 12 * Math.PI * 2;
            const px = Math.floor(b.pos.x + Math.cos(ang) * ring);
            const pz = Math.floor(b.pos.z + Math.sin(ang) * ring);
            if (!g.world.solid(px, SEA + 1, pz)) continue; // still the channel
            const cost = ring + Math.hypot(px + 0.5 - goal.x, pz + 0.5 - goal.z) * 0.1;
            if (cost < bestCost) { bestCost = cost; best = [px, pz]; }
          }
          if (best) break; // a dry column on the nearest ring wins
        }
        exit = this.exit = best;
      }
      if (exit) dest.set(exit[0] + 0.5, g.world.surface(exit[0], exit[1]), exit[1] + 0.5);
    } else this.exit = null;
    const dir = new THREE.Vector3(dest.x - b.pos.x, 0, dest.z - b.pos.z);
    const dist = dir.length();
    if (dist > 1.2) dir.normalize();

    // Combat movement when engaged: strafe up close, hold and crouch-fire
    // at range — but never in water, where the sideways mix orbits the bot
    // off its committed exit wall.
    let toFoe = null, foeD = Infinity, undermining = false;
    if (this.target && targetPoint && !b.inWater) {
      foeD = b.pos.distanceTo(targetPoint);
      // Undermine: a foe we merely REMEMBER (memoryT keeps the trail) is up
      // a tower we can't see through — walk to the column and let the shovel
      // and gravity argue with his footing. No aim required: the head never
      // settles on a target it can't see, so gating on aimT would forbid this.
      if (!this.carrier && !g.losClear(b.eye(), targetEye) &&
          targetPoint.y > b.pos.y + 3 && foeD < 14) {
        undermining = true;
        dir.subVectors(targetPoint, b.pos).setY(0).normalize();
      } else if (this.aimT > 0.3) {
        toFoe = new THREE.Vector3().subVectors(targetPoint, b.pos).setY(0).normalize();
        // A flag carrier's movement vector belongs to the run home. They can
        // return fire, but must not orbit an incidental target and carry the
        // objective sideways away from the stand.
        if (!this.carrier && foeD < profile.strafe) {
          const side = new THREE.Vector3(-toFoe.z, 0, toFoe.x).multiplyScalar(Math.sin(g.time * 1.7 + this.name.length) > 0 ? 1 : -1);
          dir.multiplyScalar(0.4).add(side.multiplyScalar(0.6)).normalize();
        }
        if (!this.carrier && smgClosingIntent(this.gunClass, foeD, this.targetVisible))
          dir.lerp(toFoe, 0.82).normalize();
      }
    }

    // Wounded and engaged: fall back toward home for a beat (still shooting),
    // throwing a wall up behind us if there's cover to make. Then re-engage.
    // Sniper adds a second trigger: closing inside closeRetreat disengages
    // regardless of health, since CQB is bad for it no matter how healthy
    // it is — rifle/smg leave closeRetreat null, so only health matters
    // for them, unchanged from before.
    // Objective commitment: a bot actively holding ground that matters — on
    // or near the hill in KOTH, defending near the flag stand in CTF —
    // tolerates more punishment before falling back. Abandoning the actual
    // point over a routine wound undermines the job ("hold the hill,"
    // "defend the flag") worse than the wound itself does. Halved rather
    // than removed: still some self-preservation, since a dead bot holds
    // nothing either.
    let retreatHealth = profile.retreatHealth;
    if (g.hill && b.pos.distanceTo(g.hill.pos) < g.hill.r + 4) retreatHealth *= 0.5;
    else if (this.role === 'defend' && g.flags && b.pos.distanceTo(g.standOf(this.team)) < 14) retreatHealth *= 0.6;
    this.retreatT -= dt; this.retreatCd -= dt;
    if (this.target && this.retreatCd <= 0 && toFoe &&
        (this.health < retreatHealth ||
         (profile.closeRetreat != null && foeD < profile.closeRetreat))) {
      this.retreatT = 2.5; this.retreatCd = 9;
    }
    if (this.retreatT > 0 && toFoe) {
      // A flag carrier keeps heading home even while retreating — the
      // generic "flee straight away from whoever's shooting" vector below
      // has no idea which direction that actually is, and could easily
      // point away from home as readily as toward it. Aggressively
      // getting the flag home means staying on that line even wounded,
      // not abandoning it to flee blind. Carriers also skip the generic
      // stop-and-build behavior: the objective must keep moving.
      if (!this.carrier) dir.set(-toFoe.x - this.heading * 0.5, 0, -toFoe.z).normalize();
      if (!this.carrier && b.onGround && this.blocks >= 3
          && this.buildT <= 0 && !hasCover(this, toFoe))
        buildCover(this, toFoe, COMBAT_CONTEXT);
    }

    // --- combat engineering: caught in the open at range, throw up a
    // knee-high wall toward the threat, then fight from behind it. Skipped
    // for smg: an aggressor that stops mid-push to build a wall isn't
    // aggressive, and turtling up contradicts the whole point of carrying
    // a close-range gun in the first place.
    this.buildT -= dt; this.coverT -= dt; this.duckT -= dt;
    if (this.gunClass !== 1 && this.target && !this.carrier && !this.responding && toFoe &&
        b.onGround && !b.inWater && this.blocks >= 3 && this.buildT <= 0 &&
        this.coverT <= 0) {
      if (foeD > 8 && foeD < 42 && !hasCover(this, toFoe)) buildCover(this, toFoe, COMBAT_CONTEXT);
    }
    // A defender with quiet hands fortifies: wall off the enemy approach to
    // the flag stand, one knee wall at a time.
    else if (this.role === 'defend' && !this.target && this.blocks >= 6 &&
        this.buildT <= 0 && b.onGround && !b.inWater) {
      if (b.pos.distanceTo(g.standOf(this.team)) < 12) {
        buildCover(this, new THREE.Vector3(this.heading, 0, 0), COMBAT_CONTEXT);
        this.coverT = 0; // fortifying, not fighting — keep patrolling
      }
    }
    // Behind fresh cover: hold the line instead of advancing — unless there's
    // team-colored masonry overhead, which the collapse system can drop on us.
    // A retreating bot never holds: the wall it just threw up is for falling
    // back BEHIND, not for standing next to.
    const coverHold = !this.carrier && this.coverT > 0 && this.target
      && this.retreatT <= 0 && !hasOverhead(this, NAV_CONTEXT);
    if (coverHold) dir.multiplyScalar(0.15);
    // Holding a ranged firing line: plant the feet while crouch-firing.
    const holdingLine = this.target && !this.carrier && foeD > profile.hold
        && this.aimT > reactT && this.coverT <= 0 &&
        !undermining && b.onGround && !b.inWater;
    if (holdingLine) dir.multiplyScalar(0.15);
    // Deliberately near-motionless, either from cover or a held line — the
    // stuck-sampler below must not read discipline as being wedged.
    const holding = coverHold || holdingLine;

    // --- terrain negotiation: tunnel level, stair-step uphill, hop steps ---
    // The passage ahead is two voxels high at foot level; whatever of it is
    // solid gets shovelled, one swing every 0.32s, feet planted or swimming
    // (airborne swings gouge random heights). A full wall with the goal
    // uphill becomes a staircase: clear the ledge, the headroom above it,
    // and any block hanging over the bot's own head — then hop on and
    // repeat. That climbs out of pits AND the Pinefall ravine: the old code
    // demanded dry feet and open sky, so a bot treading creek water under a
    // sheer bank could only bob there forever.
    this.digT -= dt;
    const w = g.world, fy = Math.floor(b.pos.y);
    // Route around a short obstacle before ever reaching for the shovel: try
    // a couple of headings off the direct line, and steer that way if one's
    // clear. There is no pathfinding in this file — a straight line is the
    // only route a bot ever considers — so without this, ANY solid terrain
    // between a bot and its goal (a hillside, a stand of trees, a single
    // wall) got dug through rather than walked around, on every map, as the
    // routine way bots made progress rather than a rare fallback. The
    // deliberate beeline cases (responding, bridging, mid rim-climb) and the
    // deliberate dig cases (a committed water exit, undermining a tower)
    // keep going straight at their target on purpose — this only touches the
    // ordinary "walking somewhere and a wall is in the way" case.
    this.routeT = Math.max(0, this.routeT - dt);
    const routeEligible = !beeline && !this.target && !b.inWater && this.wetT <= 0
      && !undermining && dir.lengthSq() > 0.01;
    const navChanged = this.navRevision !== (g.navRevision ?? 0);
    if (navChanged) {
      this.navRevision = g.navRevision ?? 0;
      this.routeT = 0; // a new crater, wall, or tunnel invalidates cached space
    }
    if (routeEligible && this.routeT > 0) dir.copy(this.route);
    if (routeEligible && (thinks || navChanged || this.routeT <= 0)) {
      const planned = planLocalRoute(this, dir, fy, NAV_CONTEXT);
      if (planned) {
        dir.copy(planned);
        this.route.copy(planned);
        this.routeT = 0.8;
      } else this.route.set(0, 0, 0);
    }
    // Probe the contact column first, then a step beyond: a bot pressed
    // against the face is closer than shovel reach, and both columns block.
    let tx = 0, tz = 0, lo = false, hi = false;
    for (const reach of [0.9, 1.5]) {
      const px = Math.floor(b.pos.x + dir.x * reach);
      const pz = Math.floor(b.pos.z + dir.z * reach);
      lo = w.solid(px, fy, pz); hi = w.solid(px, fy + 1, pz);
      if (lo || hi) { tx = px; tz = pz; break; }
      lo = hi = false;
    }
    // Never shovel down the wall we ourselves threw up moments ago —
    // without this a bot repositioning through its own fresh cover reads it
    // as just another obstacle and digs it back out, burning the block
    // budget it spent seconds earlier for nothing.
    const ownCover = this._cover.some(c => c.x === tx && c.z === tz && g.time - c.t < 8);
    // Combat suppresses digging on land (fight first), but a swimmer pressed
    // against a bank climbs even mid-fight: bobbing in the creek is a worse
    // look than pausing fire to shovel.
    // Swimmers dig regardless of distance-to-dest: the committed exit column
    // IS a wall, so the bot idles within dist<=2 of it forever otherwise.
    // Gate on lo || hi: under a tree canopy the only obstruction can be a
    // foot-level leaf block while fy+1 is open air between the leaves.
    // A bot wedged against terrain digs even mid-fight (stuck >= 1): trading
    // fire while pressed into a bank it could shovel through is the worse
    // look — combat only pauses digging on open ground.
    // Undermining counts as wedged-in work: shoveling out a tower's legs is
    // worth pausing fire for, same as climbing a bank.
    // activelyFiring is the hard stop: a bot that's actually landing shots
    // never breaks off to swing a shovel over an unrelated stuck sample
    // (undermining and swimming are the deliberate exceptions — those ARE
    // the fight).
    const activelyFiring = this.target && this.aimT > reactT && !undermining && !b.inWater;
    const canEdit = botTerrainEditAllowed(this, { water: b.inWater || !!this.exit,
      stuck: this.stuck, undermining });
    if (!activelyFiring && canEdit && !ownCover
        && (!this.target || b.inWater || this.stuck >= 2 || undermining)
        && (dist > 2 || b.inWater || this.exit || undermining)
        && this.digT <= 0 && (lo || hi) && (b.onGround || b.inWater)) {
      this.digT = 0.32;
      this.lastDig = g.time;
      const uphill = dest.y - b.pos.y > 1.5;
      if (lo && uphill) {
        digVoxel(this, tx, fy + 1, tz); digVoxel(this, tx, fy + 2, tz);  // the ledge
        digVoxel(this, tx, fy + 3, tz);                              // its headroom
        // The block above our own head: an overhang would guillotine the hop.
        digVoxel(this, Math.floor(b.pos.x), fy + 2, Math.floor(b.pos.z));
        b.jump();
        if (b.inWater) b.vel.y = 6; // swim-hop needs extra lift to crest the lip
      } else {
        digVoxel(this, tx, fy, tz); digVoxel(this, tx, fy + 1, tz);      // wall face or lip
      }
    }
    if (!canEdit && (lo || hi) && this.routeT <= 0) {
      const side = this.id % 2 ? 1 : -1;
      this.wander.set(-dir.z * side * 10, 0, dir.x * side * 10);
      this.wanderT = Math.max(this.wanderT, 1.2);
    }
    const digging = g.time - this.lastDig < 0.9;

    // --- bridging: never launch into a ravine we could span. If the column
    // a pace ahead drops away deeper than a couple of blocks (and the goal
    // isn't downhill anyway, where descending is the point), lay the next
    // plank at foot level. A bridgelayer's pace keeps us from outrunning
    // the plank cadence and walking off our own bridge tip. ---
    this.bridgeT -= dt;
    if (!this.target && dist > 2 && b.onGround && !b.inWater &&
        this.blocks > 0 && dir.lengthSq() > 0 && this.bridgeT <= 0) {
      const gx = Math.floor(b.pos.x + dir.x * 1.4);
      const gz = Math.floor(b.pos.z + dir.z * 1.4);
      let drop = 0;
      for (let y = fy - 1; y >= fy - 16 && !w.solid(gx, y, gz); y--) drop++;
      // Bridge only when the goal sits ABOVE the bottom of the drop ahead:
      // a ravine between two banks qualifies (even when the far bank is
      // lower); a valley we're descending into doesn't — walking down is
      // the point there. The scan reaches sixteen deep so a tall deck over
      // a gorge still reads the true bottom, not four blocks below the
      // planks — otherwise the bot stops bridging mid-span and walks off.
      if (drop >= 3 && goal.y > fy - drop) {
        this.bridgeT = 0.35;
        this.lastBridge = g.time; // hold the bridgelayer's pace while a drop is ahead
        // Deck the nearest hole first: hopping between plank tops skips
        // onGround frames, so always aiming 1.4 ahead can skip a column —
        // and a one-column gap in the deck is a fall into the ravine.
        for (const ahead of [0.8, 1.3, 1.8]) {
          const px = Math.floor(b.pos.x + dir.x * ahead);
          const pz = Math.floor(b.pos.z + dir.z * ahead);
          if (w.solid(px, fy - 1, pz)) continue;      // already decked
          if (g.tryBuild(this, px, fy - 1, pz)) break; // nearest hole plugged
        }
      }
    }

    // Group up: past midfield with no teammate in sight is how lone bots get
    // picked off. Creep cautiously until the team catches up. Defenders and
    // responders answer to their own urgency, not this rule. groupRange is
    // per-class: sniper rarely finds a teammate close enough to feel
    // backed up (won't push forward alone), smg almost always does
    // (rushes ahead of the pack readily) — see CLASS_PROFILE.
    let cautious = false;
    if (!this.target && !this.carrier && !this.responding && this.role !== 'defend' && !b.inWater) {
      const over = this.heading > 0 ? b.pos.x > SX / 2 : b.pos.x < SX / 2;
      if (over) {
        cautious = true;
        for (const m of g.teamOf(this.team))
          if (m !== this && m.alive && m.team === this.team &&
              m.body.pos.distanceTo(b.pos) < profile.groupRange) { cautious = false; break; }
      }
    }

    // Digging pace applies in water too: at full swim speed a bot outswims
    // its own shovel cadence (~1 block per swing) and never sits at a bank
    // face long enough to clear the ledge — the creek-bobbing loop.
    // Bots sprint too: unengaged and with somewhere to be, they run nearly
    // as fast as a sprinting player (5.4 × 1.45). Combat drops to a walk —
    // scaled by speedMul there specifically: patrol/response urgency is the
    // same for everyone, but how briskly a bot moves ONCE IN A FIGHT is
    // part of its class identity (smg presses in, sniper repositions with
    // more deliberation).
    const speed = (b.inWater ? (digging ? 1.4 : 3.2)
      : this.target && !this.carrier ? 5.0 * profile.speedMul // close to patrol pace — a fight is not a standing trade
      : digging || bridging ? 2.2  // shovel/plank pace: never outrun the tool
      : this.carrier || this.tacticalRole === 'escort' ? 7.8
        // objective run / escort: match a player's sprint pace
      : this.responding ? 6.2      // urgency: our flag is on the ground
      : 6.0) * (cautious ? 0.45 : 1);
    // Local squad spacing: blend away from allies inside shoulder-to-shoulder
    // range, but never override a committed bridge/water exit or a deliberate
    // held firing position.
    if (!holding && !bridging && !b.inWater && dir.lengthSq() > 0.01) {
      const sep = botSeparation(b.pos, g.teamOf(this.team), this.id, 2.4, this._separation);
      dir.x += sep.x * 0.55; dir.z += sep.z * 0.55; dir.normalize();
    }
    b.vel.x += (dir.x * speed - b.vel.x) * Math.min(1, dt * 8);
    b.vel.z += (dir.z * speed - b.vel.z) * Math.min(1, dt * 8);

    // Stuck detection: sample displacement every 0.4s — hop over one-high
    // steps, sidestep when truly wedged. Suppressed mid-dig: a tunneler at
    // the face is making progress even while momentarily pressed still.
    // (Per-frame thresholds lie: a full-speed bot only moves ~0.08 vox a
    // frame, so any fixed per-frame cutoff reads as "stuck".)
    this.sampleT -= dt;
    if (this.sampleT <= 0) {
      this.sampleT = 0.4;
      // Horizontal displacement only: a bot bouncing in place under a low
      // canopy moves a full block vertically per hop and would otherwise
      // read as "making progress", never triggering the sidestep.
      const moved = Math.hypot(b.pos.x - this.lastPos.x, b.pos.z - this.lastPos.z);
      // dist>2 alone would never flag a bot pressed against its committed
      // exit wall (the wall IS the dest), so a wedged climb counts too —
      // but not mid-swing: a dig-climb is horizontal-stationary by nature.
      // A bot that's holding position on purpose (crouched behind cover,
      // planted for a ranged shot) used to trip this the same as one truly
      // wedged against terrain: after ~1.6s it would launch itself into a
      // jump loop and then abandon the position for a random wander,
      // self-sabotaging the exact fight it was winning. Discipline isn't
      // stuck.
      this.stuck = !holding && moved < 0.5 && (dist > 2 || this.exit) && !digging ? this.stuck + 1 : 0;
      this.lastPos.copy(b.pos);
    }
    if (this.stuck >= 1 && !(digging && hi)) b.jump();
    if (this.stuck >= 4) { // wedged on something unshovelled — sidestep
      this.wander.set((Math.random() - .5) * 30, 0, (Math.random() - .5) * 30);
      this.wanderT = 2;
      this.stuck = 0;
      this.exit = null;      // abandon the exit pick that led us here
      this.telemetry.stuckRecoveries++;
      this.routeT = 0;
    }

    b.move(dt);

    // Cover posture: duck while reloading behind the wall or riding out a
    // burst pause; stand to shoot. At range a bot crouch-fires for the
    // steadier spread — same trade the player's crouch makes. Same bounded
    // lerp as the player crouch.
    if (this.reloading > 0 && this.coverT > 0) this.duckT = Math.max(this.duckT, 0.2);
    let rangeDuck = this.target && !this.carrier && foeD > profile.hold
      && this.aimT > reactT && b.onGround && !b.inWater;
    if (rangeDuck) {
      // Don't duck blind behind our own knee wall: if the crouched eye can't
      // see the foe but the standing eye can, stand and shoot over it.
      const duckEye = new THREE.Vector3(b.pos.x, b.pos.y + CROUCH_HEIGHT - EYE_INSET, b.pos.z);
      const standEye = new THREE.Vector3(b.pos.x, b.pos.y + STAND_HEIGHT - EYE_INSET, b.pos.z);
      if (!g.losClear(duckEye, targetEye) &&
          g.losClear(standEye, targetEye)) rangeDuck = false;
    }
    const ducking = this.duckT > 0 || rangeDuck;
    b.half.h += ((ducking ? CROUCH_HEIGHT : STAND_HEIGHT) - b.half.h) * Math.min(1, dt * 10);
    this.crouched = ducking; // fireHitscan reads this for the spread bonus
    setCrouch(this.parts, ducking);

    // --- grenades: one frag per life, lobbed over the knee walls foes
    // duck behind. Arc up a touch so it clears cover and lands at feet. ---
    this.nadeT -= dt;
    if (this.target && targetPoint && this.nades > 0 && this.nadeT <= 0 && !b.inWater &&
        foeD > 10 && foeD < 28 && Math.random() < dt * 0.25 &&
        g.losClear(b.eye(), targetEye)) {
      const lob = new THREE.Vector3().subVectors(targetPoint, b.pos).normalize();
      lob.y += 0.45; lob.normalize();
      this.nades--; this.nadeT = 7;
      g.throwGrenade(this, b.eye(), lob, 11 + foeD * 0.15);
    }

    // --- shooting ---
    this.cooldown -= dt;
    if (this.reloading > 0) {
      const spec = TOOLS[this.gunClass];
      this.reloading -= dt;
      const progress = 1 - Math.max(0, this.reloading) / spec.reload;
      const cue = nextReloadCue(this.reloadStage, progress);
      if (cue) { this.reloadStage = cue.stage; sfx.at(cue.name, b.pos, spec.key); }
      if (this.reloading <= 0) { this.ammo = spec.mag; this.reloadStage = 0; }
    } else if (!this.target && this.ammo < TOOLS[this.gunClass].mag * 0.55) {
      // Top off during a lull instead of discovering an almost-empty magazine
      // on the first shot of the next fight.
      const spec = TOOLS[this.gunClass];
      this.reloading = spec.reload; this.reloadStage = 1;
      sfx.at('reloadStart', b.pos, spec.key);
    } else if (this.target && targetPoint && this.aimT > reactT
        && this.cooldown <= 0 && foeD <= (profile.fireRange ?? Infinity)) {
      if (this.ammo <= 0) {
        const spec = TOOLS[this.gunClass];
        this.reloading = spec.reload; this.reloadStage = 1;
        sfx.at('reloadStart', b.pos, spec.key);
      }
      else {
        const from = b.eye();
        const toFoe = new THREE.Vector3().subVectors(targetPoint, b.pos).setY(0).normalize();
        // The muzzle only speaks once the head has turned on target — and
        // opening shots go wide before the aim settles. No 180° no-scopes.
        if (this.face.dot(toFoe) > 0.87 && g.losClear(from, targetEye)) {
          this.ammo--;
          const burstPause = Math.random() < 0.25;
          this.cooldown = TOOLS[this.gunClass].interval * (burstPause ? 4 : 1); // burst rhythm
          if (burstPause && this.coverT > 0) this.duckT = this.cooldown + 0.15;
          // One randomization source, not two stacked ones: this used to
          // hand-jitter the aim vector AND let fireHitscan add the weapon's
          // own spread on top of that, every shot. Worse, the manual jitter
          // shrank toward a floor with aimT while the weapon spread never
          // did — so a bot that had held a target for two full seconds was
          // still only as accurate as the fixed spread allowed, and
          // "holding aim longer" never actually paid off the way the
          // numbers implied it should. Aim precisely and let the weapon's
          // own spread (scaled by hold time and skill, same as a human
          // tightening up) be the only randomness.
          const spec = TOOLS[this.gunClass];
          // Aim at CENTER MASS, not the eye. body.eye() is the exact
          // center of the head hitbox — literally the same formula
          // rayVsSoldier uses for its own head sphere — so aiming there
          // was landing a headshot on essentially every on-target shot:
          // spread this tight, at a typical engagement range, deviates far
          // less than the head sphere's own angular size covers. Harmless
          // under the bot's old, weak custom gun (a 27dmg headshot barely
          // mattered); a real weapon's headshot (110-247dmg) turned "bots
          // aim precisely at the head by default" into bots aimbot-sniping
          // every fight. Headshots now come from spread landing high, the
          // way they should, not from being the default aim point.
          const aimAt = new THREE.Vector3(targetPoint.x,
            targetPoint.y + this.target.body.half.h * 0.5, targetPoint.z);
          const aim = new THREE.Vector3().subVectors(aimAt, from).normalize();
          const held = Math.min(1, (this.aimT - reactT) / 1.0); // 0 fresh -> 1 well-aimed
          // Fresh-shot end widened 1.8 -> 3.2: the very first shot right as
          // reactT clears was still tight enough to land often against a
          // center-mass-sized target, which is what actually read as
          // "one-shot aimbot" even with the reaction delay working
          // correctly — the delay was real, but the shot the moment it
          // ended was still too good. Well-aimed end (0.5) is unchanged:
          // a bot that's held aim for a full second earns real accuracy,
          // same as it always did.
          const spreadMul = (3.2 - 2.7 * held) * this.difficulty.aimError / this.skill;
          g.fireHitscan(this, from, aim, { ...spec, spread: spec.spread * spreadMul });
        }
      }
    }

    // --- presentation: eyes track the fight, but heads take time to turn ---
    const pg = this.parts.group;
    pg.position.copy(b.pos);
    const want = this.target && targetPoint
      ? new THREE.Vector3().subVectors(targetPoint, b.pos).setY(0).normalize()
      : dir;
    if (want.lengthSq() > 0.01) {
      const ang = this.face.angleTo(want);
      if (ang > 1e-3) this.face.lerp(want, Math.min(1, 7 * dt / ang)).normalize();
    }
    pg.rotation.y = Math.atan2(-this.face.x, -this.face.z);
    placeShadow(this.parts, g.world, pg.rotation.y);
    // Tool in hand matches the work: spade out while the shovel is swinging.
    const shoveling = g.time - this.lastDig < 0.9;
    this.parts.gun.visible = !shoveling;
    this.parts.spade.visible = shoveling;
    animateSoldier(this.parts, Math.hypot(b.vel.x, b.vel.z), g.time + this.name.length);
  }

  // Shot in the back? The impact supplies a direction, not wall vision.
  alert(from) {
    if (from?.alive && from.team !== this.team) {
      this.face.subVectors(from.body.pos, this.body.pos).setY(0).normalize();
      this.target = from;
      this.targetVisible = false;
      this.memoryPos.copy(from.body.pos); // damage direction is legitimate sensory information
      this.memorySeenAt = this.game.time;
      this.memoryT = Math.min(1.5, this.difficulty.memory);
      this.aimT = 0;
      this.nextThink = Math.min(this.nextThink, this.game.time + 0.08);
    }
  }

  die(killer) {
    this.alive = false;
    this.ctfStageAt = -Infinity;
    this.deadT = 0; // corpse tumble starts; the body hides itself when done
    this._mkCount = 0; this._mkT = null; // tracked for consistency even though bots don't get the callout shown
    this._streak = 0; // bots cannot spend scorestreak rewards
    this.parts.gun.visible = true; // drop the spade, back to the rifle
    this.parts.spade.visible = false;
    this.game.effects.burst(this.body.eye(), 26, teamHex(this.team), 6);
    this.game.onDeath(this, killer);
  }

  respawn() {
    if (Number.isInteger(this._humanLife)) this._humanLife++;
    const p = this.game.spawnPoint(this.team);
    this.body.pos.set(p.x, p.y, p.z);
    this.body.vel.set(0, 0, 0);
    this.health = 100;
    this.alive = true;
    this._spawnedAt = this.game.time;
    this.protT = 3; // same spawn protection humans get
    this.gunClass = randomClass(); // rerolled each life, same as a human choosing
    setSoldierTool(this.parts, this.gunClass);
    this.ammo = TOOLS[this.gunClass].mag;
    this.reloading = 0;
    this.reloadStage = 0;
    this.stuck = 0;
    this.sampleT = 0.4;
    this.digT = 0;
    this.lastDig = -9;
    this._editTokens = this._editBudget;
    this._terrainEdits = 0;
    this.blocks = 16;
    this.bridgeT = 0;
    this.lastBridge = -9;
    this.buildT = 0;
    this.coverT = 0;
    this.duckT = 0;
    this.patrol = null;
    this.patrolT = 0;
    this.retreatT = 0;
    this.retreatCd = 0;
    this.route.set(0, 0, 0);
    this.routeT = 0;
    this.nades = 1;
    this.nadeT = 0;
    this.crouched = false;
    this.body.half.h = STAND_HEIGHT;
    resetEnvironmentalState(this);
    this.target = null;
    this.aimT = 0;
    this.memoryT = 0;
    this.memorySeenAt = -Infinity;
    this.targetVisible = false;
    this.cachedGoal = null;
    this.nextThink = this.game.time + this.difficulty.thinkInterval;
    this.navRevision = this.game.navRevision ?? 0;
    this.orderId = null;
    this.ctfStageAt = -Infinity;
    this.face.set(this.heading, 0, 0);
    this.lastPos.copy(this.body.pos);
    this.deadT = -1;
    resetDeath(this.parts);
    // The gap this closes: animateDeath sinks the corpse's Y position
    // (see entities.js) as it decays, and resetDeath only ever clears the
    // tumble rotation — it never had the new spawn position to reset
    // position TO, since it only receives `parts`, not this bot's own
    // body. Without this line, group.position stays wherever the corpse
    // last sank to (often mid-map, at a contested chokepoint or a KOTH
    // hill, and at ground level from sinking) for exactly one frame:
    // this respawn() call sets visible=true immediately, but the group's
    // position only gets corrected on this bot's OWN next update() call —
    // which, given respawns are processed in a separate pass AFTER
    // Game#update already ran every bot's update() this frame (bots.js's
    // "presentation" section, pg.position.copy(b.pos)), doesn't happen
    // until next frame. One frame at 60fps is ~16ms — short, but a
    // sudden full-map-width jump reads as a very noticeable flash, and it
    // happens on literally every bot respawn, which is constant over a
    // match. Avatar (remote players/bots as seen by anyone over the
    // network) never had this problem — its own setAlive() hides the
    // model until a fresh position sample arrives, a different mechanism
    // for the same goal. Bots, rendered directly for whoever's hosting or
    // playing solo, had no equivalent guard until now.
    this.parts.group.position.copy(this.body.pos);
    this.parts.group.visible = true;
  }
}
