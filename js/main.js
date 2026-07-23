// main.js — boot, game state machine, loop, cameras, targeting, menus
import * as THREE from 'three';
import { clamp, lerp, damp, KTS, FT, NM, wrapAngle, flightQuat, rand } from './util.js';
import { World, groundHeight } from './world.js';
import { Player, PLANES, Chute } from './flight.js';
import { AIAircraft } from './ai.js';
import { FXPool, Missile, GunSystem } from './weapons.js';
import { HUD } from './hud.js';
import { Input } from './input.js';
import { setupTouch } from './touch.js';
import { AudioEngine } from './audio.js';
import { MISSIONS } from './missions.js';
import { Intro, FF_SPOTS } from './intro.js';
import { MapView } from './mapview.js';
import { Gallery } from './gallery.js';
import { buildModel } from './models.js';

const $ = (id) => document.getElementById(id);

// ---- guard-band safety: clamp off-screen clip coordinates ----------------
// In low grazing views the ground cells that straddle the camera's w=0 plane
// are clipped into triangles hundreds of viewports wide; some rasterizers
// (incl. software WebGL) overflow their guard band on them, smearing terrain
// and sea across the sky and punching holes beside the runways. Clamping every
// projected vertex to ±4 viewports keeps rasterizer coordinates sane; the
// frustum clip still produces the identical on-screen image.
if (!new URLSearchParams(location.search).has('nogb'))
THREE.ShaderChunk.project_vertex = `vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
{
	float _gb = abs( gl_Position.w ) * 64.0 + 1e-4;
	gl_Position.xy = clamp( gl_Position.xy, -vec2( _gb ), vec2( _gb ) );
}`;

// ---------------- error overlay (helps debugging) ----------------
window.addEventListener('error', (e) => { $('errbox').textContent += `\n${e.message}`; });

// ---------------- renderer ----------------
// logarithmic depth buffer: kills ocean/terrain z-fighting at map altitude and
// giant-triangle depth artifacts near the camera (standard depth can't span 1.5m..320km)
const renderer = new THREE.WebGLRenderer({ canvas: $('gl'), antialias: false, logarithmicDepthBuffer: !new URLSearchParams(location.search).has('nologz') });
// Amiga-authentic chunky pixels: render small, upscale with nearest-neighbor
const RETRO_SCALE = 0.36;
renderer.setPixelRatio(1);
renderer.setSize(Math.floor(window.innerWidth * RETRO_SCALE), Math.floor(window.innerHeight * RETRO_SCALE), false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1.5, 320000);
// showroom F/A-18 pinned to the camera — a slow turntable on the home menu,
// so the star of the game is on screen the moment the page loads
scene.add(camera);
const hero = buildModel('f18');
hero.scale.setScalar(0.28);
hero.position.set(2.25, -0.15, -6);
hero.rotation.order = 'YXZ';
hero.rotation.x = 0.16;
if (hero.userData.gear) hero.userData.gear.visible = false;   // clean in-flight look
camera.add(hero);
// soft showroom spot so the star stays lit after dark (short range: only the hero)
const heroLight = new THREE.PointLight(0xcfe0ff, 0, 16, 1.6);
heroLight.position.set(3.5, 2.5, -3);
camera.add(heroLight);
window.addEventListener('resize', () => {
  renderer.setSize(Math.floor(window.innerWidth * RETRO_SCALE), Math.floor(window.innerHeight * RETRO_SCALE), false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  hud.resize();
});

// ---------------- game context ----------------
const G = {
  scene, camera, renderer,
  state: 'menu',            // menu | briefing | flying | dead | debrief | paused
  time: 0, score: 0, kills: 0, gunHits: 0, shotsFired: 0,
  player: null, world: null, fx: null, hud: null, audio: null, input: null,
  bandits: [], missiles: [], radarContacts: [], messages: [],
  playerTarget: null, lockLevel: 0, locked: false,
  waypoint: null, radarRange: 40 * NM, radarRangeNM: 40,   // original powers up on the 40 MI scope
  mission: null, over: false, view: 'cockpit',
  trappedThisSortie: false, landedThisSortie: false,
  missileWarning: false, podDropRequested: false,
  freeFlightStart: 'carrier',
  orbit: { yaw: 0, pitch: 0.25, dist: 55, manual: false },
  shakeT: 0, smokeTrail: false,
  xmag: 1.0, towerName: '',
  msg(text, kind = 'info') { this.messages.unshift({ text, kind, t: this.time }); if (this.messages.length > 6) this.messages.pop(); },
  radio(text) { this.msg(text, 'radio'); this.audio.radioClick(); },
  addScore(n) { this.score += n; },
};
window.G = G; // debug hook

G.audio = new AudioEngine();
G.input = new Input();
G.touch = setupTouch(G);   // mobile: thumb stick + button deck (no-op on desktop)
G.intro = new Intro(G);
const hud = new HUD($('hud'));
G.hud = hud;
G.mapview = new MapView();   // N toggles the live tactical map
G.gallery = new Gallery(G, () => showMenu());   // menu item 9: aircraft viewer

// world is heavy — build lazily on first load but before menu demo
G.world = new World(scene);
G.fx = new FXPool(scene);
G.player = new Player(scene, G.world);
G.player.isPlayer = true;
const gun = new GunSystem(G);

// ---------------- persistence ----------------
const SAVE_KEY = 'hornet-bay-v1';
let save = { qualified: false, done: {}, best: 0, kills: 0 };
try { Object.assign(save, JSON.parse(localStorage.getItem(SAVE_KEY) || '{}')); } catch (e) {}
function persist() { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); }
G.dayNightSel = save.dayNight || 'mission';     // T on the plane-select screen toggles MISSION/DAY/NIGHT
G.weatherSel = save.weather || 'mission';       // R on the menu toggles MISSION/CLEAR/RAIN

// ---------------- menu (original 1-8 structure) ----------------
const MISSION_ORDER = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
let menuMode = 'main';
function buildMenu(mode = 'main') {
  menuMode = mode;
  const list = $('menu-list');
  list.innerHTML = '';
  const addBtn = (num, label, tag, cb) => {
    const b = document.createElement('button');
    b.className = 'mbtn';
    b.innerHTML = `${num ? `<span class="mnum">${num}</span>` : ''}${label}${tag ? `<span class="tag">${tag}</span>` : ''}`;
    b.dataset.key = num || '';
    if (cb) b.onclick = () => { G.audio.ensure(); cb(); };
    list.appendChild(b);
  };
  if (mode === 'missions') {
    $('menu-title').textContent = 'SELECTABLE MISSIONS';
    MISSION_ORDER.forEach((id, i) => {
      const def = MISSIONS.find(m => m.id === id);
      addBtn(`F${i + 1}`, def.title, save.done[id] ? 'COMPLETE' : '', () => startBriefing(id));
    });
    addBtn('ESC', 'RETURN TO MAIN MENU', '', () => buildMenu('main'));
    return;
  }
  if (mode === 'log') {
    $('menu-title').textContent = 'YOUR CURRENT FLIGHT LOG STATISTICS';
    const done = MISSION_ORDER.filter(id => save.done[id]).length;
    for (const ln of [
      `CALLSIGN ......... ${save.callsign || 'ROOKIE'}`,
      `QUALIFIED ........ ${save.qualified ? 'YES' : 'NO'}`,
      `MISSIONS DONE .... ${done} OF ${MISSION_ORDER.length}`,
      `KILLS ............ ${save.kills}`,
      `BEST SCORE ....... ${save.best}`,
      `CARRIER TRAPS .... ${save.traps || 0}`,
    ]) {
      const d = document.createElement('div'); d.className = 'logline'; d.textContent = ln; list.appendChild(d);
    }
    addBtn('C', 'CHANGE CALLSIGN', '', () => {
      const n = prompt('ENTER YOUR CALLSIGN:', save.callsign || 'ROOKIE');
      if (n) { save.callsign = n.toUpperCase().slice(0, 12); persist(); buildMenu('log'); }
    });
    addBtn('ESC', 'RETURN TO MAIN MENU', '', () => buildMenu('main'));
    return;
  }
  $('menu-title').textContent = '';   // main mode: the logo block above says it
  addBtn('1', 'DEMO', '', () => startDemo(true));
  addBtn('2', 'FREE FLIGHT, NO ENEMY CONFRONTATION', '', () => startFreeFlightMap());
  addBtn('3', 'TRAINING: DEMO OF MANEUVERS', 'SOON', () => G.msg('TRAINING NOT AVAILABLE THIS TOUR', 'info'));
  addBtn('4', 'TRAINING: PRACTICE MANEUVERS', 'SOON', () => G.msg('TRAINING NOT AVAILABLE THIS TOUR', 'info'));
  addBtn('5', 'QUALIFICATION: REQUIRED FOR MISSIONS', save.qualified ? 'QUALIFIED' : '', () => startBriefing('qual'));
  addBtn('6', 'SELECTABLE MISSIONS', '', () => buildMenu('missions'));
  addBtn('7', 'NEXT ACTIVE ADVANCED MISSION', '', () => {
    const next = MISSION_ORDER.find(id => !save.done[id]) || MISSION_ORDER[0];
    startBriefing(next);
  });
  addBtn('8', 'YOUR CURRENT FLIGHT LOG STATISTICS', '', () => buildMenu('log'));
  addBtn('9', 'AIRCRAFT GALLERY', '', () => {
    $('menu').classList.add('hidden');
    stopDemo();
    G.gallery.enter();
  });
  addBtn('T', 'TOGGLE DAY or NIGHT FLIGHT', `NOW: ${{ mission: 'MISSION DEFAULT', day: 'DAY', night: 'NIGHT' }[G.dayNightSel]}`, () => cycleMenuDayNight());
  addBtn('R', 'TOGGLE CLEAR or RAIN WEATHER', `NOW: ${{ mission: 'MISSION DEFAULT', clear: 'CLEAR', rain: 'RAIN' }[G.weatherSel]}`, () => cycleMenuWeather());
  addBtn('', 'FLIGHT MANUAL / CONTROLS', '', () => { G.openManual(); });
  $('pilot-record').textContent =
    `PILOT LOG — ${save.callsign || 'ROOKIE'} · MISSIONS FLOWN: ${Object.keys(save.done).length} · KILLS: ${save.kills} · BEST SCORE: ${save.best}`;
}
// number keys drive the menu like the original (plus T for the time-of-day row)
window.addEventListener('keydown', (e) => {
  if (G.state !== 'menu') return;
  if (e.code === 'Escape' && menuMode !== 'main') { buildMenu('main'); return; }
  const d = e.code.startsWith('Digit') ? e.code.slice(5) : e.code === 'KeyT' ? 'T' : e.code === 'KeyR' ? 'R' : null;
  if (!d) return;
  const btn = [...document.querySelectorAll('#menu-list .mbtn')].find(b => b.dataset.key === d);
  if (btn && btn.onclick) { G.audio.ensure(); btn.onclick(); }
});

