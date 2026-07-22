// models.js — procedural low-poly aircraft (nose = +Z, up = +Y, right = +X)
import * as THREE from 'three';

function M(color, opts = {}) {
  return new THREE.MeshLambertMaterial(Object.assign({ color, flatShading: true }, opts));
}
function wingGeo(points, thick) {
  // points: [[span, chordZ], ...] planform outline in XY, extruded in Z then laid flat
  const sh = new THREE.Shape();
  sh.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) sh.lineTo(points[i][0], points[i][1]);
  sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: thick, bevelEnabled: false });
  g.rotateX(Math.PI / 2); // -> lies in XZ, thickness in Y
  g.translate(0, thick / 2, 0);
  return g;
}
function cone(r, len, color, segs = 8) {
  const g = new THREE.ConeGeometry(r, len, segs);
  g.rotateX(Math.PI / 2); // point along +Z
  return new THREE.Mesh(g, M(color));
}
function box(w, h, d, color) { return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M(color)); }
function cyl(r1, r2, len, color, segs = 10) {
  const g = new THREE.CylinderGeometry(r1, r2, len, segs);
  g.rotateX(Math.PI / 2); // axis along Z
  return new THREE.Mesh(g, M(color));
}
function abFlame(len = 3.4, r = 0.5) {
  const g = new THREE.ConeGeometry(r, len, 8);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffa030, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  m.visible = false;
  return m;
}
function missileMesh(color = 0xe8e8e8, len = 3, r = 0.14) {
  const g = new THREE.Group();
  const b = cyl(r, r, len * 0.75, color, 6); g.add(b);
  const n = cone(r, len * 0.25, 0xc03030, 6); n.position.z = len * 0.5; g.add(n);
  const f1 = box(0.5, 0.04, 0.4, color); f1.position.z = -len * 0.25; g.add(f1);
  const f2 = box(0.04, 0.5, 0.4, color); f2.position.z = -len * 0.25; g.add(f2);
  return g;
}

