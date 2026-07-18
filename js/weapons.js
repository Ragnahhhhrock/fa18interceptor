// weapons.js — missiles, gun, countermeasures, explosions, particle FX
import * as THREE from 'three';
import { clamp, lerp, rand, randSpread } from './util.js';
import { makeGlowTexture, makeSmokeTexture } from './models.js';

const _v = new THREE.Vector3(), _d = new THREE.Vector3();

// ---------------- sprite particle pool ----------------
export class FXPool {
  constructor(scene) {
    this.scene = scene;
    this.glowTex = makeGlowTexture();
    this.smokeTex = makeSmokeTexture();
    this.parts = [];
    this.pool = [];
    for (let i = 0; i < 400; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.smokeTex, transparent: true, depthWrite: false }));
      s.visible = false; scene.add(s);
      this.pool.push({ s, life: 0, maxLife: 1, vel: new THREE.Vector3(), grow: 1, fade: 1, size0: 1, col: new THREE.Color() });
    }
  }
  spawn(pos, vel, life, size, color, additive, grow = 1, tex = null) {
    const p = this.pool.find(q => q.life <= 0);
    if (!p) return;
    p.life = p.maxLife = life; p.vel.copy(vel); p.grow = grow; p.size0 = size;
    p.s.material.map = tex || this.smokeTex;
    p.s.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    p.s.material.color.set(color);
    p.s.material.opacity = additive ? 0.9 : 0.55;
    p.s.position.copy(pos);
    p.s.scale.set(size, size, 1);
    p.s.visible = true;
  }
  smoke(pos, life = 1.2, size = 2, color = 0x555555, vel = null) {
    this.spawn(pos, vel || _v.set(randSpread(2), rand(1, 3), randSpread(2)), life, size, color, false, 2.4);
  }
  fire(pos, life = 0.5, size = 3) {
    this.spawn(pos, _v.set(randSpread(4), rand(0, 3), randSpread(4)), life, size, 0xff8830, true, 0.6, this.glowTex);
  }
  flash(pos, size = 10, color = 0xfff0b0, life = 0.18) {
    this.spawn(pos, _v.set(0, 0, 0), life, size, color, true, 1.8, this.glowTex);
  }
  trail(pos, size = 1.6, color = 0xdddddd, life = 1.6) {
    this.spawn(pos, _v.set(0, 0.4, 0), life, size, color, false, 1.4);
  }
  explosion(pos, scale = 1) {
    this.flash(pos, 26 * scale, 0xfff4c0, 0.22);
    this.flash(pos, 60 * scale, 0xff9840, 0.35);
    for (let i = 0; i < 14; i++) {
      _d.set(randSpread(30), randSpread(30), randSpread(30));
      this.fire(_v.copy(pos).addScaledVector(_d, 0.15), rand(0.4, 0.9), rand(3, 7) * scale);
      this.spawn(_v, _d.clone().multiplyScalar(0.7), rand(0.5, 1.1), rand(2, 4) * scale, 0xffc060, true, 0.4, this.glowTex);
    }
    for (let i = 0; i < 16; i++) {
      _d.set(randSpread(18), rand(2, 16), randSpread(18));
      this.smoke(_v.copy(pos).addScaledVector(_d, 0.2), rand(1.5, 3.5), rand(4, 9) * scale, 0x2c2c2c, _d.clone().multiplyScalar(0.5));
    }
  }
  splash(pos, scale = 1) {
    for (let i = 0; i < 12; i++) {
      _d.set(randSpread(10), rand(8, 22), randSpread(10));
      this.spawn(pos, _d.clone(), rand(0.6, 1.2), rand(2, 5) * scale, 0xcfe8ff, false, 1.2, this.glowTex);
    }
    this.smoke(pos, 2, 8 * scale, 0xffffff);
  }
  update(dt) {
    for (const p of this.pool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.s.visible = false; continue; }
      p.s.position.addScaledVector(p.vel, dt);
      const t = 1 - p.life / p.maxLife;
      const sz = p.size0 * (1 + t * (p.grow - 1));
      p.s.scale.set(sz, sz, 1);
      p.s.material.opacity = (p.s.material.blending === THREE.AdditiveBlending ? 0.9 : 0.55) * (1 - t * t);
    }
  }
}

// ---------------- missiles ----------------
const MISSILE_TYPES = {
  aim120: { vmax: 1050, accel: 260, turn: 1.9, life: 40, prox: 30, dmg: 110, ir: false },
  aim9:   { vmax: 850,  accel: 320, turn: 3.2, life: 22, prox: 26, dmg: 110, ir: true  },
  r27:    { vmax: 950,  accel: 240, turn: 1.6, life: 35, prox: 30, dmg: 70,  ir: false },
  r73:    { vmax: 800,  accel: 300, turn: 3.0, life: 18, prox: 26, dmg: 60,  ir: true  },
};
let missileGeo = null, missileMat = null;

