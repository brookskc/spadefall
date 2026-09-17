// remote-player.js — the host-side lifecycle for one connected human.
import { Avatar } from './avatar.js';
import { Body, STAND_HEIGHT } from './entities.js';
import { teamHex } from './settings.js';
import { resetEnvironmentalState } from './environment.js';
import { TOOLS } from './player.js';

export class RemotePlayer {
  constructor(game, id, name, team) {
    this.game = game;
    this.id = id;
    this.name = name;
    this.team = team;
    this.isRemote = true;
    const p = game.spawnPoint(team);
    this.body = new Body(game.world, p.x, p.y, p.z);
    this.health = 100;
    this.alive = true;
    this.protT = 3;
    this._spawnedAt = game.time;
    resetEnvironmentalState(this);
    this.carrier = false;
    this.blocks = 50;
    this.tool = 0;
    this.gunClass = 0;
    this._pendingClass = 0;
    this._spawnPreference = 'front';
    this.yaw = team === 'green' ? -Math.PI / 2 : Math.PI / 2;
    this.nades = 3;
    this.nadeRegen = 0;
    this._actT = {};
    this.ammo = TOOLS.map(t => t.mag ?? 0);
    this._reloadUntil = 0;
    this._lastActionSeq = 0;
    this._life = 1;
    this.avatar = new Avatar(game.scene, team, name, team === game.player.team);
    this.avatar.push(p.x, p.y, p.z, this.yaw);
  }

  die(killer) {
    this.alive = false;
    this._mkCount = 0; this._mkT = null;
    this._streak = 0;
    this._lastAimDir = null; this._lastAimT = null;
    this._lastNadeAimDir = null; this._lastNadeAimT = null;
    this._reloadUntil = 0;
    this.game.effects.burst(this.body.eye(), 26, teamHex(this.team), 6);
    const redeploy = this.game.onDeath(this, killer);
    this.game.net.sendTo(this.id, { t: 'e', k: 'died', rt: redeploy,
      recap: this.game.engagementFeatures.deathRecap ? this._lastDeathRecap : undefined });
  }

  respawn(at = null, notify = true) {
    this._life++;
    const p = at ?? this.game.spawnPoint(this.team, this._spawnPreference);
    this._spawnPreference = 'front';
    this.body.pos.set(p.x, p.y, p.z);
    this.body.vel.set(0, 0, 0);
    this.body.half.h = STAND_HEIGHT;
    this.body.voidFall = false;
    resetEnvironmentalState(this);
    this.health = 100;
    this.alive = true;
    this._spawnedAt = this.game.time;
    this.carrier = false;
    this.blocks = 50;
    this.nades = 3;
    this.nadeRegen = 0;
    this.crouched = false;
    this.protT = 3;
    this.gunClass = this._pendingClass;
    this.tool = this.gunClass;
    this._actT = {};
    this.ammo = TOOLS.map(t => t.mag ?? 0);
    this._reloadUntil = 0;
    this._lastAimDir = null; this._lastAimT = null;
    this._lastNadeAimDir = null; this._lastNadeAimT = null;
    this._mkCount = 0; this._mkT = null;
    this._streak = 0;
    this._airMove = null;
    this._movementBudget = null;
    this._lastDeathRecap = null;
    this._lastPosT = null;
    this.yaw = this.team === 'green' ? -Math.PI / 2 : Math.PI / 2;
    this.avatar.setAlive(true);
    this.avatar.push(p.x, p.y, p.z, this.yaw);
    if (notify) this.game.net.sendTo(this.id, { t: 'e', k: 'spawn',
      x: p.x, y: p.y, z: p.z, yaw: this.team === 'green' ? 0 : Math.PI,
      life: this._life });
  }

  resetForRound() {
    this.avatar.dispose();
    this.avatar = new Avatar(this.game.scene, this.team, this.name,
      this.team === this.game.player.team);
    this.respawn(null, true);
  }
}
