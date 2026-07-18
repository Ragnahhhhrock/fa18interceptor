// hud.js — 2D HUD: flight symbology, radar, targeting, weapons, messages
import * as THREE from 'three';
import { clamp, lerp, KTS, FT, NM, wrapAngle, deg } from './util.js';

const GREEN = '#3aff72', AMBER = '#ffb437', RED = '#ff4a3a', BLUE = '#8fd0ff', WHITE = '#e8f4ff';
const _v = new THREE.Vector3();

export class HUD {
  constructor(canvas) {
    this.cv = canvas;
    this.cx = canvas.getContext('2d');
    this.resize();
  }
  resize() {
    this.cv.width = window.innerWidth; this.cv.height = window.innerHeight;
    this.w = this.cv.width; this.h = this.cv.height;
    this.cxw = this.w / 2; this.cyh = this.h / 2;
    this.scale = clamp(this.h / 900, 0.7, 1.6);
  }
  project(pos, camera, out) {
    _v.copy(pos).project(camera);
    out.x = (_v.x * 0.5 + 0.5) * this.w;
    out.y = (-_v.y * 0.5 + 0.5) * this.h;
    out.behind = _v.z > 1;
    out.visible = !out.behind && _v.x > -1.05 && _v.x < 1.05 && _v.y > -1.05 && _v.y < 1.05;
    return out;
  }

  draw(G, dt) {
    const c = this.cx, w = this.w, h = this.h, cx = this.cxw, cy = this.cyh, s = this.scale;
    c.clearRect(0, 0, w, h);
    if (!G.player || G.state !== 'flying') return;
    const P = G.player;
    c.font = `${12 * s}px "Courier New", monospace`;
    c.lineWidth = 1.4 * s;

    if (G.view === 'cockpit') this._cockpitFrame(c, w, h, s);

    const sp = P.speedKts, alt = P.altFt;
    const fwd = P.fwd;
    const pitch = Math.asin(clamp(fwd.y, -1, 1));
    // bank angle from quaternion
    const right = _v.set(1, 0, 0).applyQuaternion(P.quat);
    const upY = new THREE.Vector3(0, 1, 0).applyQuaternion(P.quat).y;
    const bank = Math.atan2(-right.y, upY);
    const hdg = Math.atan2(fwd.x, -fwd.z);

    this._ladder(c, cx, cy, pitch, bank, s);
    this._tapes(c, sp, alt, hdg, P, s, w, h);
    this._flightPathMarker(c, G, P);
    this._gunReticle(c, cx, cy, s, G);
    this._targetBox(c, G, s);
    this._waypoint(c, G, s);
    this._radar(c, G, s);
    this._infoBlock(c, G, P, s);
    this._messages(c, G, s, dt);
    this._warnings(c, G, P, s, w, h);
    this._mouseStick(c, G, s);
    if (G.view === 'orbit') this._centerText(c, 'EXTERNAL VIEW', s);
  }

  // ---------- attitude ladder ----------
  _ladder(c, cx, cy, pitch, bank, s) {
    c.save();
    c.translate(cx, cy);
    c.rotate(bank);
    const pxPerRad = 620 * s;
    c.strokeStyle = GREEN; c.fillStyle = GREEN;
    // horizon
    c.beginPath();
    c.moveTo(-2000, -pitch * pxPerRad); c.lineTo(2000, -pitch * pxPerRad);
    c.stroke();
    for (let p = -80; p <= 80; p += 10) {
      if (p === 0) continue;
      const y = -(p * Math.PI / 180 - pitch) * pxPerRad;
      if (Math.abs(y) > 700 * s) continue;
      const len = (p % 30 === 0 ? 60 : 32) * s;
      c.beginPath();
      c.moveTo(-len, y); c.lineTo(-len * 0.25, y); c.moveTo(len * 0.25, y); c.lineTo(len, y);
      c.stroke();
      c.fillText(Math.abs(p).toString(), -len - 26 * s, y + 4 * s);
      c.fillText(Math.abs(p).toString(), len + 8 * s, y + 4 * s);
    }
    c.restore();
    // fixed waterline (aircraft symbol)
    c.strokeStyle = AMBER; c.lineWidth = 2.4 * s;
    c.beginPath();
    c.moveTo(cx - 70 * s, cy); c.lineTo(cx - 22 * s, cy); c.lineTo(cx - 12 * s, cy + 9 * s);
    c.moveTo(cx + 70 * s, cy); c.lineTo(cx + 22 * s, cy); c.lineTo(cx + 12 * s, cy + 9 * s);
    c.moveTo(cx, cy - 4 * s); c.lineTo(cx, cy + 2 * s);
    c.stroke();
    c.lineWidth = 1.4 * s;
  }

