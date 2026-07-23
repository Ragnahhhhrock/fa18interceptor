// input.js — keyboard + mouse virtual stick
import { clamp } from './util.js';

export class Input {
  constructor() {
    this.keys = new Set();
    this.justPressed = new Set();
    this.mouseStick = false;
    this.mx = 0; this.my = 0;           // -1..1 stick deflection
    this.plLocked = false; this.plx = 0; this.ply = 0;  // pointer-lock stick (trackpad/mouse)
    document.addEventListener('pointerlockchange', () => {
      this.plLocked = !!document.pointerLockElement;
      if (!this.plLocked) { this.plx = 0; this.ply = 0; }
    });
    this.pitch = 0; this.roll = 0; this.yaw = 0; this.throttleDelta = 0;
    this.ab = false; this.trigger = false;
    this.taActive = false; this.tax = 0; this.tay = 0;   // touch stick (touch.js)
    window.addEventListener('keydown', (e) => {
      if (e.repeat) { this.keys.add(e.code); return; }
      this.keys.add(e.code); this.justPressed.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab'].includes(e.code)
        || /^F\d{1,2}$/.test(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.mb0 = false; });
    // the original's fire button was the mouse button
    window.addEventListener('mousedown', (e) => { if (e.button === 0) this.mb0 = true; });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.mb0 = false; });
    window.addEventListener('mousemove', (e) => {
      this.mx = clamp((e.clientX / window.innerWidth) * 2 - 1, -1, 1);
      this.my = clamp((e.clientY / window.innerHeight) * 2 - 1, -1, 1);
      if (this.plLocked) {
        // relative movement drives the stick like a sprung stick held off-center
        this.plx = clamp(this.plx + e.movementX * 0.006, -1, 1);
        this.ply = clamp(this.ply + e.movementY * 0.006, -1, 1);
      }
    });
    this.wheel = 0;
    window.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
  }
  pressed(code) { return this.justPressed.has(code); }
  down(code) { return this.keys.has(code); }
  // call once per frame after game logic reads justPressed
  postUpdate() { this.justPressed.clear(); this.wheel = 0; }
  poll() {
    // discrete
    if (this.pressed('KeyY')) this.mouseStick = !this.mouseStick;
    // continuous axes
    let pitch = 0, roll = 0, yaw = 0, thr = 0;
    // stick sense: pull back (ArrowDown) = nose up, push (ArrowUp) = nose down
    if (this.down('ArrowUp')) pitch -= 1;
    if (this.down('ArrowDown')) pitch += 1;
    if (this.down('ArrowLeft')) roll -= 1;
    if (this.down('ArrowRight')) roll += 1;
    if (this.mouseStick) {
      // mouse position maps to stick deflection (with deadzone); when the
      // pointer is captured (click the screen) relative movement drives it —
      // that's what makes a trackpad playable
      const dz = 0.06;
      const sx = this.plLocked ? this.plx : this.mx;
      const sy = this.plLocked ? this.ply : this.my;
      const ax = Math.abs(sx) < dz ? 0 : sx;
      const ay = Math.abs(sy) < dz ? 0 : sy;
      roll = clamp(ax * 1.6, -1, 1);
      pitch = clamp(ay * 1.6, -1, 1);   // mouse back (down) = pull back = nose up
    }
    if (this.taActive) {
      // touch thumb-stick: same sense as the mouse stick — drag down = pull back
      const dz = 0.06;
      const ax = Math.abs(this.tax) < dz ? 0 : this.tax;
      const ay = Math.abs(this.tay) < dz ? 0 : this.tay;
      roll = clamp(ax * 1.7, -1, 1);
      pitch = clamp(ay * 1.7, -1, 1);
    }
    if (this.down('Comma')) yaw -= 1;
    if (this.down('Period')) yaw += 1;
    if (this.down('KeyW')) thr += 1;
    if (this.down('KeyS')) thr -= 1;
    // number keys + F1-F10 set throttle directly (the original used F1-F10)
    const nums = ['Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7','Digit8','Digit9','Digit0'];
    const fks = ['F1','F2','F3','F4','F5','F6','F7','F8','F9','F10'];
    this.throttleSet = -1;
    for (let i = 0; i < 10; i++) if (this.pressed(nums[i]) || this.pressed(fks[i])) this.throttleSet = ((i + 1) % 10) / 10;
    this.pitch = clamp(pitch, -1, 1);
    this.roll = clamp(roll, -1, 1);
    this.yaw = yaw;
    this.throttleDelta = thr;
    this.ab = this.down('ShiftLeft') || this.down('ShiftRight');
    this.trigger = !!this.mb0;   // gun trigger = mouse fire button, like the original
  }
}
