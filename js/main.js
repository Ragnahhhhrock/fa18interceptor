// main.js — boot, game state machine, loop, cameras, targeting, menus
import * as THREE from 'three';
import { clamp, lerp, damp, KTS, FT, NM, wrapAngle, flightQuat, rand } from './util.js';
import { World, groundHeight } from './world.js';
import { Player, PLANES } from './flight.js';
import { AIAircraft } from './ai.js';
import { FXPool, Missile, GunSystem } from './weapons.js';
import { HUD } from './hud.js';
import { Input } from './input.js';
import { AudioEngine } from './audio.js';
import { MISSIONS } from './missions.js';

const $ = (id) => document.getElementById(id);

// ---------------- error overlay (helps debugging) ----------------
window.addEventListener('error', (e) => { $('errbox').textContent += `\n${e.message}`; });

// ---------------- renderer ----------------
const renderer = new THREE.WebGLRenderer({ canvas: $('gl'), antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 320000);
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
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
  waypoint: null, radarRange: 10 * NM, radarRangeNM: 10,
  mission: null, over: false, view: 'chase',
  trappedThisSortie: false, landedThisSortie: false,
  missileWarning: false, podDropRequested: false,
  freeFlightStart: 'carrier',
  msg(text, kind = 'info') { this.messages.unshift({ text, kind, t: this.time }); if (this.messages.length > 6) this.messages.pop(); },
  radio(text) { this.msg(text, 'radio'); this.audio.radioClick(); },
  addScore(n) { this.score += n; },
};
window.G = G; // debug hook

G.audio = new AudioEngine();
G.input = new Input();
const hud = new HUD($('hud'));
G.hud = hud;

// world is heavy — build lazily on first load but before menu demo
G.world = new World(scene);
G.fx = new FXPool(scene);
G.player = new Player(scene, G.world);
G.player.isPlayer = true;
const gun = new GunSystem(G);

// ---------------- persistence ----------------
const SAVE_KEY = 'fa18-interceptor-v1';
let save = { qualified: false, done: {}, best: 0, kills: 0 };
try { Object.assign(save, JSON.parse(localStorage.getItem(SAVE_KEY) || '{}')); } catch (e) {}
function persist() { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); }

// ---------------- menu ----------------
function buildMenu() {
  const list = $('menu-list');
  list.innerHTML = '';
  const addBtn = (label, tag, cb, disabled = false) => {
    const b = document.createElement('button');
    b.className = 'mbtn';
    b.innerHTML = `${label}${tag ? `<span class="tag">${tag}</span>` : ''}`;
    b.disabled = disabled;
    if (cb) b.onclick = () => { G.audio.ensure(); cb(); };
    list.appendChild(b);
  };
  addBtn('QUALIFICATION — CARRIER OPS', save.qualified ? 'QUALIFIED' : 'REQUIRED', () => startBriefing('qual'));
  const order = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
  order.forEach((id, i) => {
    const def = MISSIONS.find(m => m.id === id);
    const prevDone = i === 0 || save.done[order[i - 1]];
    const unlocked = save.qualified && prevDone;
    const tag = save.done[id] ? 'COMPLETE' : (unlocked ? '' : (save.qualified ? 'LOCKED' : 'NEED QUAL'));
    addBtn(`MISSION ${i + 1} — ${def.title}`, tag, unlocked ? () => startBriefing(id) : null, !unlocked);
  });
  addBtn('FREE FLIGHT — FROM CARRIER', '', () => { G.freeFlightStart = 'carrier'; startBriefing('free'); });
  addBtn('FREE FLIGHT — FROM SFO', '', () => { G.freeFlightStart = 'sfo'; startBriefing('free'); });
  addBtn('FREE FLIGHT — AIRBORNE', '', () => { G.freeFlightStart = 'air'; startBriefing('free'); });
  addBtn('FLIGHT MANUAL / CONTROLS', '', () => { $('controls').classList.remove('hidden'); });
  $('pilot-record').textContent =
    `PILOT LOG — MISSIONS FLOWN: ${Object.keys(save.done).length} · KILLS: ${save.kills} · BEST SCORE: ${save.best}`;
}

function showMenu() {
  G.state = 'menu';
  $('menu').classList.remove('hidden');
  $('briefing').classList.add('hidden');
  $('debrief').classList.add('hidden');
  $('pause').classList.add('hidden');
  buildMenu();
  startDemo();
}