// T on the main menu: cycle MISSION/DAY/NIGHT — the change is applied to the
// demo scenery behind the menu immediately and saved for the next mission
function cycleMenuDayNight() {
  G.dayNightSel = { mission: 'day', day: 'night', night: 'mission' }[G.dayNightSel] || 'mission';
  save.dayNight = G.dayNightSel;
  persist();
  G.audio.radioClick();
  applyMenuTimeOfDay();
  buildMenu();   // refresh the row label
}
function applyMenuTimeOfDay() {
  G.world.setTimeOfDay(G.dayNightSel === 'mission' ? 'day' : G.dayNightSel);
}
// R on the main menu: cycle MISSION/CLEAR/RAIN — the menu backdrop gets the
// weather immediately and the choice is saved for the next mission
function cycleMenuWeather() {
  G.weatherSel = { mission: 'clear', clear: 'rain', rain: 'mission' }[G.weatherSel] || 'mission';
  save.weather = G.weatherSel;
  persist();
  G.audio.radioClick();
  applyMenuWeather();
  buildMenu();   // refresh the row label
}
function applyMenuWeather() {
  G.world.setWeather(G.weatherSel === 'mission' ? 'clear' : G.weatherSel);
}

function showMenu() {
  G.state = 'menu';
  if (G.chute) { G.chute.dispose(); G.chute = null; }
  G.audio.endChute();
  $('menu').classList.remove('hidden');
  $('briefing').classList.add('hidden');
  $('debrief').classList.add('hidden');
  $('pause').classList.add('hidden');
  buildMenu();
  startDemo();
  applyMenuTimeOfDay();   // menu backdrop reflects the selected time of day
  applyMenuWeather();     // ...and the selected weather
}

// ---------------- briefing / debrief (map + typed text + zoom, like the original)
let pendingMission = null;
function startBriefing(id) {
  const def = MISSIONS.find(m => m.id === id);
  pendingMission = def;
  $('menu').classList.add('hidden');
  stopDemo();
  G.intro.briefing(def, () => enterPlaneSelect(def));
}
function enterPlaneSelect(def) {
  pendingMission = def;
  // the F-16 has no tailhook — carrier starts are Hornet-only
  G.intro.carrierStart = def.id === 'free' ? G.freeFlightStart === 'carrier' : def.id !== 'm1';
  G.intro.planeSelect();
}
function startFreeFlightMap() {
  $('menu').classList.add('hidden');
  stopDemo();
  G.intro.mapSelect();
}
function launchWithZoom(def) {
  launchMission(def, { zoom: true });
}
// plane select + map select + briefing keys
window.addEventListener('keydown', (e) => {
  if (G.state === 'planesel') {
    if (e.code === 'KeyT') {
      G.dayNightSel = G.dayNightSel === 'mission' ? 'day' : G.dayNightSel === 'day' ? 'night' : 'mission';
      save.dayNight = G.dayNightSel; persist();
      G.audio.radioClick();
    }
    else if (e.code === 'KeyR') {
      G.weatherSel = G.weatherSel === 'mission' ? 'clear' : G.weatherSel === 'clear' ? 'rain' : 'mission';
      save.weather = G.weatherSel; persist();
      G.audio.radioClick();
    }
    else if (e.code === 'Digit1') { G.player.type = 'f18'; launchWithZoom(pendingMission); }
    else if (e.code === 'Digit2') {
      // the F-16 has no tailhook and can't take off from or land on the carrier
      const carrierStart = pendingMission.id === 'free' ? G.freeFlightStart === 'carrier' : pendingMission.id !== 'm1';
      if (carrierStart) { G.intro.blockMsg = 'F-16 CANNOT OPERATE FROM THE CARRIER'; G.intro.blockT = G.time; G.audio.radioClick(); }
      else { G.player.type = 'f16'; launchWithZoom(pendingMission); }
    }
  } else if (G.state === 'mapselect') {
    const spot = FF_SPOTS.find(s => s.key === (e.code.startsWith('Digit') ? e.code.slice(5) : ''));
    if (spot) { G.freeFlightStart = spot.id; enterPlaneSelect(MISSIONS.find(m => m.id === 'free')); }
  } else if (G.state === 'briefing') {
    if (e.code === 'Enter' || e.code === 'Space') { G.intro.afterBrief && G.intro.afterBrief(); }
    if (e.code === 'Escape') showMenu();
  }
});
$('debrief-menu').onclick = () => { $('debrief').classList.add('hidden'); showMenu(); };
$('debrief-next').onclick = () => { $('debrief').classList.add('hidden'); showMenu(); };
// flight manual on demand — corner button or ? key; auto-pauses the sim while open
G._manualPaused = false;
G.openManual = () => {
  if (G.state === 'flying') { togglePause(); G._manualPaused = true; }
  $('controls').classList.remove('hidden');
  $('pause').classList.add('hidden');          // manual reads above the PAUSED card
};
G.closeManual = () => {
  $('controls').classList.add('hidden');
  if (G._manualPaused && G.state === 'paused') togglePause();
  G._manualPaused = false;
  if (G.state === 'paused') $('pause').classList.remove('hidden');
};
$('controls-back').onclick = () => G.closeManual();
$('manual-btn').addEventListener('mousedown', (e) => e.stopPropagation());  // don't fire the gun
$('manual-btn').addEventListener('click', (e) => { e.stopPropagation(); G.openManual(); });
// mouse / trackpad stick: click the screen to capture the cursor (pointer lock),
// then relative movement flies the jet — the Amiga way, and playable on a trackpad
$('gl').addEventListener('click', () => {
  if (G.input.mouseStick && G.state === 'flying' && !document.pointerLockElement) $('gl').requestPointerLock();
});
$('controls').addEventListener('click', (e) => { if (e.target.id === 'controls') G.closeManual(); });
$('pause-resume').onclick = () => togglePause();
$('pause-restart').onclick = () => { $('pause').classList.add('hidden'); launchMission(G.missionDef); };
$('pause-quit').onclick = () => { $('pause').classList.add('hidden'); showMenu(); };

// ---------------- mission lifecycle ----------------
function launchMission(def, opts = {}) {
  G.missionDef = def;
  // safety net: the F-16 never goes to the boat, whatever path got us here
  if (G.player.type === 'f16') {
    const carrierStart = def.id === 'free' ? G.freeFlightStart === 'carrier' : def.id !== 'm1';
    if (carrierStart) G.player.type = 'f18';
  }
  $('menu').classList.add('hidden');
  $('briefing').classList.add('hidden');
  $('debrief').classList.add('hidden');
  $('pause').classList.add('hidden');
  stopDemo();
  // clear entities
  if (G.chute) { G.chute.dispose(); G.chute = null; }
  G._chuteCamSnap = false;
  G.audio.endChute();
  for (const b of G.bandits) b.dispose();
  G.bandits = [];
  for (const m of G.missiles) m._die();
  G.missiles = [];
  G.time = 0; G.score = 0; G.kills = 0; G.gunHits = 0; G.shotsFired = 0;
  G.messages = []; G.playerTarget = null; G.lockLevel = 0; G.waypoint = null;
  G.trappedThisSortie = false; G.landedThisSortie = false; G.over = false;
  G.missileWarning = false; G.podDropRequested = false;
  G.crashHandled = false;                        // arm the crash handler again
  G.fx.clearDebris();
  G.world.enemySub.group.visible = false;   // m6 spawns its own destructible sub entity
  G.world.setTimeOfDay(def.time || 'day');
  G.mission = Object.assign({}, def);
  G.mission.setup(G);
  // day/night selection from the plane-select screen (overrides the authored time)
  if (G.dayNightSel === 'day') G.world.setTimeOfDay('day');
  else if (G.dayNightSel === 'night') G.world.setTimeOfDay('night');
  // weather selection from the menu (missions are authored clear)
  G.world.setWeather(G.weatherSel === 'mission' ? 'clear' : G.weatherSel);
  scriptT = 0; runScript._gear = false;
  G.msg(def.title, 'info');
  G.audio.ensure();
  if (opts.zoom) {
    G.intro.zoomToAircraft(() => { G.view = 'cockpit'; G.state = 'flying'; snapCamera(); showQuickstart(); });
  } else {
    G.state = 'flying';
    snapCamera();
    showQuickstart();
  }
}

