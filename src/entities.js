// entities.js — voxel AABB physics and the little blocky soldiers.
import * as THREE from 'three';
import { SEA, PALETTE, boxFaceTints } from './world.js';
import { getGfxLevel } from './settings.js';

const GRAVITY = -30;
export const STAND_HEIGHT = 1.75;
export const CROUCH_HEIGHT = 1.31;
export const EYE_INSET = 0.18;

// Shared by Game#_footDust (the local player and, on host/solo, every
// bot/remote proxy via the entities() loop) and Avatar#update (a guest's
// own view of everyone ELSE stepping, which goes through this file's
// interpolation instead) — one implementation instead of two that could
// drift apart. Colors from the real block underfoot, matching
// blockBurst's own precedent of debris reflecting the actual material.
// Silently does nothing if there's no solid ground directly underfoot
// (an edge, a floating-point sliver at a block boundary) or no effects
// system available yet, rather than guessing.
export function footDust(world, effects, x, y, z) {
  if (!world || !effects) return;
  const bx = Math.floor(x), by = Math.floor(y) - 1, bz = Math.floor(z);
  const v = world.get(bx, by, bz);
  if (!v) return;
  effects.burst(new THREE.Vector3(bx + 0.5, by + 1, bz + 0.5), 3, PALETTE[v].color, 1.6);
}

export class Body {
  constructor(world, x, y, z) {
    this.world = world;
    this.pos = new THREE.Vector3(x, y, z); // feet center
    this.vel = new THREE.Vector3();
    this.half = { x: 0.32, h: STAND_HEIGHT }; // half-width, full height
    this.onGround = false;
    this.inWater = false;
    // One-frame landing event consumed by the authoritative Game. Preserve
    // downward velocity before collision zeroes it so fall damage can use the
    // real impact rather than guessing from the post-collision body state.
    this.landedSpeed = 0;
    this.guard = false; // crouch edge-guard: refuse to walk off a real drop
  }

  // Whole-body AABB overlap against solid terrain, at an ARBITRARY
  // candidate position rather than this.pos — same box definition
  // _axis's collision response already uses below (feet-center position,
  // half-width, full height), but as a pure query: no movement, no
  // velocity changes, no step-up or edge-guard side effects. Exists so
  // the host can validate a guest's reported position before ever
  // committing to it, without simulating a fake movement step to do it.
  overlapsSolid(x, y, z) {
    const h = this.half;
    const x0 = Math.floor(x - h.x), x1 = Math.floor(x + h.x);
    const y0 = Math.floor(y), y1 = Math.floor(y + h.h);
    const z0 = Math.floor(z - h.x), z1 = Math.floor(z + h.x);
    for (let yy = y0; yy <= y1; yy++)
      for (let zz = z0; zz <= z1; zz++)
        for (let xx = x0; xx <= x1; xx++)
          if (this.world.solid(xx, yy, zz)) return true;
    return false;
  }

  // Axis-separated integration: move one axis at a time, clamp on collision.
  move(dt) {
    this.landedSpeed = 0;
    const wasInWater = this.inWater;
    const g = this.inWater ? GRAVITY * 0.25 : GRAVITY;
    this.vel.y = Math.max(this.vel.y + g * dt, -40);
    this._axis('x', this.vel.x * dt);
    this._axis('z', this.vel.z * dt);
    this.onGround = false;
    this._axis('y', this.vel.y * dt);
    this.inWater = this.pos.y < SEA + 0.4;
    // Entering the sea breaks a fall. Without this, a body retained its full
    // dry-land velocity underwater and could rocket into the seabed before
    // swimming controls had time to respond.
    if (!wasInWater && this.inWater && this.vel.y < 0) this.vel.y = Math.max(this.vel.y * 0.3, -6);
    // Safety net: a body that leaves the world gets parked above sea level
    // and FLAGGED. Without the flag it just falls again forever — nothing
    // else kills it, so a grenade chain that digs a shaft to bedrock used to
    // strand a player in an endless loop. Game.update reads voidFall and
    // kills, which routes through the normal death (flag drop, respawn).
    if (this.pos.y < -8) { this.pos.y = SEA + 10; this.vel.set(0, 0, 0); this.voidFall = true; }
  }

