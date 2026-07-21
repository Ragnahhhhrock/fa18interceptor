// world.js — San Francisco Bay Area: terrain, ocean, sky, city, bridges, carrier, airports
import * as THREE from 'three';
import { clamp, lerp, fbm, noise2, rand } from './util.js';

// ---------- polygon coastline ----------
// Traced against the original game's satellite map: the Pacific on the west,
// the Golden Gate strait at the origin, the SF peninsula wrapping under the
// bay's south tip, Marin headlands to the north, the San Pablo / Suisun lobe
// reaching northeast and the East Bay shore behind Oakland. x east, z south,
// listed in kilometers and scaled to meters below.
const sstep = (e0, e1, v) => { const t = clamp((v - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const _UP = new THREE.Vector3(0, 1, 0);
const _tm = new THREE.Matrix4(), _tq = new THREE.Quaternion(), _tv = new THREE.Vector3(), _ts = new THREE.Vector3(), _e = new THREE.Euler();

const PENINSULA = [ // SF peninsula + the land south of the bay (San Jose side)
  [-2, 1.8], [7, 2.8], [9, 5.5], [10.5, 9], [12, 12.5], [13.8, 16], [15.5, 20],
  [16.5, 24], [17, 27], [16.8, 31], [17, 35], [19, 37.5], [22, 38.5], [25.5, 37.8],
  [28, 39.5], [33, 41], [40, 42.5], [55, 44], [75, 46], [100, 47], [125, 48],
  [125, 130], [6, 130], [3, 90], [1, 76], [-0.5, 66], [-1.8, 57], [-3, 50],
  [-4, 43], [-4.8, 36], [-5.4, 30], [-5.6, 24], [-5.2, 18], [-4.5, 13],
  [-3.5, 8], [-2.5, 4],
];
const MARIN_EASTBAY = [ // Marin + north shore + East Bay; the bay itself is a "bite"
  [-2, -1.8], [-3.5, -5], [-5.5, -10], [-6.5, -16], [-7, -22], [-6, -28],
  [-4.5, -34], [-3, -40], [-1, -46], [1, -54], [3, -64], [5, -76], [6.5, -92], [7.5, -115],
  // inland boundary runs a few km SOUTH of the peninsula polygon's, so the
  // two landmasses overlap — no water seam east of the bay's south tip
  [130, -115], [130, 52], [100, 51], [75, 50], [55, 48], [40, 46.5], [33, 45], [28, 43.5],
  [25.5, 37.8], [28, 35], [29.5, 31], [30, 26], [24.5, 21], [24, 16], [24, 13],
  [24.5, 8], [29, 2], [30, -4], [32, -10], [36, -12], [40, -14], [46, -16],
  [52, -17], [60, -18], [70, -20],
  [74, -23], [72, -27], [64, -29], [54, -30.5], [48, -32], [40, -33], [32, -32], [26, -30], [22, -27],
  [19, -22], [17.5, -17], [15.5, -12], [14, -9], [9, -4], [2, -2],
];
const ALAMEDA = [ // Alameda island: a low, flat fill island in the bay, west
  // tip toward SF, estuary channel separating it from the East Bay shore
  [19.2, 12.5], [19.6, 11.8], [21.5, 11.68], [22.9, 12.0], [23.0, 12.6],
  [22.6, 13.15], [20.8, 13.35], [19.4, 13.1],
];
const LAND_POLYS = [PENINSULA, MARIN_EASTBAY, ALAMEDA].map(p => p.map(([x, z]) => [x * 1000, z * 1000]));
const POLY_PEAK = [150, 330, 6];
const POLY_BBOX = LAND_POLYS.map(p => {
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const [x, z] of p) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  return { x0, x1, z0, z1 };
});
const ISLANDS = [
  { x: 10000,  z: 0,     r: 230,  peak: 44,  f: 0.004,  s: 5 },  // Alcatraz
  { x: 16500,  z: -6000, r: 1000, peak: 250, f: 0.0012, s: 9 },  // Angel Island
  { x: -46000, z: 4200,  r: 420,  peak: 100, f: 0.005,  s: 3 },  // Farallon
];
function _inPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function _distToPoly(x, z, poly) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const x1 = poly[j][0], z1 = poly[j][1], dx = poly[i][0] - x1, dz = poly[i][1] - z1;
    const t = clamp(((x - x1) * dx + (z - z1) * dz) / (dx * dx + dz * dz), 0, 1);
    const ex = x - (x1 + dx * t), ez = z - (z1 + dz * t);
    const dd = ex * ex + ez * ez;
    if (dd < best) best = dd;
  }
  return Math.sqrt(best);
}
const FLATS = [
  { x: 7000,  z: 5200,  r: 2600, y: 14 },   // downtown SF
  { x: 13000, z: 20000, r: 2400, y: 4 },    // SFO
  { x: 26500, z: 16000, r: 2600, y: 3 },    // Oakland Intl (south + north fields)
  { x: 10000, z: 34000, r: 2000, y: 10 },   // Moffett Field
  { x: 14000, z: 23500, r: 900,  y: 8 },    // San Mateo (EA HQ)
  { x: 21000, z: 12500, r: 1600, y: 4 },    // NAS Alameda
];
const BUMPS = [
  { x: 4800, z: 9200, r: 900, h: 240 },  // Twin Peaks N
  { x: 5500, z: 9700, r: 900, h: 260 },  // Twin Peaks S
  { x: 8300, z: 4000, r: 500, h: 85 },   // Telegraph Hill (Coit Tower)
  { x: 3500, z: 6800, r: 1100, h: 130 }, // Nob/Russian hill mass
];

export function groundHeight(x, z) {
  let h = -12;
  for (let p = 0; p < LAND_POLYS.length; p++) {
    const B = POLY_BBOX[p];
    if (x < B.x0 || x > B.x1 || z < B.z0 || z > B.z1) continue;
    const poly = LAND_POLYS[p];
    if (!_inPoly(x, z, poly)) continue;
    const d = _distToPoly(x, z, poly);            // distance inland from the shore
    const m = clamp(d / 1300, 0, 1);
    const shore = lerp(-12, 5, Math.min(1, m * 3.2));
    // fbm dips negative — clamp the noise term so valleys flatten into
    // lowland instead of carving below sea level (solid green, like the original)
    const hills = m * m * POLY_PEAK[p] * Math.max(0, 0.25 + 1.5 * fbm(x * 0.00016 + p * 31.7, z * 0.00016 + p * 17.3, 4));
    const v = shore + hills;
    if (v > h) h = v;
  }
  for (const I of ISLANDS) {
    const d = Math.hypot(x - I.x, z - I.z);
    if (d > I.r + 900) continue;
    const m = clamp(1 - d / (I.r + 900), 0, 1);
    const v = lerp(-12, 5, Math.min(1, m * 3.2)) + m * m * I.peak * Math.max(0, 0.4 + fbm(x * I.f + I.s, z * I.f + I.s * 2, 3));
    if (v > h) h = v;
  }
  for (const B of BUMPS) {
    const d2 = (x - B.x) * (x - B.x) + (z - B.z) * (z - B.z);
    const r2 = B.r * B.r;
    if (d2 < r2 * 4) h += B.h * Math.exp(-d2 / r2);
  }
  for (const F of FLATS) {
    const d = Math.hypot(x - F.x, z - F.z);
    // flat out to 1.05r so the whole runway rectangle (len/2 ~ 0.7r) plus
    // margin sits exactly at field elevation, then a wide, gentle apron out
    // to 2.6x the pad radius: a short ramp cuts 300 m cliff walls into the
    // mesh around each airfield, and those giant vertical triangles straddle
    // ground-level cameras and wreck weak rasterizers (smears in the sky,
    // holes beside the runway)
    if (d < F.r * 2.6) h = lerp(h, F.y, sstep(F.r * 2.6, F.r * 1.05, d));
  }
  return h;
}

