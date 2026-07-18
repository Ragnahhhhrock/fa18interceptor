// missions.js — qualification, six missions, free flight (authentic to the 1988 original)
import * as THREE from 'three';
import { rand, clamp } from './util.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// helpers
function near(a, b, r) { return a.distanceTo(b) < r; }

// ============================================================
export const MISSIONS = [
// ------------------------------------------------ QUALIFICATION
{
  id: 'qual', num: 0, title: 'CARRIER QUALIFICATION', code: 'TRAINING COMMAND',
  time: 'day', planeChoice: true,
  briefing:
`Welcome to the squadron. Before you fly active duty you must
qualify on the boat.

1. Launch from USS ENTERPRISE (full power + afterburner,
   rotate at 150 KTS).
2. Fly the pattern: pass each WHITE DIAMOND checkpoint.
3. Return and TRAP on the deck — gear (L), hook (A),
   30-40% throttle, ~140 KTS, aim for the wires.

Do this cleanly and you go on the mission board.`,
  loadout: 'UNARMED TRAINING LOAD — CHAFF/FLARES ONLY',
  setup(G) {
    G.setPlayerStart({ onCarrier: true });
    this.gates = [
      V(-22000, 400, 10000), V(-8000, 600, 6000), V(0, 500, 0), V(-16000, 400, 9000),
    ];
    this.gate = 0; this.phase = 0;
    G.waypoint = this.gates[0];
    G.radio('ENTERPRISE TOWER: WIND IS DOWN THE DECK. CLEARED TO LAUNCH, VIPER 1-1.');
  },
  update(G, dt) {
    if (this.phase === 0 && !G.player.onGround) { this.phase = 1; G.radio('TOWER: GOOD LAUNCH. FLY THE PATTERN.'); }
    if (this.gate < this.gates.length) {
      const g = this.gates[this.gate];
      if (near(G.player.pos, g, 1200)) {
        this.gate++;
        G.audio.kill();
        if (this.gate < this.gates.length) { G.waypoint = this.gates[this.gate]; G.msg(`CHECKPOINT ${this.gate}/${this.gates.length}`, 'good'); }
        else { G.waypoint = G.world.carrier.pos.clone().add(V(0, 40, 0)); G.msg('ALL GATES — RETURN AND TRAP', 'good'); G.radio('TOWER: PATTERN COMPLETE. CLEARED TO LAND.'); }
      }
    } else if (G.trappedThisSortie) {
      G.completeMission('QUALIFIED!', `Carrier qualification complete.\n\nYou are cleared for active duty, pilot.\n\nSCORE +2000 (QUAL + TRAP)`);
      G.addScore(2000);
    }
  },
},
// ------------------------------------------------ M1 VISUAL CONFIRMATION
{
  id: 'm1', num: 1, title: 'VISUAL CONFIRMATION', code: 'SEPT 1, 1994 — 0630 HRS',
  time: 'morning', planeChoice: true,
  briefing:
`Two unidentified bogeys have entered the defense zone,
heading for San Francisco at 20,000 FT.

Scramble from the Enterprise, intercept, and close to
VISUAL RANGE (under 0.5 NM) to identify each contact.

RULES OF ENGAGEMENT: DO NOT FIRE UNLESS FIRED UPON.
If they are hostile and engage you — weapons free.

Return to the boat when the sky is sorted.`,
  loadout: '2× AIM-9 SIDEWINDER · 4× AIM-120 AMRAAM · 500× 20MM',
  setup(G) {
    G.setPlayerStart({ onCarrier: true });
    const hostile = Math.random() < 0.65;
    this.hostile = hostile;
    this.bogeys = [];
    const type = hostile ? 'mig29' : 'b707';
    for (let i = 0; i < 2; i++) {
      const b = G.spawnAI(type, {
        pos: V(-58000 - i * 3000, 6100 + i * 300, 18000 + i * 2500),
        heading: Math.PI / 2, speed: hostile ? 240 : 220, hp: 100,
        hostile: false, name: hostile ? 'MIG-29' : 'BOEING 707', label: 'BOGEY',
        mode: hostile ? 'route' : 'land', noEvade: !hostile, identified: false,
        waypoints: hostile ? [V(7000, 6100, 5000), V(60000, 6100, -5000)] :
          [V(2000, 1500, 20000), V(9000, 300, 20000), V(11300, 6, 20000)],
      });
      b.identified = false; b.kind = 'bandit'; b.firedFirst = false;
      this.bogeys.push(b);
    }
    this.idCount = 0; this.weaponsFree = false; this.phase = 0; this.timer = 0;
    G.waypoint = this.bogeys[0].pos;
    G.radio('NORAD: VIPER 1-1, SCRAMBLE! TWO BOGEYS INBOUND FROM THE WEST.');
  },
  update(G, dt) {
    this.timer += dt;
    // waypoint to nearest unidentified bogey
    let next = this.bogeys.find(b => !b.dead && !b.identified);
    G.waypoint = next ? next.pos : null;
    for (const b of this.bogeys) {
      if (!b.dead && !b.identified && near(G.player.pos, b.pos, 900)) {
        b.identified = true; b.label = b.name;
        this.idCount++;
        G.audio.radioClick();
        if (b.type === 'mig29') { G.msg('VISUAL ID: MIG-29 FULCRUM — HOSTILE!', 'bad'); G.radio('VIPER: TALLY HO! MIG-29s! DO NOT ENGAGE UNLESS FIRED UPON.'); }
        else { G.msg('VISUAL ID: BOEING 707 — FRIENDLY', 'good'); G.radio('NORAD: CONFIRMED FRIENDLY. STAND DOWN, VIPER 1-1.'); }
      }
    }
    // rules of engagement
    if (!this.weaponsFree && this.hostile) {
      for (const b of this.bogeys) {
        if (b.dead && !b.firedFirst) { G.failMission('COURT MARTIAL', 'You fired before being fired upon.\nThe rules of engagement were explicit.'); return; }
      }
      if (this.idCount >= 2 && this.timer > 0) {
        this.timer = -0.01; this.phase = 1;
      }
      if (this.phase === 1 && this.timer > 12) {
        this.weaponsFree = true;
        for (const b of this.bogeys) {
          if (b.dead) continue;
          b.mode = 'attack'; b.target = G.player; b.hostile = true; b.noEvade = false; b.firedFirst = true; b.skill = 0.9; b.targetSpeed = 280;
        }
        G.msg('THEY\'RE FIRING! WEAPONS FREE!', 'bad');
        G.radio('NORAD: WEAPONS FREE! SPLASH THE MIGS!');
      }
    }
    // friendly case: just RTB
    if (!this.hostile && this.idCount >= 2) {
      if (!this.rtbCalled) { this.rtbCalled = true; G.radio('NORAD: GOOD EYES. RETURN TO THE ENTERPRISE.'); G.waypoint = G.world.carrier.pos; }
      if (G.trappedThisSortie || G.landedThisSortie) {
        G.addScore(1500);
        G.completeMission('MISSION COMPLETE', 'Both bogeys identified as friendly.\nFalse alarm — but you were ready.\n\nSCORE +1500');
      }
    }
    if (this.weaponsFree) {
      const allDown = this.bogeys.every(b => b.dead);
      if (allDown) {
        G.addScore(2000);
        G.completeMission('MISSION COMPLETE', 'Both MiG-29s splashed.\nSan Francisco sleeps safe tonight.\n\nSCORE +2000 + KILL BONUSES');
      }
    }
  },
},
// ------------------------------------------------ M2 AIR FORCE ONE
{
  id: 'm2', num: 2, title: 'EMERGENCY DEFENSE', code: 'SEPT 3, 1994 — 0915 HRS',
  time: 'day', planeChoice: true,
  briefing:
`AIR FORCE ONE is inbound to San Francisco International
with the President aboard. Its fighter escort has just been
bounced and destroyed by TWO MIG-29s.

Scramble immediately. Intercept and destroy the hostiles
before they reach the President's aircraft.

Air Force One must survive.`,
  loadout: '2× AIM-9 · 4× AIM-120 · 500× 20MM — HOT SCRAMBLE',
  setup(G) {
    G.setPlayerStart({ onCarrier: true });
    this.af1 = G.spawnAI('b747', {
      pos: V(-52000, 4200, 4000), heading: Math.PI / 2 + 0.35, speed: 220, hp: 750,
      name: 'AIR FORCE ONE', label: 'AF1', mode: 'land', noEvade: true,
      waypoints: [V(2000, 1500, 20000), V(9000, 300, 20000), V(11300, 6, 20000)],
    });
    this.af1.kind = 'af1';
    this.migs = [];
    for (let i = 0; i < 2; i++) {
      const m = G.spawnAI('mig29', {
        pos: V(-40000, 5000 + i * 800, -6000 + i * 6000), heading: Math.PI * 0.6, speed: 280,
        hostile: true, name: 'MIG-29', label: 'MIG-29', mode: 'attack', skill: 0.85, agility: 1.1,
      });
      m.target = this.af1; m.kind = 'bandit'; m.identified = true; m.fireCooldown = 12 + i * 8;
      this.migs.push(m);
    }
    this.warned = false;
    G.waypoint = this.migs[0].pos;
    G.radio('NORAD: VIPER 1-1, AIR FORCE ONE IS UNDER ATTACK! SCRAMBLE, SCRAMBLE, SCRAMBLE!');
  },
  update(G, dt) {
    G.waypoint = this.migs.find(m => !m.dead)?.pos || this.af1.pos;
    if (this.af1.dead) { G.failMission('THE PRESIDENT IS DOWN', 'Air Force One was destroyed.\nThis is the darkest day in the nation\'s history.'); return; }
    if (!this.warned && this.migs.some(m => m.dead)) { this.warned = true; G.radio('AIR FORCE ONE: WE SEE THE SPLASH! KEEP THEM OFF US!'); }
    if (this.migs.every(m => m.dead)) {
      G.addScore(2500);
      G.completeMission('MISSION COMPLETE', 'Both MiGs destroyed.\nAir Force One is on final approach to SFO.\nThe President sends his thanks.\n\nSCORE +2500 + KILL BONUSES');
    }
  },
},
// ------------------------------------------------ M3 STOLEN F-16S
{
  id: 'm3', num: 3, title: 'STOLEN AIRCRAFT', code: 'SEPT 6, 1994 — 1400 HRS',
  time: 'day', planeChoice: true,
  briefing:
`Two F-16s carrying SECRET ECM EQUIPMENT have been stolen
by defecting pilots. They are heading west over the Pacific
with two MiG-29s flying top cover.

Intercept and order them to turn back to Moffett Field.
Close to 0.7 NM to make the radio challenge.

If they refuse to turn — they must NOT reach enemy hands.
Weapons free on my mark.`,
  loadout: '2× AIM-9 · 4× AIM-120 · 500× 20MM',
  setup(G) {
    G.setPlayerStart({ onCarrier: true });
    this.f16s = []; this.migs = [];
    for (let i = 0; i < 2; i++) {
      const f = G.spawnAI('f16', {
        pos: V(26000 + i * 1500, 5200 + i * 400, 3000 + i * 1800), heading: -Math.PI / 2, speed: 265,
        hostile: false, name: 'STOLEN F-16', label: 'F-16 ?', mode: 'route', noEvade: true, skill: 1.1,
        waypoints: [V(-120000, 5200, -8000)],
      });
      f.kind = 'stolen'; f.contacted = false; f.refused = false;
      this.f16s.push(f);
    }
    for (let i = 0; i < 2; i++) {
      const m = G.spawnAI('mig29', {
        pos: V(22000, 8000 + i * 600, 6000 - i * 4000), heading: -Math.PI / 2, speed: 265,
        hostile: false, name: 'MIG-29', label: 'MIG-29', mode: 'route', skill: 1.05, agility: 1.15,
        waypoints: [V(-120000, 8000, -8000)], noEvade: true,
      });
      m.kind = 'bandit'; m.identified = true;
      this.migs.push(m);
    }
    this.contacted = 0; this.weaponsFree = false; this.escTimer = 120;
    G.waypoint = this.f16s[0].pos;
    G.radio('NORAD: STOP THOSE F-16s BEFORE THEY CLEAR THE COAST.');
  },
  update(G, dt) {
    for (const f of this.f16s) {
      if (f.dead || f.contacted) continue;
      if (near(G.player.pos, f.pos, 1300)) {
        f.contacted = true; this.contacted++;
        G.audio.radioClick();
        G.radio('VIPER: RENEGADE FLIGHT, TURN BACK TO MOFFETT IMMEDIATELY.');
        setTimeout(() => { if (!G.over) { G.radio('RENEGADE: NEGATIVE. WE\'RE NOT GOING BACK.'); G.msg('THEY REFUSE TO TURN', 'bad'); } }, 3500);
      }
      // escaped?
      if (f.pos.x < -85000) { G.failMission('THEY ESCAPED', 'The stolen F-16s reached enemy hands\nwith our secret ECM equipment.'); return; }
    }
    if (!this.weaponsFree && (this.contacted >= 2 || (this.contacted > 0 && this.f16s.some(f => f.pos.x < -60000)))) {
      this.weaponsFree = true;
      G.msg('WEAPONS FREE — DOWN THE F-16s!', 'bad');
      G.radio('NORAD: WEAPONS FREE. THEY MADE THEIR CHOICE.');
      for (const f of this.f16s) { f.noEvade = false; f.hostile = true; f.targetSpeed = 300; f.label = 'RENEGADE'; }
      for (const m of this.migs) { m.mode = 'attack'; m.target = G.player; m.hostile = true; m.noEvade = false; }
    }
    if (this.weaponsFree && this.f16s.every(f => f.dead)) {
      G.addScore(2500);
      G.completeMission('MISSION COMPLETE', 'The stolen F-16s are at the bottom of the Pacific.\nThe ECM secrets are safe.\n\nSCORE +2500 + KILL BONUSES');
    }
  },
},
// ------------------------------------------------ M4 SEARCH AND RESCUE
{
  id: 'm4', num: 4, title: 'SEARCH AND RESCUE', code: 'SEPT 9, 1994 — 1930 HRS',
  time: 'dusk', planeChoice: true,
  briefing:
`One of our F/A-18s was shot down this afternoon. The pilot
bailed out and is in a raft near the FARALLON ISLANDS,
30 miles west of the Golden Gate. Two MiG-29s patrol the area.

Fly low over the raft and drop a rescue pod:
below 1,500 FT, within 0.7 NM — press SHIFT+P.

You carry THREE pods. The pilot is marking his position
with orange smoke. Bring him home.`,
  loadout: '2× AIM-9 · 4× AIM-120 · 500× 20MM · 3× RESCUE PODS',
  setup(G) {
    G.setPlayerStart({ onCarrier: true });
    this.raftPos = V(-45800, 1, 3900);
    this.raft = G.spawnAI('raft', { pos: this.raftPos.clone(), speed: 0, name: 'PILOT RAFT', label: 'RAFT', mode: 'straight', noEvade: true, hp: 9999 });
    this.raft.kind = 'raft';
    this.raft.targetSpeed = 0; this.raft.speed = 0;
    this.migs = [];
    for (let i = 0; i < 2; i++) {
      const m = G.spawnAI('mig29', {
        pos: V(-46000 + i * 6000, 2200 + i * 900, 3900 - i * 5000), heading: rand(0, 6), speed: 230,
        hostile: false, name: 'MIG-29', label: 'MIG-29', mode: 'orbit', skill: 1.0, agility: 1.1,
      });
      m.orbitCenter = V(-46000, 2200 + i * 900, 3900); m.orbitRadius = 9000 + i * 4000;
      m.kind = 'bandit'; m.identified = true;
      this.migs.push(m);
    }
    this.pods = 3; this.hostileNow = false; this.smokeT = 0; this.podDropped = false;
    G.waypoint = this.raftPos;
    G.radio('RESCUE COORD: PILOT IS ALIVE AND SIGNALING. WATCH FOR MIGS.');
  },
  update(G, dt) {
    // orange smoke marker
    this.smokeT -= dt;
    if (this.smokeT <= 0 && !this.podDropped) { this.smokeT = 0.25; G.fx.smoke(this.raftPos.clone().add(V(0, 2, 0)), 2.5, 4, 0xff6a20); }
    G.waypoint = this.raftPos;
    // migs go hostile if player closes or fires
    if (!this.hostileNow && (G.player.pos.distanceTo(this.raftPos) < 16000 || G.shotsFired > 0)) {
      this.hostileNow = true;
      for (const m of this.migs) { m.mode = 'attack'; m.target = G.player; m.hostile = true; }
      G.radio('RESCUE COORD: MIGS ARE COMING TO YOU — FIGHT OR RUN THE DROP LOW!');
    }
    // pod drop
    if (G.podDropRequested) {
      G.podDropRequested = false;
      const altOk = G.player.altFt < 1500;
      const distOk = near(G.player.pos, this.raftPos, 1300);
      if (altOk && distOk && !this.podDropped) {
        this.podDropped = true;
        G.audio.podDrop();
        G.fx.splash(this.raftPos.clone(), 1.2);
        G.msg('POD AWAY — PILOT SECURED!', 'good');
        G.radio('RESCUE COORD: HE\'S GOT THE POD! PICKUP EN ROUTE. RTB, VIPER.');
        G.addScore(1500);
        setTimeout(() => { if (!G.over) G.completeMission('MISSION COMPLETE', 'The rescue pod is secure and the pilot\nwill be home for breakfast.\n\nSCORE +1500 + KILL BONUSES'); }, 5000);
      } else {
        this.pods--;
        G.audio.podDrop();
        if (this.pods <= 0) { G.failMission('PODS EXPENDED', 'All three rescue pods missed the raft.\nThe pilot remains in the sea.'); return; }
        G.msg(`POD MISSED — ${altOk ? 'TOO FAR' : 'TOO HIGH'} (${this.pods} LEFT)`, 'warn');
      }
    }
  },
},
// ------------------------------------------------ M5 CRUISE MISSILE
{
  id: 'm5', num: 5, title: 'CRUISE MISSILE INBOUND', code: 'SEPT 12, 1994 — 0510 HRS',
  time: 'morning', planeChoice: true,
  briefing:
`A nuclear-armed CRUISE MISSILE has been launched at
San Francisco. It is flying at 200 FEET at over 500 KNOTS —
terrain-following, radar-invisible until you are close.

Scramble NOW. Every second counts. Intercept over the water
and kill it before it reaches the city.

It is small, fast and low. Use AMRAAMs head-on or get
behind it with the gun. Good hunting.`,
  loadout: '2× AIM-9 · 4× AIM-120 · 500× 20MM — HOT SCRAMBLE',
  setup(G) {
    G.setPlayerStart({ onCarrier: true });
    this.cm = G.spawnAI('cruise', {
      pos: V(-44000, 70, 5500), heading: Math.atan2(7000 - (-44000), -(5000 - 5500)), speed: 258,
      name: 'CRUISE MISSILE', label: 'CRUISE MSL', mode: 'straight', noEvade: true, hp: 60,
      terrainFollow: true, hostile: true,
    });
    this.cm.kind = 'bandit'; this.cm.identified = true;
    this.warnT = 0;
    G.waypoint = this.cm.pos;
    G.radio('NORAD: VIPER 1-1, CRUISE MISSILE INBOUND! FULL BURNER — GO!');
  },
  update(G, dt) {
    if (this.cm.dead) {
      G.addScore(3000);
      G.completeMission('MISSION COMPLETE', 'Cruise missile destroyed over the Pacific.\nThe city never even woke up.\n\nSCORE +3000');
      return;
    }
    G.waypoint = this.cm.pos;
    const d = this.cm.pos.distanceTo(V(7000, 70, 5000));
    this.warnT -= dt;
    if (this.warnT <= 0) { this.warnT = 10; G.msg(`MISSILE ${(d / 1852).toFixed(0)} NM FROM THE CITY`, 'warn'); }
    if (d < 2600) {
      G.explode(this.cm.pos, 3);
      G.failMission('THE CITY IS HIT', 'The cruise missile reached San Francisco.\nYou were seconds too late.');
    }
  },
},
// ------------------------------------------------ M6 CARRIER SUB
{
  id: 'm6', num: 6, title: 'THE CARRIER SUB', code: 'SEPT 15, 1994 — 1745 HRS',
  time: 'dusk', planeChoice: true,
  briefing:
`This is no longer a crisis — it is WAR.

An enemy SUBMERSIBLE AIRCRAFT CARRIER has surfaced
60 miles west of the Golden Gate and is launching
strike aircraft at the coast.

Destroy EVERY aircraft it launches. The carrier itself
cannot be sunk by your missiles — kill its air wing and
it will be forced to flee.

This is the big one, pilot. The city is counting on you.`,
  loadout: '2× AIM-9 · 4× AIM-120 · 500× 20MM — LAND TO REARM ANYTIME',
  setup(G) {
    G.setPlayerStart({ onCarrier: true });
    this.sub = G.world.enemySub;
    this.sub.group.visible = true;
    this.total = 6; this.spawned = 0; this.killed = 0; this.spawnT = 8;
    this.migs = [];
    G.waypoint = this.sub.pos.clone().add(V(0, 500, 0));
    G.radio('FLEET COM: ALL HOSTILE AIRCRAFT MUST BE DESTROYED. GOOD HUNTING.');
  },
  update(G, dt) {
    G.waypoint = this.migs.find(m => !m.dead)?.pos || this.sub.pos.clone().add(V(0, 500, 0));
    // launch schedule
    this.spawnT -= dt;
    if (this.spawned < this.total && this.spawnT <= 0) {
      this.spawnT = 26;
      this.spawned++;
      const m = G.spawnAI('mig29', {
        pos: this.sub.pos.clone().add(V(rand(-40, 40), 60, rand(-40, 40))),
        heading: Math.atan2(G.player.pos.x - this.sub.pos.x, -(G.player.pos.z - this.sub.pos.z)),
        speed: 240, hostile: true, name: 'MIG-29', label: 'MIG-29', mode: 'attack',
        skill: 0.9 + this.spawned * 0.05, agility: 1.1,
      });
      m.target = G.player; m.kind = 'bandit'; m.identified = true;
      this.migs.push(m);
      G.msg(`BOGEY LAUNCHED FROM THE SUB! (${this.spawned}/${this.total})`, 'warn');
      G.audio.radioClick();
    }
    const deadCount = this.migs.filter(m => m.dead).length;
    if (this.spawned >= this.total && deadCount >= this.total && !this.done) {
      this.done = true;
      this.sub.submerge();
      G.radio('FLEET COM: THE SUB IS CRASH-DIVING! IT\'S OVER — YOU DID IT!');
      G.addScore(4000);
      setTimeout(() => {
        if (!G.over) G.completeMission('VICTORY!', 'The enemy air wing is destroyed and the\ncarrier sub has fled beneath the waves.\n\nTHE BAY IS SAFE. THE WAR IS OVER.\nYou are a legend of the squadron.\n\nSCORE +4000 + KILL BONUSES');
      }, 6000);
    }
  },
},
// ------------------------------------------------ FREE FLIGHT
{
  id: 'free', num: 99, title: 'FREE FLIGHT', code: 'NO ENEMY ACTIVITY',
  time: 'day', planeChoice: true,
  briefing:
`The Bay is yours. Fly anywhere, buzz the bridges, practice
carrier traps, or rent your skills against the range drone.

A single MiG-29 flies an aerobatic circuit over the Bay —
it will not shoot back, but it WILL evade if you lock it up.

Press X to eject and respawn at your start point.`,
  loadout: 'FULL LOADOUT — UNLIMITED RESPAWNS',
  setup(G) {
    const start = G.freeFlightStart || 'carrier';
    if (start === 'carrier') G.setPlayerStart({ onCarrier: true });
    else if (start === 'sfo') G.setPlayerStart({ runway: G.world.runways[0] });
    else G.setPlayerStart({ pos: V(-6000, 1200, 0), heading: Math.PI / 2, speed: 180 });
    this.mig = this._spawnDrone(G);
    this.respawnT = 0;
  },
  _spawnDrone(G) {
    const m = G.spawnAI('mig29', {
      pos: V(5000, 1500, 5000), heading: 0, speed: 230, name: 'RANGE DRONE', label: 'DRONE',
      mode: 'route', loop: true, skill: 1.2, agility: 1.3, hp: 100,
      waypoints: [V(0, 800, 0), V(7000, 1200, 5000), V(10000, 600, 0), V(0, 1500, -6000), V(-4000, 900, 3000)],
    });
    m.kind = 'bandit'; m.identified = true; m.noAttack = true;
    return m;
  },
  update(G, dt) {
    if (this.mig.dead || this.mig.removeMe) {
      this.respawnT += dt;
      if (this.respawnT > 18) { this.respawnT = 0; this.mig = this._spawnDrone(G); G.msg('RANGE DRONE AIRBORNE AGAIN', 'good'); }
    }
  },
},
];