  _axis(axis, delta) {
    if (delta === 0) return;
    const old = this.pos[axis];
    this.pos[axis] += delta;
    const p = this.pos, h = this.half;
    const x0 = Math.floor(p.x - h.x), x1 = Math.floor(p.x + h.x);
    const y0 = Math.floor(p.y),        y1 = Math.floor(p.y + h.h);
    const z0 = Math.floor(p.z - h.x),  z1 = Math.floor(p.z + h.x);
    // Edge-guard (crouch-walking): never let the whole footprint leave solid
    // footing when the far side is more than a single step down. One-block
    // steps still pass, so slopes and stairs stay walkable while crouched;
    // ravine rims and parapets stop you cold.
    if (this.guard && this.onGround && axis !== 'y' && !this._footing(y0)) {
      p[axis] = old;
      this.vel[axis] = 0;
      return;
    }
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          if (!this.world.solid(x, y, z)) continue;
          if (axis === 'y') {
            if (delta < 0) {
              this.landedSpeed = Math.max(this.landedSpeed, -this.vel.y);
              p.y = y + 1; this.onGround = true;
            }
            else p.y = y - h.h - 0.001;
            this.vel.y = 0;
          } else {
            // Water-exit step: a swimmer pressing into a shoreline lip should
            // be able to mantle onto a block whose top is within one normal
            // step of their feet. The ordinary auto-step below deliberately
            // requires dry, grounded movement, which left players and bots
            // pinned against even water-level blocks. Keep this in Body so
            // every locally simulated body gets identical collision rules.
            const waterStepY = this.step !== false && this.inWater
              ? this._waterStepY(y + 1) : null;
            if (waterStepY !== null) {
              p.y = waterStepY;
              this.vel.y = Math.max(0, this.vel.y);
              this.onGround = true;
              this._stepped = true;
              return;
            }
            // Auto-step: grounded and walking into a one-block rise with
            // headroom? Treat it as a stair, not a wall — lift onto it and
            // let the y-pass settle. Gated on walking (step === false while
            // sprinting) and never mid-air, so it can't grab a ledge you
            // were trying to drop past or turn sprint into a hill-climb.
            // p[axis] already holds the advanced position; _stepFits tests it.
            if (this.step !== false && this.onGround && !this.inWater
                && this.vel.y <= 0.01 && this._stepFits()) {
              p.y += 1.001;
              this._stepped = true; // first-person camera eases this pop out
              return;
            }
            const sign = Math.sign(delta);
            p[axis] = sign > 0
              ? (axis === 'x' ? x : z) - h.x - 0.001
              : (axis === 'x' ? x : z) + 1 + h.x + 0.001;
            this.vel[axis] = 0;
          }
          return;
        }
  }

  // Would the AABB fit if lifted one block at the current position, with
  // footing under the lifted feet? Caller has already advanced pos[axis].
  _stepFits() {
    const p = this.pos, h = this.half, y = p.y + 1.001;
    const x0 = Math.floor(p.x - h.x), x1 = Math.floor(p.x + h.x);
    const y0 = Math.floor(y),        y1 = Math.floor(y + h.h);
    const z0 = Math.floor(p.z - h.x), z1 = Math.floor(p.z + h.x);
    for (let yy = y0; yy <= y1; yy++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++)
          if (this.world.solid(x, yy, z)) return false;
    return this._footing(y0);
  }

  // Return the exact feet height for a reachable shoreline mantle, or null.
  // The lower bound prevents deep swimmers from snapping upward through a
  // bank; the rise bound prevents this from becoming a general wall climb.
  // At the candidate height, the whole body must be clear and the ledge must
  // actually provide footing beneath the advanced horizontal position.
  _waterStepY(blockTop) {
    const p = this.pos, h = this.half;
    const target = blockTop + 0.001;
    const rise = target - p.y;
    if (p.y < SEA - 1.25 || rise < -0.05 || rise > 1.251) return null;
    const x0 = Math.floor(p.x - h.x), x1 = Math.floor(p.x + h.x);
    const y0 = Math.floor(target),    y1 = Math.floor(target + h.h);
    const z0 = Math.floor(p.z - h.x), z1 = Math.floor(p.z + h.x);
    for (let yy = y0; yy <= y1; yy++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++)
          if (this.world.solid(x, yy, z)) return null;
    return this._footing(y0) ? target : null;
  }

  // Is there ground within one step anywhere under the footprint?
  _footing(y0) {
    const h = this.half, p = this.pos;
    for (let y = y0 - 1; y >= y0 - 2; y--)
      for (let x = Math.floor(p.x - h.x); x <= Math.floor(p.x + h.x); x++)
        for (let z = Math.floor(p.z - h.x); z <= Math.floor(p.z + h.x); z++)
          if (this.world.solid(x, y, z)) return true;
    return false;
  }

  jump() {
    if (this.onGround) this.vel.y = 9.5;
    else if (this.inWater) this.vel.y = 4; // swim upward
  }

  eye() { return new THREE.Vector3(this.pos.x, this.pos.y + this.half.h - EYE_INSET, this.pos.z); }
}