// ---------------- F/A-18 Hornet ----------------
// navigation lights — red port (+X is the left wing), green starboard, white
// tail; collected in userData.nav so the game can toggle them with the sun
let _navTex = null, _navMats = null;
function addNavLights(g, halfSpan, tailZ, y = 1) {
  if (!_navTex) _navTex = makeGlowTexture();
  if (!_navMats) _navMats = {
    r: new THREE.SpriteMaterial({ map: _navTex, color: 0xff2020, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    g: new THREE.SpriteMaterial({ map: _navTex, color: 0x28ff40, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    w: new THREE.SpriteMaterial({ map: _navTex, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  };
  if (!g.userData.nav) g.userData.nav = [];
  const mk = (mat, x, yy, z) => {
    const sp = new THREE.Sprite(mat);
    sp.scale.setScalar(3); sp.position.set(x, yy, z); sp.visible = false;
    g.add(sp); g.userData.nav.push(sp);
  };
  mk(_navMats.r, halfSpan, y, 0);
  mk(_navMats.g, -halfSpan, y, 0);
  mk(_navMats.w, 0, y + 0.5, tailZ);
}

export function buildFA18() {
  const g = new THREE.Group();
  const C = 0xa8b4bc, CD = 0x8a98a0;
  const fus = box(2.0, 1.7, 9.5, C); fus.position.z = -0.8; g.add(fus);
  const spine = box(1.5, 0.5, 6, CD); spine.position.set(0, 1.0, -2); g.add(spine);
  // dorsal antenna blade behind the canopy
  const ant = box(0.07, 0.4, 0.55, CD); ant.position.set(0, 1.35, -0.6); g.add(ant);
  // slender radome with a hint of the real jet's droop
  const nose = cone(0.82, 5.0, C); nose.scale.set(1.12, 0.88, 1); nose.position.z = 6.4; g.add(nose);
  // teardrop bubble canopy — tinted gold/green like the real laminated glass
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.85, 10, 8),
    M(0x5a707c));
  canopy.scale.set(0.8, 0.6, 2.3); canopy.position.set(0, 0.98, 3.15); g.add(canopy);
  // LEX — long ogival strakes running from the cockpit back into the wing
  const lexG = wingGeo([[0.4, 5.3], [2.2, 0.4], [0.4, 0.4]], 0.12);
  for (const s of [1, -1]) {
    const lex = new THREE.Mesh(lexG, M(CD)); lex.scale.x = s; lex.position.set(0, 0.35, 0.6); g.add(lex);
  }
  // main wing — trapezoid, taper ~0.3 like the real planform
  const wG = wingGeo([[0.8, 1.9], [0.8, -3.4], [6.6, -2.6], [6.6, -0.9]], 0.22);
  for (const s of [1, -1]) {
    const w = new THREE.Mesh(wG, M(C)); w.scale.x = s; w.position.y = 0.15; g.add(w);
  }
  // twin canted tails on the rear shelf, outboard of the nozzles
  const tG = wingGeo([[0, 0.4], [0, -2.0], [2.6, -2.9], [2.6, -2.2]], 0.16);
  for (const s of [1, -1]) {
    const t = new THREE.Mesh(tG, M(C));
    t.rotation.z = Math.PI / 2 - s * 0.31;
    t.position.set(s * 2.0, 0.65, -3.2); g.add(t);
  }
  // engines + nozzles + AB
  const ab = [];
  for (const s of [1, -1]) {
    const e = cyl(0.72, 0.62, 4.6, CD); e.position.set(s * 0.85, -0.1, -5.6); g.add(e);
    const nz = cyl(0.55, 0.42, 1.2, 0x33383e); nz.position.set(s * 0.85, -0.1, -8.2); g.add(nz);
    const ni = cyl(0.38, 0.38, 0.18, 0x0a0a0c); ni.position.set(s * 0.85, -0.1, -8.72); g.add(ni);   // dark tailpipe
    const f = abFlame(3.6, 0.5); f.position.set(s * 0.85, -0.1, -9.6); g.add(f); ab.push(f);
    // D-shaped intakes under the LEX, with dark splitter-gap mouths
    const it = box(0.95, 0.85, 2.8, CD); it.position.set(s * 1.15, -0.5, 0.9); g.add(it);
    const mouth = box(0.7, 0.62, 0.12, 0x0c0e10); mouth.position.set(s * 1.15, -0.5, 2.34); g.add(mouth);
  }
  // centre "beaver tail" fairing between the nozzles (hook attach point)
  const bt = box(0.34, 0.5, 2.0, CD); bt.position.set(0, -0.15, -7.7); g.add(bt);
  // stabilators (animated with pitch)
  const sG = wingGeo([[0.3, 0.3], [0.3, -1.8], [3.5, -1.5], [3.5, -0.3]], 0.14);
  const stabL = new THREE.Mesh(sG, M(C)); stabL.position.set(0.4, 0.1, -6.5); g.add(stabL);
  const stabR = new THREE.Mesh(sG, M(C)); stabR.scale.x = -1; stabR.position.set(-0.4, 0.1, -6.5); g.add(stabR);
  // gear
  const gear = new THREE.Group();
  const gm = M(0x2c3136);
  const mkWheel = (x, y, z) => {
    const w = new THREE.Group();
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.4, 6), gm); strut.position.y = 0.7; w.add(strut);
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.22, 10), gm);
    tire.rotation.z = Math.PI / 2; tire.position.y = 0.1; w.add(tire);
    w.position.set(x, y, z); return w;
  };
  gear.add(mkWheel(0, -2.1, 3.6), mkWheel(1.1, -2.1, -1.4), mkWheel(-1.1, -2.1, -1.4));
  g.add(gear);
  // tailhook (stows under the beaver tail)
  const hook = box(0.1, 0.1, 2.6, 0xcccccc); hook.position.set(0, -0.45, -8.3);
  hook.rotation.x = -0.5; hook.visible = false; g.add(hook);
  // weapons (visual)
  const stores = { aim9: [], aim120: [] };
  for (const s of [1, -1]) {
    const m9 = missileMesh(0xe8e8e8, 2.9, 0.13); m9.position.set(s * 6.6, -0.1, -1.7); g.add(m9); stores.aim9.push(m9);
    for (const px of [2.6, 4.4]) {
      const m120 = missileMesh(0xd8d8d8, 3.6, 0.16); m120.position.set(s * px, -0.55, -1.8); g.add(m120); stores.aim120.push(m120);
    }
  }
  g.userData = { ab, gear, hook, stabL, stabR, stores, type: 'f18' };
  addNavLights(g, 6.8, -8.5, 1.0);
  return g;
}