// ---- major Bay Area roads (topology per the AAA bay-area road map) ----
// pts: [x, z] drapes over the terrain; [x, z, y] is fixed height (bridge
// decks sit on the bridge structures: GG deck top 71, Bay Bridge 59,
// San Mateo 51, Dumbarton 45). The original 1988 game drew the major roads.
export const ROADS = [
  { n: 'US-101', pts: [[11000,-30000],[12000,-21000],[10000,-15000],[6000,-8000],[1000,-2500],[0,-1750,71.5],[0,1750,71.5],[1500,2900],[5000,3800],[8600,7000],[9500,9000],[10200,11500],[10800,14000],[10700,17500],[10800,20000],[11000,22000],[12500,24500],[14000,26500],[13000,29000],[11500,31000],[10200,32000],[8600,32300],[8300,33800],[8600,35500],[10000,38500],[12000,41000],[15000,43000],[19000,44500]] },
  { n: 'I-280',  pts: [[8600,7000],[6000,9000],[4800,14000],[4500,19000],[5000,24000],[5800,29000],[6800,34000],[8000,39000],[11000,42000],[15000,43000]] },
  { n: 'I-80',   pts: [[32000,-8000],[30500,-3000],[29500,1500],[28500,5000],[28000,8500],[28000,8800,59.5],[9800,6000,59.5],[9000,6400],[8600,7000]] },
  { n: 'I-880',  pts: [[28000,9500],[27200,12000],[26600,13500],[25800,15000],[24000,15500],[23600,17000],[28000,19000],[28500,22000],[30000,23500],[30500,26000],[30500,29000],[30000,32000],[29500,36000],[28500,39500],[26500,42000],[24000,43500],[20000,44500]] },
  { n: 'I-580',  pts: [[28000,10000],[30000,12500],[32000,16000],[34000,20000],[35500,24000],[37000,28000]] },
  { n: 'HWY-24', pts: [[28100,8000],[31000,8500],[34000,9000],[37000,9800]], w: 24 },
  { n: 'HWY-92', pts: [[13400,25700],[15000,24300],[16800,24000,51.5],[29600,24200,51.5],[29300,24300]] },
  { n: 'HWY-84', pts: [[13000,29000],[14800,29800],[16800,30500,45.5],[29500,30600,45.5],[30000,32000]] },
  { n: 'HWY-237',pts: [[8600,32300],[10000,32400],[13000,32600],[16500,32700]], w: 24 },
  { n: 'HWY-85', pts: [[9800,38300],[10000,43000],[14000,45000],[17500,44000]] },
  { n: 'HWY-17', pts: [[15000,43000],[13000,47000],[10000,52000],[8000,58000]], w: 24 },
  { n: 'HWY-1',  pts: [[-2500,-16000],[-2000,-10000],[-1500,-5000],[-800,-2500],[0,-1750,71.5],[0,1750,71.5],[-800,2800],[-1500,6000],[-2200,12000],[-2800,18000],[-3200,24000],[-3000,30000],[-2200,36000],[-800,42000]], w: 24 },
  { n: 'I-680',  pts: [[35500,24000],[35000,30000],[34000,36000],[32000,43000],[30000,45000]] },
];
// --- the surface the camera actually shows: barycentric interpolation of
// the coarse mesh grid and the airfield pads. Road ribbons drape over THIS
// (not the raw ground function), so they can never sink into a hill whose
// coarse triangles deviate from the true height — they follow the rendered
// terrain exactly, 35 cm up, on any rasterizer.
const COARSE_W = 230000, COARSE_SEG = 480, COARSE_CX = 5000, COARSE_CZ = 8000;
const _cgCache = new Map();
function _coarseVertexY(ix, iz) {   // value assigned to coarse vertex (ix,iz)
  const key = ix * 1000 + iz;
  let y = _cgCache.get(key);
  if (y === undefined) {
    const x = -COARSE_W / 2 + ix * (COARSE_W / COARSE_SEG) + COARSE_CX;
    const z = -COARSE_W / 2 + iz * (COARSE_W / COARSE_SEG) + COARSE_CZ;
    y = groundHeight(x, z);
    y = y < 0 ? y - 25 : y;
    for (const F of FLATS) {
      const d = Math.hypot(x - F.x, z - F.z);
      if (d < F.r * 2.8) y -= 5 * sstep(F.r * 2.8, F.r * 0.5, d);
    }
    _cgCache.set(key, y);
  }
  return y;
}
export function surfaceHeight(x, z) {
  const cell = COARSE_W / COARSE_SEG;
  const gx = (x - COARSE_CX + COARSE_W / 2) / cell, gz = (z - COARSE_CZ + COARSE_W / 2) / cell;
  const ix = Math.floor(gx), iz = Math.floor(gz);
  let h = null;
  if (ix >= 0 && iz >= 0 && ix < COARSE_SEG && iz < COARSE_SEG) {
    const fx = gx - ix, fz = gz - iz;
    const ya = _coarseVertexY(ix, iz), yb = _coarseVertexY(ix + 1, iz);
    const yc = _coarseVertexY(ix + 1, iz + 1), yd = _coarseVertexY(ix, iz + 1);
    h = (fx + fz <= 1) ? ya + (yb - ya) * fx + (yd - ya) * fz
                       : yc + (yd - yc) * (1 - fx) + (yb - yc) * (1 - fz);
  }
  for (const F of FLATS) {   // airfield pads (84 x 84 grid, exact true surface)
    const S = (F.r + 400) * 2, segs = 84, c = S / segs;
    const px = (x - F.x + S / 2) / c, pz = (z - F.z + S / 2) / c;
    const pi = Math.floor(px), pj = Math.floor(pz);
    if (pi < 0 || pj < 0 || pi >= segs || pj >= segs) continue;
    const fx = px - pi, fz = pz - pj;
    const y = (i, k) => { const g = groundHeight(F.x - S / 2 + i * c, F.z - S / 2 + k * c); return g < 0 ? g - 25 : g; };
    const ya = y(pi, pj), yb = y(pi + 1, pj), yc = y(pi + 1, pj + 1), yd = y(pi, pj + 1);
    const ph = (fx + fz <= 1) ? ya + (yb - ya) * fx + (yd - ya) * fz
                              : yc + (yd - yc) * (1 - fx) + (yb - yc) * (1 - fz);
    if (h === null || ph > h) h = ph;
  }
  return h;   // null outside the world grid
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
      alameda:    new THREE.Vector3(21000, 4, 12500),
      farallon:   new THREE.Vector3(-46000, 60, 4200),
      ea:         new THREE.Vector3(14000, 8, 23500),
    };
    // Real airfield layouts (headings = runway designators, lengths ~real):
    // SFO: two crossing pairs — 01L/R (010°) x 10L/R (103°); OAK: big 12/30
    // south field + north-field 10/28 pair and short 15/33; Moffett: 14/32
    // pair; NAS Alameda: crossing 07/25 and 13/31.
    const D = Math.PI / 180;
    this.runways = [
      { id: 'sfo',      name: 'SFO INTL 01L', x: 12887, z: 19980, hdg: 10 * D,  len: 3400, wid: 61, elev: 4 },
      {                   name: 'SFO INTL 01R', x: 13113, z: 20020, hdg: 10 * D,  len: 3300, wid: 61, elev: 4 },
      {                   name: 'SFO INTL 10L', x: 13026, z: 19888, hdg: 103 * D, len: 2900, wid: 61, elev: 4 },
      {                   name: 'SFO INTL 10R', x: 12974, z: 20112, hdg: 103 * D, len: 2300, wid: 61, elev: 4 },
      { id: 'oakland',  name: 'OAKLAND 12',   x: 25900, z: 16600, hdg: 120 * D, len: 3200, wid: 46, elev: 3 },
      {                   name: 'OAKLAND 10L',  x: 27013, z: 15227, hdg: 100 * D, len: 1700, wid: 46, elev: 3 },
      {                   name: 'OAKLAND 10R',  x: 26987, z: 15374, hdg: 100 * D, len: 1700, wid: 46, elev: 3 },
      {                   name: 'OAKLAND 15',   x: 26600, z: 15600, hdg: 150 * D, len: 1030, wid: 30, elev: 3 },
      { id: 'moffett',  name: 'MOFFETT 14L',  x: 10081, z: 33932, hdg: 140 * D, len: 2800, wid: 61, elev: 10 },
      {                   name: 'MOFFETT 14R',  x: 9919,  z: 34068, hdg: 140 * D, len: 2450, wid: 61, elev: 10 },
      { id: 'alameda',  name: 'ALAMEDA 07',   x: 21000, z: 12500, hdg: 70 * D,  len: 2400, wid: 55, elev: 4 },
      {                   name: 'ALAMEDA 13',   x: 21000, z: 12500, hdg: 130 * D, len: 2150, wid: 55, elev: 4 },
    ];
    this.runwayById = (id) => this.runways.find(r => r.id === id);
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
    this._buildRoads();
    // night systems + road traffic
    this.nightGroup = new THREE.Group();
    this.nightGroup.visible = false;
    this.scene.add(this.nightGroup);
    this._buildCityLights();
    this._buildRunwayLights();
    this._buildTraffic();
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
      sunCol:  { value: new THREE.Color() },
      night:   { value: 0 },
    };
    this.skyU.sunCol.value.setRGB(1.0, 0.95, 0.82);   // raw display values, like top/horizon
    const mat = new THREE.ShaderMaterial({
      uniforms: this.skyU, side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: 'varying vec3 vDir; void main(){ vDir=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `
        uniform vec3 top, horizon, sunCol; uniform vec3 sunDir; uniform float night;
        varying vec3 vDir;
        float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,45.164)))*43758.5453); }
        void main(){
          float h = clamp(vDir.y, 0.0, 1.0);
          // Amiga-flat sky: thin horizon band, then solid color
          vec3 col = mix(horizon, top, smoothstep(0.0, 0.12, h));
          // the original's sun: a bright disc riding sunDir (a pale moon at night)
          float s = dot(normalize(vDir), sunDir);
          vec3 scol = mix(sunCol, vec3(0.72, 0.78, 0.9), night);
          col += scol * smoothstep(0.99955, 0.99975, s) * (1.0 - night * 0.55);
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
    // true Amiga palette, sampled from the original running under emulation:
    // day sky 0x444477, sea 0x003366 — muted, not the bright web-shot lavender
    const cfg = {
      day:     { top: 0x444477, hor: 0x444477, water: 0x003366, sun: [0.3, 0.88, -0.22], i: 1.1,  hemi: 1.0,  fog: [45000, 220000], night: 0 },
      morning: { top: 0x3c3c6e, hor: 0x6a5f7e, water: 0x0a2c55, sun: [0.85, 0.25, -0.25], i: 1.0,  hemi: 0.85, fog: [45000, 220000], night: 0 },
      dusk:    { top: 0x2e2842, hor: 0x4a3a4a, water: 0x081226, sun: [-0.9, 0.15, 0.2],   i: 0.9,  hemi: 0.75, fog: [40000, 200000], night: 0.12 },
      night:   { top: 0x0a0a24, hor: 0x181830, water: 0x060a1c, sun: [0.3, 0.5, 0.4],     i: 0.3,  hemi: 0.25, fog: [35000, 160000], night: 1 },
    }[mode] || {};
    // setRGB bypasses sRGB->linear conversion: the custom sky shader outputs
    // raw color, so feed it the exact display values (the Amiga palette)
    const raw = (hex, col) => col.setRGB(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
    raw(cfg.top, S.top.value); raw(cfg.hor, S.horizon.value);
    S.sunDir.value.set(...cfg.sun).normalize(); S.night.value = cfg.night;
    this.sun.position.copy(S.sunDir.value).multiplyScalar(120000);
    this.sun.intensity = cfg.i; this.sun.color.set(0xffffff);
    this.hemi.intensity = cfg.hemi;
    F.color.set(cfg.hor); F.near = cfg.fog[0]; F.far = cfg.fog[1];
    if (this.waterMat) this.waterMat.color.set(cfg.water);
    if (this.clouds) this.clouds.visible = false;   // the original's sky is cloudless
    this.mode = mode;
    // night systems: city/runway/carrier lights and traffic headlights
    this.night01 = cfg.night;
    const isNight = cfg.night > 0.5;
    if (this.nightGroup) this.nightGroup.visible = isNight;
    if (this.traffic) this.traffic.lights.visible = isNight;
    for (const sh of [this.carrier, this.enemySub]) if (sh && sh.nightGroup) sh.nightGroup.visible = isNight;
    // the unlit road ribbons would glow after dark — dim them with the sun
    const dim = 1 - cfg.night * 0.62;
    if (this._roadMat) this._roadMat.color.setScalar(dim);
    if (this._roadLineMat) this._roadLineMat.color.setHex(0xd8b830).multiplyScalar(dim);
  }

  _buildOcean() {
    // The sea is one solid sheet of blue, built as a polar fan centred on the
    // camera: tiny cells near the eye (no extreme slivers for the near-plane
    // clip to mangle on weak rasterizers), growing geometrically to the
    // horizon. It follows the camera in World.update; being flat and
    // untextured, the motion is invisible.
    const RINGS = 72, SEGS = 128, R0 = 60, R1 = 260000;
    const q = Math.pow(R1 / R0, 1 / (RINGS - 1));
    const verts = [0, 0, 0];
    for (let i = 0; i < RINGS; i++) {
      const r = R0 * Math.pow(q, i);
      for (let j = 0; j < SEGS; j++) {
        const a = (j / SEGS) * Math.PI * 2;
        verts.push(Math.cos(a) * r, 0, Math.sin(a) * r);
      }
    }
    const idx = [];
    for (let j = 0; j < SEGS; j++) idx.push(0, 1 + ((j + 1) % SEGS), 1 + j);
    for (let i = 0; i < RINGS - 1; i++) {
      for (let j = 0; j < SEGS; j++) {
        const a = 1 + i * SEGS + j, b = 1 + i * SEGS + ((j + 1) % SEGS),
              c = 1 + (i + 1) * SEGS + j, d = 1 + (i + 1) * SEGS + ((j + 1) % SEGS);
        idx.push(a, b, d, a, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    geo.setIndex(idx);
    this.waterMat = new THREE.MeshBasicMaterial({ color: 0x003366, fog: true });
    const mesh = new THREE.Mesh(geo, this.waterMat);
    mesh.position.set(5000, -2.5, 8000);   // a touch below the beaches, less grazing z-fight
    mesh.frustumCulled = false;            // it follows the camera — always visible
    this.oceanMesh = mesh;
    this.scene.add(mesh);
    // camera-following specks: whitecaps on the sea + low-altitude land flecks
    this._buildSpecks();
  }

  // Wrapped point grids that stay centred on the camera, straight from the
  // original: white wave-cap dots over the sea everywhere, and black flecks
  // over land that fade in below ~2500 ft for low-level speed sensation.
  _buildSpecks() {
    const mk = (K, S, color, size, opacity, atten) => {
      const n = K * K;
      const arr = new Float32Array(n * 3);
      const jit = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) { jit[i * 2] = Math.random(); jit[i * 2 + 1] = Math.random(); arr[i * 3 + 1] = -500; }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const mat = new THREE.PointsMaterial({ color, size, sizeAttenuation: atten, transparent: true, opacity, fog: true });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      this.scene.add(pts);
      return { K, S, geo, mat, pts, jit, lcx: 1e9, lcz: 1e9 };
    };
    this.caps = mk(52, 190, 0xffffff, 5, 0.62, true);    // ~10 km span of wave caps
    // fixed 2.5px flecks like the original's screen-space ground specks
    this.flecks = mk(30, 150, 0x101010, 2.5, 0, false);
  }

  _reflowSpecks(cam, playerY = cam.y) {
    // wave caps — always on, but only over water
    const g = this.caps;
    const cellX = Math.floor(cam.x / g.S), cellZ = Math.floor(cam.z / g.S);
    if (cellX !== g.lcx || cellZ !== g.lcz) {
      g.lcx = cellX; g.lcz = cellZ;
      const a = g.geo.attributes.position.array, j = g.jit;
      let n = 0;
      for (let ix = 0; ix < g.K; ix++) for (let iz = 0; iz < g.K; iz++, n++) {
        const x = (cellX - g.K / 2 + ix + j[n * 2]) * g.S;
        const z = (cellZ - g.K / 2 + iz + j[n * 2 + 1]) * g.S;
        a[n * 3] = x; a[n * 3 + 2] = z;
        a[n * 3 + 1] = groundHeight(x, z) < -1 ? 0.6 : -500;
      }
      g.geo.attributes.position.needsUpdate = true;
    }
    // land flecks — fade in below 2500 ft; skipped entirely when high
    const f = this.flecks;
    const op = clamp((2500 - playerY * 3.28084) / 400, 0, 1) * 0.85;
    f.mat.opacity = op;
    const on = op > 0.02;
    f.pts.visible = on;
    if (!on) { f.lcx = 1e9; return; }   // force a reflow on the next low pass
    const fcx = Math.floor(cam.x / f.S), fcz = Math.floor(cam.z / f.S);
    if (fcx === f.lcx && fcz === f.lcz) return;
    f.lcx = fcx; f.lcz = fcz;
    const a = f.geo.attributes.position.array, j = f.jit;
    let n = 0;
    for (let ix = 0; ix < f.K; ix++) for (let iz = 0; iz < f.K; iz++, n++) {
      const x = (fcx - f.K / 2 + ix + j[n * 2]) * f.S;
      const z = (fcz - f.K / 2 + iz + j[n * 2 + 1]) * f.S;
      a[n * 3] = x; a[n * 3 + 2] = z;
      let y = -500;
      const h = surfaceHeight(x, z);
      if (h > 0.3) {
        // keep the airfields clean — no flecks on the pads
        let onPad = false;
        for (const F of FLATS) {
          const dx = x - F.x, dz = z - F.z;
          if (dx * dx + dz * dz < F.r * F.r * 1.21) { onPad = true; break; }
        }
        if (!onPad) y = h + 0.4;
      }
      a[n * 3 + 1] = y;
    }
    f.geo.attributes.position.needsUpdate = true;
  }

  _buildTerrain() {
    const W = 230000, SEG = 480, CX = 5000, CZ = 8000;
    const geo = new THREE.PlaneGeometry(W, W, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    // flat Amiga land colors, sampled from the original: green 0x115511, grey city
    const cGrass = new THREE.Color(0x115511), cRock = new THREE.Color(0x0e4a0e),
          cSand = new THREE.Color(0x777755), cCity = new THREE.Color(0x555555),
          cDeep = new THREE.Color(0x003366), cShallow = new THREE.Color(0x003366), tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + CX, z = pos.getZ(i) + CZ;
      const h = groundHeight(x, z);
      // sink submerged verts well below the water plane so distant depth
      // buffer imprecision never lets the seafloor z-fight through the sea
      let y = h < 0 ? h - 25 : h;
      // keep the coarse sheet well under the fine airfield pads: its 479 m
      // cells mis-interpolate the flattening ramps by up to ~2.3 m, which
      // buried the runway strips. Smooth 5 m depression, no cliffs.
      for (const F of FLATS) {
        const dF = Math.hypot(x - F.x, z - F.z);
        if (dF < F.r * 2.8) y -= 5 * sstep(F.r * 2.8, F.r * 0.5, dF);
      }
      pos.setY(i, y);
      const dCity = Math.hypot(x - 7000, z - 5000);
      if (h < -4) tmp.copy(cDeep);
      else if (h < 1.5) tmp.copy(cSand);
      else if (h < 3) tmp.copy(cShallow).lerp(cSand, sstep(-2, 1.5, h));
      else if (dCity < 2800) tmp.copy(cCity).lerp(cGrass, sstep(1600, 2800, dCity));
      else tmp.copy(cGrass).lerp(cRock, sstep(170, 320, h));
      colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    // unlit: the original's terrain is flat-filled polygons with no shading.
    // (depth separation from the ocean is handled by the renderer's
    // logarithmic depth buffer — polygonOffset can't span 1.5m..320km)
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(CX, 0, CZ);
    this.scene.add(mesh);

    // Fine pads under each airfield: a 62 m local copy of the true surface
    // (interpolation error is sub-centimetre on the gentle ramps). The coarse
    // sheet is depressed 5 m below these discs, so the pad is the visible
    // ground around every airfield and the runway strips rest 20 cm above it.
    for (const F of FLATS) {
      const pg = new THREE.PlaneGeometry((F.r + 400) * 2, (F.r + 400) * 2, 84, 84);
      pg.rotateX(-Math.PI / 2);
      const pp = pg.attributes.position;
      const pcol = new Float32Array(pp.count * 3);
      for (let i = 0; i < pp.count; i++) {
        const x = pp.getX(i) + F.x, z = pp.getZ(i) + F.z;
        const h = groundHeight(x, z);
        pp.setY(i, h < 0 ? h - 25 : h);
        const dCity = Math.hypot(x - 7000, z - 5000);
        if (h < -4) tmp.copy(cDeep);
        else if (h < 1.5) tmp.copy(cSand);
        else if (h < 3) tmp.copy(cShallow).lerp(cSand, sstep(-2, 1.5, h));
        else if (dCity < 2800) tmp.copy(cCity).lerp(cGrass, sstep(1600, 2800, dCity));
        else tmp.copy(cGrass).lerp(cRock, sstep(170, 320, h));
        pcol[i * 3] = tmp.r; pcol[i * 3 + 1] = tmp.g; pcol[i * 3 + 2] = tmp.b;
      }
      pg.setAttribute('color', new THREE.BufferAttribute(pcol, 3));
      const pad = new THREE.Mesh(pg, mat);
      pad.position.set(F.x, 0, F.z);
      this.scene.add(pad);
    }
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
    // flat light-grey boxes, like the original's untextured downtown
    this.cityMat = new THREE.MeshLambertMaterial({ color: 0x777777, flatShading: true });
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const N = 130;
    this.cityMesh = new THREE.InstancedMesh(box, this.cityMat, N);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    this._cityLightPts = [];
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
      // lit windows/roof for the night city
      this._cityLightPts.push(x + rand(-w * 0.3, w * 0.3), g - 1 + h * rand(0.55, 1.02), z + rand(-d * 0.3, d * 0.3));
      if (i % 2 === 0) this._cityLightPts.push(x + rand(-w * 0.4, w * 0.4), g - 1 + h * rand(0.2, 0.95), z + rand(-d * 0.4, d * 0.4));
      i++;
    }
    this.scene.add(this.cityMesh);
    const g1 = groundHeight(7300, 4600);
    const pyr = new THREE.Mesh(new THREE.ConeGeometry(26, 260, 4), new THREE.MeshLambertMaterial({ color: 0x888888 }));
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
    // unlit: the original's bridge is a flat, unmistakable dark red silhouette
    const orange = new THREE.MeshBasicMaterial({ color: 0x880000, fog: true });
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
    g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x883333 })));
    this.scene.add(g);
  }

  _buildBayBridge() {
    // gray spans like the original's map: Bay Bridge (SF->Oakland), the San
    // Mateo crossing further south, and the Dumbarton (Hwy 84) near the
    // south end of the bay — each drawn shore to shore
    this._bridgeSpan(new THREE.Vector3(9800, 56, 6000), new THREE.Vector3(28000, 56, 8800));
    this._bridgeSpan(new THREE.Vector3(16800, 48, 24000), new THREE.Vector3(29600, 48, 24200));
    this._bridgeSpan(new THREE.Vector3(16800, 42, 30500), new THREE.Vector3(29500, 42, 30600));
  }

  // one arc-length resample per road, shared by the asphalt ribbon, the
  // painted centreline and the traffic lanes — they can never drift apart
  _roadPath(R, ri) {
    const lift = 0.35 + (ri % 5) * 0.05;
    const S = [];
    for (let i = 0; i < R.pts.length - 1; i++) {
      const a = R.pts[i], b = R.pts[i + 1];
      const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
      const n = Math.max(1, Math.round(L / 45));   // ~45 m so ribbons hug the ground
      for (let k = (i === 0 ? 0 : 1); k <= n; k++) {
        const t = k / n, x = a[0] + dx * t, z = a[1] + dz * t;
        const sh = surfaceHeight(x, z);
        const gy = (sh === null ? groundHeight(x, z) : sh) + lift;
        let y;
        if (a.length === 3 && b.length === 3) y = lerp(a[2], b[2], t);
        else if (a.length === 3) y = lerp(a[2], gy, t);
        else if (b.length === 3) y = lerp(gy, b[2], t);
        else y = gy;
        S.push([x, y, z, (a.length === 3 || b.length === 3) ? 1 : 0]);   // 4th: bridge deck
      }
    }
    const cum = [0];
    for (let i = 1; i < S.length; i++) cum.push(cum[i - 1] + Math.hypot(S[i][0] - S[i - 1][0], S[i][2] - S[i - 1][2]));
    return { S, cum, len: cum[cum.length - 1], w: R.w || 40, lift };
  }

  _buildRoads() {
    // gray asphalt ribbons draped over the terrain, with painted markings:
    // white edge lines and a dashed yellow centreline for the two-way traffic
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const g2 = c.getContext('2d');
    g2.fillStyle = '#707780'; g2.fillRect(0, 0, 64, 64);        // light asphalt gray
    g2.fillStyle = '#e8e8e0';                                    // white edge lines
    g2.fillRect(2, 0, 3, 64); g2.fillRect(59, 0, 3, 64);
    g2.fillStyle = '#f0c830'; g2.fillRect(29, 6, 5, 24);         // yellow centre dash
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;                                          // crisp at glancing angles
    const mat = new THREE.MeshBasicMaterial({ map: tex });   // unlit, like the original
    const lineMat = new THREE.LineBasicMaterial({ color: 0xd8b830, fog: true });
    this._roadMat = mat; this._roadLineMat = lineMat;   // dimmed by setTimeOfDay
    for (let ri = 0; ri < ROADS.length; ri++) {
      const P = this._roadPath(ROADS[ri], ri);
      const S = P.S;
      const w = P.w / 2;   // wide enough to survive the retro render scale
      const verts = new Float32Array(S.length * 6), uvs = new Float32Array(S.length * 4);
      const idx = [];
      let cum = 0;
      for (let i = 0; i < S.length; i++) {
        const p = S[i], q = S[Math.min(i + 1, S.length - 1)], pr = S[Math.max(i - 1, 0)];
        let dx = q[0] - pr[0], dz = q[2] - pr[2];
        const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
        if (i > 0) cum += Math.hypot(p[0] - S[i - 1][0], p[2] - S[i - 1][2]);
        // per-vertex heights: each ribbon edge hugs the surface beneath it,
        // so cross-slopes never bury an edge (deck samples stay on the deck)
        let yL = p[1], yR = p[1];
        if (!p[3]) {
          const drape = (vx, vz) => {
            const s = surfaceHeight(vx, vz);
            return s === null ? p[1] : s + P.lift;
          };
          yL = drape(p[0] - dz * w, p[2] + dx * w);
          yR = drape(p[0] + dz * w, p[2] - dx * w);
        }
        verts.set([p[0] - dz * w, yL, p[2] + dx * w,  p[0] + dz * w, yR, p[2] - dx * w], i * 6);
        uvs.set([0, cum / 24, 1, cum / 24], i * 4);   // 24 m per texture repeat: 9 m dash, 15 m gap
        if (i > 0) { const b0 = i * 2; idx.push(b0 - 2, b0 - 1, b0, b0 - 1, b0 + 1, b0); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geo.setIndex(idx);
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;   // one long ribbon: culling by bounds would pop whole highways
      this.scene.add(m);
      // plus a constant 1px yellow line along the centreline — the retro render
      // scale shrinks even a 40 m ribbon to nothing at 3 km, and this keeps the
      // road (and its dividing line) readable from any altitude
      const lv = new Float32Array(S.length * 3);
      for (let i = 0; i < S.length; i++) lv.set([S[i][0], S[i][1] + 0.3, S[i][2]], i * 3);
      const lgeo = new THREE.BufferGeometry();
      lgeo.setAttribute('position', new THREE.BufferAttribute(lv, 3));
      const line = new THREE.Line(lgeo, lineMat);
      line.frustumCulled = false;
      this.scene.add(line);
    }
  }

  // ---- night: warm window/roof dots over the city + town clusters ----------
  _buildCityLights() {
    const pts = this._cityLightPts || [];
    const cluster = (cx, cz, r, n, hMin, hMax) => {
      for (let k = 0; k < n; k++) {
        const a = rand(Math.PI * 2), rr = Math.pow(rand(), 0.7) * r;
        const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
        const g = groundHeight(x, z); if (g < 1) continue;
        pts.push(x, g + rand(hMin, hMax), z);
      }
    };
    cluster(7000, 5000, 2600, 500, 10, 90);      // downtown SF
    cluster(27000, 12000, 4200, 700, 8, 45);     // Oakland
    cluster(14000, 38000, 5500, 700, 8, 40);     // south bay
    cluster(-2000, -6000, 3000, 350, 8, 35);     // Marin
    cluster(13000, 21000, 2500, 350, 8, 30);     // San Mateo
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const mat = new THREE.PointsMaterial({ color: 0xffd9a0, size: 7, sizeAttenuation: true, transparent: true, opacity: 0.85, depthWrite: false, fog: true });
    const p = new THREE.Points(geo, mat);
    p.frustumCulled = false;
    this.nightGroup.add(p);
  }

  // ---- night: runway edge / threshold / end lights --------------------------
  _buildRunwayLights() {
    const pos = [], col = [];
    const cW = [1.0, 0.95, 0.75], cG = [0.2, 1.0, 0.3], cR = [1.0, 0.15, 0.1];
    for (const rw of this.runways) {
      const fx = Math.sin(rw.hdg), fz = -Math.cos(rw.hdg);   // down-runway direction
      const px = -fz, pz = fx;                               // right of the centreline
      const hw = rw.wid * 0.5 * 0.92, y0 = rw.elev + 0.6;
      for (let d = -rw.len / 2; d <= rw.len / 2; d += 55) {
        for (const sg of [-1, 1]) { pos.push(rw.x + fx * d + px * hw * sg, y0, rw.z + fz * d + pz * hw * sg); col.push(...cW); }
      }
      for (const e of [-1, 1]) {
        for (let k = -1.5; k <= 1.5; k += 1) {
          pos.push(rw.x + fx * e * rw.len / 2 + px * k * 3, y0, rw.z + fz * e * rw.len / 2 + pz * k * 3); col.push(...cG);
          pos.push(rw.x + fx * e * (rw.len / 2 + 8) + px * k * 3, y0, rw.z + fz * e * (rw.len / 2 + 8) + pz * k * 3); col.push(...cR);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({ size: 3, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: 0.95, depthWrite: false, fog: true });
    const p = new THREE.Points(geo, mat);
    p.frustumCulled = false;
    this.nightGroup.add(p);
  }

  // ---- road traffic: cars, trucks and buses plying every road --------------
  _buildTraffic() {
    // each road gets two lane polylines, offset right-of-travel from the shared
    // road path and draped at their own lateral position — vehicles sit exactly
    // on the asphalt, even on curves and cross-slopes
    const mkCum = (S) => { const c = [0]; for (let i = 1; i < S.length; i++) c.push(c[i - 1] + Math.hypot(S[i][0] - S[i - 1][0], S[i][2] - S[i - 1][2])); return c; };
    const paths = [];
    for (let ri = 0; ri < ROADS.length; ri++) {
      const P = this._roadPath(ROADS[ri], ri);
      // keep lanes close to the painted centreline: from the air a flat ribbon
      // foreshortens to a line, so cars must sit near it to read as ON the road
      const off = P.w * 0.13;
      const laneA = [], laneB = [];   // A: right of forward travel, B: right of reverse
      for (let i = 0; i < P.S.length; i++) {
        const p = P.S[i], q = P.S[Math.min(i + 1, P.S.length - 1)], pr = P.S[Math.max(i - 1, 0)];
        let dx = q[0] - pr[0], dz = q[2] - pr[2];
        const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
        for (const sgn of [1, -1]) {
          const lx = p[0] - dz * off * sgn, lz = p[2] + dx * off * sgn;
          let ly;
          if (p[3]) ly = p[1];   // bridge deck: flat across
          else { const sh = surfaceHeight(lx, lz); ly = (sh === null ? groundHeight(lx, lz) : sh) + P.lift; }
          (sgn === 1 ? laneA : laneB).push([lx, ly, lz]);
        }
      }
      paths.push({
        A: { S: laneA, cum: mkCum(laneA) }, B: { S: laneB, cum: mkCum(laneB) },
        len: P.len, w: P.w,
      });
    }
    const COL_CAR = [0xd8d8d8, 0xf0f0f0, 0x1c2228, 0xa02828, 0x2848a8, 0xd8a828, 0x787878, 0x38a0c8];
    const COL_HEAVY = [0xe0e0e0, 0xa8a8a8, 0x707a88, 0xc86030];
    const COL_BUS = [0x2a5a8a, 0x8a2a2a, 0xd0d0d0];
    const defs = [];
    for (const p of paths) {
      const n = Math.max(2, Math.round(p.len / (p.w > 30 ? 430 : 650)));
      for (let k = 0; k < n; k++) {
        const r = rand();
        const type = r < 0.72 ? 0 : r < 0.88 ? 1 : 2;
        const dir = rand() < 0.5 ? 1 : -1;
        defs.push({
          path: p, lane: dir === 1 ? p.A : p.B, d: rand() * p.len, dir,
          speed: rand(17, 27) * (type === 0 ? 1 : 0.85), type, j: 0,
          col: (type === 0 ? COL_CAR : type === 1 ? COL_HEAVY : COL_BUS)[Math.floor(rand() * (type === 0 ? 8 : 4))],
        });
      }
    }
    const N = defs.length;
    const geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, 0.5, 0);
    const body = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({}), N);
    body.frustumCulled = false;
    const cab = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0x14181c }), N);
    cab.frustumCulled = false;
    const colTmp = new THREE.Color();
    for (let i = 0; i < N; i++) body.setColorAt(i, colTmp.setHex(defs[i].col));
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    this.scene.add(body); this.scene.add(cab);
    // headlights / tail lights, one Points cloud, shown at night only
    const lp = new Float32Array(N * 2 * 3), lc = new Float32Array(N * 2 * 3);
    for (let i = 0; i < N; i++) {
      lc.set([1, 1, 0.85], i * 6);          // headlight — white
      lc.set([1, 0.12, 0.1], i * 6 + 3);    // tail light — red
    }
    const lgeo = new THREE.BufferGeometry();
    lgeo.setAttribute('position', new THREE.BufferAttribute(lp, 3));
    lgeo.setAttribute('color', new THREE.BufferAttribute(lc, 3));
    const lights = new THREE.Points(lgeo, new THREE.PointsMaterial({ size: 2.6, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: 0.95, depthWrite: false, fog: true }));
    lights.frustumCulled = false;
    lights.visible = false;
    this.scene.add(lights);
    this.traffic = { defs, body, cab, lights, lp };
  }

  _updateTraffic(dt) {
    const T = this.traffic;
    if (!T) return;
    const DIM = [[4.4, 1.5, 1.9], [8.5, 2.7, 2.6], [11, 2.7, 2.7]];    // car / truck / bus
    const _m = _tm, _q = _tq, _p = _tv, _s = _ts;
    for (let i = 0; i < T.defs.length; i++) {
      const v = T.defs[i], L = v.lane, cum = L.cum, S = L.S;
      const lLen = cum[cum.length - 1];
      v.d += v.dir * v.speed * dt;
      if (v.d > lLen) v.d -= lLen; else if (v.d < 0) v.d += lLen;
      let j = v.j;
      while (j < cum.length - 2 && cum[j + 1] < v.d) j++;
      while (j > 0 && cum[j] > v.d) j--;
      v.j = j;
      const t = (v.d - cum[j]) / Math.max(cum[j + 1] - cum[j], 1e-6);
      const a = S[j], b = S[Math.min(j + 1, S.length - 1)];
      let tx = b[0] - a[0], tz = b[2] - a[2];
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const dirx = tx * v.dir, dirz = tz * v.dir;          // direction of travel
      const x = a[0] + (b[0] - a[0]) * t;                  // lane polyline already
      const z = a[2] + (b[2] - a[2]) * t;                  // carries the road offset
      const y = a[1] + (b[1] - a[1]) * t + 0.15;
      const dims = DIM[v.type];
      _e.set(0, Math.atan2(dirx, dirz), 0); _q.setFromEuler(_e);
      _p.set(x, y, z); _s.set(dims[2], dims[1], dims[0]); _m.compose(_p, _q, _s);
      T.body.setMatrixAt(i, _m);
      // cabin block (cars and truck cabs only)
      if (v.type < 2) {
        const cd = v.type === 0 ? [2.2, 0.7, 1.7] : [2.4, 0.7, 2.4];
        const cz = v.type === 0 ? -0.3 : dims[0] * 0.28;   // cars: cabin aft; trucks: cab forward
        _p.set(x + dirx * cz, y + dims[1], z + dirz * cz); _s.set(cd[2], cd[1], cd[0]); _m.compose(_p, _q, _s);
      } else {
        _p.set(x, y - 10, z); _s.set(0.01, 0.01, 0.01); _m.compose(_p, _q, _s);
      }
      T.cab.setMatrixAt(i, _m);
      // lights: white at the nose, red at the tail
      const nose = dims[0] / 2 + 0.3, li = i * 6;
      T.lp[li] = x + dirx * nose; T.lp[li + 1] = y + 0.8; T.lp[li + 2] = z + dirz * nose;
      T.lp[li + 3] = x - dirx * nose; T.lp[li + 4] = y + 0.8; T.lp[li + 5] = z - dirz * nose;
    }
    T.body.instanceMatrix.needsUpdate = true;
    T.cab.instanceMatrix.needsUpdate = true;
    T.lights.geometry.attributes.position.needsUpdate = true;
  }
  _bridgeSpan(a, b) {
    const gray = new THREE.MeshLambertMaterial({ color: 0x9aa2a8 });
    const g = new THREE.Group();
    const dir = b.clone().sub(a), len = dir.length(), ang = Math.atan2(dir.x, dir.z);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(24, 6, len), gray);
    deck.position.copy(a).add(b).multiplyScalar(0.5); deck.rotation.y = ang;
    g.add(deck);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    this.addCollider(mid.x, mid.y, mid.z, Math.abs(dir.x) / 2 + 12, 5, Math.abs(dir.z) / 2 + 12);
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
    this.towerViews = [];   // viewpoints for the tower camera
    const rwyTex = (() => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 512;
      const g2 = c.getContext('2d');
      g2.fillStyle = '#5a5e63'; g2.fillRect(0, 0, 64, 512);
      g2.fillStyle = '#e8e8e8';
      for (let y = 30; y < 500; y += 42) g2.fillRect(30, y, 4, 22);
      // piano-key thresholds like the original's runways
      for (let k = 0; k < 6; k++) {
        g2.fillRect(5 + k * 9.5, 4, 5, 14); g2.fillRect(5 + k * 9.5, 494, 5, 14);
      }
      return new THREE.CanvasTexture(c);
    })();
    // flat paved rectangle (runway/taxiway/apron); subdivided along its length
    // so no single triangle can straddle a ground-level camera
    const mkPaved = (x, z, wid, len, hdg, y, mat) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(wid, len, 1, Math.max(1, Math.round(len / 80))), mat);
      m.rotation.x = -Math.PI / 2; m.rotation.z = -hdg;
      m.position.set(x, y, z);
      this.scene.add(m);
      return m;
    };
    const rwyMat = new THREE.MeshLambertMaterial({ map: rwyTex });
    const taxiMat = new THREE.MeshLambertMaterial({ color: 0x606468 });
    const apronMat = new THREE.MeshLambertMaterial({ color: 0x565a5e });
    // paved-layer heights above the pad (which is exactly the true surface):
    // aprons 18 cm, taxiways 22 cm, runways 30 cm — taller layers win
    // crossings, and 30 cm clears the small pad rise where two FLATS zones
    // overlap (San Mateo's ramp reaches SFO's 01R threshold)
    const Y_APRON = 0.18, Y_TAXI = 0.22, Y_RWY = 0.3;
    const hangarMat = new THREE.MeshLambertMaterial({ color: 0xb9bcae });
    const hangarDark = new THREE.MeshLambertMaterial({ color: 0x8f9484 });
    // arched dirigible hangar (Moffett's Hangar One/Two/Three): a half-pipe
    const mkArch = (x, z, hdg, len, r, h, mat) => {
      const geo = new THREE.CylinderGeometry(r, r, len, 20, 1, false, 0, Math.PI);
      const m = new THREE.Mesh(geo, mat);
      m.rotation.z = Math.PI / 2;              // axis along X, shell facing up
      m.rotation.y = -hdg + Math.PI / 2;       // align axis with the field
      m.scale.y = h / r;                       // taller than a true semicircle
      const gy = groundHeight(x, z);
      m.position.set(x, gy, z);
      this.scene.add(m);
      // rotated AABB: arch axis runs along (sin h, -cos h), width r across it
      this.addCollider(x, gy + h / 2, z,
        len / 2 * Math.abs(Math.sin(hdg)) + r * Math.abs(Math.cos(hdg)), h / 2,
        len / 2 * Math.abs(Math.cos(hdg)) + r * Math.abs(Math.sin(hdg)));
      return m;
    };
    const mkBox = (x, z, w, h, l, hdg, mat) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), mat);
      const gy = groundHeight(x, z);
      m.position.set(x, gy + h / 2, z); m.rotation.y = -hdg;
      this.scene.add(m);
      this.addCollider(x, gy + h / 2, z,
        w / 2 * Math.abs(Math.cos(hdg)) + l / 2 * Math.abs(Math.sin(hdg)) + 2, h / 2,
        w / 2 * Math.abs(Math.sin(hdg)) + l / 2 * Math.abs(Math.cos(hdg)) + 2);
      return m;
    };
    const mkTower = (x, z, elev, name) => {
      const tw = new THREE.Mesh(new THREE.CylinderGeometry(4, 6, 40, 8), new THREE.MeshLambertMaterial({ color: 0xb8c0c8 }));
      tw.position.set(x, elev + 20, z); this.scene.add(tw);
      const cab = new THREE.Mesh(new THREE.CylinderGeometry(8, 6, 10, 8), new THREE.MeshLambertMaterial({ color: 0x30414f }));
      cab.position.set(x, elev + 44, z); this.scene.add(cab);
      this.addCollider(x, elev + 24, z, 9, 26, 9);
      this.towerViews.push({ name, pos: new THREE.Vector3(x, elev + 50, z) });
    };
    // tiny parked jets on the apron: fuselage + wing + tail boxes
    const mkParked = (x, z, hdg, color) => {
      const g = new THREE.Group();
      const mat = new THREE.MeshLambertMaterial({ color });
      const fus = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2, 15), mat); fus.position.y = 1.6; g.add(fus);
      const wing = new THREE.Mesh(new THREE.BoxGeometry(11, 0.4, 3.4), mat); wing.position.set(0, 1.8, 1); g.add(wing);
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.4, 3, 2.4), mat); tail.position.set(0, 3, 6.4); g.add(tail);
      g.position.set(x, groundHeight(x, z) + 0.1, z); g.rotation.y = -hdg;
      this.scene.add(g);
    };
    for (const rw of this.runways) mkPaved(rw.x, rw.z, rw.wid, rw.len, rw.hdg, rw.elev + Y_RWY, rwyMat);

    // ---- per-airfield ground layout: taxiways, aprons, hangars, towers ----
    const D = Math.PI / 180;
    // SFO — terminal core south of the crossing, tower on it, taxiways along
    // both pairs (the real field sits on bay fill at the water's edge)
    mkPaved(13150, 20950, 350, 620, 10 * D, 4 + Y_APRON, apronMat);           // terminal apron
    mkPaved(13360, 20200, 18, 2300, 10 * D, 4 + Y_TAXI, taxiMat);             // taxiway along 01 pair
    mkPaved(13000, 20550, 18, 2500, 103 * D, 4 + Y_TAXI, taxiMat);            // taxiway along 10/28
    mkBox(12950, 21100, 120, 18, 60, 10 * D, hangarDark);                     // terminal block
    mkBox(13100, 21250, 90, 15, 50, 10 * D, hangarDark);
    mkBox(13350, 21100, 70, 14, 200, 10 * D, hangarMat);                      // concourse fingers
    mkBox(13000, 20920, 60, 13, 160, 103 * D, hangarMat);
    mkTower(13150, 20750, 4, 'SFO TOWER');
    mkParked(13220, 20980, 100 * D, 0xd8dde2); mkParked(13080, 21010, 100 * D, 0xcfd6da);
    mkParked(13260, 20860, 10 * D, 0xe2e6ea);
    // OAKLAND — apron complex between the south field (12/30) and north field
    mkPaved(26450, 15950, 380, 900, 120 * D, 3 + Y_APRON, apronMat);
    mkPaved(26200, 16100, 18, 2900, 120 * D, 3 + Y_TAXI, taxiMat);            // taxiway parallel 12/30
    mkPaved(26800, 15550, 18, 1500, 100 * D, 3 + Y_TAXI, taxiMat);            // north-field taxiway
    mkBox(26650, 15900, 90, 16, 60, 120 * D, hangarMat);                      // hangars along the apron
    mkBox(26750, 16050, 70, 13, 55, 120 * D, hangarMat);
    mkBox(26250, 15750, 80, 14, 60, 120 * D, hangarDark);
    mkTower(26500, 15800, 3, 'OAKLAND TOWER');
    mkParked(26420, 15920, 30 * D, 0xd8dde2); mkParked(26520, 16020, 30 * D, 0xc9ced4);
    // MOFFETT — Hangar One west, Hangars Two & Three east, aprons both sides
    mkPaved(9700, 34200, 260, 420, 140 * D, 10 + Y_APRON, apronMat);          // west apron
    mkPaved(10500, 33550, 300, 520, 140 * D, 10 + Y_APRON, apronMat);         // east apron
    mkPaved(10000, 34000, 18, 2700, 140 * D, 10 + Y_TAXI, taxiMat);           // taxiway between parallels
    mkArch(9550, 34400, 140 * D, 345, 47, 60, hangarMat);                     // Hangar One
    mkArch(10450, 33700, 140 * D, 180, 30, 36, hangarMat);                    // Hangar Two
    mkArch(10560, 33820, 140 * D, 180, 30, 36, hangarMat);                    // Hangar Three
    mkTower(9750, 34100, 10, 'MOFFETT TOWER');
    mkParked(9760, 34260, 50 * D, 0xb9c0c6); mkParked(10520, 33620, 140 * D, 0xb9c0c6);
    // NAS ALAMEDA — apron and hangars on the north side, carrier pier feel
    mkPaved(21100, 12000, 320, 760, 70 * D, 4 + Y_APRON, apronMat);
    mkPaved(21100, 12250, 18, 2100, 70 * D, 4 + Y_TAXI, taxiMat);             // taxiway along 07/25
    mkBox(20900, 11800, 110, 15, 70, 70 * D, hangarMat);
    mkBox(21150, 11750, 90, 14, 60, 70 * D, hangarMat);
    mkBox(21400, 11850, 80, 13, 60, 70 * D, hangarDark);
    mkTower(20800, 12050, 4, 'ALAMEDA TOWER');
    mkParked(21000, 12050, 70 * D, 0xd8dde2); mkParked(21180, 12120, 70 * D, 0xc9ced4);
    mkParked(20920, 12140, 340 * D, 0xe2e6ea);
  }

  // carrier island cab — computed live since the ship is underway
  carrierTowerPos(out) {
    const c = this.carrier, ci = c.islandOffset;
    out.set(ci.x, c.deckY + 24, ci.z).applyAxisAngle(_UP, Math.PI - c.heading);
    return out.add(c.group.position);
  }

  update(dt, camPos, playerY = camPos.y) {
    this.time += dt;
    // ocean is flat — nothing to animate
    if (this.skyMesh) this.skyMesh.position.copy(camPos);
    if (this.oceanMesh) this.oceanMesh.position.set(camPos.x, -2.5, camPos.z);
    this._reflowSpecks(camPos, playerY);
    this.carrier.update(dt);
    this.enemySub.update(dt);
    this._updateTraffic(dt);
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
    // laid out like the real CVN-65 deck plan: canvas left = starboard,
    // top = stern, bottom = bow (the deck box's top-face UV mapping)
    const c = document.createElement('canvas'); c.width = 256; c.height = 1024;
    const g = c.getContext('2d');
    const cX = (x) => (x + 38) / 76 * 256, cY = (z) => (z + 168) / 336 * 1024;
    g.fillStyle = '#23262b'; g.fillRect(0, 0, 256, 1024);   // near-black deck, like the original
    g.strokeStyle = '#c9cdd2'; g.lineWidth = 3; g.strokeRect(5, 5, 246, 1014);
    // axial-deck dashed centreline (stern to bow)
    g.fillStyle = '#dfe3e6';
    for (let z = -150; z < 160; z += 20) g.fillRect(cX(0) - 1.5, cY(z), 3, 12);
    // angled landing deck: stern-starboard (x -14) to port bow (x +27), ~9 deg
    const a0 = { x: -14, z: -160 }, a1 = { x: 27, z: 112 };
    this.angleDeck = { a0, a1 };
    const ang = Math.atan2(a1.x - a0.x, a1.z - a0.z), aLen = Math.hypot(a1.x - a0.x, a1.z - a0.z);
    const YM = 1024 / 336;   // canvas px per deck metre along the ship
    g.save();
    g.translate(cX(a0.x), cY(a0.z)); g.rotate(ang);
    g.fillStyle = '#e8ecef';
    g.fillRect(-30, 0, 3, aLen * YM); g.fillRect(27, 0, 3, aLen * YM);   // edge stripes
    for (let d = 14; d < aLen * 0.94; d += 22) g.fillRect(-2, d * YM, 4, 12);  // centreline dashes
    for (const wz of [-50, -38, -26, -14]) g.fillRect(-27, (wz - a0.z) * YM, 54, 4);  // 4 arrestor wires
    g.restore();
    // catapult tracks (dark slots): two bow cats + two waist cats
    g.strokeStyle = '#232529'; g.lineWidth = 5;
    for (const cx of [-13, 11]) { g.beginPath(); g.moveTo(cX(cx), cY(30)); g.lineTo(cX(cx), cY(158)); g.stroke(); }
    g.save(); g.translate(cX(22), cY(-60)); g.rotate(ang);
    for (const off of [0, -30]) { g.beginPath(); g.moveTo(off, 0); g.lineTo(off, 90 * YM); g.stroke(); }
    g.restore();
    // elevators: yellow deck-edge outlines (3 starboard + 1 port aft)
    g.strokeStyle = '#d8bc30'; g.lineWidth = 3;
    const elev = (x, z0, z1) => g.strokeRect(cX(x) - 1, cY(z0), 12, cY(z1) - cY(z0));
    elev(-38, 62, 88); elev(-38, -2, 24); elev(-38, -78, -52); elev(26, -34, -8);
    // foul-line box around the bow park
    g.setLineDash([10, 8]); g.strokeRect(cX(-34), cY(58), cX(30) - cX(-34), cY(160) - cY(58)); g.setLineDash([]);
    if (!this.isSub) {
      g.save(); g.translate(cX(8), cY(128)); g.rotate(Math.PI);
      g.font = 'bold 64px Arial'; g.fillStyle = '#e8ecef'; g.textAlign = 'center'; g.fillText('65', 0, 0); g.restore();
    }
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    return t;
  }
  _build(isSub) {
    const deckMat = new THREE.MeshLambertMaterial({ map: this._deckTexture() });
    const deck = new THREE.Mesh(new THREE.BoxGeometry(76, 3, 336), deckMat);
    deck.position.y = this.deckY - 1.5; this.group.add(deck);
    const deckY = this.deckY;
    if (!isSub) {
      // ---- CVN-65 detailing -------------------------------------------
      const LM = (c) => new THREE.MeshLambertMaterial({ color: c });
      const gM = LM(0x8a929c), dM = LM(0x596069), wM = LM(0xdfe3e6);   // light island over the dark deck, like the original

      // lofted hull: grey freeboard above the waterline, red anti-fouling below
      // sections are [z, halfWidth at deck, halfWidth at keel]
      const secs = [
        [-160, 10, 8], [-152, 26, 22], [-135, 33, 28], [-80, 35, 30],
        [0, 35, 30], [100, 34, 29], [150, 27, 17], [178, 4, 2],
      ];
      const yTop = deckY - 1.5, yWat = 0, yBot = -8;
      const cG = new THREE.Color(0x4b4f56), cR = new THREE.Color(0x6e241d);   // dark hull like the original
      const V = [], C = [];
      const push = (p, col) => { V.push(p[0], p[1], p[2]); C.push(col.r, col.g, col.b); };
      const quad = (a, b, c2, d, col) => { push(a, col); push(b, col); push(c2, col); push(a, col); push(c2, col); push(d, col); };
      const rings = secs.map(([z, wt, wb]) => [
        [wt, yTop, z], [wt, yWat, z], [wb, yBot, z],
        [-wb, yBot, z], [-wt, yWat, z], [-wt, yTop, z],
      ]);
      const edgeCol = [cG, cR, cR, cR, cG];
      for (let i = 0; i < rings.length - 1; i++) {
        for (let e = 0; e < 5; e++) {   // edge 5 (top) is hidden under the deck
          const e2 = (e + 1) % 6;
          quad(rings[i][e], rings[i][e2], rings[i + 1][e2], rings[i + 1][e], edgeCol[e]);
        }
      }
      for (const ri of [0, rings.length - 1]) {           // stern + bow caps
        const ring = rings[ri];
        const ctr = [0, (yTop + yBot) / 2, ring[0][2]];
        for (let e = 0; e < 6; e++) {
          const e2 = (e + 1) % 6;
          const col = (ring[e][1] + ring[e2][1]) / 2 > yWat ? cG : cR;
          if (ri === 0) { push(ctr, col); push(ring[e2], col); push(ring[e], col); }
          else { push(ctr, col); push(ring[e], col); push(ring[e2], col); }
        }
      }
      const hg = new THREE.BufferGeometry();
      hg.setAttribute('position', new THREE.Float32BufferAttribute(V, 3));
      hg.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
      hg.computeVertexNormals();
      this.group.add(new THREE.Mesh(hg, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })));

      // island (starboard): stacked levels, window band, mast + rotating radar
      const isl = new THREE.Group();
      const ib = (w, h, d, x, y, z, m) => { const q = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m || gM); q.position.set(x, y, z); isl.add(q); return q; };
      ib(16, 14, 34, -30, deckY + 7, 30);          // base
      ib(14, 7, 28, -30, deckY + 17.5, 30);       // level 2
      ib(15, 5, 24, -30, deckY + 23.5, 30);       // bridge house
      ib(15.6, 1.8, 24.6, -30, deckY + 25, 30, LM(0x141c26)); // window band
      ib(10, 2.4, 16, -30, deckY + 29, 30);       // top platform
      ib(9, 0.8, 34, -30, deckY + 0.6, 30, dM);   // catwalk skirting
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.1, 22, 8), dM);
      mast.position.set(-30, deckY + 41, 34); isl.add(mast);
      const yard = new THREE.Mesh(new THREE.BoxGeometry(9, 0.5, 0.5), dM);
      yard.position.set(-30, deckY + 46, 34); isl.add(yard);
      const yard2 = yard.clone(); yard2.position.y = deckY + 49; yard2.scale.x = 0.7; isl.add(yard2);
      this.radar = new THREE.Group();
      this.radar.position.set(-30, deckY + 52.5, 34);
      const bar1 = new THREE.Mesh(new THREE.BoxGeometry(8, 0.8, 1.2), wM);
      const bar2 = new THREE.Mesh(new THREE.BoxGeometry(6, 0.6, 1.0), wM);
      bar2.position.y = 1.2; this.radar.add(bar1, bar2); isl.add(this.radar);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(1.6, 10, 8), wM);
      dome.position.set(-30, deckY + 48, 26); isl.add(dome);
      this.group.add(isl);
      // big "65" on both island faces
      const c65 = document.createElement('canvas'); c65.width = 128; c65.height = 128;
      const g65 = c65.getContext('2d');
      g65.clearRect(0, 0, 128, 128);
      g65.fillStyle = '#23262b'; g65.font = 'bold 92px Arial'; g65.textAlign = 'center'; g65.fillText('65', 64, 96);
      const t65 = new THREE.CanvasTexture(c65);
      for (const s of [-1, 1]) {
        const p = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.MeshBasicMaterial({ map: t65, transparent: true }));
        p.position.set(-30 + 8.1 * s, deckY + 7, 30); p.rotation.y = s > 0 ? Math.PI / 2 : -Math.PI / 2;
        this.group.add(p);
      }
      this.islandOffset = { x: -30, z: 30 };

      // arrestor wires (3D) across the angled deck — a0/a1 set by _deckTexture()
      const { a0, a1 } = this.angleDeck;
      const ang = Math.atan2(a1.x - a0.x, a1.z - a0.z);
      const wireM = LM(0x2a2c2e);
      for (const wz of [-50, -38, -26, -14]) {
        const t = (wz - a0.z) / (a1.z - a0.z);
        const w = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.25, 30), wireM);
        w.position.set(a0.x + (a1.x - a0.x) * t, deckY + 0.15, wz);
        w.rotation.y = Math.PI / 2 + ang;          // perpendicular to the landing axis
        this.group.add(w);
      }
      // catapult shuttles on the two bow tracks
      for (const cx of [-13, 11]) {
        const sh = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.3, 2.5), dM);
        sh.position.set(cx, deckY + 0.18, 40); this.group.add(sh);
      }
      // fresnel lens ("meatball") on the port deck edge, facing the approach
      const fl = new THREE.Group(); fl.position.set(35.2, deckY + 0.6, -95); fl.rotation.y = Math.PI - 0.15;
      const flb = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.4, 0.6), dM); flb.position.y = 1.2; fl.add(flb);
      const fll = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.8, 0.15), new THREE.MeshBasicMaterial({ color: 0xffb43c }));
      fll.position.set(0, 1.2, 0.35); fl.add(fll); this.group.add(fl);
      // whip antennas along both deck edges
      const whipG = new THREE.CylinderGeometry(0.06, 0.06, 6, 4);
      for (let i = 0; i < 5; i++) for (const s of [-1, 1]) {
        const wp = new THREE.Mesh(whipG, dM);
        wp.position.set(37 * s, deckY + 3, -140 + i * 74); this.group.add(wp);
      }
      // deck edge lights
      const lm2 = new THREE.MeshBasicMaterial({ color: 0xbfd9ff });
      for (let z = -160; z <= 160; z += 40) for (const s of [-1, 1]) {
        const li = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), lm2);
        li.position.set(37.5 * s, deckY + 0.3, z); this.group.add(li);
      }
      // night lighting: glowing deck edge line, island windows, masthead
      this.nightGroup = new THREE.Group();
      this.nightGroup.visible = false;
      const np = [], nc = [];
      const addL = (x, y, z, c) => { np.push(x, y, z); nc.push(...c); };
      for (let z = -160; z <= 160; z += 12) for (const s of [-1, 1]) addL(37.5 * s, deckY + 0.6, z, [0.7, 0.8, 1]);
      for (let i = 0; i < 22; i++) addL(-30 + rand(-6, 6), deckY + rand(4, 24), 30 + rand(-13, 13), [1, 0.85, 0.55]);
      addL(-30, deckY + 53.5, 34, [1, 1, 1]);   // masthead
      const ngeo = new THREE.BufferGeometry();
      ngeo.setAttribute('position', new THREE.Float32BufferAttribute(np, 3));
      ngeo.setAttribute('color', new THREE.Float32BufferAttribute(nc, 3));
      const npts = new THREE.Points(ngeo, new THREE.PointsMaterial({ size: 3.2, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: 0.95, depthWrite: false, fog: true }));
      npts.frustumCulled = false;
      this.nightGroup.add(npts);
      this.group.add(this.nightGroup);
    } else {
      const hullC = 0x1c2126;
      const hull = new THREE.Mesh(new THREE.BoxGeometry(70, 18, 320), new THREE.MeshLambertMaterial({ color: hullC }));
      hull.position.y = 2; this.group.add(hull);
      const bow = new THREE.Mesh(new THREE.CylinderGeometry(35, 12, 18, 4, 1), new THREE.MeshLambertMaterial({ color: hullC }));
      bow.rotation.y = Math.PI / 4; bow.scale.set(1, 1, 1.6); bow.position.set(0, 2, 178); this.group.add(bow);
      const sail = new THREE.Mesh(new THREE.BoxGeometry(10, 14, 22), new THREE.MeshLambertMaterial({ color: 0x23292e }));
      sail.position.set(0, deckY + 7, 60); this.group.add(sail);
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
    if (this.radar) this.radar.rotation.y += dt * 0.9;
    const p = this.group.position;
    // stay well out in the Pacific — the coast at this latitude is ~-4 km
    if (this.turning === 0 && Math.abs(Math.sin(this.heading)) > 0.5 && (p.x > -14000 || p.x < -56000)) this.turning = Math.PI;
    if (this.turning > 0) { const tr = 0.06 * dt; this.heading += tr; this.turning -= tr; if (this.turning <= 0) this.turning = 0; }
    p.x += Math.sin(this.heading) * this.speed * dt;
    p.z += -Math.cos(this.heading) * this.speed * dt;
    this.group.rotation.y = Math.PI - this.heading;
  }
  submerge() { this.submerged = true; }
}
