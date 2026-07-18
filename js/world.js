// world.js — San Francisco Bay Area: terrain, ocean, sky, city, bridges, carrier, airports
import * as THREE from 'three';
import { clamp, lerp, fbm, noise2, rand } from './util.js';

// ---------- 2D rounded-box SDF ----------
function sdBox(x, z, cx, cz, hx, hz, r) {
  const dx = Math.abs(x - cx) - (hx - r), dz = Math.abs(z - cz) - (hz - r);
  const ax = Math.max(dx, 0), az = Math.max(dz, 0);
  return Math.hypot(ax, az) + Math.min(Math.max(dx, dz), 0) - r;
}
const sstep = (e0, e1, v) => { const t = clamp((v - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

// Landmasses of the Bay (x east, z south; Golden Gate at origin)
const LANDS = [
  { cx: 7000,  cz: 16500, hx: 8000,  hz: 14000, r: 2500, peak: 150, f: 0.00016, s: 11 },  // SF peninsula
  { cx: -3500, cz: -7500, hx: 6500,  hz: 6500,  r: 2200, peak: 290, f: 0.00020, s: 23 },  // Marin headlands
  { cx: 43000, cz: 8000,  hx: 19000, hz: 28000, r: 3200, peak: 390, f: 0.00014, s: 37 },  // East Bay / Oakland
  { cx: 25000, cz: 40000, hx: 38000, hz: 14000, r: 4200, peak: 210, f: 0.00018, s: 51 },  // South bay
  { cx: 32000, cz: -20000, hx: 32000, hz: 11000, r: 4200, peak: 250, f: 0.00017, s: 67 }, // North bay shore
  { cx: 10000, cz: 0,     hx: 230,   hz: 170,   r: 120,  peak: 44,  f: 0.004,   s: 5  },  // Alcatraz
  { cx: 16500, cz: -6000, hx: 1000,  hz: 750,   r: 500,  peak: 250, f: 0.0012,  s: 9  },  // Angel Island
  { cx: -46000, cz: 4200, hx: 750,   hz: 420,   r: 300,  peak: 100, f: 0.005,   s: 3  },  // Farallon Islands
];
const FLATS = [
  { x: 7000,  z: 5200,  r: 2600, y: 14 },   // downtown SF
  { x: 13000, z: 20000, r: 2400, y: 4 },    // SFO
  { x: 26500, z: 16000, r: 2200, y: 3 },    // Oakland Intl
  { x: 10000, z: 34000, r: 2000, y: 10 },   // Moffett Field
  { x: 14000, z: 23500, r: 900,  y: 8 },    // San Mateo (EA HQ)
];
const BUMPS = [
  { x: 4800, z: 9200, r: 900, h: 240 },  // Twin Peaks N
  { x: 5500, z: 9700, r: 900, h: 260 },  // Twin Peaks S
  { x: 8300, z: 4000, r: 500, h: 85 },   // Telegraph Hill (Coit Tower)
  { x: 3500, z: 6800, r: 1100, h: 130 }, // Nob/Russian hill mass
];

export function groundHeight(x, z) {
  let h = -12;
  for (let i = 0; i < LANDS.length; i++) {
    const L = LANDS[i];
    const d = sdBox(x, z, L.cx, L.cz, L.hx, L.hz, L.r);
    if (d > 1400) continue;
    const m = clamp(-d / 1300, 0, 1);
    if (m <= 0) continue;
    const shore = lerp(-12, 5, Math.min(1, m * 3.2));
    const hills = m * m * L.peak * (0.25 + 1.5 * fbm(x * L.f + L.s * 7, z * L.f + L.s * 13, 4));
    const v = shore + hills;
    if (v > h) h = v;
  }
  for (const B of BUMPS) {
    const d2 = (x - B.x) * (x - B.x) + (z - B.z) * (z - B.z);
    const r2 = B.r * B.r;
    if (d2 < r2 * 4) h += B.h * Math.exp(-d2 / r2);
  }
  for (const F of FLATS) {
    const d = Math.hypot(x - F.x, z - F.z);
    if (d < F.r) h = lerp(h, F.y, sstep(F.r, F.r * 0.45, d));
  }
  return h;
}

// ============================================================
export class World {
  constructor(scene) {
    this.scene = scene;
    this.colliders = [];
    this.time = 0;
    this.landmarks = {
      goldenGate: new THREE.Vector3(0, 67, 0),
      downtown:   new THREE.Vector3(7000, 0, 5000),
      alcatraz:   new THREE.Vector3(10000, 45, 0),
      sfo:        new THREE.Vector3(13000, 4, 20000),
      oakland:    new THREE.Vector3(26500, 3, 16000),
      moffett:    new THREE.Vector3(10000, 10, 34000),
      farallon:   new THREE.Vector3(-46000, 60, 4200),
      ea:         new THREE.Vector3(14000, 8, 23500),
    };
    this.runways = [
      { name: 'SFO INTL',     x: 13000, z: 20000, hdg: Math.PI / 2, len: 3200, wid: 60, elev: 4 },
      { name: 'OAKLAND INTL', x: 26500, z: 16000, hdg: 0,           len: 3000, wid: 55, elev: 3 },
      { name: 'MOFFETT FLD',  x: 10000, z: 34000, hdg: Math.PI / 2, len: 2800, wid: 55, elev: 10 },
    ];
    this._buildLights();
    this._buildSky();
    this._buildOcean();
    this._buildTerrain();
    this._buildClouds();
    this._buildCity();
    this._buildGoldenGate();
    this._buildBayBridge();
    this._buildAlcatraz();
    this._buildAirports();
    this._buildFarallon();
    this._buildEA();
    this.carrier = new Carrier(this, new THREE.Vector3(-30000, 0, 10000), Math.PI / 2, false);
    this.enemySub = new Carrier(this, new THREE.Vector3(-42000, 0, -14000), Math.PI / 2, true);
    this.enemySub.group.visible = false;
    this.setTimeOfDay('day');
  }

  addCollider(cx, cy, cz, hx, hy, hz) {
    this.colliders.push({ min: { x: cx - hx, y: cy - hy, z: cz - hz }, max: { x: cx + hx, y: cy + hy, z: cz + hz } });
  }

  _buildLights() {
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.position.set(50000, 80000, -30000);
    this.scene.add(this.sun);
    this.hemi = new THREE.HemisphereLight(0xbfd9ff, 0x3a4a3a, 0.85);
    this.scene.add(this.hemi);
  }
  _buildSky() {
    const geo = new THREE.SphereGeometry(280000, 24, 16);
    this.skyU = {
      top:     { value: new THREE.Color(0x2a6fd4) },
      horizon: { value: new THREE.Color(0xbfd9ef) },
      sunDir:  { value: new THREE.Vector3(0.5, 0.6, -0.3).normalize() },
      sunCol:  { value: new THREE.Color(0xfff3d0) },
      night:   { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.skyU, side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: 'varying vec3 vDir; void main(){ vDir=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `
        uniform vec3 top, horizon, sunCol; uniform vec3 sunDir; uniform float night;
        varying vec3 vDir;
        float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,45.164)))*43758.5453); }
        void main(){
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 col = mix(horizon, top, pow(h, 0.55));
          float s = max(dot(vDir, sunDir), 0.0);
          col += sunCol * (pow(s, 900.0) * 1.6 + pow(s, 18.0) * 0.22);
          if (night > 0.01 && vDir.y > 0.02) {
            vec3 g = floor(vDir * 220.0);
            float st = step(0.9975, hash(g)) * night * smoothstep(0.02, 0.25, vDir.y);
            col += vec3(st);
          }
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.skyMesh = new THREE.Mesh(geo, mat);
    this.skyMesh.frustumCulled = false;
    this.scene.add(this.skyMesh);
    this.scene.fog = new THREE.Fog(0xbfd9ef, 12000, 130000);
  }
  setTimeOfDay(mode) {
    const S = this.skyU, F = this.scene.fog;
    const cfg = {
      day:     { top: 0x2a6fd4, hor: 0xbfd9ef, sun: [0.45, 0.75, -0.35], sunC: 0xfff3d0, i: 2.2, hemi: 0.85, fog: [12000, 130000], night: 0, win: 0.25 },
      morning: { top: 0x3a6fc0, hor: 0xffd9a8, sun: [0.85, 0.22, -0.25], sunC: 0xffd9a0, i: 1.9, hemi: 0.7,  fog: [10000, 110000], night: 0, win: 0.5 },
      dusk:    { top: 0x2c2a66, hor: 0xff9a52, sun: [-0.9, 0.12, 0.2],   sunC: 0xffb070, i: 1.4, hemi: 0.5,  fog: [9000, 95000],  night: 0.15, win: 1.2 },
      night:   { top: 0x050818, hor: 0x101a30, sun: [0.3, 0.5, 0.4],     sunC: 0x9ab,    i: 0.35, hemi: 0.22, fog: [8000, 80000],  night: 1, win: 2.2 },
    }[mode] || {};
    S.top.value.set(cfg.top); S.horizon.value.set(cfg.hor);
    S.sunDir.value.set(...cfg.sun).normalize(); S.sunCol.value.set(cfg.sunC); S.night.value = cfg.night;
    this.sun.position.copy(S.sunDir.value).multiplyScalar(120000);
    this.sun.intensity = cfg.i; this.sun.color.set(cfg.sunC);
    this.hemi.intensity = cfg.hemi;
    F.color.set(cfg.hor); F.near = cfg.fog[0]; F.far = cfg.fog[1];
    if (this.waterU) { this.waterU.sunDir.value.copy(S.sunDir.value); this.waterU.sunCol.value.set(cfg.sunC);
      this.waterU.deep.value.set(mode === 'night' ? 0x06121f : 0x0a3550); this.waterU.sky.value.set(cfg.hor); }
    if (this.cityMat) this.cityMat.emissiveIntensity = cfg.win;
    if (this.cloudMat) this.cloudMat.opacity = mode === 'night' ? 0.25 : 0.7;
    this.mode = mode;
  }

  _buildOcean() {
    const u = {
      time:   { value: 0 },
      deep:   { value: new THREE.Color(0x0a3550) },
      sky:    { value: new THREE.Color(0xbfd9ef) },
      sunDir: { value: new THREE.Vector3(0.5, 0.6, -0.3).normalize() },
      sunCol: { value: new THREE.Color(0xfff3d0) },
    };
    const geo = new THREE.PlaneGeometry(560000, 560000, 96, 96);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, u]),
      fog: true,
      vertexShader: `
        #include <fog_pars_vertex>
        uniform float time; varying vec3 vW;
        void main(){
          vec4 wp = modelMatrix * vec4(position, 1.0);
          wp.y += sin(wp.x*0.004 + time*0.9) * cos(wp.z*0.0031 + time*0.7) * 1.4;
          vW = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        #include <fog_pars_fragment>
        uniform vec3 deep, sky, sunCol; uniform vec3 sunDir; uniform float time;
        varying vec3 vW;
        void main(){
          vec3 V = normalize(cameraPosition - vW);
          float n1 = sin(vW.x*0.031 + time*0.9) * sin(vW.z*0.027 - time*0.7);
          float n2 = sin(vW.x*0.013 - time*0.5 + vW.z*0.019);
          float n3 = sin((vW.x + vW.z)*0.041 + time*1.3);
          vec3 N = normalize(vec3(n1*0.055 + n3*0.03, 1.0, n2*0.05 - n1*0.035));
          float fres = pow(1.0 - max(dot(V, N), 0.0), 3.0);
          vec3 col = mix(deep, sky, fres*0.75 + 0.06);
          vec3 R = reflect(-sunDir, N);
          col += sunCol * pow(max(dot(R, V), 0.0), 240.0) * 2.2;
          col += vec3(0.02) * smoothstep(0.75, 1.0, n3);
          gl_FragColor = vec4(col, 1.0);
          #include <fog_fragment>
        }`,
    });
    this.waterU = mat.uniforms;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(5000, 0, 8000);
    this.scene.add(mesh);
  }

  _buildTerrain() {
    const W = 230000, SEG = 300, CX = 5000, CZ = 8000;
    const geo = new THREE.PlaneGeometry(W, W, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const cGrass = new THREE.Color(0x4d7c3c), cRock = new THREE.Color(0x7d7a70),
          cSand = new THREE.Color(0xc9b98a), cCity = new THREE.Color(0x8f9296),
          cDeep = new THREE.Color(0x0a3550), cShallow = new THREE.Color(0x1a5a70), tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + CX, z = pos.getZ(i) + CZ;
      const h = groundHeight(x, z);
      pos.setY(i, h);
      const dCity = Math.hypot(x - 7000, z - 5000);
      if (h < -4) tmp.copy(cDeep);
      else if (h < 1.5) tmp.copy(cSand);
      else if (h < 3) tmp.copy(cShallow).lerp(cSand, sstep(-2, 1.5, h));
      else if (dCity < 2800) tmp.copy(cCity).lerp(cGrass, sstep(1600, 2800, dCity));
      else tmp.copy(cGrass).lerp(cRock, sstep(170, 320, h));
      const v = 0.92 + 0.16 * noise2(x * 0.002, z * 0.002);
      colors[i * 3] = tmp.r * v; colors[i * 3 + 1] = tmp.g * v; colors[i * 3 + 2] = tmp.b * v;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(CX, 0, CZ);
    this.scene.add(mesh);
  }

  _cloudTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    for (let i = 0; i < 14; i++) {
      const x = 24 + rand(80), y = 44 + rand(40), r = 12 + rand(22);
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    }
    return new THREE.CanvasTexture(c);
  }
  _buildClouds() {
    const tex = this._cloudTexture();
    this.cloudMat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.7, depthWrite: false, fog: false });
    this.clouds = new THREE.Group();
    for (let i = 0; i < 46; i++) {
      const s = new THREE.Sprite(this.cloudMat);
      const sc = rand(500, 1400);
      s.scale.set(sc, sc * 0.32, 1);
      s.position.set(rand(-70000, 80000), rand(900, 2400), rand(-50000, 70000));
      this.clouds.add(s);
    }
    this.scene.add(this.clouds);
  }

  _windowTexture() {
    const c = document.createElement('canvas'); c.width = 64; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#4c5258'; g.fillRect(0, 0, 64, 128);
    for (let y = 4; y < 124; y += 7) for (let x = 4; x < 60; x += 6) {
      const lit = Math.random() < 0.55;
      g.fillStyle = lit ? (Math.random() < 0.7 ? '#ffd890' : '#bfe0ff') : '#22262c';
      g.fillRect(x, y, 4, 4);
    }
    return new THREE.CanvasTexture(c);
  }
  _buildCity() {
    const tex = this._windowTexture();
    this.cityMat = new THREE.MeshLambertMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.25 });
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const N = 130;
    this.cityMesh = new THREE.InstancedMesh(box, this.cityMat, N);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    let i = 0, guard = 0;
    while (i < N && guard++ < 2000) {
      const a = rand(Math.PI * 2), r = Math.pow(rand(), 0.6) * 1900;
      const x = 7000 + Math.cos(a) * r, z = 5000 + Math.sin(a) * r * 0.85;
      const g = groundHeight(x, z); if (g < 2) continue;
      const tall = r < 700;
      const h = tall ? rand(120, 260) : rand(18, 80);
      const w = rand(22, 55), d = rand(22, 55);
      p.set(x, g - 1, z); s.set(w, h, d); q.setFromAxisAngle(up, rand(Math.PI));
      m.compose(p, q, s);
      this.cityMesh.setMatrixAt(i, m);
      this.addCollider(x, g + h / 2, z, w / 2 + 4, h / 2 + 2, d / 2 + 4);
      i++;
    }
    this.scene.add(this.cityMesh);
    const g1 = groundHeight(7300, 4600);
    const pyr = new THREE.Mesh(new THREE.ConeGeometry(26, 260, 4), new THREE.MeshLambertMaterial({ color: 0xd8d4c8 }));
    pyr.position.set(7300, g1 + 130, 4600); pyr.rotation.y = Math.PI / 4;
    this.scene.add(pyr); this.addCollider(7300, g1 + 130, 4600, 24, 132, 24);
    const g2 = groundHeight(8300, 4000);
    const coit = new THREE.Mesh(new THREE.CylinderGeometry(5, 6, 64, 10), new THREE.MeshLambertMaterial({ color: 0xe8e0d0 }));
    coit.position.set(8300, g2 + 32, 4000); this.scene.add(coit);
    this.addCollider(8300, g2 + 32, 4000, 8, 34, 8);
    const g3 = groundHeight(5150, 9450);
    const sutro = new THREE.Group();
    const smat = new THREE.MeshLambertMaterial({ color: 0xc04030 });
    for (let k = 0; k < 3; k++) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 2, 300, 5), smat);
      const a = k * Math.PI * 2 / 3;
      leg.position.set(Math.cos(a) * 22, 150, Math.sin(a) * 22);
      leg.rotation.z = Math.cos(a) * 0.14; leg.rotation.x = -Math.sin(a) * 0.14;
      sutro.add(leg);
    }
    const cross = new THREE.Mesh(new THREE.BoxGeometry(46, 4, 4), smat);
    cross.position.y = 250; cross.rotation.y = 0.5; sutro.add(cross);
    const cross2 = cross.clone(); cross2.position.y = 180; cross2.rotation.y = -0.4; sutro.add(cross2);
    sutro.position.set(5150, g3, 9450); this.scene.add(sutro);
    this.addCollider(5150, g3 + 150, 9450, 28, 152, 28);
  }

  _buildGoldenGate() {
    const orange = new THREE.MeshLambertMaterial({ color: 0xc24a2e });
    const g = new THREE.Group();
    const DECK_Y = 67, HALF = 1750;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(30, 8, HALF * 2), orange);
    deck.position.set(0, DECK_Y, 0); g.add(deck);
    this.addCollider(0, DECK_Y, 0, 16, 6, HALF);
    for (const tz of [-640, 640]) {
      for (const tx of [-14, 14]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(8, 230, 12), orange);
        leg.position.set(tx, 115, tz); g.add(leg);
      }
      for (const sy of [70, 130, 185, 225]) {
        const strut = new THREE.Mesh(new THREE.BoxGeometry(34, 10, 10), orange);
        strut.position.set(0, sy, tz); g.add(strut);
      }
      this.addCollider(0, 115, tz, 19, 118, 9);
    }
    const pts = [];
    for (const cx of [-13, 13]) {
      let prev = null;
      for (let z = -HALF; z <= HALF; z += 50) {
        const az = Math.abs(z);
        let y;
        if (az > 640) y = lerp(228, 6, sstep(640, HALF, az));
        else y = 80 + 148 * Math.pow(az / 640, 2.2);
        if (prev !== null) pts.push(cx, prev, z - 50, cx, y, z);
        prev = y;
        if (az < 640 && y > DECK_Y + 6 && (z / 50) % 2 === 0) pts.push(cx, y, z, cx, DECK_Y + 4, z);
      }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xd86a4a })));
    this.scene.add(g);
  }

  _buildBayBridge() {
    const gray = new THREE.MeshLambertMaterial({ color: 0x9aa2a8 });
    const g = new THREE.Group();
    const a = new THREE.Vector3(15500, 56, 6600), b = new THREE.Vector3(24500, 56, 8500);
    const dir = b.clone().sub(a), len = dir.length(), ang = Math.atan2(dir.x, dir.z);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(24, 6, len), gray);
    deck.position.copy(a).add(b).multiplyScalar(0.5); deck.rotation.y = ang;
    g.add(deck);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    this.addCollider(mid.x, 56, mid.z, Math.abs(dir.x) / 2 + 12, 5, Math.abs(dir.z) / 2 + 12);
    for (const t of [0.25, 0.5, 0.75]) {
      const p = a.clone().lerp(b, t);
      const tw = new THREE.Mesh(new THREE.BoxGeometry(10, 160, 10), gray);
      tw.position.set(p.x, 80, p.z); g.add(tw);
      this.addCollider(p.x, 80, p.z, 8, 84, 8);
    }
    this.scene.add(g);
  }

  _buildAlcatraz() {
    const g = new THREE.Group();
    const base = groundHeight(10000, 0);
    const rock = new THREE.Mesh(new THREE.CylinderGeometry(180, 260, 40, 12), new THREE.MeshLambertMaterial({ color: 0x8a8578 }));
    rock.position.set(10000, base - 5, 0); g.add(rock);
    const prison = new THREE.Mesh(new THREE.BoxGeometry(150, 26, 60), new THREE.MeshLambertMaterial({ color: 0xc9c2b2 }));
    prison.position.set(10000, base + 26, 0); g.add(prison);
    const light = new THREE.Mesh(new THREE.CylinderGeometry(4, 5, 26, 8), new THREE.MeshLambertMaterial({ color: 0xe8e0d0 }));
    light.position.set(10070, base + 30, 10); g.add(light);
    this.scene.add(g);
    this.addCollider(10000, base + 26, 0, 80, 22, 34);
  }

  _buildFarallon() {
    const mat = new THREE.MeshLambertMaterial({ color: 0x6f6a5e });
    for (const [x, z, r, h] of [[-46000, 4200, 500, 90], [-45400, 3900, 260, 60], [-46600, 4600, 300, 70]]) {
      const rock = new THREE.Mesh(new THREE.ConeGeometry(r, h, 8), mat);
      rock.position.set(x, h / 2 - 6, z);
      this.scene.add(rock);
      this.addCollider(x, h / 2, z, r * 0.7, h / 2, r * 0.7);
    }
  }

  _buildEA() {
    const g = groundHeight(14000, 23500);
    const b = new THREE.Mesh(new THREE.BoxGeometry(70, 42, 70), new THREE.MeshLambertMaterial({ color: 0x3a4a5c }));
    b.position.set(14000, g + 21, 23500); this.scene.add(b);
    const c = document.createElement('canvas'); c.width = 128; c.height = 64;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#0a1220'; ctx.fillRect(0, 0, 128, 64);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 40px monospace'; ctx.textAlign = 'center'; ctx.fillText('EA', 64, 46);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(40, 20), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c) }));
    sign.position.set(14000, g + 34, 23500 - 36); sign.rotation.y = Math.PI; this.scene.add(sign);
    this.addCollider(14000, g + 21, 23500, 36, 23, 36);
  }

  _buildAirports() {
    const mkStrip = (rw) => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 512;
      const g2 = c.getContext('2d');
      g2.fillStyle = '#33373c'; g2.fillRect(0, 0, 64, 512);
      g2.fillStyle = '#e8e8e8';
      for (let y = 30; y < 500; y += 42) g2.fillRect(30, y, 4, 22);
      g2.fillRect(4, 6, 56, 8); g2.fillRect(4, 498, 56, 8);
      const t = new THREE.CanvasTexture(c);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(rw.wid, rw.len), new THREE.MeshLambertMaterial({ map: t }));
      m.rotation.x = -Math.PI / 2; m.rotation.z = -rw.hdg;
      m.position.set(rw.x, rw.elev + 0.3, rw.z);
      this.scene.add(m);
      const tw = new THREE.Mesh(new THREE.CylinderGeometry(4, 6, 40, 8), new THREE.MeshLambertMaterial({ color: 0xb8c0c8 }));
      tw.position.set(rw.x + 300, rw.elev + 20, rw.z + 300); this.scene.add(tw);
      const cab = new THREE.Mesh(new THREE.CylinderGeometry(8, 6, 10, 8), new THREE.MeshLambertMaterial({ color: 0x30414f }));
      cab.position.set(rw.x + 300, rw.elev + 44, rw.z + 300); this.scene.add(cab);
      this.addCollider(rw.x + 300, rw.elev + 24, rw.z + 300, 9, 26, 9);
    };
    for (const rw of this.runways) mkStrip(rw);
  }

  update(dt, camPos) {
    this.time += dt;
    if (this.waterU) this.waterU.time.value = this.time;
    if (this.skyMesh) this.skyMesh.position.copy(camPos);
    this.carrier.update(dt);
    this.enemySub.update(dt);
  }
}