// ---------------- F-16 Fighting Falcon ----------------
export function buildF16() {
  const g = new THREE.Group();
  const C = 0xa8b4bc, CD = 0x8a98a0;
  const fus = box(1.7, 1.5, 9, C); fus.position.z = -0.6; g.add(fus);
  const nose = cone(0.75, 3.8, C); nose.position.z = 5.8; g.add(nose);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.8, 10, 8),
    M(0x94a2aa));
  canopy.scale.set(0.8, 0.6, 1.8); canopy.position.set(0, 0.85, 2.6); g.add(canopy);
  const intake = box(1.0, 0.6, 2.2, CD); intake.position.set(0, -0.75, 2.2); g.add(intake);
  const wG = wingGeo([[0.7, 1.2], [0.7, -3.2], [5.4, -3.3], [5.4, -2.7]], 0.2);
  for (const s of [1, -1]) { const w = new THREE.Mesh(wG, M(C)); w.scale.x = s; w.position.y = 0.05; g.add(w); }
  // single tail
  const tG = wingGeo([[0, 0.6], [0, -2.4], [3.6, -3.4], [3.6, -2.6]], 0.16);
  const tail = new THREE.Mesh(tG, M(C)); tail.rotation.z = Math.PI / 2; tail.position.set(0, 0.5, -3.0); g.add(tail);
  for (const s of [1, -1]) {
    const vf = box(0.12, 1.0, 1.4, CD); vf.position.set(s * 0.5, -0.9, -4.6); g.add(vf);
  }
  const e = cyl(0.75, 0.6, 4.4, CD); e.position.set(0, -0.05, -5.2); g.add(e);
  const nz = cyl(0.55, 0.42, 1.1, 0x33383e); nz.position.set(0, -0.05, -7.6); g.add(nz);
  const f = abFlame(3.4, 0.5); f.position.set(0, -0.05, -8.9); g.add(f);
  const sG = wingGeo([[0.3, 0.1], [0.3, -1.4], [2.8, -1.2], [2.8, -0.5]], 0.13);
  const stabL = new THREE.Mesh(sG, M(C)); stabL.position.set(0.3, 0.05, -5.4); g.add(stabL);
  const stabR = new THREE.Mesh(sG, M(C)); stabR.scale.x = -1; stabR.position.set(-0.3, 0.05, -5.4); g.add(stabR);
  const gear = new THREE.Group();
  const gm = M(0x2c3136);
  const mkWheel = (x, y, z) => {
    const w = new THREE.Group();
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.3, 6), gm); strut.position.y = 0.65; w.add(strut);
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.2, 10), gm);
    tire.rotation.z = Math.PI / 2; tire.position.y = 0.08; w.add(tire);
    w.position.set(x, y, z); return w;
  };
  gear.add(mkWheel(0, -1.9, 3.2), mkWheel(1.0, -1.9, -1.2), mkWheel(-1.0, -1.9, -1.2));
  g.add(gear);
  const hook = box(0.1, 0.1, 2.2, 0xcccccc); hook.position.set(0, -0.55, -6.6);
  hook.rotation.x = -0.5; hook.visible = false; g.add(hook);
  const stores = { aim9: [], aim120: [] };
  for (const s of [1, -1]) {
    const m9 = missileMesh(0xe8e8e8, 2.9, 0.13); m9.position.set(s * 5.4, -0.05, -3.0); g.add(m9); stores.aim9.push(m9);
    for (const px of [2.2, 3.8]) {
      const m120 = missileMesh(0xd8d8d8, 3.6, 0.16); m120.position.set(s * px, -0.5, -2.2); g.add(m120); stores.aim120.push(m120);
    }
  }
  g.userData = { ab: [f], gear, hook, stabL, stabR, stores, type: 'f16' };
  addNavLights(g, 5.0, -7.5, 0.8);
  return g;
}

