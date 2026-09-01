// avatar.js — remote soldiers: model, nametag, snapshot interpolation.
import * as THREE from 'three';
import { makeSoldier, makeNametag, animateSoldier, animateDeath, resetDeath, disposeObject,
  setCrouch, setSoldierTool, placeShadow, footDust } from './entities.js';
import { sfx } from './audio.js';
import { teamHex } from './settings.js';

export class Avatar {
  constructor(parent, team, name, friendly = false) {
    this.team = team;
    this.parts = makeSoldier(teamHex(team));
    this.group = this.parts.group;
    // Callsigns are for your own side. An enemy tag floats at y=2.15, above
    // the helmet — so a man crouched behind a two-block wall was fully hidden
    // while his name sat over the parapet. Finding the enemy is supposed to
    // be something you do with your eyes.
    if (friendly) this.group.add(makeNametag(name, team));
    parent.add(this.group);
    this.group.visible = false; // until the first update() places us
    this.samples = []; // [receiptTime, x, y, z, yaw]
    this.alive = true;
    this.crouch = false;
    this.deadAt = null;  // wall-clock time of death, while the corpse tumbles
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    // Hard-edged warning blocks, not a glow or particle aura. Windup blinks
    // amber; the active state becomes orange/white and visibly orbits the
    // silhouette in stepped increments so opponents can read the buff.
    this.overchargeFx = new THREE.Group();
    this.overchargeFx.visible = false;
    const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffd97a });
    const sparkGeo = new THREE.BoxGeometry(0.09, 0.09, 0.09);
    for (let i = 0; i < 8; i++) {
      const spark = new THREE.Mesh(sparkGeo, sparkMat);
      const a = i / 8 * Math.PI * 2;
      spark.position.set(Math.cos(a) * 0.48, 0.45 + (i % 3) * 0.48,
        Math.sin(a) * 0.48);
      this.overchargeFx.add(spark);
    }
    this.group.add(this.overchargeFx);
    this._overchargePhase = 0;
  }

  // ry is model-space rotation.y (soldier forward is -Z).
  push(x, y, z, ry) {
    // Measure the arrival process: EWMA of the gap between snapshots and of
    // its jitter. The render delay below is derived from this, so a clean
    // link gets a small buffer and a jittery one gets what it needs — nothing
    // on the wire, nothing advertised by the host.
    const now = performance.now() / 1000;
    if (this.lastArrival) {
      const gap = now - this.lastArrival;
      this.interval = this.interval ? this.interval + 0.1 * (gap - this.interval) : gap;
      this.jitter = (this.jitter ?? 0) + 0.1 * (Math.abs(gap - this.interval) - (this.jitter ?? 0));
    }
    this.lastArrival = now;
    const s = this.samples, last = s[s.length - 1];
    // Teleports (respawn, lag stall) snap instead of gliding from the old spot.
    if (last && Math.hypot(x - last[1], y - last[2], z - last[3]) > 8) s.length = 0;
    s.push([now, x, y, z, ry]);
    if (s.length > 12) s.shift();
  }

  // Death starts the corpse tumble; respawn drops position history so the
  // avatar snaps to its spawn instead of gliding from the corpse. Respawn
  // also hides the body until a fresh snapshot places it — otherwise it
  // stands at the death spot for a frame or two (the mid-map ghost flash).
  // A brand-new avatar learning its owner is already dead skips the tumble
  // replay: that corpse fell long before we got here.
  setAlive(alive) {
    if (alive === this.alive) return;
    this.alive = alive;
    if (alive) {
      this.samples.length = 0;
      this.lastArrival = null; this.interval = 0; this.jitter = 0; // fresh stats
      this.deadAt = null;
      this.group.visible = false;
      resetDeath(this.parts);
    } else {
      this.deadAt = performance.now() / 1000 - (this.samples.length ? 0 : 2);
    }
  }

  setCrouch(on) { this.crouch = on; }
  setTool(tool) { setSoldierTool(this.parts, tool); }
  setOvercharge(charging, active) {
    this._overchargePhase = active ? 2 : charging ? 1 : 0;
    this.overchargeFx.visible = this.alive && this._overchargePhase > 0;
  }

  // Render just far enough in the past to bracket two snapshots: one
  // observed interval plus two jitter sigmas, clamped to sanity. A clean
  // 15Hz link lands near 80ms; the old fixed 130ms assumed the worst.
  update(gameT, world = null, effects = null) {
    const now = performance.now() / 1000;
    const delay = Math.min(0.22, Math.max(0.06,
      1.15 * (this.interval || 0.083) + 2 * (this.jitter ?? 0)));
    const rt = now - delay;
    const s = this.samples;
    if (!s.length) { this.group.visible = false; return; } // nothing valid to show
    let a = s[0], b = s[s.length - 1];
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i][0] <= rt) { a = s[i]; b = s[Math.min(i + 1, s.length - 1)]; break; }
    }
    const span = b[0] - a[0];
    const k = span > 0 ? Math.min(1, Math.max(0, (rt - a[0]) / span)) : 1;
    const nx = a[1] + (b[1] - a[1]) * k;
    const ny = a[2] + (b[2] - a[2]) * k;
    const nz = a[3] + (b[3] - a[3]) * k;
    let dry = b[4] - a[4];
    if (dry > Math.PI) dry -= Math.PI * 2;
    if (dry < -Math.PI) dry += Math.PI * 2;
    // Walk-cycle speed from real velocity: per-frame displacement divided by
    // the actual frame delta, so high-refresh displays don't slow the gait.
    const fdt = this._lastUpd ? Math.max(1e-3, now - this._lastUpd) : 1 / 60;
    this._lastUpd = now;
    const speed = Math.hypot(nx - this.pos.x, ny - this.pos.y, nz - this.pos.z) / fdt;
    this.pos.set(nx, ny, nz);
    this.group.position.copy(this.pos);
    // Footsteps off the interpolated ground truth: 2.2 blocks of travel, one
    // step sound where they actually are.
    if (this.alive && this._px !== undefined) {
      this._stepAcc = (this._stepAcc ?? 0) + Math.hypot(nx - this._px, nz - this._pz);
      if (this._stepAcc >= 2.2) {
        this._stepAcc = 0;
        const surface = world?.get(Math.floor(nx), Math.floor(ny) - 1, Math.floor(nz)) ?? 1;
        sfx.at('step', this.pos, 1, surface);
        // Closes the one real gap in muzzle-flash/footstep-dust coverage:
        // a guest's own view of everyone ELSE stepping renders through
        // here, not through either of the two sites in game.js — those
        // only ever cover the local player's own steps plus whatever
        // host/solo is directly simulating. footDust silently no-ops if
        // effects wasn't passed in (guards its own inputs), so this is
        // safe even before every caller of update() is updated to pass it.
        footDust(world, effects, nx, ny, nz);
      }
    }
    this._px = nx; this._pz = nz;

    if (!this.alive) { // corpse: tumble where it fell, then vanish
      this.overchargeFx.visible = false;
      if (this.deadAt !== null) animateDeath(this.parts, performance.now() / 1000 - this.deadAt);
      return;
    }
    this.group.visible = true;
    this.group.rotation.y = a[4] + dry * k;
    animateSoldier(this.parts, speed, gameT + this.pos.x);
    setCrouch(this.parts, this.crouch);
    this.overchargeFx.visible = this._overchargePhase > 0;
    if (this._overchargePhase > 0) {
      const step = Math.floor(gameT * (this._overchargePhase === 1 ? 12 : 8));
      this.overchargeFx.rotation.y = step * Math.PI / 4;
      this.overchargeFx.children[0].material.color.setHex(
        this._overchargePhase === 1 || step % 2 === 0 ? 0xffd97a : 0xff6b3d);
      for (let i = 0; i < this.overchargeFx.children.length; i++)
        this.overchargeFx.children[i].visible = this._overchargePhase === 2 || (i + step) % 2 === 0;
    }
    if (world) placeShadow(this.parts, world, this.group.rotation.y);
  }

  dispose() { disposeObject(this.group); }
}
