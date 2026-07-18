// input.js — keyboard + mouse virtual stick
import { clamp } from './util.js';

export class Input {
  constructor() {
    this.keys = new Set();
    this.justPressed = new Set();
    this.mouseStick = false;
    this.mx = 0; this.my = 0;           // -1..1 stick deflection
    this.pitch = 0; this.roll = 0; this.yaw = 0; this.throttleDelta = 0;
    this.ab = false; this.trigger = false;
    window.addEventListener('keydown', (e) => {
      if (e.repeat) { this.keys.add(e.code); return; }
      this.keys.add(e.code); this.justPressed.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('mousemove', (e) => {
      this.mx = clamp((e.clientX / window.innerWidth) * 2 - 1, -1, 1);
      this.my = clamp((e.clientY / window.innerHeight) * 2 - 1, -1, 1);
    });
  }
  pressed(code) { return this.justPressed.has(code); }
  down(code) { return this.keys.has(code); }
  // call once per frame after game logic reads justPressed
  postUpdate() { this.justPressed.clear(); }
  poll() {
    // discrete
    if (this.pressed('KeyM')) this.mouseStick = !this.mouseStick;
    // continuous axes
    let pitch = 0, roll = 0, yaw = 0, thr = 0;
    if (this.down('ArrowUp')) pitch += 1;
    if (this.down('ArrowDown')) pitch -= 1;
    if (this.down('ArrowLeft')) roll -= 1;
    if (this.down('ArrowRight')) roll += 1;
    if (this.mouseStick) {
      // mouse position maps to stick deflection (with deadzone)
      const dz = 0.06;
      const ax = Math.abs(this.mx) < dz ? 0 : this.mx;
      const ay = Math.abs(this.my) < dz ? 0 : this.my;
      roll = clamp(ax * 1.6, -1, 1);
      pitch = clamp(-ay * 1.6, -1, 1);
    }
    if (this.down('Comma')) yaw -= 1;
    if (this.down('Period')) yaw += 1;
    if (this.down('KeyW')) thr += 1;
    if (this.down('KeyS')) thr -= 1;
    // number keys set throttle directly (like the original's F1-F10)
    const nums = ['Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7','Digit8','Digit9','Digit0'];
    this.throttleSet = -1;
    for (let i = 0; i < 10; i++) if (this.pressed(nums[i])) this.throttleSet = ((i + 1) % 10) / 10;
    this.pitch = clamp(pitch, -1, 1);
    this.roll = clamp(roll, -1, 1);
    this.yaw = yaw;
    this.throttleDelta = thr;
    this.ab = this.down('ShiftLeft') || this.down('ShiftRight');
    this.trigger = this.down('KeyG');
  }
}