// ---------------- quick-start card ----------------
// the handful of keys that get a new pilot airborne; shows at every launch
// until they tick "don't show again"
let qsTimer = 0;
function showQuickstart() {
  if (localStorage.getItem('hb-qs-hide') === '1') return;
  const touch = document.documentElement.classList.contains('touch');
  $('qs-grid').innerHTML = touch
    ? `<div><b>THR +</b></div><div>hold &mdash; throttle to full</div>
       <div><b>BRK</b></div><div>brakes off</div>
       <div><b>STICK BACK</b></div><div>pull at 150 KT &mdash; you&#39;re flying</div>
       <div><b>GEAR</b></div><div>gear up when climbing</div>
       <div><b>? MANUAL</b></div><div>top-right &mdash; the full flight manual</div>`
    : `<div><b>W</b></div><div>hold &mdash; throttle to full (S slows down)</div>
       <div><b>B</b></div><div>brakes off</div>
       <div><b>&darr;</b></div><div>pull back at 150 KT &mdash; you&#39;re flying</div>
       <div><b>G</b></div><div>gear up when climbing</div>
       <div><b>Y</b></div><div>mouse / trackpad stick &mdash; then click the screen to capture the cursor</div>
       <div><b>?</b></div><div>the full flight manual</div>`;
  const cb = $('qs-never-cb');
  cb.checked = false;
  cb.onchange = () => localStorage.setItem('hb-qs-hide', cb.checked ? '1' : '0');
  $('quickstart').classList.remove('hidden');
  qsTimer = 14;
}
function hideQuickstart() { $('quickstart').classList.add('hidden'); qsTimer = 0; }
$('quickstart').addEventListener('click', (e) => {
  if (e.target.closest('.qs-never')) return;   // ticking the checkbox doesn't close
  hideQuickstart();
});

G.spawnAI = (type, opts) => {
  const a = new AIAircraft(scene, G.world, type, opts);
  a.label = opts.label || opts.name || type;
  G.bandits.push(a);
  return a;
};
G.setPlayerStart = (cfg) => {
  cfg.plane = G.player.type;
  G.player.reset(cfg);
};
G.explode = (pos, scale = 1) => {
  G.fx.explosion(pos, scale);
  G.audio.explosion(camera.position.distanceTo(pos));
  flash(0.35 * scale);
};
G.fireEnemyMissile = (owner, target) => {
  const type = Math.random() < 0.5 ? 'r27' : 'r73';
  G.missiles.push(new Missile(G, owner, type, target));
  G.audio.enemyMissile();
  if (target === G.player) G.msg('!! MISSILE LAUNCH — BREAK !!', 'bad');
};
G.onAircraftDown = (unit, byPlayer) => {
  if (unit === G.player) return;
  if (unit.kind === 'bandit' || unit.kind === 'stolen') {
    if (byPlayer) {
      G.kills++; save.kills++; persist();
      G.addScore(1000);
      G.msg(`SPLASH! ${unit.label} DOWN  +1000`, 'good');
      G.audio.kill();
    } else {
      G.msg(`${unit.label} DESTROYED`, 'info');
    }
  }
  if (unit.type === 'cruise') { G.msg('CRUISE MISSILE DESTROYED', 'good'); }
  if (unit.type === 'sub') { G.msg('SHADOW SUB DESTROYED!', 'good'); }
};
G.onPlayerHit = (dmg, byWhom) => {
  if (G.player.dead || G.player.ejected) return;
  G.player.damage += dmg;
  G.audio.explosion(50);
  flash(0.5);
  if (G.player.damage >= 100) {
    G.player.dead = true;
    G.msg('FIRE! YOU\'RE GOING DOWN — EJECT (SHIFT+E)!', 'bad');
    G.audio.fail();
  } else {
    G.msg(`HIT! DAMAGE ${Math.round(G.player.damage)}%`, 'warn');
  }
};
G.onCrashed = (reason) => {
  if (G.player.dead && G.crashHandled) return;
  if (G.crashHandled) return;
  G.crashHandled = true;
  G.player.dead = true;
  G.explode(G.player.pos, 1.4);
  G.fx.shatter(G.player.pos, G.player.vel, 1.3);   // the jet breaks apart on impact
  G.player.model.visible = false;
  if (G.state === 'flying') {
    G.state = 'dead'; G.deadT = 0; G.crashReason = reason;
  }
};
G.onEmptyPlaneDown = () => { G.explode(G.player.pos, 1.2); G.fx.shatter(G.player.pos, G.player.vel, 1.1); G.player.model.visible = false; };
G.onTrapped = () => {
  G.trappedThisSortie = true;
  G.addScore(500);
  G.msg('TRAPPED! +500 — DECK CREW: REARMING', 'good');
  G.audio.trap();
  // rearm & refuel
  const P = G.player;
  P.fuel = P.cfg.fuel; P.stores.aim9 = 2; P.stores.aim120 = 4; P.stores.gun = 500;
  P.stores.chaff = 14; P.stores.flares = 14; P.damage = Math.min(P.damage, 20);
};
// sonic boom: crossing Mach 1 shakes the world and cracks the air
G.onMachCross = (supersonic) => {
  const P = G.player;
  G.shakeT = Math.max(G.shakeT, 1.4);
  G.audio.sonicBoom();
  if (supersonic) G.msg('MACH 1', 'info');
  // vapor cone puffs shedding off the airframe
  for (let i = 0; i < 10; i++) {
    const p = P.pos.clone().addScaledVector(P.fwd, 2 - i * 1.8);
    p.y += (Math.random() - 0.5) * 1.5;
    G.fx.smoke(p, 0.55, 1.3, 0xf4f8ff);
  }
  G.fx.flash(P.pos.clone(), 12, 0xffffff, 0.14);
};
G.completeMission = (title, text) => {
  if (G.over) return;
  G.over = true;
  const id = G.missionDef.id;
  if (id === 'qual') { save.qualified = true; }
  else if (id !== 'free') { save.done[id] = true; }
  save.best = Math.max(save.best, G.score);
  persist();
  setTimeout(() => {
    if (G.state === 'menu') return;   // player bailed to the menu first
    $('debrief-title').textContent = title;
    $('debrief-title').className = 'good';
    $('debrief-body').textContent = text + `\n\nFINAL SCORE: ${G.score} · KILLS: ${G.kills}`;
    $('debrief').classList.remove('hidden');
    G.state = 'debrief';
  }, 2500);
  G.msg('MISSION COMPLETE', 'good');
  G.audio.kill();
};
G.failMission = (title, text) => {
  if (G.over) return;
  G.over = true;
  save.best = Math.max(save.best, G.score); persist();
  setTimeout(() => {
    if (G.state === 'menu') return;   // player bailed to the menu first
    $('debrief-title').textContent = title;
    $('debrief-title').className = 'bad';
    $('debrief-body').textContent = text + `\n\nSCORE: ${G.score}`;
    $('debrief').classList.remove('hidden');
    G.state = 'debrief';
  }, 2200);
  G.msg('MISSION FAILED', 'bad');
  G.audio.fail();
};

function snapCamera() {
  const P = G.player;
  const f = P.fwd.clone();
  camPos.copy(P.pos).addScaledVector(f, -30).add(new THREE.Vector3(0, 8, 0));
  camUp.set(0, 1, 0);
}

function flash(op) {
  const f = $('flash');
  f.style.opacity = Math.min(op, 0.8);
  setTimeout(() => f.style.opacity = 0, 120);
}

// ---------------- demo flight behind menu ----------------
let demoJet = null;
let attract = false;   // DEMO menu item: full-screen attract loop, any key returns
function startDemo(attractMode) {
  if (!demoJet) {
    demoJet = new AIAircraft(scene, G.world, 'f18', {
      pos: new THREE.Vector3(-24000, 700, 12000), heading: Math.PI / 2, speed: 210,
      mode: 'route', loop: true, agility: 1.4, name: 'DEMO',
      waypoints: [
        new THREE.Vector3(-3000, 220, 600), new THREE.Vector3(0, 42, 0),      // under the Golden Gate!
        new THREE.Vector3(5000, 300, 4000), new THREE.Vector3(9800, 260, 100), // Alcatraz
        new THREE.Vector3(13000, 900, 16000), new THREE.Vector3(4000, 1600, 9000),
        new THREE.Vector3(-16000, 900, 6000), new THREE.Vector3(-28000, 500, 10000),
      ],
    });
    demoJet.targetSpeed = 210;
  }
  if (attractMode && !attract) {
    attract = true;
    $('menu').classList.add('hidden');
    $('attract-hint').classList.remove('hidden');
    const bail = () => {
      window.removeEventListener('keydown', bail, true);
      window.removeEventListener('mousedown', bail, true);
      window.removeEventListener('touchstart', bail, true);
      attract = false;
      $('attract-hint').classList.add('hidden');
      if (G.state === 'menu') showMenu();
    };
    window.addEventListener('keydown', bail, true);
    window.addEventListener('mousedown', bail, true);
    window.addEventListener('touchstart', bail, true);
  }
}
function stopDemo() {
  if (demoJet) { demoJet.dispose(); demoJet = null; }
}

// ---------------- pause ----------------
function togglePause() {
  if (G.state === 'flying') { G.state = 'paused'; $('pause').classList.remove('hidden'); }
  else if (G.state === 'paused') { G.state = 'flying'; $('pause').classList.add('hidden'); }
}
// Q — bail straight back to the main menu from flying / paused / dead
function quitToMenu() {
  G._manualPaused = false;
  $('controls').classList.add('hidden');
  $('pause').classList.add('hidden');
  showMenu();
}

// ---------------- cameras ----------------
const camPos = new THREE.Vector3(-24000, 900, 14000);
const camUp = new THREE.Vector3(0, 1, 0);

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _fwd = new THREE.Vector3();
// plane models fly nose = local +Z, but a three.js camera looks down its
// local -Z — rotate the cockpit cam 180° about Y so it faces the nose
const _qy180 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

