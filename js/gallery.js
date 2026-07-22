// gallery.js — aircraft gallery: examine the game's models up close.
// Rotate with arrows / A D W S (or drag the mouse), zoom with +/- or the
// wheel, cycle aircraft with Tab / [ ] / 1-4, leave with Q or ESC.
import * as THREE from 'three';
import { buildModel } from './models.js';
import { clamp } from './util.js';

const ITEMS = [
  { type: 'f18',   name: 'F/A-18 HORNET',              info: 'CARRIER-CAPABLE MULTIROLE STRIKE FIGHTER — THE MOUNT' },
  { type: 'f16',   name: 'F-16 FIGHTING FALCON',       info: 'LAND-BASED AIR-DEFENCE HOT-ROD — NO TAILHOOK' },
  { type: 'b707',  name: 'AIR FORCE ONE (BOEING 707)', info: 'PRESIDENTIAL HEAVY — DO NOT SCRATCH THE PAINT' },
  { type: 'mig29', name: 'MIG-29 FULCRUM',             info: 'ENEMY BOGEY — TWIN-TAIL AGILE FIGHTER' },
];

export class Gallery {
  constructor(G, onExit) {
    this.G = G; this.onExit = onExit;
    this.idx = 0; this.yaw = 0.8; this.pitch = 0.15; this.dist = 40;
    this.model = null;
    this.anchor = new THREE.Vector3(-6000, 1400, -6000);   // over the ocean, bay behind
    this._e = new THREE.Euler();
    this._drag = null;
    this._onDown = (e) => { this._drag = { x: e.clientX, y: e.clientY }; };
    this._onMove = (e) => {
      if (!this._drag) return;
      this.yaw += (e.clientX - this._drag.x) * 0.006;
      this.pitch = clamp(this.pitch + (e.clientY - this._drag.y) * 0.005, -1.2, 1.2);
      this._drag = { x: e.clientX, y: e.clientY };
    };
    this._onUp = () => { this._drag = null; };
  }
  enter() {
    this.G.state = 'gallery';
    window.addEventListener('mousedown', this._onDown);
    window.addEventListener('mousemove', this._onMove);
    window.addEventListener('mouseup', this._onUp);
    this._show(this.idx);
  }
  exit() {
    window.removeEventListener('mousedown', this._onDown);
    window.removeEventListener('mousemove', this._onMove);
    window.removeEventListener('mouseup', this._onUp);
    if (this.model) { this.G.scene.remove(this.model); this.model = null; }
    this.onExit();
  }
  _show(i) {
    this.idx = ((i % ITEMS.length) + ITEMS.length) % ITEMS.length;
    if (this.model) this.G.scene.remove(this.model);
    this.model = buildModel(ITEMS[this.idx].type);
    this.model.position.copy(this.anchor);
    this.G.scene.add(this.model);
  }
  update(dt, I) {
    const R = 1.9 * dt;
    if (I.down('ArrowLeft') || I.down('KeyA')) this.yaw -= R;
    if (I.down('ArrowRight') || I.down('KeyD')) this.yaw += R;
    if (I.down('ArrowUp') || I.down('KeyW')) this.pitch = clamp(this.pitch - R * 0.7, -1.2, 1.2);
    if (I.down('ArrowDown') || I.down('KeyS')) this.pitch = clamp(this.pitch + R * 0.7, -1.2, 1.2);
    if (I.down('Minus') || I.down('NumpadSubtract')) this.dist = Math.min(170, this.dist + 34 * dt);   // - : zoom out
    if (I.down('Equal') || I.down('NumpadAdd')) this.dist = Math.max(18, this.dist - 34 * dt);         // + : zoom in
    if (I.wheel) this.dist = clamp(this.dist + I.wheel * 7, 18, 170);
    if (I.pressed('Tab') || I.pressed('BracketRight')) this._show(this.idx + 1);
    if (I.pressed('BracketLeft')) this._show(this.idx - 1);
    for (let k = 0; k < ITEMS.length; k++) if (I.pressed('Digit' + (k + 1))) this._show(k);
    if (I.pressed('KeyQ') || I.pressed('Escape')) { this.exit(); return; }
    if (this.model) {
      this._e.set(this.pitch, this.yaw, 0, 'YXZ');
      this.model.quaternion.setFromEuler(this._e);
    }
    const cam = this.G.camera, a = this.anchor;
    cam.position.set(a.x + this.dist * 0.85, a.y + this.dist * 0.28, a.z - this.dist * 0.85);
    cam.up.set(0, 1, 0);
    cam.lookAt(a.x, a.y + 2, a.z);
    if (cam.fov !== 55) { cam.fov = 55; cam.updateProjectionMatrix(); }
  }
  drawOverlay(c, w, h) {
    const s = clamp(h / 500, 0.6, 1.5), it = ITEMS[this.idx];
    c.textAlign = 'center';
    c.fillStyle = 'rgba(0,0,0,0.45)';
    c.fillRect(0, h * 0.055, w, h * 0.105);
    c.fillStyle = '#9df09d';
    c.font = `bold ${17 * s}px "Courier New", monospace`;
    c.fillText(`AIRCRAFT GALLERY — ${this.idx + 1}/${ITEMS.length}`, w / 2, h * 0.10);
    c.fillStyle = '#ffd76a';
    c.font = `bold ${21 * s}px "Courier New", monospace`;
    c.fillText(it.name, w / 2, h * 0.145);
    c.fillStyle = '#9df09d';
    c.font = `${11 * s}px "Courier New", monospace`;
    c.fillText(it.info, w / 2, h * 0.90);
    c.fillStyle = '#6a9a6a';
    c.fillText('ARROWS / DRAG — ROTATE     + / - / WHEEL — ZOOM     1-4 / TAB — NEXT AIRCRAFT     Q — MENU', w / 2, h * 0.94);
    c.textAlign = 'left';
  }
}