  // ---------- tapes ----------
  _tapes(c, sp, alt, hdg, P, s, w, h) {
    const cx = this.cxw, cy = this.cyh;
    c.strokeStyle = GREEN; c.fillStyle = GREEN;
    // speed box
    this._box(c, cx - 340 * s, cy - 14 * s, 96 * s, 28 * s);
    c.font = `bold ${17 * s}px "Courier New", monospace`;
    c.fillText(Math.round(sp).toString().padStart(3, '0'), cx - 330 * s, cy + 6 * s);
    c.font = `${10 * s}px "Courier New", monospace`;
    c.fillText('KTS', cx - 262 * s, cy + 6 * s);
    // altitude box
    this._box(c, cx + 244 * s, cy - 14 * s, 110 * s, 28 * s);
    c.font = `bold ${17 * s}px "Courier New", monospace`;
    c.fillText(Math.round(alt).toLocaleString('en-US'), cx + 254 * s, cy + 6 * s);
    c.font = `${10 * s}px "Courier New", monospace`;
    c.fillText('FT', cx + 326 * s, cy + 6 * s);
    // radar altitude when low
    const agl = Math.max(0, P.pos.y - Math.max(0, P.groundH ?? 0)) / FT;
    if (agl < 2500) { c.fillStyle = AMBER; c.fillText('R ' + Math.round(agl), cx + 254 * s, cy + 30 * s); }
    // heading tape
    const hd = deg(hdg);
    c.fillStyle = GREEN;
    const hy = 40 * s, hspan = 180 * s;
    c.beginPath(); c.moveTo(cx - hspan, hy + 16 * s); c.lineTo(cx + hspan, hy + 16 * s); c.stroke();
    c.font = `${11 * s}px "Courier New", monospace`;
    for (let a = -30; a <= 30; a += 5) {
      let ah = Math.round((hd + a) / 5) * 5;
      const off = wrapAngle((ah - hd) * Math.PI / 180) * 180 / Math.PI;
      const x = cx + off / 30 * hspan;
      if (Math.abs(x - cx) > hspan) continue;
      const big = ah % 30 === 0;
      c.beginPath(); c.moveTo(x, hy + 16 * s); c.lineTo(x, hy + (big ? 8 : 12) * s); c.stroke();
      if (big) {
        let lbl = ((ah % 360) + 360) % 360;
        c.fillText((lbl / 10).toString(), x - 5 * s, hy + 4 * s);
      }
    }
    c.strokeStyle = AMBER;
    c.beginPath(); c.moveTo(cx, hy + 20 * s); c.lineTo(cx, hy + 30 * s); c.stroke();
    c.strokeStyle = GREEN;
  }
  _box(c, x, y, w, h) { c.beginPath(); c.rect(x, y, w, h); c.stroke(); }

  // ---------- flight path marker ----------
  _flightPathMarker(c, G, P) {
    if (P.speed < 5) return;
    const mark = _v.copy(P.pos).addScaledVector(P.vel, 2.5);
    const pr = this.project(mark, G.camera, { x: 0, y: 0 });
    if (!pr.visible) return;
    c.strokeStyle = GREEN;
    c.beginPath(); c.arc(pr.x, pr.y, 7 * this.scale, 0, Math.PI * 2); c.stroke();
    c.beginPath();
    c.moveTo(pr.x - 14 * this.scale, pr.y); c.lineTo(pr.x - 7 * this.scale, pr.y);
    c.moveTo(pr.x + 7 * this.scale, pr.y); c.lineTo(pr.x + 14 * this.scale, pr.y);
    c.moveTo(pr.x, pr.y - 7 * this.scale); c.lineTo(pr.x, pr.y - 13 * this.scale);
    c.stroke();
  }

