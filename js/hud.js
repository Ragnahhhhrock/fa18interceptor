// hud.js — Amiga-authentic cockpit: HUD combiner glass, white symbology,
// bottom instrument panel (attitude dial, fuel, radar scope, compass ball,
// data block), and the original's minimal external-view readout bar
import * as THREE from 'three';
import { clamp, KTS, FT, NM, wrapAngle, deg } from './util.js';

const WHITE = '#f2f2f2', GREEN = '#3aff72', AMBER = '#ffb437', RED = '#ff4a3a',
      BLUE = '#8fd0ff', PANEL = '#8f8f8f', DARK = '#0a0a0a';
const _v = new THREE.Vector3();
// the original separates thousands with a space: "3 075 FT"
const fmtN = n => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export class HUD {
  constructor(canvas) {
    this.cv = canvas;
    this.cx = canvas.getContext('2d');
    // dithered Amiga panel texture (4x4 checker)
    const d = document.createElement('canvas'); d.width = d.height = 4;
    const g = d.getContext('2d');
    g.fillStyle = '#565656'; g.fillRect(0, 0, 4, 4);
    g.fillStyle = '#464646';
    g.fillRect(0, 0, 2, 2); g.fillRect(2, 2, 2, 2);
    this.dither = this.cx.createPattern(d, 'repeat');
    this.resize();
  }
  resize() {
    // low backing resolution -> chunky Amiga pixels once CSS upscales it
    this.cv.width = Math.floor(window.innerWidth * 0.55);
    this.cv.height = Math.floor(window.innerHeight * 0.55);
    this.w = this.cv.width; this.h = this.cv.height;
    this.cxw = this.w / 2; this.cyh = this.h / 2;
    this.scale = clamp(this.h / 500, 0.6, 1.5);
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
    const c = this.cx, w = this.w, h = this.h;
    c.clearRect(0, 0, w, h);
    if (G.intro && G.intro.active) { G.intro.drawOverlay(c, w, h); return; }
    if (G.state === 'gallery') { if (G.gallery) G.gallery.drawOverlay(c, w, h); return; }
    if (!G.player || G.state !== 'flying') return;
    const P = G.player, s = this.scale;
    const fwd = P.fwd;
    const pitch = Math.asin(clamp(fwd.y, -1, 1));
    const right = _v.set(1, 0, 0).applyQuaternion(P.quat);
    const upY = new THREE.Vector3(0, 1, 0).applyQuaternion(P.quat).y;
    const bank = Math.atan2(-right.y, upY);
    const hdg = Math.atan2(fwd.x, -fwd.z);
    const st = { G, P, s, sp: P.speedKts, alt: P.altFt, pitch, bank, hdg };

    c.lineWidth = 1.2 * s;
    if (G.chute) {                       // ejected — external view only, no cockpit/HUD
      this._messages(c, G, s);
      if (G.mapview) G.mapview.draw(c, w, h, G);
      return;
    }
    if (G.view === 'cockpit') {
      this._hudGlass(c, st);
      c.save();
      c.clip(this._glassPath());         // all symbology stays on the combiner glass
      this._pitchTicks(c, st);
      this._hudNumbers(c, st);
      this._vectorText(c, G, s);
      this._flightPathMarker(c, G, P);
      this._gunReticle(c, st);
      this._targetBox(c, G, s);
      this._waypoint(c, G, s);
      this._warnings(c, G, P, s);
      c.restore();
      this._panel(c, st);   // messages print in the panel's centre-bottom strip
    } else {
      this._flightPathMarker(c, G, P);
      this._gunReticle(c, st);
      this._targetBox(c, G, s);
      this._waypoint(c, G, s);
      this._messages(c, G, s);
      this._warnings(c, G, P, s);
      this._extBar(c, st);
      const vlabel = G.view === 'tower' ? (G.towerName || 'TOWER VIEW')
        : G.view === 'orbit' ? 'EXTERNAL VIEW' : 'CHASE VIEW';
      c.fillStyle = WHITE; c.font = `${11 * s}px "Courier New", monospace`;
      c.textAlign = 'center'; c.fillText(`${vlabel}${G.xmag > 1 ? '  ' + G.xmag.toFixed(1) + ' XMAG' : ''}`, this.cxw, this.h * 0.105); c.textAlign = 'left';
    }
    this._mouseStick(c, G, s);
    if (G.mapview) G.mapview.draw(c, w, h, G);   // live map rides above the HUD
  }

  // ---------------- HUD combiner glass frame ----------------
  _glassPath() {
    const w = this.w, h = this.h;
    // chamfered top corners, exactly like the original's combiner glass
    const x1 = w * 0.265, x2 = w * 0.735, xt1 = w * 0.29, xt2 = w * 0.71;
    const yT = h * 0.165, yC = h * 0.185, yB = this._panelTop();
    const p = new Path2D();
    p.moveTo(x1, yB); p.lineTo(x1, yC); p.lineTo(xt1, yT); p.lineTo(xt2, yT); p.lineTo(x2, yC); p.lineTo(x2, yB);
    p.closePath();
    return p;
  }
  _hudGlass(c, { s }) {
    const p = this._glassPath();
    c.strokeStyle = '#202020'; c.lineWidth = 2.4 * s;
    c.stroke(p);
    c.lineWidth = 1.2 * s;
  }
  _panelTop() { return this.h * 0.72; }   // measured from the original cockpit

  // yellow tower vector text, top of the glass: "YOUR VECTOR 350 FOR BOGEY"
  _vectorText(c, G, s) {
    if (!G.vectorText) return;
    c.fillStyle = '#ffe23a'; c.font = `bold ${12 * s}px "Courier New", monospace`;
    c.textAlign = 'center';
    c.fillText(G.vectorText, this.cxw, this.h * 0.225);
    c.textAlign = 'left';
  }

  // ---------------- white HUD numbers (speed/alt/heading/G/AM) ----------------
  _hudNumbers(c, { G, P, s, sp, alt, hdg }) {
    const w = this.w, h = this.h, cx = this.cxw;
    c.fillStyle = WHITE; c.strokeStyle = WHITE;
    // heading tens across the top of the glass
    const hd = deg(hdg), hy = h * 0.165, hspan = w * 0.115;
    c.font = `${12 * s}px "Courier New", monospace`;
    c.textAlign = 'center';
    for (let a = -20; a <= 20; a += 10) {
      let ah = Math.round((hd + a) / 10) * 10;
      const off = wrapAngle((ah - hd) * Math.PI / 180) * 180 / Math.PI;
      const x = cx + off / 20 * hspan;
      if (Math.abs(x - cx) > hspan + 4) continue;
      const lbl = (((ah % 360) + 360) % 360) / 10;
      c.fillText(lbl.toString().padStart(2, '0'), x, hy + 10 * s);
      c.beginPath(); c.moveTo(x, hy + 13 * s); c.lineTo(x, hy + 18 * s); c.stroke();
    }
    // caret
    c.beginPath(); c.moveTo(cx, hy + 20 * s); c.lineTo(cx, hy + 26 * s); c.stroke();
    // speed left, altitude right — the F-16 has tape-style side scales,
    // the Hornet the original's stacked number-over-unit blocks
    if (P.type === 'f16') {
      this._tape(c, w * 0.33, h * 0.40, sp, 20, 110, v => Math.round(v).toString(), 'KT', s, -1);
      this._tape(c, w * 0.67, h * 0.40, alt, 100, 550, v => fmtN(Math.round(v)), 'FT', s, 1);
    } else {
      c.textAlign = 'center';
      c.font = `bold ${17 * s}px "Courier New", monospace`;
      c.fillText(`${Math.round(sp)}`, w * 0.305, h * 0.38);
      c.fillText(fmtN(alt), w * 0.695, h * 0.38);
      c.font = `${11 * s}px "Courier New", monospace`;
      c.fillText('KT', w * 0.305, h * 0.38 + 13 * s);
      c.fillText('FT', w * 0.695, h * 0.38 + 13 * s);
    }
    // G + missiles remaining, low on the glass like the original
    c.textAlign = 'center'; c.font = `${12.5 * s}px "Courier New", monospace`;
    c.fillText(`${P.gForce.toFixed(1)} G`, w * 0.305, h * 0.70);
    const msl = P.weapon === 'aim120' ? P.stores.aim120 : P.weapon === 'aim9' ? P.stores.aim9 : P.stores.gun;
    c.fillText(`${P.weapon === 'gun' ? 'GU' : 'AM'} ${msl}`, w * 0.695, h * 0.70);
    c.textAlign = 'left';
  }

  // F-16 tape scale: vertical strip, current value boxed at center.
  // side -1 = scale grows to the left of the strip (speed), +1 = right (alt)
  _tape(c, x, cy, val, minor, range, fmt, unit, s, side) {
    const half = 105 * s, px = half / range;
    c.save();
    c.strokeStyle = WHITE; c.fillStyle = WHITE; c.lineWidth = 1.4 * s;
    // clip to the tape window
    c.beginPath(); c.rect(x - 46 * s, cy - half, 92 * s, half * 2); c.clip();
    const lo = Math.floor((val - range) / minor) * minor;
    c.font = `${10.5 * s}px "Courier New", monospace`;
    for (let v = lo; v <= val + range; v += minor) {
      if (v < 0) continue;
      const y = cy - (v - val) * px;
      const major = (v / minor) % 2 === 0;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + side * (major ? 12 : 6) * s, y);
      c.stroke();
      if (major) {
        c.textAlign = side < 0 ? 'right' : 'left';
        c.fillText(fmt(v), x + side * 15 * s, y + 3.5 * s);
      }
    }
    c.restore();
    // center box with the digital value
    c.font = `bold ${12.5 * s}px "Courier New", monospace`;
    const txt = fmt(val);
    const bw = Math.max(34 * s, c.measureText(txt).width + 10 * s), bh = 16 * s;
    const bx = side < 0 ? x - bw - 16 * s : x + 16 * s;
    c.fillStyle = 'rgba(8,8,24,0.92)';
    c.fillRect(bx, cy - bh / 2, bw, bh);
    c.strokeStyle = WHITE; c.lineWidth = 1.4 * s;
    c.strokeRect(bx, cy - bh / 2, bw, bh);
    c.fillStyle = WHITE;
    // caret from box to the tape line
    c.beginPath();
    if (side < 0) { c.moveTo(x, cy); c.lineTo(x - 8 * s, cy - 5 * s); c.lineTo(x - 8 * s, cy + 5 * s); }
    else { c.moveTo(x, cy); c.lineTo(x + 8 * s, cy - 5 * s); c.lineTo(x + 8 * s, cy + 5 * s); }
    c.closePath(); c.fill();
    c.textAlign = side < 0 ? 'right' : 'left';
    c.fillText(txt, side < 0 ? bx + bw - 5 * s : bx + 5 * s, cy + 4.5 * s);
    c.font = `${10 * s}px "Courier New", monospace`;
    c.fillText(unit, side < 0 ? bx + bw - 5 * s : bx + 5 * s, cy + bh / 2 + 11 * s);
    c.textAlign = 'left';
  }

  // ---------------- minimal pitch ticks + waterline ----------------
  _pitchTicks(c, { s, pitch, bank }) {
    const cx = this.cxw, cy = this.cyh * 0.92;
    c.save();
    c.translate(cx, cy);
    c.rotate(bank);
    const pxPerRad = 520 * s;
    c.strokeStyle = WHITE;
    c.beginPath();
    c.moveTo(-170 * s, -pitch * pxPerRad); c.lineTo(170 * s, -pitch * pxPerRad);
    c.stroke();
    for (const p of [-10, 10]) {
      const y = -(p * Math.PI / 180 - pitch) * pxPerRad;
      if (Math.abs(y) > 300 * s) continue;
      c.beginPath();
      c.moveTo(-52 * s, y); c.lineTo(-18 * s, y); c.moveTo(18 * s, y); c.lineTo(52 * s, y);
      c.stroke();
    }
    c.restore();
    // fixed waterline (W)
    c.strokeStyle = WHITE; c.lineWidth = 2 * s;
    c.beginPath();
    c.moveTo(cx - 44 * s, cy); c.lineTo(cx - 14 * s, cy); c.lineTo(cx - 8 * s, cy + 7 * s);
    c.moveTo(cx + 44 * s, cy); c.lineTo(cx + 14 * s, cy); c.lineTo(cx + 8 * s, cy + 7 * s);
    c.moveTo(cx, cy - 3 * s); c.lineTo(cx, cy + 2 * s);
    c.stroke();
    c.lineWidth = 1.2 * s;
  }

  _flightPathMarker(c, G, P) {
    if (P.speed < 5) return;
    const mark = _v.copy(P.pos).addScaledVector(P.vel, 2.5);
    const pr = this.project(mark, G.camera, { x: 0, y: 0 });
    if (!pr.visible) return;
    const s = this.scale;
    c.strokeStyle = WHITE;
    c.beginPath();
    c.moveTo(pr.x - 9 * s, pr.y); c.lineTo(pr.x + 9 * s, pr.y);
    c.moveTo(pr.x, pr.y - 9 * s); c.lineTo(pr.x, pr.y + 9 * s);
    c.stroke();
    c.fillStyle = WHITE; c.fillRect(pr.x - 1, pr.y - 1, 2, 2);
  }

  _gunReticle(c, { G, s }) {
    if (G.player.weapon !== 'gun') return;
    const cx = this.cxw, cy = this.cyh * 0.92;
    c.strokeStyle = WHITE;
    c.beginPath(); c.arc(cx, cy - 30 * s, 13 * s, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(cx, cy - 30 * s - 18 * s); c.lineTo(cx, cy - 30 * s + 18 * s);
    c.moveTo(cx - 18 * s, cy - 30 * s); c.lineTo(cx + 18 * s, cy - 30 * s); c.stroke();
    c.fillStyle = WHITE; c.fillRect(cx - 1.5, cy - 31.5 * s, 3, 3);
  }

  // ---------------- target diamond / lock / missile markers ----------------
  _targetBox(c, G, s) {
    const t = G.playerTarget;
    if (t && !t.dead) {
      const pr = this.project(t.pos, G.camera, { x: 0, y: 0 });
      const dist = G.player.pos.distanceTo(t.pos);
      c.font = `${11 * s}px "Courier New", monospace`;
      if (pr.visible) {
        c.strokeStyle = G.lockLevel >= 1 ? RED : (t.identified === false ? '#bfbfbf' : WHITE);
        const r = 15 * s;
        c.beginPath();
        c.moveTo(pr.x, pr.y - r); c.lineTo(pr.x + r, pr.y); c.lineTo(pr.x, pr.y + r); c.lineTo(pr.x - r, pr.y);
        c.closePath(); c.stroke();
        if (G.lockLevel > 0.02) {
          c.strokeStyle = G.lockLevel >= 1 ? RED : AMBER;
          c.beginPath(); c.arc(pr.x, pr.y, r + 9 * s, -Math.PI / 2, -Math.PI / 2 + G.lockLevel * Math.PI * 2); c.stroke();
        }
        c.fillStyle = c.strokeStyle;
        c.fillText(`${t.label || t.name} ${(dist / NM).toFixed(1)}NM`, pr.x + r + 6 * s, pr.y - 4 * s);
        c.fillText(`${Math.round(t.speed / KTS)}KT ${Math.round(t.pos.y / FT)}FT`, pr.x + r + 6 * s, pr.y + 10 * s);
        if (G.lockLevel >= 1) {
          c.fillStyle = RED; c.font = `bold ${14 * s}px "Courier New", monospace`;
          if (Math.sin(G.time * 10) > -0.4) c.fillText('SHOOT', pr.x - 22 * s, pr.y + r + 22 * s);
        }
      } else {
        const dir = _v.copy(t.pos).sub(G.player.pos);
        const f = G.player.fwd;
        const a = wrapAngle(Math.atan2(dir.x, -dir.z) - Math.atan2(f.x, -f.z));
        const R = 170 * s;
        const ax = this.cxw + Math.sin(a) * R, ay = this.cyh - Math.cos(a) * R * 0.7;
        c.fillStyle = RED;
        c.save(); c.translate(ax, ay); c.rotate(a);
        c.beginPath(); c.moveTo(0, -9 * s); c.lineTo(6 * s, 6 * s); c.lineTo(-6 * s, 6 * s); c.closePath(); c.fill();
        c.restore();
      }
      // red bandit banner cycling HDG -> ALT -> SPD, like the original
      if (t.identified !== false) {
        const bHdg = Math.round(((t.heading !== undefined ? t.heading : Math.atan2(t.vel.x, -t.vel.z)) * 180 / Math.PI + 360) % 360);
        const phase = Math.floor(G.time / 2.5) % 3;
        const info = phase === 0 ? `HDG: ${String(bHdg).padStart(3, '0')}`
          : phase === 1 ? `ALT: ${Math.round(t.pos.y / FT)}`
          : `SPD: ${Math.round(t.speed / KTS)}`;
        c.fillStyle = RED; c.font = `bold ${13 * s}px "Courier New", monospace`;
        c.textAlign = 'center';
        c.fillText(`${(t.label || 'MIG-29').toUpperCase()} ${info}`, this.cxw, this._panelTop() - 14 * s);
        c.textAlign = 'left';
      }
      // range readout under the horizon: 4-digit + 'IN RNG' inside weapon range
      const rng100 = Math.max(0, Math.round(dist / (FT * 100)));
      const wpn = G.player.weapon;
      const inRng = wpn === 'aim120' ? dist < 20000 : wpn === 'aim9' ? dist < 6500 : dist < 1800;
      c.fillStyle = WHITE; c.font = `${12 * s}px "Courier New", monospace`;
      c.textAlign = 'center';
      c.fillText(String(rng100).padStart(4, '0'), this.cxw + this.w * 0.09, this.cyh + 52 * s);
      if (inRng) {
        c.font = `bold ${12 * s}px "Courier New", monospace`;
        c.fillText('IN RNG', this.cxw + this.w * 0.09, this.cyh + 68 * s);
      }
      c.textAlign = 'left';
    }
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
    if (!pr.visible) return;
    const r = 9 * s;
    c.strokeStyle = WHITE;
    c.beginPath();
    c.moveTo(pr.x, pr.y - r); c.lineTo(pr.x + r, pr.y); c.lineTo(pr.x, pr.y + r); c.lineTo(pr.x - r, pr.y);
    c.closePath(); c.stroke();
    c.fillStyle = WHITE; c.font = `${10.5 * s}px "Courier New", monospace`;
    c.fillText(`WPT ${(G.player.pos.distanceTo(G.waypoint) / NM).toFixed(1)}`, pr.x + r + 4 * s, pr.y + 4 * s);
  }

  _messages(c, G, s) {
    const x = this.cxw;
    let y0 = this.h * 0.05;
    c.textAlign = 'center';
    let i = 0;
    for (const m of G.messages) {
      const age = G.time - m.t;
      if (age > 6) continue;
      c.globalAlpha = age > 5 ? 1 - (age - 5) : 1;
      c.fillStyle = m.kind === 'warn' ? AMBER : m.kind === 'bad' ? RED : m.kind === 'good' ? '#9aff9a' : WHITE;
      c.font = `${12.5 * s}px "Courier New", monospace`;
      c.fillText(m.text, x, y0 + i * 17 * s);
      i++;
      if (i > 5) break;
    }
    c.globalAlpha = 1; c.textAlign = 'left';
  }

  _warnings(c, G, P, s) {
    const cx = this.cxw, cy = this.cyh * 0.92;
    c.font = `bold ${17 * s}px "Courier New", monospace`;
    c.textAlign = 'center';
    if (P.stalled && Math.sin(G.time * 12) > 0) { c.fillStyle = RED; c.fillText('STALL', cx, cy - 120 * s); }
    if (G.missileWarning && Math.sin(G.time * 16) > -0.2) { c.fillStyle = RED; c.fillText('! MISSILE !', cx, cy - 95 * s); }
    if (P.fuel < 2200 && Math.sin(G.time * 6) > 0) { c.fillStyle = AMBER; c.fillText('LOW FUEL', cx, cy + 118 * s); }
    if (P.fuel <= 0) { c.fillStyle = RED; c.fillText('FLAMEOUT', cx, cy + 118 * s); }
    if (P.gearDown && P.speedKts > 300) { c.fillStyle = AMBER; c.fillText('GEAR OVERSPEED', cx, cy + 94 * s); }
    c.textAlign = 'left';
  }

  // ---------------- the Amiga instrument panel ----------------
  // every box position measured straight off the original cockpit screenshot
  _panel(c, { G, P, s, sp, alt, pitch, bank, hdg }) {
    const w = this.w, h = this.h;
    const yT = this._panelTop();
    // dithered grey slab + dark top edge
    c.fillStyle = this.dither; c.fillRect(0, yT, w, h - yT);
    c.fillStyle = '#777777'; c.fillRect(0, yT, w, 3 * s);

    // display bezel with the real DDI's 20 pushbuttons (5 per side)
    const bezel = (x0f, y0f, x1f, y1f) => {
      const x0 = x0f * w, y0 = y0f * h, x1 = x1f * w, y1 = y1f * h;
      c.fillStyle = '#8a8a8a'; c.fillRect(x0, y0, x1 - x0, y1 - y0);
      c.fillStyle = '#6a6a6a'; c.fillRect(x0 + 2 * s, y0 + 2 * s, x1 - x0 - 4 * s, y1 - y0 - 4 * s);
      c.fillStyle = '#2e2e2e';
      const bw = 3.2 * s;
      for (let i = 0; i < 5; i++) {
        const bx = x0 + 2.5 * s + (x1 - x0 - 5 * s) * (i + 0.5) / 5 - bw / 2;
        c.fillRect(bx, y0 + 0.8 * s, bw, bw); c.fillRect(bx, y1 - 0.8 * s - bw, bw, bw);
        const by = y0 + 2.5 * s + (y1 - y0 - 5 * s) * (i + 0.5) / 5 - bw / 2;
        c.fillRect(x0 + 0.8 * s, by, bw, bw); c.fillRect(x1 - 0.8 * s - bw, by, bw, bw);
      }
    };
    const screen = (x0f, y0f, x1f, y1f, col = '#03140a') => {
      c.fillStyle = col; c.fillRect(x0f * w, y0f * h, (x1f - x0f) * w, (y1f - y0f) * h);
    };

    // ---- EJECT / BRAKE / GEAR: x .030-.117, three stacked
    const btn = (label, y0f, y1f, lit, col = '#1a1a1a') => {
      const bx = 0.030 * w, bw = 0.087 * w, y = y0f * h, bh = (y1f - y0f) * h;
      c.fillStyle = lit ? '#c8c8c8' : '#9a9a9a'; c.fillRect(bx, y, bw, bh);
      c.strokeStyle = '#3a3a3a'; c.lineWidth = 1.6 * s; c.strokeRect(bx, y, bw, bh);
      c.fillStyle = lit ? col : '#2a2a2a';
      c.font = `bold ${12 * s}px "Courier New", monospace`;
      c.textAlign = 'center'; c.fillText(label, bx + bw / 2, y + bh * 0.70, bw - 4); c.textAlign = 'left';
      c.lineWidth = 1.2 * s;
    };
    btn('EJECT', 0.758, 0.815, true, GREEN);
    btn('BRAKE', 0.838, 0.888, P.brakes);
    btn('GEAR',  0.908, 0.965, P.gearDown);

    // ---- weapons loadout display: bezel x .140-.312, screen x .155-.295
    bezel(0.140, 0.738, 0.312, 0.995);
    screen(0.155, 0.758, 0.295, 0.962);
    this._loadout(c, P, 0.155 * w, 0.758 * h, 0.140 * w, 0.204 * h, s, G.time);

    // ---- FUEL: label, vertical bar, digital number box below
    c.fillStyle = '#1a1a1a'; c.font = `bold ${11 * s}px "Courier New", monospace`;
    c.fillText('FUEL', 0.331 * w, 0.770 * h);
    screen(0.340, 0.782, 0.360, 0.898, '#101010');
    const frac = clamp(P.fuel / P.cfg.fuel, 0, 1);
    const bTop = 0.782 * h, bBot = 0.898 * h;
    c.fillStyle = frac < 0.2 ? RED : '#28c850';
    c.fillRect(0.341 * w, bBot - (bBot - bTop) * frac, 0.018 * w, (bBot - bTop) * frac);
    screen(0.325, 0.908, 0.395, 0.958, '#101010');
    c.strokeStyle = '#3a3a3a'; c.strokeRect(0.325 * w, 0.908 * h, 0.070 * w, 0.050 * h);
    c.fillStyle = '#c8c8c8'; c.font = `bold ${12 * s}px "Courier New", monospace`;
    c.textAlign = 'center'; c.fillText(Math.round(P.fuel).toString(), 0.360 * w, 0.944 * h); c.textAlign = 'left';

    // ---- centre radar: bezel x .408-.595 y .718-.928, screen x .420-.583
    bezel(0.408, 0.718, 0.595, 0.928);
    screen(0.420, 0.738, 0.583, 0.918);
    this._radarScope(c, G, 0.420 * w, 0.738 * h, 0.163 * w, 0.180 * h, s);

    // ---- centre-bottom text strip: x .408-.592, y .958-1.0 — kept short so
    // the attitude ball (bezel x .598+) never overlaps it
    screen(0.408, 0.958, 0.592, 0.998, '#020a05');
    c.strokeStyle = '#2a6a3a'; c.strokeRect(0.408 * w, 0.958 * h, 0.184 * w, 0.040 * h);
    const m0 = G.messages[0];
    if (m0 && G.time - m0.t < 6) {
      c.globalAlpha = G.time - m0.t > 5 ? 1 - (G.time - m0.t - 5) : 1;
      c.fillStyle = m0.kind === 'warn' ? AMBER : m0.kind === 'bad' ? RED : m0.kind === 'good' ? '#9aff9a' : GREEN;
      c.font = `bold ${10 * s}px "Courier New", monospace`;
      c.textAlign = 'center';
      c.fillText(m0.text, 0.500 * w, 0.986 * h, 0.176 * w);
      c.textAlign = 'left'; c.globalAlpha = 1;
    }

    // ---- compass: bezel x .598-.708, card window on top, ball below
    bezel(0.598, 0.738, 0.708, 0.995);
    screen(0.604, 0.748, 0.702, 0.780, '#141414');
    const bX = 0.653 * w, bY = 0.878 * h, bR = 0.078 * h;
    const hd = deg(hdg);
    c.font = `bold ${11 * s}px "Courier New", monospace`;
    c.textAlign = 'center';
    for (const [lbl, ang] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
      const rel = wrapAngle((ang - hd) * Math.PI / 180) * 180 / Math.PI;
      if (Math.abs(rel) > 70) continue;
      const lx = bX + rel / 70 * (0.045 * w);
      c.fillStyle = Math.abs(rel) < 25 ? RED : '#c8c8c8';
      c.fillText(lbl, lx, 0.773 * h);
      c.fillStyle = '#c8c8c8'; c.fillText('·', lx - 0.008 * w, 0.773 * h);
    }
    c.textAlign = 'left';
    // ---- attitude ball: blue over brown, pitch ladder, bank pointer + scale,
    // fixed aircraft symbol — per the real attitude indicator
    const py = pitch * 120 * s;
    c.save();
    c.beginPath(); c.arc(bX, bY, bR, 0, Math.PI * 2); c.clip();
    c.save();
    c.translate(bX, bY); c.rotate(bank);
    // sky above the horizon line, ground below (nose up => the line drops)
    c.fillStyle = '#2f9df0'; c.fillRect(-bR * 1.3, -bR * 1.3, bR * 2.6, bR * 1.3 + py);
    c.fillStyle = '#7a5a28'; c.fillRect(-bR * 1.3, py, bR * 2.6, bR * 1.3);
    // pitch ladder bars at 10/20/30 deg, numbered
    c.strokeStyle = '#f2f2f2'; c.fillStyle = '#f2f2f2'; c.lineWidth = 1.1 * s;
    c.font = `${6.5 * s}px "Courier New", monospace`; c.textAlign = 'center';
    const lad = (degA, halfW) => {
      const y = py - degA * Math.PI / 180 * 120 * s;
      c.beginPath(); c.moveTo(-halfW * bR, y); c.lineTo(halfW * bR, y); c.stroke();
      c.fillText(Math.abs(degA).toString(), -halfW * bR - 4.5 * s, y + 2 * s);
      c.fillText(Math.abs(degA).toString(), halfW * bR + 4.5 * s, y + 2 * s);
    };
    lad(10, 0.55); lad(-10, 0.55); lad(20, 0.42); lad(-20, 0.42); lad(30, 0.30); lad(-30, 0.30);
    // white horizon line across the ball
    c.lineWidth = 1.8 * s;
    c.beginPath(); c.moveTo(-bR * 0.98, py); c.lineTo(bR * 0.98, py); c.stroke();
    // bank pointer — rides the ball, points up at the fixed scale
    c.fillStyle = '#ffae2a';
    c.beginPath(); c.moveTo(0, -bR + 1 * s); c.lineTo(-3.2 * s, -bR + 7 * s); c.lineTo(3.2 * s, -bR + 7 * s); c.closePath(); c.fill();
    c.restore();
    c.restore();
    // fixed bank scale around the top of the dial
    c.strokeStyle = '#e8e8e8'; c.lineWidth = 1.3 * s;
    for (const a of [0, 10, 20, 30, 45, 60]) for (const sg of a === 0 ? [1] : [-1, 1]) {
      const ang = sg * a * Math.PI / 180, len = (a === 0 || a === 30 || a === 60) ? 7 : 4.5;
      c.beginPath();
      c.moveTo(bX + Math.sin(ang) * (bR + 1.5 * s), bY - Math.cos(ang) * (bR + 1.5 * s));
      c.lineTo(bX + Math.sin(ang) * (bR + len * s), bY - Math.cos(ang) * (bR + len * s));
      c.stroke();
    }
    // fixed aircraft symbol (orange W + centre dot)
    c.strokeStyle = '#ffae2a'; c.lineWidth = 2.2 * s;
    c.beginPath();
    c.moveTo(bX - bR * 0.72, bY - bR * 0.06); c.lineTo(bX - bR * 0.14, bY + bR * 0.10); c.lineTo(bX, bY);
    c.lineTo(bX + bR * 0.14, bY + bR * 0.10); c.lineTo(bX + bR * 0.72, bY - bR * 0.06);
    c.stroke();
    c.fillStyle = '#ffae2a'; c.beginPath(); c.arc(bX, bY, 1.6 * s, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#3a3a3a'; c.lineWidth = 1.6 * s; c.beginPath(); c.arc(bX, bY, bR, 0, Math.PI * 2); c.stroke();
    c.lineWidth = 1.2 * s;

    // ---- right data block: bezel x .718-.905, screen x .730-.893
    bezel(0.718, 0.738, 0.905, 0.995);
    screen(0.730, 0.758, 0.893, 0.962);
    const rows = [
      [`${fmtN(alt)} FT`, GREEN], [`${Math.round(sp).toString().padStart(3, '0')} KTS`, GREEN],
      [`${Math.round((0.07 + 0.93 * P.throttle) * 100)}% THRST${P.ab ? ' AB' : ''}`, GREEN],
      [`${(G.xmag || 1).toFixed(1)} XMAG`, GREEN], [`${G.radarRangeNM} MI RNG`, GREEN],
      [`DMG ${Math.round(P.damage)}%`, P.damage > 50 ? RED : GREEN],
      [`CHF ${P.stores.chaff} FLR ${P.stores.flares}`, GREEN],
    ];
    c.font = `bold ${11 * s}px "Courier New", monospace`;
    rows.forEach(([txt, col], i) => { c.fillStyle = col; c.fillText(txt, 0.745 * w, (0.795 + i * 0.0272) * h); });

    // ---- two lamp squares above the ECM button
    screen(0.905, 0.748, 0.968, 0.782, '#181818');
    c.fillStyle = '#0a0a0a';
    c.fillRect(0.910 * w, 0.753 * h, 0.024 * w, 0.022 * h);
    c.fillRect(0.939 * w, 0.753 * h, 0.024 * w, 0.022 * h);
    // ---- ECM button: x .905-.968, y .815-.868
    c.fillStyle = P.ecm ? AMBER : '#9a9a9a'; c.fillRect(0.905 * w, 0.815 * h, 0.063 * w, 0.053 * h);
    c.strokeStyle = '#3a3a3a'; c.strokeRect(0.905 * w, 0.815 * h, 0.063 * w, 0.053 * h);
    c.fillStyle = P.ecm ? '#1a1a1a' : '#2a2a2a';
    c.font = `bold ${11 * s}px "Courier New", monospace`;
    c.textAlign = 'center'; c.fillText('ECM', 0.9365 * w, 0.852 * h); c.textAlign = 'left';

    // ---- coordinates: periwinkle boxes, x .905-.998, lat y .878-.918, lon y .928-.968
    const lat = 37.7749 - (P.pos.z - 5000) / 111320;
    const lon = -122.4194 + (P.pos.x - 7000) / (111320 * Math.cos(37.7749 * Math.PI / 180));
    c.font = `bold ${10.5 * s}px "Courier New", monospace`;
    for (const [txt, y0f] of [[`${Math.abs(lat).toFixed(1)}${lat >= 0 ? 'N' : 'S'}`, 0.878], [`${Math.abs(lon).toFixed(1)}${lon >= 0 ? 'E' : 'W'}`, 0.928]]) {
      c.fillStyle = '#8a94c8'; c.fillRect(0.905 * w, y0f * h, 0.093 * w, 0.040 * h);
      c.strokeStyle = '#3a3a3a'; c.strokeRect(0.905 * w, y0f * h, 0.093 * w, 0.040 * h);
      c.fillStyle = '#1a2a6a';
      c.textAlign = 'center'; c.fillText(txt, 0.9515 * w, (y0f + 0.028) * h); c.textAlign = 'left';
    }
  }

  _radarScope(c, G, rX, rY, rW, rH, s) {
    const cx = rX + rW / 2, cy = rY + rH / 2;
    const range = G.radarRange;
    const pf = G.player.fwd;
    const hdg = Math.atan2(pf.x, -pf.z);
    // faint wedge lines like the original scope
    c.strokeStyle = '#1c4a28';
    c.beginPath();
    c.moveTo(cx, cy + rH * 0.40); c.lineTo(cx - rW * 0.38, cy - rH * 0.36);
    c.moveTo(cx, cy + rH * 0.40); c.lineTo(cx + rW * 0.38, cy - rH * 0.36);
    c.stroke();
    for (const ct of G.radarContacts) {
      const dx = ct.pos.x - G.player.pos.x, dz = ct.pos.z - G.player.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > range) continue;
      const ang = Math.atan2(dx, -dz) - hdg;
      const rr = dist / range;
      const x = cx + Math.sin(ang) * rr * rW * 0.46, y = cy - Math.cos(ang) * rr * rH * 0.42;
      switch (ct.kind) {
        case 'bandit': c.fillStyle = ct.identified === false ? '#6a6a6a' : RED; break;
        case 'af1': c.fillStyle = '#58d8ff'; break;
        case 'stolen': c.fillStyle = AMBER; break;
        case 'carrier': c.fillStyle = '#40d868'; break;
        case 'raft': c.fillStyle = '#ff8830'; break;
        case 'missile': c.fillStyle = Math.sin(G.time * 14) > 0 ? RED : '#4a0d05'; break;
        case 'sub': c.fillStyle = '#ff58c8'; break;
        default: c.fillStyle = WHITE;
      }
      if (ct.kind === 'carrier' || ct.kind === 'sub') {
        c.beginPath(); c.moveTo(x, y - 4 * s); c.lineTo(x + 4 * s, y + 3 * s); c.lineTo(x - 4 * s, y + 3 * s); c.closePath(); c.fill();
      } else {
        c.fillRect(x - 2 * s, y - 2 * s, 4 * s, 4 * s);
      }
    }
    // own ship
    c.fillStyle = GREEN;
    c.beginPath(); c.moveTo(cx, cy - 5 * s); c.lineTo(cx + 4 * s, cy + 4 * s); c.lineTo(cx - 4 * s, cy + 4 * s); c.closePath(); c.fill();
    c.font = `${9.5 * s}px "Courier New", monospace`;
    c.fillStyle = GREEN; c.textAlign = 'center';
    c.fillText(`${G.radarRangeNM} MI`, cx, rY + rH - 6 * s);   // inside the scope, like the original
    c.textAlign = 'left';
  }

  // weapons loadout page: top-view silhouette, one mark per hardpoint
  _loadout(c, P, x, y, wL, hL, s, time) {
    const cx = x + wL / 2, cy = y + hL / 2, u = Math.min(wL, hL) / 2 * 0.92;
    c.strokeStyle = GREEN; c.lineWidth = 1.4 * s;
    // fuselage
    c.beginPath();
    c.moveTo(cx, cy - u * 0.46);
    c.lineTo(cx - u * 0.07, cy - u * 0.30); c.lineTo(cx - u * 0.055, cy + u * 0.34);
    c.lineTo(cx + u * 0.055, cy + u * 0.34); c.lineTo(cx + u * 0.07, cy - u * 0.30);
    c.closePath(); c.stroke();
    // swept wings
    c.beginPath();
    c.moveTo(cx - u * 0.05, cy - u * 0.06); c.lineTo(cx - u * 0.46, cy + u * 0.20); c.lineTo(cx - u * 0.46, cy + u * 0.27); c.lineTo(cx - u * 0.05, cy + u * 0.14);
    c.moveTo(cx + u * 0.05, cy - u * 0.06); c.lineTo(cx + u * 0.46, cy + u * 0.20); c.lineTo(cx + u * 0.46, cy + u * 0.27); c.lineTo(cx + u * 0.05, cy + u * 0.14);
    c.stroke();
    // stabilators + twin fins
    c.beginPath();
    c.moveTo(cx - u * 0.03, cy + u * 0.30); c.lineTo(cx - u * 0.22, cy + u * 0.44); c.lineTo(cx - u * 0.22, cy + u * 0.48); c.lineTo(cx - u * 0.03, cy + u * 0.38);
    c.moveTo(cx + u * 0.03, cy + u * 0.30); c.lineTo(cx + u * 0.22, cy + u * 0.44); c.lineTo(cx + u * 0.22, cy + u * 0.48); c.lineTo(cx + u * 0.03, cy + u * 0.38);
    c.moveTo(cx - u * 0.09, cy + u * 0.20); c.lineTo(cx - u * 0.09, cy + u * 0.33);
    c.moveTo(cx + u * 0.09, cy + u * 0.20); c.lineTo(cx + u * 0.09, cy + u * 0.33);
    c.stroke();
    // hardpoints: wingtip AIM-9 x2, pylon AIM-120 x4 — lit while loaded,
    // blinking when that weapon is selected
    const store = (sx, sy, loaded, sel) => {
      c.fillStyle = !loaded ? '#0a3016' : (sel && Math.sin(time * 8) > -0.4 ? '#9aff9a' : GREEN);
      c.fillRect(cx + sx * u - 2.5 * s, cy + sy * u - 4 * s, 5 * s, 8 * s);
    };
    store(-0.46, 0.14, P.stores.aim9 >= 1, P.weapon === 'aim9');
    store( 0.46, 0.14, P.stores.aim9 >= 2, P.weapon === 'aim9');
    store(-0.30, 0.10, P.stores.aim120 >= 1, P.weapon === 'aim120');
    store(-0.16, 0.05, P.stores.aim120 >= 2, P.weapon === 'aim120');
    store( 0.16, 0.05, P.stores.aim120 >= 3, P.weapon === 'aim120');
    store( 0.30, 0.10, P.stores.aim120 >= 4, P.weapon === 'aim120');
    // selection label like the original's 'ARH AM' / 'IRH AM'
    c.fillStyle = P.weapon !== 'gun' ? GREEN : AMBER;
    c.font = `bold ${9.5 * s}px "Courier New", monospace`;
    c.textAlign = 'center';
    c.fillText(P.weapon === 'aim120' ? `ARH AM x${P.stores.aim120}` : P.weapon === 'aim9' ? `IRH AM x${P.stores.aim9}` : `GUN ${P.stores.gun}`, cx, y + hL - 4 * s);
    c.textAlign = 'left';
  }

  // ---------------- external view: the original's bottom readout ----------------
  _extBar(c, { P, s, sp, alt, hdg }) {
    const w = this.w, h = this.h, bH = h * 0.085;
    c.fillStyle = '#000'; c.fillRect(0, h - bH, w, bH);
    c.fillStyle = WHITE; c.font = `${13 * s}px "Courier New", monospace`;
    const y = h - bH * 0.35;
    c.fillText(`HDG ${Math.round((deg(hdg) + 360) % 360).toString().padStart(3, '0')}`, w * 0.07, y);
    c.fillText(`${Math.round(sp)} KTS`, w * 0.30, y);
    c.fillText(`${Math.round(alt)} FT`, w * 0.50, y);
    c.textAlign = 'right';
    c.fillText(`THR ${Math.round(P.throttle * 100).toString().padStart(3, '0')}${P.ab ? ' AB' : ''}`, w * 0.93, y);
    c.textAlign = 'left';
    // small white score, top left
    c.fillStyle = WHITE; c.font = `${10.5 * s}px "Courier New", monospace`;
    c.fillText(`SCORE ${P ? this._score || '' : ''}`, -9999, -9999); // (score shown on menus/debrief)
  }

  _mouseStick(c, G, s) {
    if (!G.input.mouseStick) return;
    const x = this.w - 70 * s, y = this.h * 0.62, r = 34 * s;
    c.strokeStyle = 'rgba(242,242,242,0.55)';
    c.strokeRect(x - r, y - r, r * 2, r * 2);
    c.fillStyle = WHITE;
    c.beginPath(); c.arc(x + G.input.mx * r, y + G.input.my * r, 3.5 * s, 0, Math.PI * 2); c.fill();
    c.font = `${8.5 * s}px "Courier New", monospace`;
    c.fillText('MOUSE STICK (M)', x - r, y + r + 12 * s);
  }
  _centerText(c, txt, s) {
    c.fillStyle = WHITE; c.font = `${11 * s}px "Courier New", monospace`;
    c.textAlign = 'center'; c.fillText(txt, this.cxw, this.h - 10 * s); c.textAlign = 'left';
  }
}
