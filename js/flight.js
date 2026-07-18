// flight.js — arcade flight model, carrier ops, ground roll, collisions
import * as THREE from 'three';
import { clamp, lerp, damp, KTS, FT, flightQuat, wrapAngle } from './util.js';
import { groundHeight } from './world.js';
import { buildModel } from './models.js';

export const PLANES = {
  f18: { label: 'F/A-18 HORNET', maxThrust: 14.0, abBoost: 11.0, dragK: 0.000105, maxRoll: 3.4,
         gMax: 10, stall: 62, rotate: 72, fuel: 10800, burnMil: 0.85, burnAB: 7.0 },
  f16: { label: 'F-16 FALCON',   maxThrust: 13.0, abBoost: 10.0, dragK: 0.000100, maxRoll: 4.6,
         gMax: 11, stall: 58, rotate: 68, fuel: 7100, burnMil: 0.7, burnAB: 6.0 },
};

const _e = new THREE.Euler(), _dq = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

export class Player {
  constructor(scene, world) {
    this.scene = scene; this.world = world;
    this.model = null; this.type = 'f18';
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.reset({ plane: 'f18' });
  }
  reset(cfg) {
    if (this.model) this.scene.remove(this.model);
    this.type = cfg.plane || 'f18';
    this.cfg = PLANES[this.type];
    this.model = buildModel(this.type);
    this.scene.add(this.model);
    this.throttle = 0; this.ab = false;
    this.pitchRate = 0; this.rollRate = 0; this.yawRate = 0;
    this.gearDown = true; this.hookDown = false; this.brakes = true; this.ecm = false;
    this.fuel = this.cfg.fuel; this.damage = 0; this.gForce = 1;
    this.stores = { aim9: 2, aim120: 4, gun: 500, chaff: 14, flares: 14 };
    this.weapon = 'aim120';
    this.dead = false; this.ejected = false; this.stalled = false; this.modelDown = false;
    this.onGround = null; this.deckLocal = null; this.smokeT = 0; this.contrailT = 0;
    this.crashTimer = 0; this.spinDir = 1;
    this.vel.set(0, 0, 0);
    if (cfg.onCarrier) {
      const c = this.world.carrier;
      this.onGround = { type: 'carrier', speedRel: 0 };
      this.deckLocal = new THREE.Vector3(cfg.deckX ?? -6, 2.2, cfg.deckZ ?? -120);
      this.heading = c.heading; this.pitch = 0; this.bank = 0;
      const w = carrierLocalToWorld(c, this.deckLocal.x, this.deckLocal.y, this.deckLocal.z);
      this.pos.copy(w);
      this.quat.copy(flightQuat(this.heading, 0, 0));
    } else if (cfg.runway) {
      const rw = cfg.runway;
      this.onGround = { type: 'runway', rw, speedRel: 0 };
      this.heading = rw.hdg; this.pitch = 0; this.bank = 0;
      this.pos.set(rw.x - Math.sin(rw.hdg) * rw.len * 0.4, rw.elev + 2.2, rw.z + Math.cos(rw.hdg) * rw.len * 0.4);
      this.quat.copy(flightQuat(this.heading, 0, 0));
    } else {
      this.onGround = null;
      this.pos.copy(cfg.pos || new THREE.Vector3(-24000, 800, 14000));
      this.heading = cfg.heading ?? Math.PI / 2; this.pitch = 0; this.bank = 0;
      this.quat.copy(flightQuat(this.heading, 0, 0));
      const sp = cfg.speed ?? 150;
      this.vel.set(Math.sin(this.heading) * sp, 0, -Math.cos(this.heading) * sp);
      this.throttle = 0.8; this.brakes = false; this.gearDown = false;
    }
    this._syncVisual(0);
  }
  get speed() { return this.vel.length(); }
  get speedKts() { return this.speed / KTS; }
  get altFt() { return this.pos.y / FT; }
  get fwd() { return _v.set(0, 0, 1).applyQuaternion(this.quat); }
  headingDeg() { return ((Math.atan2(this.vel.x, -this.vel.z) * 180 / Math.PI) + 360) % 360; }

