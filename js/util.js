// util.js — math helpers shared across modules
import * as THREE from 'three';

export const KTS = 0.514444;      // 1 knot in m/s
export const FT  = 0.3048;        // 1 foot in m
export const NM  = 1852;          // 1 nautical mile in m

export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp  = (a, b, t) => a + (b - a) * t;
// frame-rate independent damping toward target
export const damp = (cur, target, rate, dt) => lerp(cur, target, 1 - Math.exp(-rate * dt));
export const rand = (a = 1, b) => b === undefined ? Math.random() * a : a + Math.random() * (b - a);
export const randSpread = (s) => (Math.random() - 0.5) * 2 * s;
export const deg = (r) => r * 180 / Math.PI;
export const rad = (d) => d * Math.PI / 180;

export function wrapAngle(a) {
  while (a >  Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// heading (rad, 0 = north/-Z, clockwise) -> direction vector
export function headingToVec(h, out = new THREE.Vector3()) {
  out.set(Math.sin(h), 0, -Math.cos(h));
  return out;
}
// direction vector -> heading
export function vecToHeading(v) {
  return Math.atan2(v.x, -v.z);
}

const _e = new THREE.Euler();
// flight attitude -> quaternion. h: heading(0=north), p: pitch(+nose up), b: bank(+right wing down). nose = +Z
export function flightQuat(h, p, b, out = new THREE.Quaternion()) {
  _e.set(-p, Math.PI - h, -b, 'YXZ');
  return out.setFromEuler(_e);
}

export function fmtInt(n) { return Math.round(n).toLocaleString('en-US'); }

// Simple value-noise for terrain (deterministic)
const P = new Uint8Array(512);
(() => { let s = 1337; const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) P[i] = p[i & 255];
})();
const fade = (t) => t * t * (3 - 2 * t);
export function noise2(x, y) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
  x -= Math.floor(x); y -= Math.floor(y);
  const u = fade(x), v = fade(y);
  const a = P[P[X] + Y] / 255, b = P[P[X + 1] + Y] / 255;
  const c = P[P[X] + Y + 1] / 255, d = P[P[X + 1] + Y + 1] / 255;
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}
export function fbm(x, y, oct = 4) {
  let v = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { v += amp * noise2(x * f, y * f); amp *= 0.5; f *= 2.03; }
  return v;
}