// ---------------- MiG-29 Fulcrum ----------------
export function buildMiG29() {
  const g = new THREE.Group();
  const C = 0x5a626a, CD = 0x4a5258;
  const fus = box(2.6, 1.4, 10, C); fus.position.z = -1; g.add(fus);
  const nose = cone(0.8, 4.8, CD); nose.scale.set(1.2, 0.85, 1); nose.position.z = 6.4; g.add(nose);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.8, 10, 8),
    M(0x4a5258));
  canopy.scale.set(0.85, 0.55, 1.7); canopy.position.set(0, 0.85, 3.0); g.add(canopy);
  const irst = new THREE.Mesh(new THREE.SphereGeometry(0.16, 6, 6), M(0x1a1a1a));
  irst.position.set(0.35, 0.75, 4.6); g.add(irst);
  const wG = wingGeo([[1.0, 1.4], [1.0, -3.6], [6.2, -3.0], [6.2, -2.2]], 0.22);
  for (const s of [1, -1]) { const w = new THREE.Mesh(wG, M(C)); w.scale.x = s; w.position.y = 0.1; g.add(w); }
  // glove intakes (top louvres)
  for (const s of [1, -1]) {
    const it = box(1.0, 0.9, 3.4, CD); it.position.set(s * 1.5, -0.6, 0.4); g.add(it);
    const e = cyl(0.7, 0.6, 4.8, CD); e.position.set(s * 0.95, -0.05, -5.8); g.add(e);
    const nz = cyl(0.52, 0.4, 1.2, 0x2c3136); nz.position.set(s * 0.95, -0.05, -8.4); g.add(nz);
  }
  const ab = [];
  for (const s of [1, -1]) { const f = abFlame(3.4, 0.48); f.position.set(s * 0.95, -0.05, -9.8); g.add(f); ab.push(f); }
  // tailboom
  const tb = box(0.7, 0.5, 3.4, CD); tb.position.set(0, 0.35, -8.6); g.add(tb);
  // twin canted fins (vertical, canted outward)
  const tG = wingGeo([[0, 0.5], [0, -2.2], [2.7, -3.1], [2.7, -2.4]], 0.16);
  for (const s of [1, -1]) {
    const t = new THREE.Mesh(tG, M(C));
    t.rotation.z = Math.PI / 2 - s * 0.22; t.position.set(s * 2.4, 0.6, -3.6); g.add(t);
  }
  const sG = wingGeo([[0.4, 0.2], [0.4, -1.6], [3.4, -1.4], [3.4, -0.6]], 0.14);
  const stabL = new THREE.Mesh(sG, M(C)); stabL.position.set(0.6, 0, -6.6); g.add(stabL);
  const stabR = new THREE.Mesh(sG, M(C)); stabR.scale.x = -1; stabR.position.set(-0.6, 0, -6.6); g.add(stabR);
  g.userData = { ab, gear: null, hook: null, stabL, stabR, stores: { aim9: [], aim120: [] }, type: 'mig29' };
  addNavLights(g, 5.7, -8.5, 1.0);
  return g;
}