  _gunReticle(c, cx, cy, s, G) {
    if (G.player.weapon !== 'gun') return;
    c.strokeStyle = AMBER;
    c.beginPath(); c.arc(cx, cy - 40 * s, 16 * s, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(cx, cy - 40 * s - 22 * s); c.lineTo(cx, cy - 40 * s + 22 * s);
    c.moveTo(cx - 22 * s, cy - 40 * s); c.moveTo(cx + 22 * s, cy - 40 * s); c.stroke();
    c.fillStyle = AMBER; c.fillRect(cx - 1.5, cy - 41.5 * s, 3, 3);
  }

  // ---------- target ----------
  _targetBox(c, G, s) {
    const t = G.playerTarget;
    if (!t || t.dead) return;
    const pr = this.project(t.pos, G.camera, { x: 0, y: 0 });
    const dist = G.player.pos.distanceTo(t.pos);
    c.font = `${11 * s}px "Courier New", monospace`;
    if (pr.visible) {
      c.strokeStyle = G.lockLevel >= 1 ? RED : (t.identified === false ? '#9a9a9a' : RED);
      const r = 16 * s;
      c.beginPath();
      c.moveTo(pr.x, pr.y - r); c.lineTo(pr.x + r, pr.y); c.lineTo(pr.x, pr.y + r); c.lineTo(pr.x - r, pr.y);
      c.closePath(); c.stroke();
      // lock circle
      if (G.lockLevel > 0.02) {
        c.strokeStyle = G.lockLevel >= 1 ? RED : AMBER;
        c.beginPath(); c.arc(pr.x, pr.y, r + 10 * s, -Math.PI / 2, -Math.PI / 2 + G.lockLevel * Math.PI * 2); c.stroke();
      }
      c.fillStyle = c.strokeStyle;
      const nm = (dist / NM).toFixed(1);
      c.fillText(`${t.label || t.name} ${nm}NM`, pr.x + r + 6 * s, pr.y - 4 * s);
      c.fillText(`${Math.round(t.speed / KTS)}KT ${Math.round(t.pos.y / FT)}FT`, pr.x + r + 6 * s, pr.y + 10 * s);
      if (G.lockLevel >= 1) {
        c.fillStyle = RED; c.font = `bold ${14 * s}px "Courier New", monospace`;
        if (Math.sin(G.time * 10) > -0.4) c.fillText('SHOOT', pr.x - 22 * s, pr.y + r + 22 * s);
      }
    } else {
      // off-screen arrow
      const dir = _v.copy(t.pos).sub(G.player.pos);
      const f = G.player.fwd;
      const ang = Math.atan2(dir.x, -dir.z) - Math.atan2(f.x, -f.z);
      const a = wrapAngle(ang);
      const R = 200 * s;
      const ax = this.cxw + Math.sin(a) * R, ay = this.cyh - Math.cos(a) * R * 0.7;
      c.fillStyle = RED;
      c.save(); c.translate(ax, ay); c.rotate(a);
      c.beginPath(); c.moveTo(0, -10 * s); c.lineTo(6 * s, 6 * s); c.lineTo(-6 * s, 6 * s); c.closePath(); c.fill();
      c.restore();
    }
    // incoming missile markers
    for (const m of G.missiles) {
      if (m.dead || m.target !== G.player) continue;
      const pm = this.project(m.pos, G.camera, { x: 0, y: 0 });
      if (pm.visible) {
        c.strokeStyle = RED;
        c.beginPath(); c.arc(pm.x, pm.y, 8 * s, 0, Math.PI * 2); c.stroke();
        c.fillStyle = RED; c.fillText('M', pm.x - 4 * s, pm.y - 12 * s);
      }
    }
  }

  _waypoint(c, G, s) {
    if (!G.waypoint) return;
    const pr = this.project(G.waypoint, G.camera, { x: 0, y: 0 });
    c.strokeStyle = WHITE;
    if (pr.visible) {
      const r = 10 * s;
      c.beginPath();
      c.moveTo(pr.x, pr.y - r); c.lineTo(pr.x + r, pr.y); c.lineTo(pr.x, pr.y + r); c.lineTo(pr.x - r, pr.y);
      c.closePath(); c.stroke();
      const d = G.player.pos.distanceTo(G.waypoint) / NM;
      c.fillStyle = WHITE; c.font = `${11 * s}px "Courier New", monospace`;
      c.fillText(`WPT ${d.toFixed(1)}`, pr.x + r + 4 * s, pr.y + 4 * s);
    }
  }

  // ---------- radar ----------
  _radar(c, G, s) {
    const R = 88 * s, cx = this.cxw, cy = this.h - R - 26 * s;
    c.save();
    c.strokeStyle = GREEN; c.fillStyle = GREEN;
    c.globalAlpha = 0.9;
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(cx, cy, R * 0.5, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(cx - R, cy); c.lineTo(cx + R, cy); c.moveTo(cx, cy - R); c.lineTo(cx, cy + R); c.stroke();
    const range = G.radarRange; // meters
    const pf = G.player.fwd;
    const hdg = Math.atan2(pf.x, -pf.z);
    for (const ct of G.radarContacts) {
      const dx = ct.pos.x - G.player.pos.x, dz = ct.pos.z - G.player.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > range) continue;
      const ang = Math.atan2(dx, -dz) - hdg;
      const rr = dist / range * R;
      const x = cx + Math.sin(ang) * rr, y = cy - Math.cos(ang) * rr;
      switch (ct.kind) {
        case 'bandit': c.fillStyle = ct.identified === false ? '#8a8a8a' : RED; break;
        case 'af1': c.fillStyle = '#58d8ff'; break;
        case 'stolen': c.fillStyle = AMBER; break;
        case 'carrier': c.fillStyle = '#40d868'; break;
        case 'raft': c.fillStyle = '#ff8830'; break;
        case 'missile': c.fillStyle = Math.sin(G.time * 14) > 0 ? RED : '#661108'; break;
        case 'sub': c.fillStyle = '#ff58c8'; break;
        default: c.fillStyle = WHITE;
      }
      if (ct.kind === 'carrier' || ct.kind === 'sub') {
        c.beginPath(); c.moveTo(x, y - 5 * s); c.lineTo(x + 5 * s, y + 4 * s); c.lineTo(x - 5 * s, y + 4 * s); c.closePath(); c.fill();
      } else {
        c.fillRect(x - 2.4 * s, y - 2.4 * s, 4.8 * s, 4.8 * s);
      }
    }
    // own ship
    c.fillStyle = GREEN;
    c.beginPath(); c.moveTo(cx, cy - 6 * s); c.lineTo(cx + 4.4 * s, cy + 5 * s); c.lineTo(cx - 4.4 * s, cy + 5 * s); c.closePath(); c.fill();
    c.font = `${10 * s}px "Courier New", monospace`;
    c.fillText(`${G.radarRangeNM}NM`, cx - R, cy + R + 14 * s);
    c.restore();
  }

  // ---------- left info block ----------
  _infoBlock(c, G, P, s) {
    const x = 26 * s, y = this.h - 250 * s;
    c.font = `${12 * s}px "Courier New", monospace`;
    c.fillStyle = GREEN;
    const thr = Math.round(P.throttle * 100);
    c.fillText(`THR ${thr}%${P.ab ? ' AB' : ''}`, x, y);
    // throttle bar
    c.strokeStyle = GREEN; c.strokeRect(x, y + 5 * s, 90 * s, 7 * s);
    c.fillRect(x, y + 5 * s, 90 * s * P.throttle, 7 * s);
    if (P.ab) { c.fillStyle = RED; c.fillRect(x + 90 * s, y + 5 * s, 12 * s, 7 * s); }
    c.fillStyle = GREEN;
    c.fillText(`FUEL ${Math.round(P.fuel)}`, x, y + 30 * s);
    c.fillText(`G ${P.gForce.toFixed(1)}`, x, y + 46 * s);
    c.fillText(`DMG ${Math.round(P.damage)}%`, x, y + 62 * s);
    // weapon + stores
    const wname = { aim120: 'AIM-120 AMRAAM', aim9: 'AIM-9 SIDEWINDER', gun: 'M61 VULCAN' }[P.weapon];
    c.fillStyle = AMBER;
    c.fillText(`WPN ${wname}`, x, y + 86 * s);
    c.fillStyle = GREEN;
    c.fillText(`A120 ${P.stores.aim120}  A9 ${P.stores.aim9}  GUN ${P.stores.gun}`, x, y + 102 * s);
    c.fillText(`CHAFF ${P.stores.chaff}  FLARE ${P.stores.flares}`, x, y + 118 * s);
    // indicators
    let ix = x;
    const ind = (label, on, col = GREEN) => {
      c.strokeStyle = col; c.strokeRect(ix, y + 130 * s, 44 * s, 15 * s);
      if (on) { c.fillStyle = col; c.fillRect(ix, y + 130 * s, 44 * s, 15 * s); c.fillStyle = '#04140a'; }
      else c.fillStyle = col;
      c.fillText(label, ix + 6 * s, y + 141 * s);
      ix += 50 * s;
    };
    ind('GEAR', P.gearDown); ind('HOOK', P.hookDown); ind('BRK', P.brakes); ind('ECM', P.ecm, AMBER);
    // score
    c.fillStyle = BLUE; c.font = `bold ${14 * s}px "Courier New", monospace`;
    c.fillText(`SCORE ${G.score}`, 26 * s, 40 * s);
    c.fillText(`KILLS ${G.kills}`, 26 * s, 58 * s);
  }

  _messages(c, G, s) {
    const x = this.cxw, y0 = 96 * s;
    c.textAlign = 'center';
    let i = 0;
    for (const m of G.messages) {
      const age = G.time - m.t;
      if (age > 6) continue;
      const a = age > 5 ? 1 - (age - 5) : 1;
      c.globalAlpha = a;
      c.fillStyle = m.kind === 'warn' ? AMBER : m.kind === 'bad' ? RED : m.kind === 'good' ? '#58ff9a' : BLUE;
      c.font = `${m.kind === 'radio' ? '' : 'bold '}${14 * s}px "Courier New", monospace`;
      c.fillText(m.text, x, y0 + i * 20 * s);
      i++;
      if (i > 5) break;
    }
    c.globalAlpha = 1; c.textAlign = 'left';
  }

  _warnings(c, G, P, s, w, h) {
    const cx = this.cxw, cy = this.cyh;
    c.font = `bold ${20 * s}px "Courier New", monospace`;
    c.textAlign = 'center';
    if (P.stalled && Math.sin(G.time * 12) > 0) {
      c.fillStyle = RED; c.fillText('STALL', cx, cy - 150 * s);
    }
    if (G.missileWarning && Math.sin(G.time * 16) > -0.2) {
      c.fillStyle = RED; c.fillText('! MISSILE !', cx, cy - 120 * s);
    }
    if (P.fuel < 2200 && Math.sin(G.time * 6) > 0) {
      c.fillStyle = AMBER; c.fillText('LOW FUEL', cx, cy + 180 * s);
    }
    if (P.fuel <= 0) { c.fillStyle = RED; c.fillText('FLAMEOUT', cx, cy + 180 * s); }
    if (P.gearDown && P.speedKts > 300) { c.fillStyle = AMBER; c.fillText('GEAR OVERSPEED', cx, cy + 205 * s); }
    c.textAlign = 'left';
  }

  _mouseStick(c, G, s) {
    if (!G.input.mouseStick) return;
    const x = this.w - 90 * s, y = this.h - 90 * s, r = 46 * s;
    c.strokeStyle = 'rgba(58,255,114,0.5)';
    c.strokeRect(x - r, y - r, r * 2, r * 2);
    c.fillStyle = GREEN;
    c.beginPath(); c.arc(x + G.input.mx * r, y + G.input.my * r, 4 * s, 0, Math.PI * 2); c.fill();
    c.font = `${9 * s}px "Courier New", monospace`;
    c.fillText('MOUSE STICK (M)', x - r, y + r + 14 * s);
  }
  _cockpitFrame(c, w, h, s) {
    c.strokeStyle = 'rgba(20,28,36,0.95)';
    c.lineWidth = 10 * s;
    c.beginPath(); c.moveTo(w * 0.5, h); c.lineTo(w * 0.5, h * 0.62); c.stroke(); // center bow? fa18 has none; keep side bows
    c.lineWidth = 14 * s;
    c.beginPath(); c.moveTo(w * 0.12, h); c.lineTo(w * 0.3, h * 0.55); c.stroke();
    c.beginPath(); c.moveTo(w * 0.88, h); c.lineTo(w * 0.7, h * 0.55); c.stroke();
    c.fillStyle = 'rgba(16,22,30,0.98)';
    c.fillRect(0, h * 0.86, w, h * 0.14); // glareshield/dash
    c.lineWidth = 1.4 * s;
  }
  _centerText(c, txt, s) {
    c.fillStyle = BLUE; c.font = `${12 * s}px "Courier New", monospace`;
    c.textAlign = 'center'; c.fillText(txt, this.cxw, this.h - 12 * s); c.textAlign = 'left';
  }
}