export class Missile {
  constructor(G, owner, type, target) {
    const cfg = MISSILE_TYPES[type];
    this.G = G; this.cfg = cfg; this.type = type;
    this.owner = owner; this.target = target;
    if (!missileGeo) {
      missileGeo = new THREE.CylinderGeometry(0.16, 0.16, 3.4, 6);
      missileGeo.rotateX(Math.PI / 2);
      missileMat = new THREE.MeshBasicMaterial({ color: 0xe8e8e8 });
    }
    this.mesh = new THREE.Mesh(missileGeo, missileMat);
    this.pos = this.mesh.position;
    this.pos.copy(owner.pos);
    // Player exposes fwd as a getter, AIAircraft as a method — handle both
    const f = (typeof owner.fwd === 'function') ? owner.fwd(new THREE.Vector3())
      : owner.fwd ? owner.fwd.clone()
        : _d.set(0, 0, 1).applyQuaternion(owner.quat);
    this.vel = f.clone().multiplyScalar((owner.speed || owner.vel.length()) + 60);
    this.vel.y += 8;
    this.dir = f.clone();
    this.life = cfg.life; this.dead = false; this.spoofed = false;
    this.smokeT = 0;
    G.scene.add(this.mesh);
    // orient
    this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.dir);
  }
  update(dt) {
    const G = this.G, cfg = this.cfg;
    this.life -= dt;
    if (this.life <= 0) { this._die(); return; }
    const t = this.target;
    const tAlive = t && !t.dead && !t.ejected && !(t.removeMe);
    // countermeasure spoof check (continuous proximity-based)
    if (tAlive && !this.spoofed) {
      const dist = this.pos.distanceTo(t.pos);
      if (dist < 1500) {
        const now = G.time;
        if (cfg.ir && now - (t.flareT ?? -99) < 2.2 && Math.random() < 0.75) this._spoof();
        else if (!cfg.ir && now - (t.chaffT ?? -99) < 2.5 && Math.random() < 0.7) this._spoof();
        // hard break at close range can defeat it
        else if (dist < 900 && t.gForce && t.gForce > 7.5 && Math.random() < 0.012) this._spoof();
      }
    }
    if (tAlive && !this.spoofed) {
      // proportional-nav-lite
      const lead = clamp(this.pos.distanceTo(t.pos) / cfg.vmax, 0, 2.2);
      _d.copy(t.pos).addScaledVector(t.vel, lead).sub(this.pos).normalize();
      const ang = this.dir.angleTo(_d);
      const maxT = cfg.turn * dt;
      if (ang > 1e-4) this.dir.lerp(_d, Math.min(1, maxT / ang)).normalize();
    }
    // speed
    const sp = Math.min(cfg.vmax, this.vel.length() + cfg.accel * dt);
    this.vel.copy(this.dir).multiplyScalar(sp);
    // gravity dip after burnout (last 25% life)
    if (this.life < cfg.life * 0.25) this.vel.y -= 4 * dt;
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.quaternion.setFromUnitVectors(_v.set(0, 0, 1), this.dir);
    // smoke trail
    this.smokeT -= dt;
    if (this.smokeT <= 0) { this.smokeT = 0.03; G.fx.trail(this.pos, 1.5, 0xeeeeee, 2.2); }
    // proximity kill
    if (tAlive && !this.spoofed) {
      const dist = this.pos.distanceTo(t.pos);
      if (dist < cfg.prox) {
        G.explode(this.pos, 0.8);
        if (t.isPlayer) G.onPlayerHit(cfg.dmg, this.owner);
        else t.hit(cfg.dmg, G, this.owner === G.player);
        this._die();
        return;
      }
    }
    // hit terrain?
    if (this.pos.y < 1) { G.fx.splash(this.pos, 0.7); this._die(); return; }
  }
  _spoof() {
    this.spoofed = true;
    if (this.target === this.G.player) this.G.msg('MISSILE DEFEATED', 'good');
  }
  _die() { this.dead = true; this.G.scene.remove(this.mesh); }
}

// ---------------- the M61 Vulcan ----------------
export class GunSystem {
  constructor(G) {
    this.G = G;
    this.cooldown = 0;
    this.tracers = [];
    if (!GunSystem.geo) {
      GunSystem.geo = new THREE.CylinderGeometry(0.12, 0.12, 26, 4);
      GunSystem.geo.rotateX(Math.PI / 2);
      GunSystem.mat = new THREE.MeshBasicMaterial({ color: 0xffd080, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.9, depthWrite: false });
    }
  }
  fire(dt, player, targets) {
    const G = this.G;
    this.cooldown -= dt;
    const ROF = 28; // rounds per second (arcade)
    while (this.cooldown <= 0 && player.stores.gun > 0) {
      this.cooldown += 1 / ROF;
      player.stores.gun--;
      G.audio.gun();
      // tracer visual
      const tr = new THREE.Mesh(GunSystem.geo, GunSystem.mat);
      const f = player.fwd.clone();
      tr.position.copy(player.pos).addScaledVector(f, 12);
      tr.position.y -= 1;
      tr.quaternion.setFromUnitVectors(_v.set(0, 0, 1), f);
      G.scene.add(tr);
      this.tracers.push({ mesh: tr, vel: f.multiplyScalar(1050).add(player.vel), life: 1.4 });
      // hit check: ray vs targets (cylinder around flight path)
      for (const t of targets) {
        if (t.dead) continue;
        _d.copy(t.pos).sub(player.pos);
        const dist = _d.length();
        if (dist > 1600 || dist < 30) continue;
        const along = _d.dot(f);
        if (along < 0) continue;
        const perp2 = _d.lengthSq() - along * along;
        const hitR = 9 + dist * 0.012;
        if (perp2 < hitR * hitR && Math.random() < 0.5) {
          t.hit(6, G, true);
          G.fx.flash(t.pos, 6, 0xffe0a0, 0.1);
          G.audio.gunHit();
          G.gunHits++;
        }
      }
      if (player.stores.gun <= 0) { G.msg('GUN EMPTY', 'warn'); break; }
    }
  }
  update(dt) {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      t.mesh.position.addScaledVector(t.vel, dt);
      if (t.life <= 0) { this.G.scene.remove(t.mesh); this.tracers.splice(i, 1); }
    }
  }
}