// A blocky AoS-style soldier: legs, torso, arms, head, gun — team colored.
// Ground shadow: one flat, hard-edged quad per soldier. It used to be a
// radial-gradient sprite parented at the feet, which was wrong twice over —
// nothing else in this game has a soft edge, and riding the model meant the
// shadow JUMPED with the player instead of staying on the ground. Now it is
// projected down onto whatever the soldier is actually standing over, which
// makes it a real read on where an airborne enemy is about to land.
// Shared resources are tagged so disposeObject leaves them alone.
export const SHADOW_MAX_DROP = 12; // beyond this, nothing to cast onto
// Four shared materials instead of a clone per soldier: the fade steps
// between fixed levels the same way the banner sways between fixed poses,
// and nothing here needs disposing when a soldier does.
const SHADOW_ALPHA = [0.28, 0.20, 0.13, 0.07];
let blobGeo = null, blobMats = null;
function blobShadow() {
  if (!blobGeo) {
    blobGeo = new THREE.PlaneGeometry(0.95, 0.95);
    blobMats = SHADOW_ALPHA.map(opacity => new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity, depthWrite: false,
    }));
  }
  const m = new THREE.Mesh(blobGeo, blobMats[0]);
  m.userData.shared = true; // geometry and materials outlive any one soldier
  m.rotation.x = -Math.PI / 2;
  return m;
}

// Drop the shadow onto the ground under a soldier and fade it with height.
// Call once per frame after the group has been positioned. `yaw` is the
// group's rotation.y — countered here so a square shadow does not spin as
// its owner turns (the old round one hid that; a hard-edged one cannot).
export function placeShadow(parts, world, yaw = 0) {
  const b = parts.blob;
  if (!b) return;
  const g = parts.group;
  const x = Math.floor(g.position.x), z = Math.floor(g.position.z);
  const foot = Math.floor(g.position.y);
  let top = -1;
  for (let y = foot; y >= foot - SHADOW_MAX_DROP; y--)
    if (world.solid(x, y, z)) { top = y + 1; break; }
  if (top < 0) { b.visible = false; return; } // over a void or deep water
  const drop = g.position.y - top;
  b.visible = true;
  b.position.y = top + 0.02 - g.position.y;   // group-local: land on the ground
  b.rotation.z = -yaw;                        // stay world-aligned
  const t = Math.min(1, Math.max(0, drop / SHADOW_MAX_DROP));
  b.scale.setScalar(1 - t * 0.45);            // smaller the higher you are
  b.material = blobMats[Math.min(SHADOW_ALPHA.length - 1, Math.floor(t * SHADOW_ALPHA.length))];
}