// ---------------- Boeing 747 (Air Force One) ----------------
export function build747() {
  const g = new THREE.Group();
  const W = 0xf0f2f4, B = 0x3a6ac0;
  const fus = cyl(3.6, 3.2, 62, W, 14); fus.position.z = 0; g.add(fus);
  const nose = cone(3.6, 10, W, 14); nose.position.z = 36; g.add(nose);
  const hump = box(5.5, 2.4, 16, W); hump.position.set(0, 3.6, 22); g.add(hump);
  const belly = cyl(3.4, 3.4, 56, B, 14); belly.scale.set(1.02, 0.55, 1); belly.position.set(0, -1.6, -2); g.add(belly);
  const tailCone = cone(3.0, 9, W, 10); tailCone.rotation.x = Math.PI; tailCone.position.z = -35; g.add(tailCone);
  const wG = wingGeo([[2.5, 4], [2.5, -8], [30, -8], [30, -5.5]], 0.5);
  for (const s of [1, -1]) { const w = new THREE.Mesh(wG, M(W)); w.scale.x = s; w.position.y = -0.5; g.add(w); }
  // 4 engines
  for (const s of [1, -1]) for (const [ex, ez] of [[9, 0], [17, -2]]) {
    const en = cyl(1.3, 1.1, 5, 0xd8dce0, 10); en.position.set(s * ex, -3.0, ez + 1); g.add(en);
  }
  // tail
  const tG = wingGeo([[0, 2], [0, -5], [11, -7.5], [11, -5.5]], 0.6);
  const tail = new THREE.Mesh(tG, M(B)); tail.rotation.z = Math.PI / 2; tail.position.set(0, 2.5, -28); g.add(tail);
  const sG = wingGeo([[1.5, 1], [1.5, -3], [11, -3.5], [11, -2]], 0.4);
  for (const s of [1, -1]) { const st = new THREE.Mesh(sG, M(W)); st.scale.x = s; st.position.set(0, 1, -30); g.add(st); }
  g.userData = { ab: [], gear: null, hook: null, stabL: null, stabR: null, stores: { aim9: [], aim120: [] }, type: 'b747' };
  addNavLights(g, 30, -34, 2.5);
  return g;
}

// ---------------- Boeing 707 ----------------
export function build707() {
  const g = new THREE.Group();
  const W = 0xd8dce0;
  const fus = cyl(2.0, 1.8, 40, W, 12); g.add(fus);
  const nose = cone(2.0, 6, W, 12); nose.position.z = 23; g.add(nose);
  const tailCone = cone(1.6, 6, W, 10); tailCone.rotation.x = Math.PI; tailCone.position.z = -23; g.add(tailCone);
  const wG = wingGeo([[1.4, 2], [1.4, -5], [17, -6], [17, -4]], 0.35);
  for (const s of [1, -1]) { const w = new THREE.Mesh(wG, M(W)); w.scale.x = s; w.position.y = -0.6; g.add(w); }
  for (const s of [1, -1]) for (const [ex, ez] of [[5.5, -1], [10, -2]]) {
    const en = cyl(0.8, 0.7, 3.4, 0xb8bcc0, 8); en.position.set(s * ex, -1.8, ez); g.add(en);
  }
  const tG = wingGeo([[0, 1.5], [0, -3.5], [7.5, -5], [7.5, -3.8]], 0.4);
  const tail = new THREE.Mesh(tG, M(0x8898a8)); tail.rotation.z = Math.PI / 2; tail.position.set(0, 1.6, -19); g.add(tail);
  const sG = wingGeo([[1, 0.8], [1, -2.2], [7, -2.6], [7, -1.6]], 0.3);
  for (const s of [1, -1]) { const st = new THREE.Mesh(sG, M(W)); st.scale.x = s; st.position.set(0, 0.6, -20); g.add(st); }
  g.userData = { ab: [], gear: null, hook: null, stabL: null, stabR: null, stores: { aim9: [], aim120: [] }, type: 'b707' };
  addNavLights(g, 22, -21, 1.8);
  return g;
}

