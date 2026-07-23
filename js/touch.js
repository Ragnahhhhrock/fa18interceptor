// touch.js — mobile controls: thumb stick + button deck, auto-enabled on
// coarse-pointer devices (force on desktop with ?touch=1 for testing).
// Every button speaks the game's native key protocol (synthetic KeyboardEvents),
// so Input.keys/justPressed, held-key polling and the window-level state
// handlers (menu / briefing / plane select / map select) all work unchanged.
import { clamp } from './util.js';

export function setupTouch(G) {
  const params = new URLSearchParams(location.search);
  const force = params.get('touch') === '1';
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (!(force || coarse || navigator.maxTouchPoints > 0 || 'ontouchstart' in window)) return null;

  const $ = (id) => document.getElementById(id);
  document.documentElement.classList.add('touch');

  // ---------------- synthetic keyboard ----------------
  const kd = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code }));
  const ku = (code) => window.dispatchEvent(new KeyboardEvent('keyup', { code }));
  const tap = (code) => { kd(code); ku(code); };

  // ---------------- DOM ----------------
  const root = document.createElement('div');
  root.id = 'touch-ui';
  root.innerHTML = `
    <div id="tflight" class="hidden">
      <div id="tstick">
        <div id="tstick-base"><div id="tstick-knob"></div></div>
      </div>
      <div id="tsys">
        <button class="tbtn sys" data-k="KeyG">GEAR</button>
        <button class="tbtn sys" data-k="KeyH">HOOK</button>
        <button class="tbtn sys" data-k="KeyB">BRK</button>
        <button class="tbtn sys" data-k="KeyV">VIEW</button>
        <button class="tbtn sys" data-k="KeyN">MAP</button>
        <button class="tbtn sys" data-k="KeyP">&#10074;&#10074;</button>
      </div>
      <div id="tthr">
        <div id="tthr-label">THR</div>
        <div id="tthr-track"><div id="tthr-handle"></div></div>
      </div>
      <div id="tact">
        <button class="tbtn act" data-k="KeyT">TGT</button>
        <button class="tbtn act" id="t-ab">AB</button>
        <button class="tbtn act" data-k="Tab">WPN</button>
        <button class="tbtn fire" id="t-fire">FIRE</button>
      </div>
    </div>
    <div id="tintro" class="hidden"></div>
  `;
  document.body.appendChild(root);

  // The portrait overlay lives OUTSIDE #touch-ui on purpose: touch-ui sits at
  // z-index 12, below the menu overlay (20) — inside it the "blocking" overlay
  // was ghosted by the menu and taps fell straight through to the buttons.
  // As a direct body child its z-60 genuinely tops every gameplay layer.
  const proot = document.createElement('div');
  proot.id = 'tportrait';
  proot.className = 'hidden';
  proot.innerHTML = `
    <div class="tp-phone"><div class="tp-screen"></div></div>
    <div class="tp-title">ROTATE YOUR DEVICE</div>
    <div class="tp-sub">HORNET BAY IS LANDSCAPE-ONLY ON MOBILE</div>
    <div class="tp-lock" id="tp-lock">STUCK ON THIS SCREEN? YOUR ROTATION LOCK IS PROBABLY ON &mdash;<br>
      CONTROL CENTER (SWIPE DOWN FROM TOP-RIGHT) &rarr; TAP THE LOCK ICON</div>
    <div class="tp-tap seen" id="tp-tap">TAP TO ENABLE SIDEWAYS MODE</div>
  `;
  document.body.appendChild(proot);

  // ---------------- button wiring ----------------
  // hold: key stays down between touchstart and touchend (throttle, burner, fire)
  const hold = (el, code) => {
    let id = null;
    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (id !== null) return;
      id = e.changedTouches[0].identifier;
      el.classList.add('on');
      G.audio.ensure();
      kd(code);
    }, { passive: false });
    const end = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === id) { id = null; el.classList.remove('on'); ku(code); }
      }
    };
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', end);
  };
  // tap: one discrete keypress (gear, hook, view, weapon cycle, ...)
  const tapBtn = (el, code) => {
    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      el.classList.add('on');
      G.audio.ensure();
      tap(code);
    }, { passive: false });
    el.addEventListener('touchend', () => el.classList.remove('on'));
    el.addEventListener('touchcancel', () => el.classList.remove('on'));
  };

  for (const b of root.querySelectorAll('#tsys .tbtn, #tact .tbtn[data-k]')) tapBtn(b, b.dataset.k);
  hold($('t-fire'), 'Space');       // gun: continuous while held; missiles: one per tap
  hold($('t-ab'), 'ShiftLeft');     // hold-to-burn, like the keyboard SHIFT

  // ---------------- sideways-mode coordinate shim ----------------
  // When the body is spun 90 degrees (rotation-lock workaround), screen touches
  // must be mapped into the game's landscape frame before rect math.
  const fakeDir = () => document.documentElement.classList.contains('fakeland') ? 1
                      : document.documentElement.classList.contains('fakeland-ccw') ? -1 : 0;
  function toGameXY(x, y) {
    const d = fakeDir();
    if (!d) return [x, y];
    const vw = window.innerWidth, vh = window.innerHeight;
    return d > 0 ? [y, vw - x] : [vh - y, x];
  }
  function toGameDelta(dx, dy) {
    const d = fakeDir();
    if (!d) return [dx, dy];
    return d > 0 ? [dy, -dx] : [-dy, dx];
  }
  function gameRect(el) {
    const r = el.getBoundingClientRect();
    const d = fakeDir();
    if (!d) return r;
    const vw = window.innerWidth, vh = window.innerHeight;
    return d > 0
      ? { left: r.top, top: vw - r.right, right: r.bottom, bottom: vw - r.left, width: r.height, height: r.width }
      : { left: vh - r.bottom, top: r.left, right: vh - r.top, bottom: r.right, width: r.height, height: r.width };
  }

  // ---------------- throttle slider (drag to set, stays put — like a real lever) ----------------
  const thrTrack = $('tthr-track'), thrHandle = $('tthr-handle');
  let thrId = null;
  const thrSet = (x, y) => {
    const [, gy] = toGameXY(x, y);
    const r = gameRect(thrTrack);
    const v = clamp(1 - (gy - r.top) / r.height, 0, 1);
    G.player.throttle = v;
  };
  thrTrack.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (thrId !== null) return;
    thrId = e.changedTouches[0].identifier;
    G.audio.ensure();
    thrSet(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
  }, { passive: false });
  thrTrack.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) if (t.identifier === thrId) thrSet(t.clientX, t.clientY);
  }, { passive: false });
  const thrEnd = (e) => {
    for (const t of e.changedTouches) if (t.identifier === thrId) thrId = null;
  };
  window.addEventListener('touchend', thrEnd);
  window.addEventListener('touchcancel', thrEnd);

  // ---------------- thumb stick (left hand) ----------------
  const stickZone = $('tstick'), base = $('tstick-base'), knob = $('tstick-knob');
  const R = 0.38 * base.clientWidth || 52;   // throw radius in px
  let sid = null, cx = 0, cy = 0;
  const setAxes = (dx, dy) => {
    G.input.taActive = true;
    G.input.tax = clamp(dx / R, -1, 1);
    G.input.tay = clamp(dy / R, -1, 1);
    const m = Math.hypot(dx, dy), k = m > R ? R / m : 1;
    knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
  };
  stickZone.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (sid !== null) return;
    const t = e.changedTouches[0];
    sid = t.identifier;
    const r = base.getBoundingClientRect();
    cx = r.left + r.width / 2; cy = r.top + r.height / 2;
    G.audio.ensure();
    const [dx, dy] = toGameDelta(t.clientX - cx, t.clientY - cy);
    setAxes(dx, dy);
  }, { passive: false });
  stickZone.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) if (t.identifier === sid) {
      const [dx, dy] = toGameDelta(t.clientX - cx, t.clientY - cy);
      setAxes(dx, dy);
    }
  }, { passive: false });
  const stickEnd = (e) => {
    for (const t of e.changedTouches) if (t.identifier === sid) {
      sid = null;
      G.input.taActive = false; G.input.tax = 0; G.input.tay = 0;
      knob.style.transform = 'translate(0px, 0px)';
    }
  };
  window.addEventListener('touchend', stickEnd);
  window.addEventListener('touchcancel', stickEnd);

  // ---------------- contextual bar for the canvas-rendered intro states ----------------
  const introBar = $('tintro');
  let introMode = '';
  const ACTIONS = {
    enter: () => tap('Enter'), back: () => tap('Escape'), skip: () => tap('Space'),
    d1: () => tap('Digit1'), d2: () => tap('Digit2'), d3: () => tap('Digit3'),
    d4: () => tap('Digit4'), d5: () => tap('Digit5'),
    t: () => tap('KeyT'), r: () => tap('KeyR'),
  };
  introBar.addEventListener('touchstart', (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    e.preventDefault();
    b.classList.add('on');
    G.audio.ensure();
    ACTIONS[b.dataset.a] && ACTIONS[b.dataset.a]();
  }, { passive: false });
  introBar.addEventListener('touchend', (e) => {
    const b = e.target.closest('button[data-a]');
    if (b) b.classList.remove('on');
  });

  function syncIntro() {
    const st = G.state;
    let html = '', mode = st;
    if (st === 'briefing') {
      html = `<button class="tbtn big" data-a="enter">&#9654; SCRAMBLE</button>
              <button class="tbtn" data-a="back">BACK</button>`;
    } else if (st === 'planesel') {
      html = `<button class="tbtn big" data-a="d1">F/A-18 HORNET</button>` +
        (G.intro.carrierStart ? '' : `<button class="tbtn big" data-a="d2">F-16 FALCON</button>`) +
        `<button class="tbtn" data-a="t">DAY/NIGHT</button>
         <button class="tbtn" data-a="r">WEATHER</button>`;
    } else if (st === 'mapselect') {
      html = ['SFO', 'OAKLAND', 'MOFFETT', 'CARRIER', 'ALAMEDA']
        .map((l, i) => `<button class="tbtn" data-a="d${i + 1}">${l}</button>`).join('');
    } else if (st === 'zoom') {
      html = `<button class="tbtn big" data-a="skip">TAP TO SKIP &#9654;</button>`;
    } else mode = '';
    if (mode !== introMode) {
      introMode = mode;
      introBar.innerHTML = html;
      introBar.classList.toggle('hidden', !mode);
    }
  }

  // ---------------- visibility / rotate banner ----------------
  // ---------------- landscape only: portrait gets a blocking rotate overlay ----------------
  const tflight = $('tflight'), tportrait = $('tportrait');
  const tpLock = $('tp-lock'), tpTap = $('tp-tap');
  if (!window.DeviceOrientationEvent) tpTap.style.display = 'none';
  const portraitMQ = window.matchMedia('(orientation: portrait)');
  let portraitSince = 0;
  let fakeDirNow = 0, flPending = 0, flPendingT = 0;   // sideways-mode state
  function sync() {
    const st = G.state;
    const portrait = portraitMQ.matches;
    tportrait.classList.toggle('hidden', !portrait);
    tflight.classList.toggle('hidden', portrait || st !== 'flying');
    const blocked = portrait && fakeDirNow === 0;   // sideways mode beats the overlay
    tportrait.classList.toggle('hidden', !blocked);
    tflight.classList.toggle('hidden', blocked || st !== 'flying');
    if (!blocked) syncIntro(); else introBar.classList.add('hidden'), introMode = '';
    // reveal the rotation-lock hints only after the overlay has been up a
    // while — a first-timer rotates in a second and never needs them
    if (blocked && !portraitSince) portraitSince = performance.now();
    if (!blocked) portraitSince = 0;
    tpLock.classList.toggle('seen', blocked && performance.now() - portraitSince > 6000);
    if (thrId === null && G.player) thrHandle.style.bottom = `${(G.player.throttle || 0) * 100}%`;
    requestAnimationFrame(sync);
  }
  sync();

  // ---------------- sideways mode (rotation-lock workaround) ----------------
  // iOS Portrait Orientation Lock keeps the WebView portrait no matter how the
  // phone is held — the old overlay spun forever and one pilot got stuck there.
  // Now, once the gyro says the phone is physically landscape, the whole game
  // spins 90 degrees inside the portrait viewport (see .fakeland in the CSS)
  // and play continues. The overlay only shows while we have no sensor data.
  function setFakeland(dir) {
    if (dir === fakeDirNow) return;
    fakeDirNow = dir;
    document.documentElement.classList.toggle('fakeland', dir === 1);
    document.documentElement.classList.toggle('fakeland-ccw', dir === -1);
    if (G.applyResize) G.applyResize();          // re-lay out with swapped dims
  }
  function onTilt(e) {
    if (e.gamma === null || e.gamma === undefined) return;
    let want = 0;
    if (portraitMQ.matches) {
      const th = fakeDirNow !== 0 ? 45 : 60;      // hysteresis: no flip-flop
      if (Math.abs(e.gamma) > th) want = e.gamma > 0 ? -1 : 1;
    }
    if (want !== flPending) { flPending = want; flPendingT = performance.now(); }
    if (want !== fakeDirNow && performance.now() - flPendingT > 300) setFakeland(want);
    // settling pulse: "we see you turning" while sideways mode engages
    tpLock.classList.toggle('hot', fakeDirNow === 0 && portraitMQ.matches && Math.abs(e.gamma) > 60);
  }
  // listen immediately — a previously granted iOS permission streams at once;
  // the overlay tap runs the permission dance for first-timers
  window.addEventListener('deviceorientation', onTilt);
  tportrait.addEventListener('touchend', () => {
    try {
      if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().catch(() => {});
      }
    } catch (e) { /* no sensors — the static hint still helps */ }
  });

  // ---------------- mobile niceties ----------------
  // canvas touches shouldn't rubber-band or pull-to-refresh (menus still scroll)
  window.addEventListener('touchmove', (e) => {
    if (e.target.tagName === 'CANVAS') e.preventDefault();
  }, { passive: false });
  window.addEventListener('contextmenu', (e) => {
    if (e.target.closest('#touch-ui')) e.preventDefault();
  });
  // audio needs a first gesture on mobile
  window.addEventListener('touchstart', () => G.audio.ensure(), { once: true });
  // fullscreen once the pilot commits to a sortie (best-effort; iPhone Safari
  // has no page fullscreen — silently skipped there)
  const fsTry = () => {
    const el = document.documentElement;
    const fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!fn || document.fullscreenElement || document.webkitFullscreenElement) return;
    try {
      const p = fn.call(el);
      if (p && p.then) p.then(() => {
        // Android Chrome honours an orientation lock inside fullscreen;
        // iOS Safari doesn't — the portrait overlay handles those cases
        if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
      }).catch(() => {});
    } catch (e) { /* unsupported */ }
  };
  introBar.addEventListener('touchstart', fsTry);
  // touch-first hint line on the title screen
  const hint = document.querySelector('#menu .hint');
  if (hint) hint.innerHTML = 'LEFT THUMB &mdash; STICK &nbsp;&middot;&nbsp; RIGHT THUMB &mdash; FIRE &nbsp;&middot;&nbsp; DRAG THR &mdash; THROTTLE &nbsp;&middot;&nbsp; ? MANUAL FOR MORE';

  // test hook: ?tstick=x,y pins the stick (headless captures / desktop QA)
  const ts = params.get('tstick');
  if (ts) {
    const [x, y] = ts.split(',').map(Number);
    G.input.taActive = true; G.input.tax = x || 0; G.input.tay = y || 0;
  }
  return { root };
}