// Bakes the exact same directional face-tint terrain voxels already use
// (FACE_TINT in world.js) into a plain box's vertex colors, so blocky
// character/viewmodel geometry gets the same "sculpted" shading instead
// of one flat color per part. THREE's BoxGeometry always lays its 24
// vertices out in this exact per-face order (verified directly against
// a real BoxGeometry's own groups and normals, not assumed): +x, -x,
// +y, -y, +z, -z — a dedicated set of 4 vertices per face, never shared
// between faces, since each face needs its own normal even where
// positions numerically coincide with a neighboring face's. Not the
// same array order world.js's own FACE_TINT uses (-x, +x, -y, +y, -z,
// +z) — this is deliberately remapped to BoxGeometry's actual order
// rather than copied, since copying it directly would have quietly
// tinted the wrong faces.
export function faceTintedBox(w, h, d) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const colors = new Float32Array(geo.attributes.position.count * 3);
  const tints = boxFaceTints();
  for (let face = 0; face < 6; face++) {
    const [r, gg, b] = tints[face];
    for (let v = 0; v < 4; v++) {
      const i = (face * 4 + v) * 3;
      colors[i] = r; colors[i + 1] = gg; colors[i + 2] = b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.userData.voxelFaceTint = true;
  return geo;
}

export function retintVoxelBoxes(root) {
  const tints = boxFaceTints();
  root?.traverse?.(object => {
    const geo = object.geometry;
    const attr = geo?.userData?.voxelFaceTint && geo.attributes?.color;
    if (!attr || attr.count < 24) return;
    for (let face = 0; face < 6; face++) {
      const [r, g, b] = tints[face];
      for (let v = 0; v < 4; v++) attr.setXYZ(face * 4 + v, r, g, b);
    }
    attr.needsUpdate = true;
  });
}

// Block-built MQ-9 silhouette used by the airstrike flyover. The aircraft
// points along local +X, which matches the player's world-space forward
// vector after Game rotates the group by player yaw. Keeping every visible
// part as a face-tinted box makes it belong to the same untextured voxel
// language as the terrain, soldiers, and weapons; the stepped wing sweep and
// tail geometry carry the detail instead of a painted texture.
export function makeMq9Drone() {
  const group = new THREE.Group();
  group.name = 'MQ-9 Reaper';
  const light = new THREE.MeshBasicMaterial({ color: 0xb8bdba, vertexColors: true });
  const mid = new THREE.MeshBasicMaterial({ color: 0x7b817f, vertexColors: true });
  const dark = new THREE.MeshBasicMaterial({ color: 0x292d2e, vertexColors: true });
  const glass = new THREE.MeshBasicMaterial({ color: 0x31454c, vertexColors: true });
  const olive = new THREE.MeshBasicMaterial({ color: 0x4b5142, vertexColors: true });
  const box = (w, h, d, mat, x, y, z, parent = group) => {
    const mesh = new THREE.Mesh(faceTintedBox(w, h, d), mat);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };

  // Long, stepped fuselage and chin-mounted sensor ball.
  box(4.6, 0.72, 0.78, light, 0.15, 0, 0);
  box(2.0, 0.54, 0.58, light, 3.25, -0.03, 0);
  box(1.05, 0.36, 0.42, mid, 4.65, -0.06, 0);
  box(0.58, 0.52, 0.58, mid, 3.25, -0.58, 0);
  box(0.32, 0.28, 0.32, glass, 3.48, -0.69, 0);
  box(2.6, 0.5, 0.62, light, -3.35, 0.02, 0);
  box(0.95, 0.38, 0.5, mid, -5.02, 0.02, 0);

  // High-aspect-ratio wings, swept backward in chunky stages.
  box(2.25, 0.18, 5.4, light, -0.25, 0.12, 0);
  box(1.72, 0.16, 4.2, light, -0.68, 0.1, 4.75);
  box(1.72, 0.16, 4.2, light, -0.68, 0.1, -4.75);
  box(1.2, 0.14, 3.25, mid, -1.1, 0.08, 8.45);
  box(1.2, 0.14, 3.25, mid, -1.1, 0.08, -8.45);
  box(0.52, 0.2, 0.62, dark, -1.1, 0.07, 10.35);
  box(0.52, 0.2, 0.62, dark, -1.1, 0.07, -10.35);

  // V-tail slabs. Rotating long Z boxes around the fuselage axis produces
  // the Reaper's unmistakable downward-canted tail without smooth geometry.
  const tailL = box(1.5, 0.16, 3.0, light, -4.25, 0.28, 1.25);
  const tailR = box(1.5, 0.16, 3.0, light, -4.25, 0.28, -1.25);
  tailL.rotation.x = -0.48;
  tailR.rotation.x = 0.48;

  // Two under-wing munitions on each side add silhouette detail that still
  // reads when the aircraft is mostly seen from below.
  for (const z of [-5.6, -3.45, 3.45, 5.6]) {
    box(1.6, 0.22, 0.25, olive, 0.25, -0.42, z);
    box(0.32, 0.34, 0.42, dark, -0.62, -0.42, z);
  }

  // Rear pusher propeller. This is the only animated subassembly; the rest
  // remains a cheap rigid group regardless of graphics preset.
  box(0.45, 0.42, 0.42, dark, -5.65, 0.03, 0);
  const propeller = new THREE.Group();
  propeller.position.set(-5.93, 0.03, 0);
  for (let i = 0; i < 3; i++) {
    const blade = box(0.12, 0.18, 2.3, dark, 0, 0, 0, propeller);
    blade.rotation.x = i * Math.PI / 3;
  }
  group.add(propeller);

  // Tiny navigation lights: colored blocks, not emissive sprites, so they
  // keep the restrained voxel look and cost no per-frame light sources.
  const red = new THREE.MeshBasicMaterial({ color: 0xb33a32, vertexColors: true });
  const green = new THREE.MeshBasicMaterial({ color: 0x3f9b58, vertexColors: true });
  box(0.3, 0.2, 0.34, red, -1.1, 0.13, 10.68);
  box(0.3, 0.2, 0.34, green, -1.1, 0.13, -10.68);

  return { group, propeller };
}

export function makeSoldier(teamColor) {
  const g = new THREE.Group();
  const gfx = getGfxLevel();
  const detail = gfx !== 'low';
  const fineDetail = gfx === 'high';
  const skin = new THREE.MeshBasicMaterial({ color: 0xd9a066, vertexColors: true });
  const cloth = new THREE.MeshBasicMaterial({ color: teamColor, vertexColors: true });
  const armor = new THREE.MeshBasicMaterial({ color: 0x4b504d, vertexColors: true });
  const armorDark = new THREE.MeshBasicMaterial({ color: 0x303533, vertexColors: true });
  const dark = new THREE.MeshBasicMaterial({ color: 0x202426, vertexColors: true });
  const metal = new THREE.MeshBasicMaterial({ color: 0x666d6b, vertexColors: true });
  const lens = new THREE.MeshBasicMaterial({ color: 0x263b42, vertexColors: true });
  const wood = new THREE.MeshBasicMaterial({ color: 0x6b4a2c, vertexColors: true });
  const box = (w, h, d, mat, x, y, z, parent = g) => {
    const m = new THREE.Mesh(faceTintedBox(w, h, d), mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };

  // Legs pivot at the hips. Splitting boot, trouser, and knee pad gives the
  // walk cycle readable joints without adding bones or changing the hitbox.
  const leg = x => {
    const root = new THREE.Group();
    root.position.set(x, 0.69, 0);
    box(0.25, 0.34, 0.27, cloth, 0, -0.17, 0, root);
    box(0.23, 0.28, 0.24, cloth, 0, -0.47, 0, root);
    box(0.25, 0.14, 0.36, dark, 0, -0.62, -0.055, root);
    if (detail) box(0.24, 0.12, 0.08, armorDark, 0, -0.36, -0.145, root);
    g.add(root);
    return root;
  };
  const legL = leg(-0.16), legR = leg(0.16);

  // The torso is a layered uniform + plate carrier rather than one team-
  // colored cube. Keep the neutral plate narrower than the uniform and use a
  // broad team-color panel on its face: at combat distance the old dark belt,
  // twin pouches, gloves, and gun merged into one black mass.
  const torso = new THREE.Group();
  torso.position.y = 0.70;
  box(0.52, 0.25, 0.31, cloth, 0, 0.12, 0, torso);
  box(0.62, 0.38, 0.35, cloth, 0, 0.42, 0, torso);
  box(0.49, 0.31, 0.38, armor, 0, 0.39, -0.035, torso);
  box(0.34, 0.17, 0.026, cloth, 0, 0.42, -0.232, torso); // readable team panel
  box(0.58, 0.10, 0.37, armorDark, 0, 0.03, 0, torso); // belt

  // Class identity remains attached to the torso even while the soldier has
  // a spade, block, or grenade out. The weapon is still the primary read;
  // these restrained rear/side shapes make the silhouette survive occlusion
  // without painting class information onto the uniform.
  const rifleKit = new THREE.Group();
  box(0.36, 0.38, 0.18, armor, 0, 0.36, 0.25, rifleKit);
  if (detail) {
    box(0.28, 0.09, 0.21, armorDark, 0, 0.58, 0.21, rifleKit);
    box(0.05, 0.34, 0.035, armorDark, -0.11, 0.36, 0.35, rifleKit);
    box(0.05, 0.34, 0.035, armorDark, 0.11, 0.36, 0.35, rifleKit);
  }

  const smgKit = new THREE.Group();
  box(0.27, 0.24, 0.14, armor, 0, 0.34, 0.23, smgKit); // compact assault pack
  box(0.10, 0.15, 0.12, armorDark, -0.27, 0.09, 0.18, smgKit);
  box(0.10, 0.15, 0.12, armorDark, 0.27, 0.09, 0.18, smgKit);
  if (detail) {
    for (const x of [-0.11, 0, 0.11])
      box(0.055, 0.14, 0.035, metal, x, 0.34, -0.238, smgKit);
  }

  const sniperKit = new THREE.Group();
  box(0.25, 0.50, 0.14, armor, 0, 0.38, 0.24, sniperKit); // tall, narrow pack
  box(0.36, 0.11, 0.17, armorDark, 0, 0.10, 0.24, sniperKit); // bedroll
  if (detail) {
    const strap = box(0.05, 0.46, 0.026, armorDark, 0.09, 0.40, -0.239, sniperKit);
    strap.rotation.z = -0.38;
  }
  if (fineDetail)
    box(0.032, 0.38, 0.032, metal, 0.14, 0.74, 0.27, sniperKit); // radio antenna
  torso.add(rifleKit, smgKit, sniperKit);
  g.add(torso);

  // Articulated arms: sleeves, armored forearms, and gloves share one
  // shoulder pivot apiece, so they still work with the old walk animation.
  const arm = x => {
    const root = new THREE.Group();
    root.position.set(x, 1.26, 0);
    box(0.18, 0.30, 0.21, cloth, 0, -0.15, 0, root);
    box(0.17, 0.25, 0.19, armor, 0, -0.42, 0, root);
    box(0.18, 0.14, 0.20, dark, 0, -0.61, 0, root);
    if (detail) box(0.08, 0.13, 0.05, cloth, x < 0 ? -0.11 : 0.11, -0.12, -0.12, root);
    g.add(root);
    return root;
  };
  const armL = arm(-0.39), armR = arm(0.39);
  armL.rotation.z = 0.25;
  armR.rotation.z = -0.25;

  // Keep the face as one clean voxel plane. The earlier eyes/nose/chin line
  // read as a smiley face at gameplay distance and fought the deliberately
  // simple, anonymous soldier style. Helmet parts remain in this articulated
  // assembly so they still move together during crouch/death.
  const head = new THREE.Group();
  head.position.y = 1.43;
  box(0.37, 0.35, 0.35, skin, 0, 0, 0, head);
  box(0.39, 0.18, 0.37, armor, 0, 0.24, 0.01, head);
  const brim = box(0.45, 0.07, 0.43, armorDark, 0, 0.15, -0.02, head);
  box(0.40, 0.06, 0.39, cloth, 0, 0.20, 0, head); // team helmet band
  g.add(head);

  // World-model guns are compact voxel builds in the same family as the
  // first-person redesign. Only one child assembly is visible at a time, so
  // hidden alternatives cost no draw calls.
  const gun = new THREE.Group();
  gun.position.set(0.10, 1.02, -0.28);
  const rifle = new THREE.Group(), smg = new THREE.Group(), sniper = new THREE.Group();
  gun.add(rifle, smg, sniper);
  const wp = (parent, w, h, d, mat, x, y, z) => box(w, h, d, mat, x, y, z, parent);
  // Rifle: full stock, receiver, magazine, barrel, and low sights.
  wp(rifle, 0.19, 0.18, 0.44, dark, 0, 0, -0.10);
  wp(rifle, 0.21, 0.20, 0.30, armorDark, 0, 0.01, 0.27);
  wp(rifle, 0.07, 0.07, 0.50, metal, 0, 0.02, -0.56);
  wp(rifle, 0.11, 0.10, 0.13, dark, 0, 0.02, -0.86);
  wp(rifle, 0.14, 0.25, 0.16, armorDark, 0, -0.18, -0.10);
  if (detail) wp(rifle, 0.08, 0.09, 0.08, metal, 0, 0.14, -0.20);
  // SMG: short barrel, tall box magazine, compact folding stock.
  wp(smg, 0.22, 0.22, 0.38, dark, 0, 0, -0.08);
  wp(smg, 0.10, 0.10, 0.24, metal, 0, 0.01, -0.38);
  wp(smg, 0.14, 0.28, 0.15, armorDark, 0, -0.20, -0.08);
  wp(smg, 0.08, 0.08, 0.34, armorDark, 0, 0.03, 0.28);
  wp(smg, 0.20, 0.08, 0.10, armorDark, 0, 0.03, 0.48);
  wp(smg, 0.09, 0.09, 0.08, metal, 0, 0.16, -0.10);
  // Sniper: long floated barrel, stock, bipod block, and raised scope.
  wp(sniper, 0.19, 0.17, 0.48, dark, 0, 0, -0.08);
  wp(sniper, 0.24, 0.22, 0.38, armorDark, 0, 0.01, 0.34);
  wp(sniper, 0.06, 0.06, 0.78, metal, 0, 0.02, -0.69);
  wp(sniper, 0.11, 0.10, 0.18, dark, 0, 0.02, -1.17);
  wp(sniper, 0.15, 0.15, 0.45, lens, 0, 0.20, -0.13);
  wp(sniper, 0.20, 0.19, 0.08, dark, 0, 0.20, -0.34);
  wp(sniper, 0.20, 0.19, 0.08, dark, 0, 0.20, 0.06);
  wp(sniper, 0.16, 0.22, 0.16, armorDark, 0, -0.17, -0.05);
  g.add(gun);

  // The spade and carried utility items occupy the same right-hand zone.
  const spade = new THREE.Group();
  box(0.06, 0.06, 0.62, wood, 0, 0, -0.22, spade);
  box(0.24, 0.27, 0.06, metal, 0, -0.03, -0.58, spade);
  box(0.22, 0.06, 0.07, dark, 0, 0, 0.12, spade);
  spade.position.set(0.20, 1.02, -0.18);
  spade.visible = false;
  g.add(spade);
  const block = new THREE.Group();
  box(0.34, 0.34, 0.34, cloth, 0, 0, 0, block);
  box(0.22, 0.06, 0.36, armorDark, 0, 0.08, 0, block);
  block.position.set(0.20, 0.88, -0.38); block.visible = false; g.add(block);
  const grenade = new THREE.Group();
  box(0.22, 0.28, 0.22, armorDark, 0, 0, 0, grenade);
  box(0.12, 0.08, 0.12, metal, 0, 0.18, 0, grenade);
  box(0.06, 0.12, 0.14, dark, 0.08, 0.22, 0, grenade);
  grenade.position.set(0.22, 0.86, -0.35); grenade.visible = false; g.add(grenade);

  const blob = blobShadow();
  g.add(blob);

  const parts = { group: g, legL, legR, armL, armR, head, torso, gun,
    rifle, smg, sniper, rifleKit, smgKit, sniperKit,
    spade, block, grenade, blob, brim };
  setSoldierTool(parts, 0);
  return parts;
}

export function setSoldierTool(parts, tool) {
  const gun = parts?.gun, spade = parts?.spade;
  if (!gun || !spade) return;
  spade.visible = tool === 2;
  parts.block.visible = tool === 3;
  parts.grenade.visible = tool === 4;
  gun.visible = tool === 0 || tool === 1 || tool === 5;
  parts.rifle.visible = tool === 0;
  parts.smg.visible = tool === 1;
  parts.sniper.visible = tool === 5;
  if (tool === 0 || tool === 1 || tool === 5) parts.gunClass = tool;
  const gunClass = parts.gunClass ?? 0;
  parts.rifleKit.visible = gunClass === 0;
  parts.smgKit.visible = gunClass === 1;
  parts.sniperKit.visible = gunClass === 5;
}

// A floating callsign: crisp canvas sprite riding above the helmet. It's an
// ordinary depth-tested scene object, so terrain occludes it exactly when the
// soldier underneath is hidden — you never read a name through a hill.
export function makeNametag(name, team) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 56;
  const g2 = c.getContext('2d');
  g2.font = '700 30px system-ui, sans-serif';
  g2.textAlign = 'center';
  g2.fillStyle = team === 'blue' ? '#a8bcff' : '#b5ecb5';
  g2.fillText(name, 128, 38);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c), depthWrite: false,
  }));
  s.scale.set(2.2, 0.48, 1);
  s.position.y = 2.15;
  return s;
}