// ---------------- cruise missile ----------------
export function buildCruiseMissile() {
  const g = new THREE.Group();
  const b = cyl(0.35, 0.3, 5.4, 0x4a5258, 8); g.add(b);
  const n = cone(0.35, 1.4, 0x3a4148, 8); n.position.z = 3.4; g.add(n);
  const w1 = box(3.2, 0.08, 0.9, 0x4a5258); w1.position.z = 0.4; g.add(w1);
  const w2 = box(0.08, 1.8, 0.7, 0x4a5258); w2.position.z = -2.2; g.add(w2);
  const w3 = box(2.2, 0.08, 0.7, 0x4a5258); w3.position.z = -2.2; g.add(w3);
  const f = abFlame(2.2, 0.3); f.position.z = -3.6; f.visible = true; g.add(f);
  g.userData = { ab: [f], gear: null, hook: null, stabL: null, stabR: null, stores: { aim9: [], aim120: [] }, type: 'cruise' };
  return g;
}

// ---------------- rescue raft ----------------
export function buildRaft() {
  const g = new THREE.Group();
  const raft = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.55, 8, 12), M(0xe86818));
  raft.rotation.x = Math.PI / 2; raft.position.y = 0.4; g.add(raft);
  const pilot = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 6), M(0x2a4a2a));
  pilot.position.y = 0.9; g.add(pilot);
  g.userData = { type: 'raft' };
  return g;
}

// surfaced submersible aircraft carrier (mission 6 target)
export function buildSub() {
  const g = new THREE.Group();
  const hullMat = M(0x23282e), deckMat = M(0x31383f);
  // main hull
  const hull = new THREE.Mesh(new THREE.CylinderGeometry(6.5, 5.2, 96, 12), hullMat);
  hull.rotation.x = Math.PI / 2; hull.position.y = 1.6; g.add(hull);
  // bow taper
  const bow = new THREE.Mesh(new THREE.SphereGeometry(6.5, 12, 8), hullMat);
  bow.scale.set(1, 0.82, 2.2); bow.position.set(0, 1.6, -52); g.add(bow);
  const stern = new THREE.Mesh(new THREE.SphereGeometry(5.6, 12, 8), hullMat);
  stern.scale.set(1, 0.9, 1.6); stern.position.set(0, 1.6, 50); g.add(stern);
  // flat flight deck (it's an aircraft carrier sub)
  const deck = new THREE.Mesh(new THREE.BoxGeometry(13, 1.2, 88), deckMat);
  deck.position.y = 7.6; g.add(deck);
  // conning tower / island
  const sail = new THREE.Mesh(new THREE.BoxGeometry(4.5, 9, 12), hullMat);
  sail.position.set(5.5, 12.5, -8); g.add(sail);
  const periscope = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 5, 6), M(0x111417));
  periscope.position.set(5.5, 19, -10); g.add(periscope);
  // deck markings
  const line = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.15, 70), M(0xd8c840));
  line.position.set(0, 8.3, 0); g.add(line);
  g.userData = { type: 'sub' };
  return g;
}

export function buildModel(type) {
  switch (type) {
    case 'f18': return buildFA18();
    case 'f16': return buildF16();
    case 'mig29': return buildMiG29();
    case 'b747': return build747();
    case 'b707': return build707();
    case 'cruise': return buildCruiseMissile();
    case 'raft': return buildRaft();
    case 'sub': return buildSub();
  }
  return buildFA18();
}

// sprite textures for FX
export function makeGlowTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,200,80,0)') {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  gr.addColorStop(0, inner); gr.addColorStop(0.35, inner.replace('1)', '0.7)')); gr.addColorStop(1, outer);
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
export function makeSmokeTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 4, 32, 32, 30);
  gr.addColorStop(0, 'rgba(200,200,200,0.85)'); gr.addColorStop(1, 'rgba(120,120,120,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
