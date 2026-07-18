// ai.js — AI aircraft: waypoint routes, intercept, evade, attack, landing, cruise missiles
import * as THREE from 'three';
import { clamp, lerp, damp, wrapAngle, flightQuat, rand, KTS } from './util.js';
import { groundHeight } from './world.js';
import { buildModel } from './models.js';

const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Euler(), _dq = new THREE.Quaternion();

export class AIAircraft {
  constructor(scene, world, type, opts = {}) {
    this.scene = scene; this.world = world; this.type = type;
    this.model = buildModel(type);
    scene.add(this.model);
    this.pos = this.model.position;
    this.pos.copy(opts.pos || new THREE.Vector3());
    this.heading = opts.heading ?? 0;
    this.speed = opts.speed ?? 220;
    this.targetSpeed = this.speed;
    this.hp = opts.hp ?? (type === 'b747' ? 400 : type === 'cruise' ? 60 : 100);
    this.hostile = opts.hostile ?? false;
    this.identified = false;
    this.name = opts.name || type.toUpperCase();
    this.mode = opts.mode || 'route';
    this.waypoints = opts.waypoints || [];
    this.wpIndex = 0; this.loop = opts.loop ?? false;
    this.agility = opts.agility ?? 1.0;      // turn-rate multiplier
    this.skill = opts.skill ?? 1.0;          // evade/attack skill
    this.target = null;                      // attack target (AIAircraft or Player)
    this.fireCooldown = rand(2, 5);
    this.evasionT = 0; this.evadeDir = null; this.flareT = -9; this.chaffT = -9;
    this.dead = false; this.removeMe = false; this.deadT = 0;
    this.landed = false; this.landSpeed = 0;
    this.bank = 0; this.pitch = 0;
    this.terrainFollow = opts.terrainFollow ?? false;
    this.gunsOnly = opts.gunsOnly ?? false;
    this.noEvade = opts.noEvade ?? false;
    this.onEvent = opts.onEvent || null;     // cb(name, data) for missions
    this.quat = new THREE.Quaternion();
    this.quat.copy(flightQuat(this.heading, 0, 0));
    this.vel = new THREE.Vector3();
    this._syncVel();
    this.spinDir = Math.random() < 0.5 ? 1 : -1;
  }
  _syncVel() {
    this.vel.set(Math.sin(this.heading) * Math.cos(this.pitch) * this.speed,
                 Math.sin(this.pitch) * this.speed,
                 -Math.cos(this.heading) * Math.cos(this.pitch) * this.speed);
  }
  get alive() { return !this.dead; }
  fwd(out = _v) { return out.set(Math.sin(this.heading) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.heading) * Math.cos(this.pitch)); }

  // steer current heading/pitch toward desired direction, limited turn rate
  _steerToward(dir, dt, turnMul = 1) {
    const f = this.fwd(_v);
    const angle = f.angleTo(dir);
    if (angle > 1e-4) {
      const maxTurn = clamp(7.5 * 9.81 / Math.max(this.speed, 60), 0.25, 1.35) * this.agility * turnMul;
      const t = Math.min(1, maxTurn * dt / angle);
      f.lerp(dir, t).normalize();
      this.heading = Math.atan2(f.x, -f.z);
      this.pitch = Math.asin(clamp(f.y, -1, 1));
      // bank into the turn (visual)
      const cross = _d.set(f.x, 0, f.z).cross(dir).y;
      this.bank = damp(this.bank, clamp(-angle * Math.sign(cross || 1) * 1.2, -1.2, 1.2), 3, dt);
    } else {
      this.bank = damp(this.bank, 0, 3, dt);
    }
  }

  update(dt, G) {
    if (this.dead) { this._updateDead(dt, G); return; }
    switch (this.mode) {
      case 'route': this._updateRoute(dt, G); break;
      case 'intercept': this._updateIntercept(dt, G); break;
      case 'attack': this._updateAttack(dt, G); break;
      case 'orbit': this._updateOrbit(dt, G); break;
      case 'land': this._updateLand(dt, G); break;
      case 'straight': this._updateStraight(dt, G); break;
    }
    // terrain following (cruise missile)
    if (this.terrainFollow) {
      const gh = groundHeight(this.pos.x, this.pos.z);
      const want = Math.max(gh + 58, 20);
      this.pos.y = damp(this.pos.y, want, 1.2, dt);
    }
    // flare/chaff timers age naturally by comparison with G.time
    this.speed = damp(this.speed, this.targetSpeed, 0.5, dt);
    this._syncVel();
    this.pos.addScaledVector(this.vel, dt);
    if (this.landed) this.pos.y = this.landY;
    // ground collision (non-landing)
    if (this.mode !== 'land') {
      const gh = groundHeight(this.pos.x, this.pos.z);
      if (this.pos.y < gh + 4 || this.pos.y < 2) {
        if (this.terrainFollow) this.pos.y = Math.max(gh + 4, 3);
        else this.kill(G, true);
      }
    }
    // evade when locked / missile inbound
    if (!this.noEvade && !this.dead && this.mode !== 'land') this._checkThreats(dt, G);
    this._syncModel(dt);
  }

  _updateRoute(dt, G) {
    if (!this.waypoints.length) return;
    const wp = this.waypoints[this.wpIndex];
    _d.set(wp.x - this.pos.x, wp.y - this.pos.y, wp.z - this.pos.z);
    const dist = _d.length();
    if (dist < Math.max(700, this.speed * 2.2)) {
      this.wpIndex++;
      if (this.wpIndex >= this.waypoints.length) {
        if (this.loop) this.wpIndex = 0;
        else { this.wpIndex = this.waypoints.length - 1; if (this.onEvent) this.onEvent('routeDone', this); }
      }
      if (this.onEvent) this.onEvent('waypoint', this);
    }
    _d.normalize();
    this._steerToward(_d, dt);
  }
  _updateIntercept(dt, G) {
    const t = this.target;
    if (!t || (t.dead) || (t.ejected)) { this.mode = 'route'; return; }
    // pure pursuit with lead
    const tv = t.vel || _d.set(0,0,0);
    _d.copy(t.pos).addScaledVector(tv, clamp(this.pos.distanceTo(t.pos) / 600, 0, 2.5)).sub(this.pos).normalize();
    this._steerToward(_d, dt);
    if (this.onEvent) this.onEvent('intercepting', this);
  }
  _updateAttack(dt, G) {
    const t = this.target;
    if (!t || t.dead || t.ejected) { this.mode = 'route'; this.target = null; return; }
    const dist = this.pos.distanceTo(t.pos);
    // pursue
    _d.copy(t.pos).addScaledVector(t.vel, clamp(dist / 600, 0, 2.5)).sub(this.pos).normalize();
    this._steerToward(_d, dt);
    this.targetSpeed = dist > 4000 ? 320 : 260;
    // fire?
    this.fireCooldown -= dt;
    const maxR = t.ecm ? 5200 : 11000;   // ECM jammer cuts their lock range
    if (this.fireCooldown <= 0 && !this.gunsOnly && dist > 1200 && dist < maxR) {
      const f = this.fwd(_v);
      _d.copy(t.pos).sub(this.pos).normalize();
      if (f.angleTo(_d) < 0.6) {
        G.fireEnemyMissile(this, t);
        this.fireCooldown = rand(9, 16) / this.skill;
      }
    }
  }
  _updateOrbit(dt, G) {
    const c = this.orbitCenter || this.waypoints[0];
    const r = this.orbitRadius || 6000;
    _d.set(this.pos.x - c.x, 0, this.pos.z - c.z);
    const ang = Math.atan2(_d.x, -_d.z) + 0.28;
    const nx = c.x + Math.sin(ang) * r, nz = c.z - Math.cos(ang) * r;
    _d.set(nx - this.pos.x, (c.y || this.pos.y) - this.pos.y, nz - this.pos.z).normalize();
    this._steerToward(_d, dt);
  }
  _updateLand(dt, G) {
    // follow waypoints to threshold, then roll out
    if (this.landed) {
      this.landSpeed = Math.max(0, this.landSpeed - 6 * dt);
      this.speed = this.landSpeed;
      this.pitch = 0;
      if (this.landSpeed <= 0 && this.onEvent) { this.onEvent('landed', this); this.onEvent = null; }
      return;
    }
    this._updateRoute(dt, G);
    const wp = this.waypoints[this.waypoints.length - 1];
    const d = Math.hypot(wp.x - this.pos.x, wp.z - this.pos.z);
    this.targetSpeed = clamp(d / 12, 65, this.speed);
    if (d < 120 && Math.abs(this.pos.y - wp.y) < 12) {
      this.landed = true; this.landSpeed = Math.max(60, this.speed);
      this.landY = wp.y;
      this.pos.y = wp.y;
      this.speed = this.landSpeed;
      if (this.onEvent) this.onEvent('touchdown', this);
    }
  }
  _updateStraight(dt, G) {
    _d.set(Math.sin(this.heading), 0, -Math.cos(this.heading));
    // gentle weave
    this.weaveT = (this.weaveT || 0) + dt;
    const w = Math.sin(this.weaveT * 0.5) * 0.08;
    _d.applyAxisAngle(new THREE.Vector3(0, 1, 0), w);
    this._steerToward(_d, dt, 0.6);
  }

  _checkThreats(dt, G) {
    // evade if player's missile is inbound on us, or player locked & close behind
    let threatened = false;
    for (const m of G.missiles) {
      if (!m.dead && m.target === this && m.pos.distanceTo(this.pos) < 6000) { threatened = 'missile'; break; }
    }
    if (!threatened && G.playerTarget === this && G.lockLevel > 0.6) {
      const toMe = _d.copy(this.pos).sub(G.player.pos);
      const dist = toMe.length();
      if (dist < 9000) {
        const pf = G.player.fwd;
        if (pf.angleTo(toMe.normalize()) < 0.5) threatened = 'locked';
      }
    }
    if (threatened) {
      this.evasionT -= dt;
      if (this.evasionT <= 0) {
        this.evasionT = rand(1.2, 2.4) / this.skill;
        const f = this.fwd(new THREE.Vector3());
        const ax = rand(0.7, 1.6) * (Math.random() < 0.5 ? 1 : -1);
        const ay = rand(-0.5, 0.5);
        this.evadeDir = f.applyAxisAngle(new THREE.Vector3(0, 1, 0), ax);
        this.evadeDir.y = clamp(this.evadeDir.y + ay, -0.5, 0.5);
        this.evadeDir.normalize();
        if (threatened === 'missile' && Math.random() < 0.5 * this.skill) this.flareT = G.time;
        if (threatened === 'missile' && Math.random() < 0.4 * this.skill) this.chaffT = G.time;
        if (this.onEvent) this.onEvent('evade', this);
      }
      if (this.evadeDir) this._steerToward(this.evadeDir, dt, 1.4);
      this.targetSpeed = 300;
    }
  }

  hit(dmg, G, byPlayer = true) {
    if (this.dead) return;
    this.hp -= dmg;
    if (this.onEvent) this.onEvent('hit', this);
    if (this.hp <= 0) this.kill(G, false, byPlayer);
    else if (this.hp < 45) this.smoking = true;
  }
  kill(G, silent = false, byPlayer = true) {
    if (this.dead) return;
    this.dead = true; this.deadT = 0;
    this.mode = 'dead';
    if (!silent && this.onEvent) this.onEvent('killed', { unit: this, byPlayer });
    G.onAircraftDown(this, byPlayer);
  }
  _updateDead(dt, G) {
    this.deadT += dt;
    // flat spin down with smoke & fire
    _e.set(0.9 * dt, 0.2 * dt, this.spinDir * 3.0 * dt, 'XYZ');
    _dq.setFromEuler(_e); this.quat.multiply(_dq).normalize();
    this.vel.y -= 9.81 * dt * 0.75;
    this.vel.multiplyScalar(1 - 0.1 * dt);
    this.pos.addScaledVector(this.vel, dt);
    if (Math.random() < 0.6) G.fx.smoke(this.pos, 0.8, 2.2, 0x333333);
    if (Math.random() < 0.35) G.fx.fire(this.pos, 0.5);
    const gh = groundHeight(this.pos.x, this.pos.z);
    if (this.pos.y < Math.max(gh, 0) + 3) {
      G.explode(this.pos, 1.2);
      this.removeMe = true;
    }
  }
  _syncModel(dt) {
    if (!this.dead) this.quat.copy(flightQuat(this.heading, this.pitch, this.bank));
    this.model.quaternion.copy(this.quat);
    const u = this.model.userData;
    if (u.ab) for (const f of u.ab) {
      f.visible = !this.dead && this.targetSpeed > 240;
      if (f.visible) { const s = 0.7 + Math.random() * 0.5; f.scale.set(s, s, 0.7 + Math.random() * 0.6); }
    }
    if (this.smoking && !this.dead && Math.random() < 0.25) {
      // light damage smoke handled by main via fx
    }
  }
  dispose() { this.scene.remove(this.model); }
}