function updateCamera(dt) {
  if (G.intro.active) return; // intro drives the camera in map/briefing/zoom states
  if (G.state === 'gallery') return;   // the gallery drives the camera
  const P = G.player;
  if (G.state === 'menu' && demoJet) {
    // cinematic chase of the demo jet
    const f = demoJet.fwd(_fwd);
    _v.copy(demoJet.pos).addScaledVector(f, -46).add(_v2.set(0, 12, 0));
    camPos.x = damp(camPos.x, _v.x, 2.2, dt);
    camPos.y = damp(camPos.y, Math.max(_v.y, 8), 2.2, dt);
    camPos.z = damp(camPos.z, _v.z, 2.2, dt);
    camera.position.copy(camPos);
    camera.up.set(0, 1, 0);
    camera.lookAt(_v2.copy(demoJet.pos).addScaledVector(f, 30));
    camera.fov = damp(camera.fov, 58, 2, dt); camera.updateProjectionMatrix();
    return;
  }
  if (!P) return;
  // ejected: a slow orbit around the pilot floating down under the canopy
  if (G.chute) {
    if (P.model) P.model.visible = true;   // watch the empty jet fall away
    const c = G.chute.group.position;
    const a = G.time * 0.1;
    _v.set(c.x - 26 * Math.cos(a), c.y + 6, c.z - 26 * Math.sin(a));
    if (!G._chuteCamSnap) { camPos.copy(_v); G._chuteCamSnap = true; }  // cut to the chute cam
    else {
      camPos.x = damp(camPos.x, _v.x, 3.0, dt);
      camPos.y = damp(camPos.y, Math.max(_v.y, 4), 3.0, dt);
      camPos.z = damp(camPos.z, _v.z, 3.0, dt);
    }
    camera.position.copy(camPos);
    camera.up.set(0, 1, 0);
    camera.lookAt(c.x, c.y + 2, c.z);
    camera.fov = damp(camera.fov, 55, 2, dt); camera.updateProjectionMatrix();
    return;
  }
  // own jet must not block the cockpit view
  if (P.model) P.model.visible = G.view !== 'cockpit';
  if (G.view === 'chase') {
    const f = P.fwd.clone();
    const dist = window.__camdist > 0 ? window.__camdist : 24 + P.speed * 0.03;
    _v.copy(P.pos).addScaledVector(f, -dist).add(_v2.set(0, 7 + P.speed * 0.004, 0));
    const k = P.onGround ? 8 : 4.5;
    camPos.x = damp(camPos.x, _v.x, k, dt);
    camPos.y = damp(camPos.y, Math.max(_v.y, 2.5), k, dt);
    camPos.z = damp(camPos.z, _v.z, k, dt);
    camera.position.copy(camPos);
    // up vector follows bank gently
    const up = _v2.set(0, 1, 0).applyQuaternion(P.quat);
    camUp.x = damp(camUp.x, up.x * 0.55, 3, dt);
    camUp.y = damp(camUp.y, Math.max(up.y, 0.25), 3, dt);
    camUp.z = damp(camUp.z, up.z * 0.55, 3, dt);
    camera.up.copy(camUp).normalize();
    camera.lookAt(_v2.copy(P.pos).addScaledVector(f, 60));
    camera.fov = damp(camera.fov, (55 + P.speed * 0.045) / G.xmag, 3, dt);
    camera.updateProjectionMatrix();
  } else if (G.view === 'cockpit') {
    const f = P.fwd.clone();
    camera.position.copy(P.pos).addScaledVector(f, 1.6).add(_v.set(0, 1.55, 0).applyQuaternion(P.quat));
    camera.quaternion.copy(P.quat).multiply(_qy180); // face the nose, not the tail
    camera.fov = damp(camera.fov, 68 / G.xmag, 4, dt); camera.updateProjectionMatrix();
  } else if (G.view === 'tower') {
    // watch the jet from the nearest control tower cab (runways or the carrier island)
    let best = null, bestD = Infinity;
    for (const tv of G.world.towerViews || []) {
      const d = tv.pos.distanceToSquared(P.pos);
      if (d < bestD) { bestD = d; best = tv; }
    }
    G.world.carrierTowerPos(_v2);
    let name = best ? best.name : 'TOWER';
    if (_v2.distanceToSquared(P.pos) < bestD) { _v.copy(_v2); name = 'ENTERPRISE TOWER'; }
    else if (best) _v.copy(best.pos);
    G.towerName = name;
    camera.position.copy(_v);
    camera.up.set(0, 1, 0);
    camera.lookAt(P.pos);
    camera.fov = damp(camera.fov, 55 / G.xmag, 5, dt); camera.updateProjectionMatrix();
  } else { // orbit — original keypad POV: yaw/pitch/distance
    const orb = G.orbit;
    if (!orb.manual) orb.yaw += dt * 0.35;
    const cp = Math.cos(orb.pitch);
    _v.set(
      P.pos.x + Math.sin(orb.yaw) * cp * orb.dist,
      Math.max(P.pos.y + Math.sin(orb.pitch) * orb.dist, 2.5),
      P.pos.z + Math.cos(orb.yaw) * cp * orb.dist);
    camera.position.copy(_v);
    camera.up.set(0, 1, 0);
    camera.lookAt(P.pos);
    camera.fov = damp(camera.fov, 45 / G.xmag, 3, dt); camera.updateProjectionMatrix();
  }
  // camera shake (sonic boom, heavy damage, hard knocks)
  if (G.shakeT > 0.01) {
    const mag = G.shakeT * (G.view === 'cockpit' ? 0.22 : 0.5);
    camera.position.x += (Math.random() - 0.5) * mag;
    camera.position.y += (Math.random() - 0.5) * mag;
    camera.position.z += (Math.random() - 0.5) * mag;
  }
}

// ---------------- targeting & weapons ----------------
function updateTargeting(dt) {
  const P = G.player;
  // build target list
  const targets = G.bandits.filter(b => !b.dead && !b.removeMe && (b.kind === 'bandit' || b.kind === 'stolen'));
  if (G.playerTarget && (G.playerTarget.dead || G.playerTarget.removeMe)) { G.playerTarget = null; G.lockLevel = 0; }
  if (G.input.pressed('KeyT')) {
    if (!targets.length) { G.playerTarget = null; }
    else {
      const idx = targets.indexOf(G.playerTarget);
      G.playerTarget = targets[(idx + 1) % targets.length];
      G.lockLevel = 0;
      G.audio.radioClick();
    }
  }
  if (!G.playerTarget && targets.length === 1) G.playerTarget = targets[0];
  // lock
  const wpn = P.weapon;
  let canLock = false, rngMax = 0;
  if (G.playerTarget && wpn !== 'gun') {
    const t = G.playerTarget;
    const dist = P.pos.distanceTo(t.pos);
    _v.copy(t.pos).sub(P.pos).normalize();
    const ang = P.fwd.angleTo(_v);
    if (wpn === 'aim9') { rngMax = 8500; canLock = dist > 400 && dist < rngMax && ang < 0.6; }
    else { rngMax = 30000; canLock = dist > 900 && dist < rngMax && ang < 0.9; }
  }
  if (canLock) G.lockLevel = Math.min(1, G.lockLevel + dt / 1.1);
  else G.lockLevel = Math.max(0, G.lockLevel - dt * 1.6);
  G.locked = G.lockLevel >= 1;
  G.audio.setLock(canLock ? G.lockLevel : 0, G.locked);
  // fire missile — lock or no lock, on the deck or in the air; with no
  // lock the round just motors straight ahead like the original's did
  if ((G.input.pressed('Space') || G.input.pressed('Enter')) && G.state === 'flying' && !P.dead && !P.ejected) {
    if (wpn === 'gun') { /* gun fires continuously while SPACE/ENTER is held — handled below */ }
    else if (wpn === 'aim9' || wpn === 'aim120') {
      if (P.stores[wpn] <= 0) G.msg(wpn === 'aim9' ? 'NO SIDEWINDERS LEFT' : 'NO AMRAAMS LEFT', 'warn');
      else {
        P.stores[wpn]--;
        const tgt = (G.locked && G.playerTarget) ? G.playerTarget : null;
        G.missiles.push(new Missile(G, P, wpn, tgt));
        G.audio.missileFire();
        G.shotsFired++;
        G.msg(wpn === 'aim9' ? 'FOX 2!' : 'FOX 3!', 'good');
        P._syncVisual(0, {});
      }
    }
  }
  // gun trigger — the Vulcan doesn't ask for a lock either; mouse button or
  // holding SPACE or ENTER with the gun selected all work
  const wantGatling = (G.input.trigger || G.input.down('Space') || G.input.down('Enter')) && P.weapon === 'gun' && G.state === 'flying' && !P.dead && !P.ejected && P.stores.gun > 0;
  if (wantGatling) {
    gun.fire(dt, P, G.bandits);
    if (G.shotsFired === 0) G.shotsFired = 1;
  }
  G.audio.setGatling(wantGatling);
}

// ---------------- radar contacts ----------------
function updateRadarContacts() {
  const c = G.radarContacts;
  c.length = 0;
  for (const b of G.bandits) {
    if (b.dead || b.removeMe) continue;
    c.push({ pos: b.pos, kind: b.kind || 'bandit', identified: b.identified });
  }
  c.push({ pos: G.world.carrier.pos, kind: 'carrier' });
  for (const m of G.missiles) if (!m.dead && m.target === G.player) c.push({ pos: m.pos, kind: 'missile' });
}