// ---------------- briefing / debrief ----------------
let pendingMission = null;
function startBriefing(id) {
  const def = MISSIONS.find(m => m.id === id);
  pendingMission = def;
  G.state = 'briefing';
  $('menu').classList.add('hidden');
  $('briefing').classList.remove('hidden');
  $('brief-code').textContent = def.code;
  $('brief-title').textContent = (def.num < 90 ? (def.num === 0 ? 'QUALIFICATION' : `MISSION ${def.num}`) : 'FREE FLIGHT') + ' — ' + def.title;
  $('brief-body').textContent = def.briefing;
  $('brief-loadout').textContent = 'LOADOUT — ' + def.loadout + '\nAIRFRAME — ' + (G.player.type === 'f16' ? 'F-16 FALCON' : 'F/A-18 HORNET') + '  [PRESS F TO SWITCH]';
}
$('brief-fly').onclick = () => { $('briefing').classList.add('hidden'); launchMission(pendingMission); };
$('brief-back').onclick = () => { $('briefing').classList.add('hidden'); showMenu(); };
$('debrief-menu').onclick = () => { $('debrief').classList.add('hidden'); showMenu(); };
$('debrief-next').onclick = () => { $('debrief').classList.add('hidden'); showMenu(); };
$('controls-back').onclick = () => $('controls').classList.add('hidden');
$('pause-resume').onclick = () => togglePause();
$('pause-restart').onclick = () => { $('pause').classList.add('hidden'); launchMission(G.missionDef); };
$('pause-quit').onclick = () => { $('pause').classList.add('hidden'); showMenu(); };

// plane switch on briefing (F key)
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyF' && G.state === 'briefing') {
    G.player.type = G.player.type === 'f18' ? 'f16' : 'f18';
    $('brief-loadout').textContent = 'LOADOUT — ' + pendingMission.loadout + '\nAIRFRAME — ' + (G.player.type === 'f16' ? 'F-16 FALCON' : 'F/A-18 HORNET') + '  [PRESS F TO SWITCH]';
  }
});