// ============================================================
// Aircraft carrier (USS Enterprise) + enemy submersible carrier
// ============================================================
export class Carrier {
  constructor(world, pos, heading, isSub) {
    this.world = world; this.isSub = isSub;
    this.group = new THREE.Group();
    this.speed = isSub ? 0 : 7.7;
    this.baseSpeed = this.speed;
    this.heading = heading;
    this.turning = 0;
    this.deckY = 19.4; this.deckHalfLen = 166; this.deckHalfWid = 38;
    this.submerged = false; this.submergeT = 0;
    this._build(isSub);
    this.group.position.copy(pos);
    this.group.rotation.y = Math.PI - heading;
    world.scene.add(this.group);
  }
  _deckTexture() {
    const c = document.createElement('canvas'); c.width = 256; c.height = 1024;
    const g = c.getContext('2d');
    g.fillStyle = '#3d4248'; g.fillRect(0, 0, 256, 1024);
    g.strokeStyle = '#e8e8e8'; g.lineWidth = 3;
    g.setLineDash([30, 24]);
    g.beginPath(); g.moveTo(128, 40); g.lineTo(128, 984); g.stroke();
    g.setLineDash([]);
    g.strokeStyle = '#d8b040'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(20, 60); g.lineTo(20, 964); g.stroke();
    g.beginPath(); g.moveTo(236, 60); g.lineTo(236, 964); g.stroke();
    g.strokeStyle = '#e8e8e8'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(30, 700); g.lineTo(200, 240); g.stroke();
    g.beginPath(); g.moveTo(50, 720); g.lineTo(220, 260); g.stroke();
    g.strokeStyle = '#ddd'; g.lineWidth = 2;
    for (const y of [420, 460, 500, 540]) { g.beginPath(); g.moveTo(60, y); g.lineTo(210, y - 60); g.stroke(); }
    if (!this.isSub) {
      g.fillStyle = '#e8e8e8'; g.font = 'bold 60px monospace';
      g.save(); g.translate(190, 950); g.rotate(Math.PI); g.fillText('65', 0, 0); g.restore();
    }
    return new THREE.CanvasTexture(c);
  }
  _build(isSub) {
    const hullC = isSub ? 0x1c2126 : 0x5a626a;
    const hull = new THREE.Mesh(new THREE.BoxGeometry(70, 18, 320), new THREE.MeshLambertMaterial({ color: isSub ? hullC : 0x7d868f }));
    hull.position.y = 2; this.group.add(hull);
    const bow = new THREE.Mesh(new THREE.CylinderGeometry(35, 12, 18, 4, 1), new THREE.MeshLambertMaterial({ color: hullC }));
    bow.rotation.y = Math.PI / 4; bow.scale.set(1, 1, 1.6); bow.position.set(0, 2, 178); this.group.add(bow);
    const deckMat = new THREE.MeshLambertMaterial({ map: this._deckTexture() });
    const deck = new THREE.Mesh(new THREE.BoxGeometry(76, 3, 336), deckMat);
    deck.position.y = this.deckY - 1.5; this.group.add(deck);
    if (!isSub) {
      const island = new THREE.Mesh(new THREE.BoxGeometry(14, 26, 30), new THREE.MeshLambertMaterial({ color: 0x9aa4ae }));
      island.position.set(-30, this.deckY + 13, 30); this.group.add(island);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 2.5, 26, 6), new THREE.MeshLambertMaterial({ color: 0x7a848e }));
      mast.position.set(-30, this.deckY + 38, 24); this.group.add(mast);
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      const cx = c.getContext('2d'); cx.fillStyle = '#444c54'; cx.fillRect(0, 0, 64, 64);
      cx.fillStyle = '#fff'; cx.font = 'bold 40px monospace'; cx.textAlign = 'center'; cx.fillText('65', 32, 46);
      const num = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c) }));
      num.position.set(-22.8, this.deckY + 20, 30); num.rotation.y = Math.PI / 2; this.group.add(num);
      this.islandOffset = { x: -30, z: 30 };
    } else {
      const sail = new THREE.Mesh(new THREE.BoxGeometry(10, 14, 22), new THREE.MeshLambertMaterial({ color: 0x23292e }));
      sail.position.set(0, this.deckY + 7, 60); this.group.add(sail);
    }
    const wakeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false });
    const wake = new THREE.Mesh(new THREE.PlaneGeometry(60, 700), wakeMat);
    wake.rotation.x = -Math.PI / 2; wake.position.set(0, 0.6, -480);
    this.group.add(wake); this.wake = wake;
  }
  get pos() { return this.group.position; }
  toLocal(v, out = new THREE.Vector3()) {
    const dx = v.x - this.group.position.x, dz = v.z - this.group.position.z;
    const ch = Math.cos(this.heading), sh = Math.sin(this.heading);
    out.set(-ch * dx - sh * dz, v.y - this.group.position.y - this.deckY, sh * dx - ch * dz);
    return out;
  }
  deckVelWorld(out = new THREE.Vector3()) {
    out.set(Math.sin(this.heading) * this.speed, 0, -Math.cos(this.heading) * this.speed);
    return out;
  }
  update(dt) {
    if (this.submerged) {
      this.submergeT += dt;
      this.group.position.y = -this.submergeT * 3.5;
      if (this.group.position.y < -80) this.group.visible = false;
      return;
    }
    if (this.isSub) { this.group.rotation.y = Math.PI - this.heading; return; }
    const p = this.group.position;
    if (this.turning === 0 && Math.abs(Math.sin(this.heading)) > 0.5 && (p.x > 6000 || p.x < -56000)) this.turning = Math.PI;
    if (this.turning > 0) { const tr = 0.06 * dt; this.heading += tr; this.turning -= tr; if (this.turning <= 0) this.turning = 0; }
    p.x += Math.sin(this.heading) * this.speed * dt;
    p.z += -Math.cos(this.heading) * this.speed * dt;
    this.group.rotation.y = Math.PI - this.heading;
  }
  submerge() { this.submerged = true; }
}