// ---------------- per-frame input handling ----------------
function handleDiscreteInput(dt) {
  const I = G.input, P = G.player;
  // N toggles the live map — works from the cockpit and the pause card
  if (I.pressed('KeyN') && (G.state === 'flying' || G.state === 'paused')) {
    G.msg(G.mapview.toggle() ? 'MAP ON' : 'MAP OFF', 'info');
  }
  if (G.state !== 'flying') {
    G.audio.setGatling(false);   // cut the burst on pause/death/quit
    if (I.pressed('Slash')) { $('controls').classList.contains('hidden') ? G.openManual() : G.closeManual(); }
    else if ((I.pressed('Escape') || I.pressed('KeyP')) && G.state === 'paused') {
      if (!$('controls').classList.contains('hidden')) G.closeManual();   // ESC closes the manual first
      else togglePause();
    }
    else if (I.pressed('KeyQ') && (G.state === 'paused' || G.state === 'dead')) quitToMenu();
    return;
  }
  if (I.pressed('KeyQ')) { quitToMenu(); return; }
  if (I.pressed('Escape')) {
    // original behavior: ESC re-positions on the catapult during qual / free flight
    if ((G.missionDef.id === 'qual' || G.missionDef.id === 'free') && !I.ab) {
      const id = G.missionDef.id, s = G.freeFlightStart;
      if (id === 'qual' || s === 'carrier' || !s) G.setPlayerStart({ onCarrier: true });
      else if (s === 'sfo') G.setPlayerStart({ runway: G.world.runwayById('sfo') });
      else if (s === 'oakland') G.setPlayerStart({ runway: G.world.runwayById('oakland') });
      else if (s === 'moffett') G.setPlayerStart({ runway: G.world.runwayById('moffett') });
      else if (s === 'alameda') G.setPlayerStart({ runway: G.world.runwayById('alameda') });
      G.msg('RE-POSITIONED', 'info');
      return;
    }
    togglePause(); return;
  }
  if (I.pressed('KeyP') && !I.ab) { togglePause(); return; }
  if (I.pressed('KeyP') && I.ab) G.podDropRequested = true;
  // weapon select moved here when ENTER became a fire key: TAB cycles,
  // 1/2/3 jump straight to a weapon; the callout says what's live
  const selW = (w) => { if (P.weapon !== w) { P.weapon = w; G.lockLevel = 0; G.audio.weaponSelect(P.weapon); } };
  if (I.pressed('Tab')) { const order = ['aim120', 'aim9', 'gun']; selW(order[(order.indexOf(P.weapon) + 1) % order.length]); }
  if (I.pressed('Digit1')) selW('aim120');
  if (I.pressed('Digit2')) selW('aim9');
  if (I.pressed('Digit3')) selW('gun');
  if (I.pressed('KeyR')) {
    const ranges = [[2, 2 * NM], [10, 10 * NM], [40, 40 * NM]];
    const i = ranges.findIndex(r => r[0] === G.radarRangeNM);
    const [nm, m] = ranges[(i + 1) % 3];
    G.radarRangeNM = nm; G.radarRange = m;
  }
  // original key set: G gear, H hook, B brake, Shift+E eject
  if (I.pressed('KeyG') || I.pressed('KeyL')) { P.gearDown = !P.gearDown; G.audio.gear(); if (P.gearDown && P.speedKts > 300) G.msg('GEAR OVERSPEED!', 'warn'); }
  if (I.pressed('KeyH') || I.pressed('KeyA')) {
    if (P.type === 'f16') G.msg('THE F-16 HAS NO TAILHOOK', 'warn');
    else { P.hookDown = !P.hookDown; G.audio.hook(); }
  }
  if (I.pressed('KeyB')) { P.brakes = !P.brakes; }
  if (I.pressed('KeyY')) G.msg(I.mouseStick ? 'MOUSE STICK — CLICK THE SCREEN TO CAPTURE THE CURSOR, ESC RELEASES' : 'MOUSE STICK OFF', 'info');
  if (I.pressed('KeyM')) { P.ecm = !P.ecm; G.msg(P.ecm ? 'ECM ON — THEY SEE YOU TOO' : 'ECM OFF', 'info'); }
  if (I.pressed('KeyC') && P.stores.chaff > 0) { P.stores.chaff--; P.chaffT = G.time; G.audio.chaff(); for (let i = 0; i < 8; i++) G.fx.smoke(P.pos, 0.8, 3, 0xaaaaaa); }
  if (I.pressed('KeyF') && P.stores.flares > 0) { P.stores.flares--; P.flareT = G.time; G.audio.chaff(); for (let i = 0; i < 6; i++) G.fx.fire(_v.copy(P.pos).addScaledVector(P.vel, -0.03 * i), 0.6, 4); }
  if (I.pressed('KeyV')) {
    const order = ['cockpit', 'chase', 'orbit', 'tower'];
    G.view = order[(order.indexOf(G.view) + 1) % order.length];
  }
  // view magnification (the original's XMAG) — works in every view
  const XSTEPS = [1, 1.5, 2, 3, 4, 6, 8];
  if (I.pressed('Equal') || I.pressed('Minus')) {
    const i = XSTEPS.findIndex(x => x >= G.xmag - 0.01);
    G.xmag = XSTEPS[clamp(i + (I.pressed('Equal') ? 1 : -1), 0, XSTEPS.length - 1)];
    G.msg(`${G.xmag.toFixed(1)} XMAG`, 'info');
  }

  if (I.pressed('Slash')) { $('controls').classList.contains('hidden') ? G.openManual() : G.closeManual(); }
  // original: F10 twice at max throttle lights the burner
  if (I.pressed('F10') && P.throttle >= 0.99 && !P.abLatch) {
    P.abLatch = true; G.msg('AFTERBURNER', 'warn'); G.audio.radioClick();
  }
  // smoke trail (the original's training aid — S is throttle-down here, so D it is)
  if (I.pressed('KeyD')) { G.smokeTrail = !G.smokeTrail; G.msg(G.smokeTrail ? 'SMOKE TRAIL ON' : 'SMOKE TRAIL OFF', 'info'); }
  // original: keypad changes point of view / distance
  const povKeys = ['Numpad0', 'Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad6', 'Numpad7', 'Numpad8', 'Numpad9', 'NumpadAdd', 'NumpadSubtract'];
  if (povKeys.some(k => I.pressed(k))) G.view = 'orbit';
  // eject is Shift+E — plain E is safe to fat-finger; works parked on the
  // deck too — the seat catapult still throws the pilot clear of the jet
  if (I.pressed('KeyE') && (I.down('ShiftLeft') || I.down('ShiftRight')) && !P.ejected && G.state === 'flying') {
    P.ejected = true; P.dead = false;
    P.stores.gun = 0;
    const cv = P.vel.clone();
    let deckY;
    if (P.onGround) {
      P._parkedEject = true;                     // the empty jet stays where it sits
      const og = P.onGround;
      if (og.type === 'carrier') {
        cv.copy(G.world.carrier.deckVelWorld(new THREE.Vector3()));
        cv.addScaledVector(_v.set(Math.sin(P.heading), 0, -Math.cos(P.heading)), og.speedRel);
        P._deckRide = P.deckLocal.clone();       // and keeps riding the ship
        deckY = P.pos.y - 2.2;
      } else {
        cv.set(Math.sin(P.heading) * og.speedRel, 0, -Math.cos(P.heading) * og.speedRel);
      }
      cv.y += 26;                                // seat charge lob
    }
    G.chute = new Chute(scene, P.pos, cv, deckY);   // the pilot floats down under a canopy
    G.audio.eject();                            // engine cuts to the sound of rushing air
    G.msg('EJECTED! THE JET IS GONE.', 'warn');
    if (G.missionDef.id === 'free') {
      setTimeout(() => { if (G.state === 'flying' || G.state === 'dead') { launchMission(G.missionDef); } }, 8000);
    } else {
      G.state = 'dead'; G.deadT = 0; G.crashReason = 'EJECTED OVER HOSTILE WATERS';
    }
  }
  if (I.throttleSet >= 0) P.throttle = I.throttleSet === 0 ? 1 : I.throttleSet;
  // original: keypad steers the external point of view (held keys move smoothly)
  if (G.view === 'orbit') {
    const orb = G.orbit;
    if (I.down('Numpad4')) { orb.yaw -= 1.6 * dt; orb.manual = true; }
    if (I.down('Numpad6')) { orb.yaw += 1.6 * dt; orb.manual = true; }
    if (I.down('Numpad8')) { orb.pitch = clamp(orb.pitch + 1.1 * dt, -0.05, 1.35); orb.manual = true; }
    if (I.down('Numpad2')) { orb.pitch = clamp(orb.pitch - 1.1 * dt, -0.05, 1.35); orb.manual = true; }
    if (I.down('NumpadAdd') || I.down('Numpad9')) { orb.dist = Math.max(18, orb.dist - 45 * dt); orb.manual = true; }
    if (I.down('NumpadSubtract') || I.down('Numpad3')) { orb.dist = Math.min(240, orb.dist + 45 * dt); orb.manual = true; }
  }
  // original training aid: continuous white smoke trail
  if (G.smokeTrail && !P.onGround && !P.dead) {
    G._smokeT = (G._smokeT || 0) - dt;
    if (G._smokeT <= 0) {
      G._smokeT = 0.05;
      for (const sgn of [-1, 1]) {
        _v.set(sgn * 4.3, 0.25, -1.2).applyQuaternion(P.quat).add(P.pos);
        G.fx.smoke(_v, 2.2, 1.6, 0xf0f0f0);
      }
    }
  }
}