// Crouch pose: legs squash and everything above the hips drops. The gameplay
// eye and head-hit sphere now meet the visible face at y=1.13, while the
// helmet remains inside the head sphere rather than being a phantom target.
export function setCrouch(parts, on) {
  if (!!parts.crouched === on) return;
  parts.crouched = on;
  parts.legL.scale.y = parts.legR.scale.y = on ? 0.56 : 1;
  parts.legL.position.y = parts.legR.position.y = on ? 0.39 : 0.69;
  parts.torso.position.y = on ? 0.40 : 0.70;
  parts.armL.position.y = parts.armR.position.y = on ? 0.96 : 1.26;
  parts.head.position.y = on ? CROUCH_HEIGHT - EYE_INSET : 1.43;
  parts.gun.position.y = on ? 0.72 : 1.02;
  parts.spade.position.y = on ? 0.72 : 1.02;
  parts.block.position.y = on ? 0.58 : 0.88;
  parts.grenade.position.y = on ? 0.56 : 0.86;
}

// Shared walk-cycle animation for player-less bodies.
export function animateSoldier(parts, speed, t) {
  const swing = Math.min(1, speed / 4) * 0.7;
  const s = Math.sin(t * 9) * swing;
  parts.legL.rotation.x = s;
  parts.legR.rotation.x = -s;
  // Armed soldiers keep both hands pitched toward the weapon; an exposed
  // spade/utility item relaxes back into the stronger opposing-arm walk.
  if (parts.gun.visible) {
    parts.armL.rotation.x = 0.52 - s * 0.16;
    parts.armR.rotation.x = 0.62 + s * 0.16;
  } else {
    parts.armL.rotation.x = -s * 0.8;
    parts.armR.rotation.x = s * 0.8;
  }
}

// Death tumble, t seconds since the killing blow: keel over backward around
// the feet, lie still a beat, then sink into the dirt and vanish.
export function animateDeath(parts, t) {
  if (parts.blob) parts.blob.visible = false; // shadows don't tumble
  const g = parts.group;
  const fall = Math.min(1, t / 0.3);
  g.rotation.x = -Math.PI / 2 * fall * (2 - fall); // ease-out tip-over
  if (g.userData.deathY === undefined) g.userData.deathY = g.position.y;
  g.position.y = g.userData.deathY - Math.max(0, t - 0.85) * 2.2;
  if (t > 1.35) g.visible = false;
}

// Back on your feet — called on respawn before the next update tick.
export function resetDeath(parts) {
  parts.group.rotation.x = 0;
  parts.group.userData.deathY = undefined;
  if (parts.blob) parts.blob.visible = true;
}

// Remove an object from its parent and release all GPU resources below it.
export function disposeObject(root) {
  root.removeFromParent();
  root.traverse(o => {
    if (o.userData.shared) return; // shared geometry/material outlives any one soldier
    o.geometry?.dispose();
    if (o.material) {
      o.material.map?.dispose();
      o.material.dispose();
    }
  });
}