// ---------------- mission lifecycle ----------------
function launchMission(def) {
  G.missionDef = def;
  $('menu').classList.add('hidden');
  $('briefing').classList.add('hidden');
  $('debrief').classList.add('hidden');
  $('pause').classList.add('hidden');
  stopDemo();
  // clear entities
  for (const b of G.bandits) b.dispose();
  G.bandits = [];
  for (const m of G.missiles) m._die();
  G.missiles = [];
  G.time = 0; G.score = 0; G.kills = 0; G.gunHits = 0; G.shotsFired = 0;
  G.messages = []; G.playerTarget = null; G.lockLevel = 0; G.waypoint = null;
  G.trappedThisSortie = false; G.landedThisSortie = false; G.over = false;
  G.missileWarning = false; G.podDropRequested = false;
  G.world.enemySub.group.visible = def.id === 'm6';
  G.world.setTimeOfDay(def.time || 'day');
  G.mission = Object.assign({}, def);
  G.mission.setup(G);
  G.state = 'flying';
  scriptT = 0; runScript._gear = false;
  snapCamera();
  G.msg(def.title, 'info');
  G.audio.ensure();
}

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
};
G.onPlayerHit = (dmg, byWhom) => {
  if (G.player.dead || G.player.ejected) return;
  G.player.damage += dmg;
  G.audio.explosion(50);
  flash(0.5);
  if (G.player.damage >= 100) {
    G.player.dead = true;
    G.msg('FIRE! YOU\'RE GOING DOWN — EJECT (X)!', 'bad');
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
  G.player.model.visible = false;
  if (G.state === 'flying') {
    G.state = 'dead'; G.deadT = 0; G.crashReason = reason;
  }
};
G.onEmptyPlaneDown = () => { G.explode(G.player.pos, 1.2); G.player.model.visible = false; };
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
G.completeMission = (title, text) => {
  if (G.over) return;
  G.over = true;
  const id = G.missionDef.id;
  if (id === 'qual') { save.qualified = true; }
  else if (id !== 'free') { save.done[id] = true; }
  save.best = Math.max(save.best, G.score);
  persist();
  setTimeout(() => {
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
function startDemo() {
  if (demoJet) return;
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
function stopDemo() {
  if (demoJet) { demoJet.dispose(); demoJet = null; }
}

// ---------------- pause ----------------
function togglePause() {
  if (G.state === 'flying') { G.state = 'paused'; $('pause').classList.remove('hidden'); }
  else if (G.state === 'paused') { G.state = 'flying'; $('pause').classList.add('hidden'); }
}

// ---------------- cameras ----------------
const camPos = new THREE.Vector3(-24000, 900, 14000);
const camUp = new THREE.Vector3(0, 1, 0);
let orbitA = 0;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _fwd = new THREE.Vector3();

function updateCamera(dt) {
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
    camera.fov = damp(camera.fov, 55 + P.speed * 0.045, 3, dt);
    camera.updateProjectionMatrix();
  } else if (G.view === 'cockpit') {
    const f = P.fwd.clone();
    camera.position.copy(P.pos).addScaledVector(f, 1.6).add(_v.set(0, 1.55, 0).applyQuaternion(P.quat));
    camera.quaternion.copy(P.quat);
    camera.fov = damp(camera.fov, 68, 4, dt); camera.updateProjectionMatrix();
  } else { // orbit
    orbitA += dt * 0.35;
    _v.set(P.pos.x + Math.sin(orbitA) * 55, P.pos.y + 14, P.pos.z + Math.cos(orbitA) * 55);
    camera.position.copy(_v);
    camera.up.set(0, 1, 0);
    camera.lookAt(P.pos);
    camera.fov = damp(camera.fov, 45, 3, dt); camera.updateProjectionMatrix();
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
  // fire missile
  if (G.input.pressed('Space') && G.state === 'flying' && !P.onGround && !P.dead) {
    if (wpn === 'gun') { /* gun uses trigger */ }
    else if (wpn === 'aim9' || wpn === 'aim120') {
      if (P.stores[wpn] <= 0) G.msg(wpn === 'aim9' ? 'NO SIDEWINDERS LEFT' : 'NO AMRAAMS LEFT', 'warn');
      else if (!G.locked || !G.playerTarget) G.msg('NO LOCK', 'warn');
      else {
        P.stores[wpn]--;
        G.missiles.push(new Missile(G, P, wpn, G.playerTarget));
        G.audio.missileFire();
        G.shotsFired++;
        G.msg(wpn === 'aim9' ? 'FOX 2!' : 'FOX 3!', 'good');
        P._syncVisual(0, {});
      }
    }
  }
  // gun trigger
  if (G.input.trigger && P.weapon === 'gun' && G.state === 'flying' && !P.onGround && !P.dead) {
    gun.fire(dt, P, G.bandits);
    if (G.shotsFired === 0) G.shotsFired = 1;
  }
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
  if (G.missionDef && G.missionDef.id === 'm6' && !G.world.enemySub.submerged) c.push({ pos: G.world.enemySub.pos, kind: 'sub' });
  for (const m of G.missiles) if (!m.dead && m.target === G.player) c.push({ pos: m.pos, kind: 'missile' });
}

// ---------------- per-frame input handling ----------------
function handleDiscreteInput() {
  const I = G.input, P = G.player;
  if (G.state !== 'flying') {
    if (I.pressed('Escape') || I.pressed('KeyP')) { if (G.state === 'paused') togglePause(); }
    return;
  }
  if (I.pressed('Escape') || (I.pressed('KeyP') && !I.ab)) { togglePause(); return; }
  if (I.pressed('KeyP') && I.ab) G.podDropRequested = true;
  if (I.pressed('Enter')) {
    const order = ['aim120', 'aim9', 'gun'];
    P.weapon = order[(order.indexOf(P.weapon) + 1) % order.length];
    G.lockLevel = 0;
    G.audio.radioClick();
  }
  if (I.pressed('KeyR')) {
    const ranges = [[2, 2 * NM], [10, 10 * NM], [40, 40 * NM]];
    const i = ranges.findIndex(r => r[0] === G.radarRangeNM);
    const [nm, m] = ranges[(i + 1) % 3];
    G.radarRangeNM = nm; G.radarRange = m;
  }
  if (I.pressed('KeyL')) { P.gearDown = !P.gearDown; G.audio.gear(); if (P.gearDown && P.speedKts > 300) G.msg('GEAR OVERSPEED!', 'warn'); }
  if (I.pressed('KeyA')) { P.hookDown = !P.hookDown; G.audio.hook(); }
  if (I.pressed('KeyB')) { P.brakes = !P.brakes; }
  if (I.pressed('KeyE')) { P.ecm = !P.ecm; G.msg(P.ecm ? 'ECM ON — THEY SEE YOU TOO' : 'ECM OFF', 'info'); }
  if (I.pressed('KeyC') && P.stores.chaff > 0) { P.stores.chaff--; P.chaffT = G.time; G.audio.chaff(); for (let i = 0; i < 8; i++) G.fx.smoke(P.pos, 0.8, 3, 0xaaaaaa); }
  if (I.pressed('KeyF') && P.stores.flares > 0) { P.stores.flares--; P.flareT = G.time; G.audio.chaff(); for (let i = 0; i < 6; i++) G.fx.fire(_v.copy(P.pos).addScaledVector(P.vel, -0.03 * i), 0.6, 4); }
  if (I.pressed('KeyV')) { G.view = G.view === 'chase' ? 'cockpit' : G.view === 'cockpit' ? 'orbit' : 'chase'; }
  if (I.pressed('KeyN')) { G.audio.setMusicOn(!G.audio.musicOn); G.msg(G.audio.musicOn ? 'MUSIC ON' : 'MUSIC OFF', 'info'); }
  if (I.pressed('KeyH')) $('controls').classList.toggle('hidden');
  if (I.pressed('KeyX') && !P.onGround && !P.ejected && G.state === 'flying') {
    P.ejected = true; P.dead = false;
    P.stores.gun = 0;
    G.msg('EJECTED! THE JET IS GONE.', 'warn');
    if (G.missionDef.id === 'free') {
      setTimeout(() => { if (G.state === 'flying' || G.state === 'dead') { launchMission(G.missionDef); } }, 2600);
    } else {
      G.state = 'dead'; G.deadT = 0; G.crashReason = 'EJECTED OVER HOSTILE WATERS';
    }
  }
  if (I.throttleSet >= 0) P.throttle = I.throttleSet === 0 ? 1 : I.throttleSet;
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
  handleDiscreteInput();

  if (G.state === 'menu' && demoJet) {
    G.time += dt;
    demoJet.update(dt, G);
    G.world.update(dt, camera.position);
    G.fx.update(dt);
  } else if (G.state === 'flying' || G.state === 'dead') {
    G.time += dt;
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
      if (G.deadT > 3 && !G.over) {
        if (G.missionDef.id === 'free') launchMission(G.missionDef);
        else G.failMission('AIRCRAFT LOST', G.crashReason + '.\nThe Navy will bill your next of kin for one fighter jet.');
      }
    }
    // entities
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
    G.world.update(dt, camera.position);
    G.fx.update(dt);
    updateRadarContacts();
    // audio
    G.audio.updateFlight(P.throttle, P.ab, P.speed);
    hud.draw(G, dt);
  } else if (G.state === 'paused') {
    hud.draw(G, 0);
  }
}

// ---------------- URL params for direct launch (testing) ----------------
const params = new URLSearchParams(location.search);
FIXDT = parseFloat(params.get('fixdt') || '0');
SCRIPT = params.get('script');
showMenu();
const auto = params.get('auto');
const viewP = params.get('view');
if (viewP) G.view = viewP;
if (auto) {
  const plane = params.get('plane');
  if (plane) G.player.type = plane;
  const start = params.get('start');
  if (start) G.freeFlightStart = start;
  if (params.get('unlock') === '1') { save.qualified = true; save.done = { m1: true, m2: true, m3: true, m4: true, m5: true }; }
  launchMission(MISSIONS.find(m => m.id === auto) || MISSIONS[0]);
  const warpT = parseFloat(params.get('t') || '0');
  if (warpT > 0) {
    const step = 1 / 60;
    for (let i = 0; i < warpT * 60; i++) {
      stepGame(step);
      if (G.state === 'debrief' || G.state === 'menu') break;
    }
    window.__warped = true;
    snapCamera();
  }
  if (params.get('xray') === '1') {
    G.player.model.traverse(o => { if (o.material) { o.material = new THREE.MeshBasicMaterial({ color: 0xff0044 }); } });
    G.player.model.scale.setScalar(4);
  }
}
window.__camdist = parseFloat(params.get('camdist') || '0');
frame();