// ---------------- scripted input (headless testing / attract mode) ----------------
let SCRIPT = null, scriptT = 0;
function runScript(dt) {
  scriptT += dt;
  const I = G.input, P = G.player;
  const _right = new THREE.Vector3(1, 0, 0).applyQuaternion(P.quat);
  const _upY = new THREE.Vector3(0, 1, 0).applyQuaternion(P.quat).y;
  const bankNow = Math.atan2(-_right.y, _upY);
  const rollTo = (desBank) => clamp((desBank - bankNow) * 1.6, -0.55, 0.55);
  if (SCRIPT === 'takeoff') {
    if (scriptT < 0.5) return;
    I.keys.add('KeyW');                       // full power
    if (scriptT > 1.0 && P.brakes) I.justPressed.add('KeyB');
    if (scriptT > 1.2) I.keys.add('ShiftLeft'); // burner
    if (P.onGround && P.onGround.speedRel > 70) I.pitch = 0.85; // rotate
    if (!P.onGround) {
      I.keys.delete('ShiftLeft');
      const gamma = Math.asin(clamp(P.vel.y / Math.max(P.speed, 1), -1, 1));
      I.pitch = clamp((0.17 - gamma) * 3.5, -0.4, 0.8);  // hold ~10 deg climb
      if (P.gearDown && P.pos.y > 40 && !runScript._gear) { runScript._gear = true; I.justPressed.add('KeyL'); }
      if (scriptT > 30) I.roll = rollTo(0.5);  // gentle turn back
    }
  } else if (SCRIPT === 'combat') {
    if (P.onGround) { // do the takeoff first
      if (scriptT < 0.5) return;
      I.keys.add('KeyW');
      if (scriptT > 1.0 && P.brakes) I.justPressed.add('KeyB');
      if (scriptT > 1.2) I.keys.add('ShiftLeft');
      if (P.onGround && P.onGround.speedRel > 70) I.pitch = 0.85;
      return;
    }
    const gamma = Math.asin(clamp(P.vel.y / Math.max(P.speed, 1), -1, 1));
    if (!G.playerTarget && !runScript._sel) { runScript._sel = true; I.justPressed.add('KeyT'); }
    const t = G.playerTarget;
    if (t && !t.dead) {
      // lead pursuit: aim ahead of the target so the geometry collapses
      // instead of trailing a maneuvering bandit forever
      const aim = t.pos.clone().addScaledVector(t.vel, clamp(t.pos.distanceTo(P.pos) / 300, 0, 8));
      const d = aim.sub(P.pos);
      const dist = d.length(); d.normalize();
      const f = P.fwd;
      const desiredH = Math.atan2(d.x, -d.z), curH = Math.atan2(f.x, -f.z);
      const dh = wrapAngle(desiredH - curH);
      // energy management: this flight model turns fastest near corner speed
      // (~130-160 m/s), so slow down to fight, burn to close distance
      const cornering = Math.abs(dh) > 0.7;
      if (cornering) {
        I.keys.delete('ShiftLeft'); I.keys.add('KeyS');
        if ((P.speed > 165) !== P.brakes) I.justPressed.add('KeyB');
      } else {
        I.keys.add('KeyW');
        if (P.brakes) I.justPressed.add('KeyB');
        if (dist > 4000 || P.speed < 160) I.keys.add('ShiftLeft'); else I.keys.delete('ShiftLeft');
      }
      // when the target is off the nose, pull UNCONDITIONALLY — any gamma
      // trim applied here creates a feedback equilibrium that parks the turn
      I.roll = rollTo(clamp(dh * 1.5, -0.75, 0.75));
      let pi;
      if (cornering) {
        pi = 0.55;
        if (gamma > 0.7) pi = 0.2;        // bound the loop, keep turning
        else if (gamma < -0.7) pi = 0.35;
      } else {
        const gammaDes = clamp(Math.asin(clamp(d.y, -1, 1)), -0.4, 0.3);
        pi = clamp(dh * 0.9, -0.4, 0.4) + clamp((gammaDes - gamma) * 0.8, -0.15, 0.15);
        if (gamma > 0.35) pi -= (gamma - 0.35) * 2.0;
        if (gamma < -0.6) pi = Math.max(pi, 0.25);
      }
      if (P.pos.y < 350 && gamma < 0) pi = 0.5;       // ground floor
      if (P.speed < 120) pi = clamp(pi, -0.2, 0.15);  // stall guard
      I.pitch = clamp(pi, -0.7, 0.7);
      if (G.locked && scriptT > 4) { I.justPressed.add('Space'); scriptT = 3.0; }
    } else {
      I.pitch = clamp((0.05 - gamma) * 3.5, -0.5, 0.5);
      I.roll = rollTo(0);
      I.keys.add('KeyW'); I.keys.delete('ShiftLeft');
      runScript._sel = false;
    }
  }
}

// ---------------- main loop ----------------
const clock = new THREE.Clock();
let acc = 0;

let FIXDT = 0;
function frame() {
  requestAnimationFrame(frame);
  const rawDt = FIXDT > 0 ? FIXDT : Math.min(clock.getDelta(), 0.05);
  const dt = G.state === 'paused' ? 0 : rawDt;

  if (FIXDT > 0 && !window.__warped) {
    // headless warp handled at boot; nothing here
  }
  stepGame(dt);
  updateCamera(dt);
  renderer.render(scene, camera);
  G.input.postUpdate();
  if (qsTimer > 0) {
    qsTimer -= rawDt;
    if (qsTimer <= 0 || G.state !== 'flying') hideQuickstart();
  }
  if (window.__probeFrames !== undefined && --window.__probeFrames <= 0) {
    delete window.__probeFrames;
    const rc = new THREE.Raycaster(), hits = [];
    for (const ny of [-0.2, -0.4, -0.6]) {
      rc.setFromCamera(new THREE.Vector2(0, ny), camera);
      hits.push({ ny, list: rc.intersectObjects(scene.children, true).slice(0, 3).map(h2 => ({ d: Math.round(h2.distance), y: Math.round(h2.point.y), t: h2.object.geometry ? h2.object.geometry.type : h2.object.type, col: h2.object.material && h2.object.material.color ? h2.object.material.color.getHexString() : null })) });
    }
    // depth-buffer capture: render with a depth-override material, read back
    // and decode true fragment depths at probe pixels
    let depth = null;
    try {
      const W2 = 320, H2 = 180;
      const rt = new THREE.WebGLRenderTarget(W2, H2);
      const prev = scene.overrideMaterial;
      scene.overrideMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      renderer.setRenderTarget(rt); renderer.render(scene, camera);
      const buf = new Uint8Array(W2 * H2 * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, W2, H2, buf);
      renderer.setRenderTarget(null); scene.overrideMaterial = prev; rt.dispose();
      const n = camera.near, f = camera.far;
      depth = [];
      for (const [fx, fy] of [[0.5, 0.30], [0.5, 0.46], [0.5, 0.52], [0.5, 0.60], [0.5, 0.68], [0.2, 0.60], [0.8, 0.60]]) {
        const px = Math.floor(fx * W2), py = Math.floor((1 - fy) * H2), i = (py * W2 + px) * 4;
        const r = buf[i] / 255, g = buf[i + 1] / 255, b2 = buf[i + 2] / 255, a = buf[i + 3] / 255;
        const z01 = r + g / 255 + b2 / 65025 + a / 16581375;
        const zndc = 2 * z01 - 1;
        const dist = (2 * n * f) / (f + n - zndc * (f - n));
        depth.push({ at: [fx, fy], z01: Math.round(z01 * 10000) / 10000, m: Math.round(dist) });
      }
    } catch (e) { depth = String(e); }
    const objs = [];
    scene.traverse(o => {
      if (!o.isMesh && !o.isSprite) return;
      const m = o.material || {};
      objs.push({ n: o.name || '', t: o.geometry ? o.geometry.type : o.type, vis: o.visible, ro: o.renderOrder,
        p: o.getWorldPosition(new THREE.Vector3()).toArray().map(v => Math.round(v)),
        s: o.scale.toArray().map(v => Math.round(v * 100) / 100),
        col: m.color ? m.color.getHexString() : null, op: m.opacity, tr: !!m.transparent, dw: m.depthWrite !== false, dt: m.depthTest !== false,
        fog: m.fog !== false, vc: !!m.vertexColors, side: m.side, po: m.polygonOffset || false });
    });
    // live material uniform state for the ocean (the actual uploaded fog values)
    let oceanU = null;
    try {
      const wm = G.world.waterMat;
      const props = renderer.properties.get(wm);
      oceanU = { fog: wm.fog, color: wm.color.getHexString(),
        fogNear: props.uniforms && props.uniforms.fogNear ? props.uniforms.fogNear.value : null,
        fogFar: props.uniforms && props.uniforms.fogFar ? props.uniforms.fogFar.value : null,
        fogColor: props.uniforms && props.uniforms.fogColor ? props.uniforms.fogColor.value : null,
        version: wm.version, hasProgram: !!props.currentProgram };
    } catch (e) { oceanU = String(e); }
    const d = document.createElement('div'); d.id = 'probe'; d.style.display = 'none';
    d.textContent = JSON.stringify({ cam: { pos: camera.position.toArray().map(v => Math.round(v)), near: camera.near, far: camera.far }, fog: { c: scene.fog.color.getHexString(), n: scene.fog.near, f: scene.fog.far }, info: renderer.info.render, oceanU, depth, hits, objs });
    document.body.appendChild(d);
  }
  // the MANUAL button is only offered while flying (or paused), manual closed
  $('manual-btn').classList.toggle('hidden',
    !((G.state === 'flying' || G.state === 'paused') && $('controls').classList.contains('hidden')));
  if (FIXDT > 0) {
    const Pf = G.player.fwd;
    const hdg = Math.round(((Math.atan2(Pf.x, -Pf.z)) * 180 / Math.PI + 360) % 360);
    const rr = new THREE.Vector3(1, 0, 0).applyQuaternion(G.player.quat);
    const tgts = G.bandits.filter(b => !b.dead && (b.kind === 'bandit' || b.kind === 'stolen')).length;
    const _gm = Math.asin(clamp(G.player.vel.y / Math.max(G.player.speed, 1), -1, 1)) * 57.3;
    let _ly = 0, _lz = 0, _bk = 0, _tn = '-', _dy = 0, _ds = 0, _ty = 0;
    if (G.playerTarget) {
      const _dw = G.playerTarget.pos.clone().sub(G.player.pos);
      _ds = _dw.length(); _dy = _dw.y; _ty = G.playerTarget.pos.y;
      _tn = (G.playerTarget.label || G.playerTarget.name || '?').slice(0, 6);
      const _d = _dw.normalize().applyQuaternion(G.player.quat.clone().invert());
      _ly = _d.y; _lz = _d.z;
      const _r = new THREE.Vector3(1, 0, 0).applyQuaternion(G.player.quat);
      const _uy = new THREE.Vector3(0, 1, 0).applyQuaternion(G.player.quat).y;
      _bk = Math.atan2(-_r.y, _uy) * 57.3;
    }
    document.title = `T${G.time.toFixed(1)} SPD${Math.round(G.player.speedKts)} HDG${hdg} Y${Math.round(G.player.pos.y)} GM${_gm.toFixed(0)} PI${G.input.pitch.toFixed(2)} RI${G.input.roll.toFixed(2)} RR${G.player.rollRate.toFixed(2)} LY${_ly.toFixed(2)} LZ${_lz.toFixed(2)} BK${_bk.toFixed(0)} TG${_tn} DY${Math.round(_dy)} DS${Math.round(_ds)} TY${Math.round(_ty)} K${G.kills} L${G.lockLevel.toFixed(2)} ${G.state}`;
  }
}