  update(dt, inp, G) {
    if (this.ejected) { this._updateBallistic(dt, G); return; }
    if (this.dead) { this._updateDead(dt, G); return; }
    // throttle
    this.throttle = clamp(this.throttle + inp.throttleDelta * dt * 0.6, 0, 1);
    this.ab = inp.ab && this.throttle > 0.5 && this.fuel > 0;
    // fuel
    const burn = this.throttle * this.cfg.burnMil * (this.onGround ? 0.6 : 1) + (this.ab ? this.cfg.burnAB : 0);
    this.fuel = Math.max(0, this.fuel - burn * dt);
    if (this.onGround) this._updateGround(dt, inp, G);
    else this._updateAir(dt, inp, G);
    this._syncVisual(dt, inp);
  }

  // ---------------- ground (deck / runway) ----------------
  _updateGround(dt, inp, G) {
    const og = this.onGround;
    const cfg = this.cfg;
    const carrier = og.type === 'carrier' ? this.world.carrier : null;
    const thrustA = cfg.maxThrust * this.throttle + (this.ab ? cfg.abBoost : 0);
    const brakeA = this.brakes ? (og.trapped ? 34 : 9) : 0;
    og.speedRel = Math.max(0, og.speedRel + (thrustA - brakeA - 0.4) * dt * (this.fuel > 0 ? 1 : 0));
    // rolling friction stops the jet when throttle idle
    if (this.throttle < 0.02 && !this.brakes) og.speedRel = Math.max(0, og.speedRel - 1.2 * dt);
    const dir = _v.set(Math.sin(this.heading), 0, -Math.cos(this.heading));
    if (og.type === 'carrier') {
      const c = carrier;
      this.deckLocal.z += og.speedRel * dt;
      const w = carrierLocalToWorld(c, this.deckLocal.x, this.deckLocal.y, this.deckLocal.z);
      this.pos.copy(w);
      // ran off the bow?
      if (this.deckLocal.z > c.deckHalfLen + 4) {
        this.onGround = null;
        this.vel.copy(dir).multiplyScalar(og.speedRel).add(c.deckVelWorld(_v2));
        if (og.speedRel < cfg.stall) { this.vel.y = -2; } // settle into the sea
        G.msg('OFF THE BOW!', 'warn');
      }
    } else {
      const rw = og.rw;
      // rudder steering at low speed
      this.heading = wrapAngle(this.heading + inp.yaw * 0.25 * dt * clamp(og.speedRel / 20, 0, 1));
      dir.set(Math.sin(this.heading), 0, -Math.cos(this.heading));
      this.pos.addScaledVector(dir, og.speedRel * dt);
      this.pos.y = rw.elev + 2.2;
      // ran off runway end?
      const dx = this.pos.x - rw.x, dz = this.pos.z - rw.z;
      const along = dx * Math.sin(rw.hdg) - dz * Math.cos(rw.hdg);
      const cross = dx * Math.cos(rw.hdg) + dz * Math.sin(rw.hdg);
      if (Math.abs(along) > rw.len / 2 + 200 || Math.abs(cross) > rw.wid) {
        // off into the dirt — stop safely
        og.speedRel = Math.max(0, og.speedRel - 12 * dt);
        this.pos.y = groundHeight(this.pos.x, this.pos.z) + 2.2;
      }
      if (og.speedRel === 0 && this.throttle < 0.05) {
        // parked: rearm & refuel
        if (this.fuel < cfg.fuel || this.stores.aim9 < 2) {
          this.fuel = cfg.fuel; this.stores.aim9 = 2; this.stores.aim120 = 4; this.stores.gun = 500;
          this.stores.chaff = 14; this.stores.flares = 14;
          G.msg(rw.name + ': REARMED & REFUELED', 'good');
        }
      }
    }
    // rotate -> lift off
    if (og.speedRel > cfg.rotate && inp.pitch > 0.35) {
      const cv = carrier ? carrier.deckVelWorld(_v2) : _v2.set(0, 0, 0);
      this.vel.copy(dir).multiplyScalar(og.speedRel).add(cv);
      this.vel.y += 4;
      this.onGround = null;
      this.pitch = 0.12;
      G.msg('AIRBORNE', 'good');
      G.audio.gear();
    }
    this.quat.copy(flightQuat(this.heading, 0, 0));
  }