function stepGame(dt) {
  G.input.poll();
  if (SCRIPT) runScript(dt);
  handleDiscreteInput(dt);
  hero.visible = (G.state === 'menu');

  if (G.state === 'menu' && demoJet) {
    G.time += dt;
    hero.rotation.y += dt * 0.45;   // the star's slow turntable
    heroLight.intensity = 60 * (G.world.night01 || 0);   // lit after dark
    demoJet.update(dt, G);
    G.world.update(dt, camera.position, G.player ? G.player.pos.y : camera.position.y);
    G.fx.update(dt);
  } else if (G.intro.active) {
    // satellite map / briefing / plane select / zoom intro states — suppress
    // the weather here so rain and murk never blot out the planning map
    G.time += dt;
    if (G.state === 'zoom' && G.player) {
      G.player.update(dt, G.input, G);
      for (const b of G.bandits) b.update(dt, G);
    }
    G.intro.update(dt);
    G.world.update(dt, camera.position, G.player ? G.player.pos.y : camera.position.y, null, true);
    G.fx.update(dt);
    hud.draw(G, dt);
  } else if (G.state === 'gallery') {
    G.time += dt;
    G.gallery.update(dt, G.input);
    G.world.update(dt, camera.position, camera.position.y);
    G.fx.update(dt);
    hud.draw(G, dt);
  } else if (G.state === 'flying' || G.state === 'dead') {
    G.time += dt;
    G.shakeT = Math.max(0, G.shakeT - dt * 1.3);
    const P = G.player;
    if (G.state === 'flying') {
      P.update(dt, G.input, G);
      P.groundH = groundHeight(P.pos.x, P.pos.z);
      // runway landing detection -> landed flag
      if (P.onGround && P.onGround.type === 'runway' && P.onGround.speedRel === 0 && !G.landedThisSortie) G.landedThisSortie = true;
      updateTargeting(dt);
      if (G.mission && G.mission.update && !G.over) G.mission.update(G, dt);
      // mission pod flag consumed by mission update
    } else {
      // dead: let the wreck fall
      if (P.dead && !G.crashHandled) P._updateDead(dt, G);
      else if (P.ejected) P._updateBallistic(dt, G);
      G.deadT += dt;
      if (G.deadT > (G.chute ? 9 : 3) && !G.over) {   // let the chute ride play out
        if (G.missionDef.id === 'free') launchMission(G.missionDef);
        else G.failMission('AIRCRAFT LOST', G.crashReason + '.\nThe Navy will bill your next of kin for one fighter jet.');
      }
    }
    // entities
    if (G.chute) G.chute.update(dt, G);
    for (let i = G.bandits.length - 1; i >= 0; i--) {
      const b = G.bandits[i];
      b.update(dt, G);
      if (b.removeMe) { b.dispose(); G.bandits.splice(i, 1); }
    }
    for (let i = G.missiles.length - 1; i >= 0; i--) {
      const m = G.missiles[i];
      m.update(dt);
      if (m.dead) G.missiles.splice(i, 1);
    }
    gun.update(dt);
    // missile warning
    G.missileWarning = G.missiles.some(m => !m.dead && m.target === G.player);
    G.audio.setMissileWarn(G.missileWarning);
    G.audio.setStall(P.stalled && G.state === 'flying');
    // effects: damage smoke, contrails
    if ((P.damage > 55 || P.dead) && !P.ejected && Math.random() < 0.5) G.fx.smoke(P.pos, 1.1, 2.4, 0x2c2c2c);
    if (!P.onGround && !P.dead && (P.gForce > 5.5 || (P.ab && P.pos.y > 5000))) {
      P.contrailT -= dt;
      if (P.contrailT <= 0) {
        P.contrailT = 0.05;
        const r = _v.set(1, 0, 0).applyQuaternion(P.quat);
        G.fx.trail(_v2.copy(P.pos).addScaledVector(r, 6), 1.1, 0xffffff, 1.2);
        G.fx.trail(_v2.copy(P.pos).addScaledVector(r, -6), 1.1, 0xffffff, 1.2);
      }
    }
    G.world.update(dt, camera.position, G.player ? G.player.pos.y : camera.position.y, G.player ? G.player.vel : null);
    G.fx.update(dt);
    updateRadarContacts();
    // audio — once the pilot is out, the jet's engine stays silent for good
    G.audio.updateFlight(P.ejected ? 0 : P.throttle, !P.ejected && P.ab, P.ejected ? 0 : P.speed);
    hud.draw(G, dt);
  } else if (G.state === 'paused') {
    hud.draw(G, 0);
  }
  syncNavLights(dt);
  if (G.world.carrier && G.world.carrier.ols) G.world.carrier.updateOLS(dt, G.player);
}

// navigation lights come on at night on every aircraft in the world — red and
// green position lights burn steady, the white tail strobe double-flashes and
// the red anti-collision beacon blinks, like the real jets
let navT = 0;
function syncNavLights(dt) {
  navT += dt;
  const night = G.world.night01 > 0.5;
  const set = (sp) => {
    sp.visible = night;
    if (!night) return;
    const role = sp.userData.role, ph = sp.userData.phase || 0, base = sp.userData.base || 3;
    if (role === 'strobe') {           // aviation double-flash: two 50 ms pops per second
      const c = (navT + ph) % 1;
      sp.scale.setScalar((c < 0.05 || (c > 0.12 && c < 0.17)) ? base : 0.001);
    } else if (role === 'beacon') {    // slower red blink
      const c = (navT * 0.9 + ph) % 1;
      sp.scale.setScalar(c < 0.09 ? base : 0.001);
    } else {
      sp.scale.setScalar(base);
    }
  };
  for (const e of [G.player, ...G.bandits, demoJet]) {
    const nav = e && e.model && e.model.userData.nav;
    if (nav) for (const sp of nav) set(sp);
  }
  const gm = G.gallery && G.gallery.model;
  if (gm && gm.userData.nav) for (const sp of gm.userData.nav) set(sp);
}

// ---------------- URL params for direct launch (testing) ----------------
const params = new URLSearchParams(location.search);
FIXDT = parseFloat(params.get('fixdt') || '0');
SCRIPT = params.get('script');
if (params.get('night')) G.dayNightSel = 'night';   // test hook: force night
if (params.get('rain')) G.weatherSel = 'rain';      // test hook: force rain
if (params.get('clean')) G.cleanShot = true;        // test hook: HUD-free captures
if (params.get('day')) G.dayNightSel = 'day';
showMenu();
const auto = params.get('auto');
const viewP = params.get('view');
if (viewP) G.view = viewP;
// intro-flow test hooks: ?auto=menu | map | brief:<id> | planesel:<id> | zoom:<id>
if (auto === 'menu') { /* stay on menu */ }
else if (auto === 'demo') { startDemo(true); }   // attract mode
else if (auto === 'map') { startFreeFlightMap(); }
else if (auto === 'gallery') { $('menu').classList.add('hidden'); stopDemo(); G.gallery.enter(); }
else if (auto && auto.startsWith('brief:')) { startBriefing(auto.slice(6)); }
else if (auto && auto.startsWith('planesel:')) {
  const def = MISSIONS.find(m => m.id === auto.slice(9));
  pendingMission = def; $('menu').classList.add('hidden'); stopDemo(); G.intro.briefing(def, () => {});
  G.intro.typed = 1e9; G.intro.afterBrief = null; enterPlaneSelect(def);
}
else if (auto && auto.startsWith('zoom:')) {
  const def = MISSIONS.find(m => m.id === auto.slice(5));
  pendingMission = def; $('menu').classList.add('hidden'); stopDemo();
  // start the dive from the satellite-map camera, like the real menu flow
  G.camera.position.set(6000, 95000, 4000 + 95000 * 0.28);
  launchMission(def, { zoom: true });
}
else if (auto) {
  const plane = params.get('plane');
  if (plane) G.player.type = plane;
  const start = params.get('start');
  if (start) G.freeFlightStart = start;
  if (params.get('unlock') === '1') { save.qualified = true; save.done = { m1: true, m2: true, m3: true, m4: true, m5: true }; }
  launchMission(MISSIONS.find(m => m.id === auto) || MISSIONS[0]);
  const ppos = params.get('ppos');           // test teleport: ppos=x,z[,h]
  if (ppos) {
    const [px, pz, ph] = ppos.split(',').map(Number);
    G.setPlayerStart({ pos: new THREE.Vector3(px, ph || 800, pz), heading: params.get('phdg') ? Number(params.get('phdg')) * Math.PI / 180 : Math.PI / 2, speed: 180 });
  }
  const wpn0 = params.get('wpn');            // test hook: preselect weapon (aim120/aim9/gun)
  if (wpn0 && G.player && ['aim120', 'aim9', 'gun'].includes(wpn0)) G.player.weapon = wpn0;
  if (params.get('xray') === '1') {
    G.player.model.traverse(o => { if (o.material) { o.material = new THREE.MeshBasicMaterial({ color: 0xff0044 }); } });
    G.player.model.scale.setScalar(4);
  }
}
// shared headless warp: works for mission AND intro-flow states
if (params.get('hold') === '1') G.intro.hold = true;
const xm = params.get('xmag');
if (xm) G.xmag = parseFloat(xm);
const warpT = parseFloat(params.get('t') || '0');
if (auto && warpT > 0) {
  const step = 1 / 60;
  const burn = params.has('burn');   // test hook: firewalled throttle + rotate pitch during warp
  // test hook: hold keys (e.g. keys=ArrowRight@10 starts 10 s into the warp;
  // separate timed batches with ';', e.g. keys=KeyP@0.5;KeyQ@1.5)
  const holdKeys = params.get('keys');
  const keySegs = holdKeys ? holdKeys.split(';').map(seg => {
    const [kl, atd] = seg.split('@');
    const [at, dur] = (atd || '0').split('+');   // keys=K@2+0.5 holds K for 0.5 s then releases
    return { list: kl.split(','), at: parseFloat(at || '0'), dur: dur !== undefined ? parseFloat(dur) : Infinity };
  }) : [];
  const warpStartState = G.state;   // allow warps that START in the menu to run
  // rec=N: composite gl+hud to a 1280x720 jpeg every Nth warp step and POST the
  // batch to /rec-upload — deterministic 60/N fps footage for promo recording
  const recN = parseInt(params.get('rec') || '0');
  let recCtx = null, recBuf = [], recIdx = 0;
  const recPost = (batch) => {
    for (let a = 0; a < 4; a++) {
      try {
        const x = new XMLHttpRequest();
        x.open('POST', '/rec-upload', false);   // synchronous: in-order, retried, no loss
        x.setRequestHeader('Content-Type', 'application/json');
        x.send(JSON.stringify(batch));
        if (x.status === 200) return;
      } catch (e) { /* retry */ }
    }
  };
  for (let i = 0; i < warpT * 60; i++) {
    if (burn && G.player) {
      G.player.throttle = 1; G.player.abLatch = true; G.player.brakes = false;
    }
    for (const seg of keySegs) {
      const on = i * step >= seg.at && i * step < seg.at + seg.dur;
      for (const k of seg.list) {
        if (on) { if (!G.input.keys.has(k)) G.input.justPressed.add(k); G.input.keys.add(k); }
        else if (seg.dur !== Infinity) G.input.keys.delete(k);
      }
    }
    stepGame(step);
    G.input.postUpdate();   // mirror the real frame loop, or justPressed sticks
    if (recN > 0 && i % recN === 0) {
      updateCamera(step);
      renderer.render(scene, camera);
      if (!recCtx) { const c = document.createElement('canvas'); c.width = 1280; c.height = 720; recCtx = c.getContext('2d'); }
      recCtx.drawImage($('gl'), 0, 0, 1280, 720);
      recCtx.drawImage($('hud'), 0, 0, 1280, 720);
      recBuf.push({ i: recIdx++, d: recCtx.canvas.toDataURL('image/jpeg', 0.75) });
      if (recBuf.length >= 10) { recPost(recBuf); recBuf = []; }
    }
    if (G.state !== warpStartState && (G.state === 'debrief' || G.state === 'menu')) break;
  }
  if (recN > 0) { if (recBuf.length) recPost(recBuf); document.title = 'REC-DONE'; }
  window.__warped = true;
  if (G.state === 'flying') snapCamera();
  if (params.has('manual')) G.openManual();   // test hook: open the flight manual
  if (params.has('noocean') && G.world.oceanMesh) G.world.oceanMesh.visible = false;  // layer-isolation probe
  // layer-isolation probes: hide=sky|terrain|ocean (comma-separated), plus a
  // raycast dump of what geometry below-horizon rays actually hit
  for (const h of (params.get('hide') || '').split(',')) {
    if (h === 'sky' && G.world.skyMesh) G.world.skyMesh.visible = false;
    if (h === 'ocean' && G.world.oceanMesh) G.world.oceanMesh.visible = false;
    if (h === 'terrain') G.scene.traverse(o => { if (o.geometry && o.geometry.attributes.position && o.geometry.attributes.position.count > 200000) o.visible = false; });
    if (h === 'model' && G.player) G.player.model.visible = false;
    if (h === 'rwy') G.scene.traverse(o => { if (o.geometry && o.geometry.type === 'PlaneGeometry' && o.material && o.material.map) o.visible = false; });
    if (h === 'wcaps') G.scene.traverse(o => { if (o.isPoints) o.visible = false; });
    if (h === 'city') G.scene.traverse(o => { if (o.geometry && (o.geometry.type === 'BoxGeometry' || o.geometry.type === 'CylinderGeometry' || o.geometry.type === 'ConeGeometry') && o.getWorldPosition(new THREE.Vector3()).distanceTo(G.camera.position) > 100) o.visible = false; });
  }
  if (params.has('wfnofog') && G.world.waterMat) { G.world.waterMat.fog = false; G.world.waterMat.needsUpdate = true; }  // probe: defog the sea
  if (params.has('planesel')) G.intro.planeSelect();   // test: jump to the start-spot map view
  if (params.has('only')) {   // bisect: keep only terrain/ocean/sky/runways
    const keep = new Set();
    G.scene.traverse(o => {
      if (o === G.world.oceanMesh || o === G.world.skyMesh) keep.add(o);
      if (o.geometry && o.geometry.attributes.position && o.geometry.attributes.position.count > 200000) keep.add(o);
      if (o.geometry && o.geometry.type === 'PlaneGeometry' && o.material && o.material.map) keep.add(o);
    });
    G.scene.traverse(o => { if ((o.isMesh || o.isPoints || o.isSprite || o.isLine) && !keep.has(o)) o.visible = false; });
  }
  if (params.has('seay') && G.world.oceanMesh) G.world.oceanMesh.position.y = parseFloat(params.get('seay'));  // probe: move the sea
  if (params.has('nan') && G.scene) {   // probe: NaN audit of all vertex buffers
    let bad = 0, tot = 0;
    G.scene.traverse(o => {
      if (!o.geometry || !o.geometry.attributes.position) return;
      const a = o.geometry.attributes.position.array;
      for (let i = 0; i < a.length; i++) { tot++; if (!Number.isFinite(a[i])) bad++; }
    });
    const d = document.createElement('div'); d.id = 'nanprobe'; d.style.display = 'none';
    d.textContent = JSON.stringify({ bad, tot }); document.body.appendChild(d);
  }
  if (params.has('depthviz')) {   // probe: log-depth visualization override
    G.scene.overrideMaterial = new THREE.ShaderMaterial({
      vertexShader: 'varying float vZ; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vZ = -mv.z; gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'varying float vZ; void main(){ float d = clamp(log(max(vZ,1.5)/1.5)/log(320000.0/1.5), 0.0, 1.0); gl_FragColor = vec4(d, fract(d*6.0)*0.6, 1.0-d, 1.0); }'
    });
  }
  if (params.has('probe')) window.__probeFrames = 5;   // run after 5 real frames (matrices fresh)
  if (params.has('cnear')) { camera.near = parseFloat(params.get('cnear')); camera.updateProjectionMatrix(); }   // probe: near-plane sweep
  if (params.has('tlift')) {   // debug: lift the terrain mesh by N metres
    const lift = parseFloat(params.get('tlift'));
    G.scene.traverse(o => { if (o.geometry && o.geometry.attributes.position && o.geometry.attributes.position.count > 200000 && o.material.vertexColors) o.position.y = lift; });
  }
  if (params.has('tdye')) {   // debug: dye terrain verts within 6 km of the player red
    G.scene.traverse(o => {
      if (o.geometry && o.geometry.attributes.position && o.geometry.attributes.position.count > 200000) {
        const p = o.geometry.attributes.position, c = o.geometry.attributes.color;
        const px = G.player.pos.x, pz = G.player.pos.z;
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i) + 5000, z = p.getZ(i) + 8000;
          if (Math.hypot(x - px, z - pz) < 6000) c.setXYZ(i, 1, 0, 0);
        }
        c.needsUpdate = true;
      }
    });
  }
  const dye = params.get('dye');   // test hook: paint the Nth textured plane red
  if (dye !== null) {
    let di = 0;
    G.scene.traverse(o => {
      if (o.geometry && o.geometry.type === 'PlaneGeometry' && o.material && o.material.map) {
        if (String(di) === dye) { o.material = new THREE.MeshBasicMaterial({ color: 0xff0000, fog: false, side: THREE.DoubleSide }); o.material.needsUpdate = true; }
        di++;
      }
    });
    window.__dyeCount = di;
  }
  if (params.has('gh') && G.player) {         // test hook: terrain height probe around the player
    const P = G.player, gh = (dx, dz) => groundHeight(P.pos.x + dx, P.pos.z + dz).toFixed(1);
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;top:34px;left:8px;color:#0f0;font:18px monospace;z-index:99;text-shadow:1px 1px 0 #000';
    let grid = '';
    for (let dz = -1200; dz <= 1200; dz += 400) {
      const row = [];
      for (let dx = -1200; dx <= 1200; dx += 400) row.push(gh(dx, dz).padStart(6));
      grid += `z${dz >= 0 ? '+' : ''}${dz}:${row.join('')}\n`;
    }
    d.style.whiteSpace = 'pre';
    d.textContent = grid;
    document.body.appendChild(d);
  }
  if (params.has('dbgroll') && G.player) {   // numeric bank readout for sign tests
    const xr = new THREE.Vector3(1, 0, 0).applyQuaternion(G.player.quat);
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;top:8px;left:8px;color:#0f0;font:22px monospace;z-index:99;text-shadow:1px 1px 0 #000';
    d.textContent = `localX.y=${xr.y.toFixed(3)}  hdg=${G.player.headingDeg().toFixed(1)}  vel.y=${G.player.vel.y.toFixed(1)}`;
    document.body.appendChild(d);
  }
  // deterministic orbit camera for tests: oyaw/opitch in degrees, odist in m
  if (params.has('oyaw') || params.has('opitch') || params.has('odist')) {
    G.orbit.manual = true;
    if (params.has('oyaw')) G.orbit.yaw = parseFloat(params.get('oyaw')) * Math.PI / 180;
    if (params.has('opitch')) G.orbit.pitch = parseFloat(params.get('opitch')) * Math.PI / 180;
    if (params.has('odist')) G.orbit.dist = parseFloat(params.get('odist'));
    snapCamera();
  }
}
window.__camdist = parseFloat(params.get('camdist') || '0');
frame();