  // ---------------- airborne ----------------
  _updateAir(dt, inp, G) {
    const cfg = this.cfg;
    const speed = this.speed;
    const fwd = this.fwd.clone();
    const rho = Math.exp(-this.pos.y / 9500);
    // ---- speed dynamics
    const hasFuel = this.fuel > 0;
    const dmgFactor = this.damage > 60 ? 0.65 : 1;
    let thrustA = hasFuel ? (cfg.maxThrust * this.throttle + (this.ab ? cfg.abBoost : 0)) * (0.35 + 0.65 * rho) * dmgFactor : 0;
    let drag = cfg.dragK * rho * speed * speed;
    if (this.gearDown) drag += cfg.dragK * rho * speed * speed * 0.9 + 0.5;
    if (this.brakes) drag += cfg.dragK * rho * speed * speed * 1.4; // speedbrake
    const gAlong = -9.81 * fwd.y;
    let newSpeed = Math.max(0, speed + (thrustA - drag + gAlong) * dt);
    // ---- control rates
    const authority = clamp(newSpeed / cfg.stall, 0.12, 1);
    const pitchMax = Math.min(1.05, cfg.gMax * 9.81 / Math.max(newSpeed, 75)) * authority;
    const rollMax = cfg.maxRoll * clamp(newSpeed / 90, 0.25, 1);
    this.stalled = newSpeed < cfg.stall && this.pos.y > 5;
    let pitchIn = inp.pitch * pitchMax;
    if (this.stalled) pitchIn -= 0.5 * (1 - newSpeed / cfg.stall); // nose drops
    this.pitchRate = damp(this.pitchRate, -pitchIn, 7, dt);           // -X = nose up
    this.rollRate  = damp(this.rollRate, -inp.roll * rollMax, 7, dt); // -Z = right roll
    this.yawRate   = damp(this.yawRate, inp.yaw * 0.35 * authority, 6, dt);
    _e.set(this.pitchRate * dt, this.yawRate * dt, this.rollRate * dt, 'XYZ');
    _dq.setFromEuler(_e);
    this.quat.multiply(_dq).normalize();
    // ---- velocity aligns to nose (coordinated arcade model)
    const newFwd = _v.set(0, 0, 1).applyQuaternion(this.quat);
    const alignRate = 3.2 * clamp(newSpeed / cfg.stall * 0.55, 0.18, 1);
    const curDir = _v2.copy(this.vel).normalize();
    if (curDir.lengthSq() < 0.5) curDir.copy(newFwd);
    curDir.lerp(newFwd, 1 - Math.exp(-alignRate * dt)).normalize();
    this.vel.copy(curDir).multiplyScalar(newSpeed);
    if (this.stalled) this.vel.y -= 9.81 * Math.pow(1 - newSpeed / cfg.stall, 2) * 3.2 * dt;
    // G estimate for HUD / blackout / contrails
    this.gForce = 1 + Math.abs(this.pitchRate) * newSpeed / 9.81 * 0.9;
    this.pos.addScaledVector(this.vel, dt);
    this._collide(G);
  }

  _collide(G) {
    const p = this.pos;
    const carrier = this.world.carrier;
    // --- carrier deck touchdown
    const loc = carrier.toLocal(p, _v);
    if (Math.abs(loc.x) < carrier.deckHalfWid && loc.z > -carrier.deckHalfLen - 10 && loc.z < carrier.deckHalfLen + 10) {
      if (loc.y < 2.6 && loc.y > -3) {
        // over the deck — attempt trap / bolter / deck landing
        const dv = carrier.deckVelWorld(_v2);
        const relV = this.vel.clone().sub(dv);
        const vy = this.vel.y;
        if (vy < 1.5 && relV.length() < 105 && this.gearDown) {
          if (this.hookDown && loc.z > -60) {
            // TRAP!
            this.onGround = { type: 'carrier', speedRel: relV.length() * 0.999, trapped: true };
            this.deckLocal = new THREE.Vector3(loc.x, 2.2, loc.z);
            this.heading = carrier.heading;
            this.throttle = 0; this.brakes = true;
            G.onTrapped();
            return;
          } else {
            // bolter / no hook — touch and go, weak brakes
            this.onGround = { type: 'carrier', speedRel: relV.length() };
            this.deckLocal = new THREE.Vector3(loc.x, 2.2, Math.max(loc.z, -carrier.deckHalfLen + 1));
            this.heading = carrier.heading;
            G.msg('BOLTER! NO WIRE — FULL POWER, GO AROUND!', 'warn');
            return;
          }
        } else if (!this.gearDown && vy < 1) {
          G.onCrashed('GEAR-UP DECK LANDING');
          return;
        }
      } else if (loc.y <= -3 && loc.y > -24) {
        G.onCrashed('HIT THE CARRIER HULL');
        return;
      }
    }
    // carrier island
    if (!carrier.isSub) {
      const il = carrier.toLocal(p, _v);
      if (Math.abs(il.x + 30) < 9 && Math.abs(il.z - 30) < 17 && il.y < 42 && il.y > -3) {
        G.onCrashed('HIT THE ISLAND'); return;
      }
    }
    // --- runway touchdown
    if (this.vel.y < 2) {
      for (const rw of this.world.runways) {
        const dx = p.x - rw.x, dz = p.z - rw.z;
        const along = dx * Math.sin(rw.hdg) - dz * Math.cos(rw.hdg);
        const cross = dx * Math.cos(rw.hdg) + dz * Math.sin(rw.hdg);
        if (Math.abs(along) < rw.len / 2 + 60 && Math.abs(cross) < rw.wid / 2 + 18 && p.y < rw.elev + 3.0) {
          if (this.vel.y > -11 && this.gearDown && this.speed < 110) {
            this.onGround = { type: 'runway', rw, speedRel: this.speed };
            this.heading = Math.atan2(this.vel.x, -this.vel.z);
            this.throttle = Math.min(this.throttle, 0.3);
            this.vel.y = 0;
            G.msg('TOUCHDOWN — ' + rw.name, 'good');
            G.audio.trap();
          } else if (!this.gearDown) { G.onCrashed('GEAR-UP LANDING'); }
          else if (this.vel.y <= -11) { G.onCrashed('HARD LANDING'); }
          return;
        }
      }
    }
    // --- terrain / water
    const gh = groundHeight(p.x, p.z);
    if (gh < -2) { if (p.y < 1.6) { G.onCrashed('DITCHED IN THE SEA'); return; } }
    else if (p.y < gh + 2.0) { G.onCrashed('TERRAIN IMPACT'); return; }
    // --- buildings / bridges
    if (p.y < 700) {
      const cols = this.world.colliders;
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        if (p.x > c.min.x && p.x < c.max.x && p.y > c.min.y && p.y < c.max.y && p.z > c.min.z && p.z < c.max.z) {
          G.onCrashed('STRUCTURE IMPACT'); return;
        }
      }
    }
  }

  _updateDead(dt, G) {
    // uncontrolled spin down, trailing smoke
    this.crashTimer += dt;
    _e.set(0.8 * dt, 0.3 * dt, this.spinDir * 2.6 * dt, 'XYZ');
    _dq.setFromEuler(_e); this.quat.multiply(_dq).normalize();
    this.vel.y -= 9.81 * dt * 0.8;
    this.vel.multiplyScalar(1 - 0.12 * dt);
    this.pos.addScaledVector(this.vel, dt);
    const gh = groundHeight(this.pos.x, this.pos.z);
    if (this.pos.y < gh + 2) G.onCrashed('SHOT DOWN');
  }
  _updateBallistic(dt, G) {
    if (this.modelDown) return;
    this.vel.y -= 9.81 * dt;
    this.pos.addScaledVector(this.vel, dt);
    _e.set(0.5 * dt, 0, 1.2 * dt, 'XYZ'); _dq.setFromEuler(_e); this.quat.multiply(_dq).normalize();
    const gh = groundHeight(this.pos.x, this.pos.z);
    if (this.pos.y < gh + 2) { this.modelDown = true; G.onEmptyPlaneDown(); }
  }

  _syncVisual(dt, inp = {}) {
    this.model.position.copy(this.pos);
    this.model.quaternion.copy(this.quat);
    const u = this.model.userData;
    if (u.gear) u.gear.visible = this.gearDown;
    if (u.hook) u.hook.visible = this.hookDown;
    for (const f of u.ab) {
      f.visible = this.ab && !this.dead;
      if (f.visible) { const s = 0.8 + Math.random() * 0.5; f.scale.set(s, s, 0.8 + Math.random() * 0.8); }
    }
    if (u.stabL) { const a = (inp.pitch || 0) * -0.5; u.stabL.rotation.x = a; u.stabR.rotation.x = a; }
    // store visuals
    if (u.stores) {
      u.stores.aim9.forEach((m, i) => m.visible = i < this.stores.aim9);
      u.stores.aim120.forEach((m, i) => m.visible = i < this.stores.aim120);
    }
  }
}

// helper kept here to match world.Carrier convention
export function carrierLocalToWorld(c, lx, ly, lz, out = new THREE.Vector3()) {
  const ch = Math.cos(c.heading), sh = Math.sin(c.heading);
  out.set(-lx * ch + lz * sh, ly + c.deckY + c.group.position.y, -lx * sh - lz * ch);
  out.x += c.group.position.x; out.z += c.group.position.z;
  return out;
}
