// audio.js — all sound synthesized with WebAudio (no assets). Original music composed in code.
import { clamp, lerp } from './util.js';

export class AudioEngine {
  constructor() {
    this.ctx = null; this.musicOn = true;
    this._lockLvl = 0; this._locked = false; this._stall = false; this._missileWarn = false;
  }
  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain(); this.master.gain.value = 0.85;
      this.master.connect(this.ctx.destination);
      this.sfx = this.ctx.createGain(); this.sfx.gain.value = 1; this.sfx.connect(this.master);
      this.mus = this.ctx.createGain(); this.mus.gain.value = 0.5; this.mus.connect(this.master);
      this._buildEngineLoop();
      this._buildWind();
      this._startSequencer();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  setMusicOn(on) { this.musicOn = on; if (this.mus) this.mus.gain.value = on ? 0.5 : 0; }

  // ---------- continuous engine ----------
  _buildEngineLoop() {
    const c = this.ctx;
    this.engOsc = c.createOscillator(); this.engOsc.type = 'sawtooth'; this.engOsc.frequency.value = 55;
    this.engOsc2 = c.createOscillator(); this.engOsc2.type = 'square'; this.engOsc2.frequency.value = 110;
    const o2g = c.createGain(); o2g.gain.value = 0.25;
    this.engFilter = c.createBiquadFilter(); this.engFilter.type = 'lowpass'; this.engFilter.frequency.value = 400; this.engFilter.Q.value = 2;
    this.engGain = c.createGain(); this.engGain.gain.value = 0.0;
    this.engOsc.connect(this.engFilter); this.engOsc2.connect(o2g); o2g.connect(this.engFilter);
    this.engFilter.connect(this.engGain); this.engGain.connect(this.sfx);
    this.engOsc.start(); this.engOsc2.start();
    const nbuf = this._noiseBuffer(2);
    this.abSrc = c.createBufferSource(); this.abSrc.buffer = nbuf; this.abSrc.loop = true;
    this.abFilter = c.createBiquadFilter(); this.abFilter.type = 'lowpass'; this.abFilter.frequency.value = 900;
    this.abGain = c.createGain(); this.abGain.gain.value = 0;
    this.abSrc.connect(this.abFilter); this.abFilter.connect(this.abGain); this.abGain.connect(this.sfx);
    this.abSrc.start();
  }
  _buildWind() {
    const c = this.ctx;
    this.windSrc = c.createBufferSource(); this.windSrc.buffer = this._noiseBuffer(2); this.windSrc.loop = true;
    this.windFilter = c.createBiquadFilter(); this.windFilter.type = 'bandpass'; this.windFilter.frequency.value = 500; this.windFilter.Q.value = 0.6;
    this.windGain = c.createGain(); this.windGain.gain.value = 0;
    this.windSrc.connect(this.windFilter); this.windFilter.connect(this.windGain); this.windGain.connect(this.sfx);
    this.windSrc.start();
  }
  _noiseBuffer(sec) {
    const c = this.ctx, buf = c.createBuffer(1, c.sampleRate * sec, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
  // rpm 0..1.1, ab bool, speed m/s
  updateFlight(rpm, ab, speed) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = 45 + rpm * 140;
    this.engOsc.frequency.setTargetAtTime(f, t, 0.1);
    this.engOsc2.frequency.setTargetAtTime(f * 2.02, t, 0.1);
    this.engFilter.frequency.setTargetAtTime(250 + rpm * 1400, t, 0.1);
    this.engGain.gain.setTargetAtTime(0.05 + rpm * 0.16, t, 0.1);
    this.abGain.gain.setTargetAtTime(ab ? 0.30 : 0, t, 0.15);
    const w = clamp(speed / 350, 0, 1);
    this.windGain.gain.setTargetAtTime(w * w * 0.22, t, 0.2);
    this.windFilter.frequency.setTargetAtTime(300 + speed * 3, t, 0.2);
    if (this._stall && t > (this._beepTimer || 0)) { this._tone(880, 0.09, 0.12, 'square'); this._beepTimer = t + 0.22; }
    if (this._missileWarn && t > (this._mwTimer || 0)) { this._tone(1400, 0.06, 0.14, 'square'); this._mwTimer = t + 0.13; }
    if (this._lockLvl > 0.03) {
      if (this._locked) { if (t > (this._lkTimer || 0)) { this._tone(1180, 0.05, 0.08, 'sine'); this._lkTimer = t + 0.09; } }
      else if (t > (this._lkTimer || 0)) { this._tone(760, 0.05, 0.07, 'sine'); this._lkTimer = t + lerp(0.5, 0.12, this._lockLvl); }
    }
  }
  setStall(b) { this._stall = b; }
  setMissileWarn(b) { this._missileWarn = b; }
  setLock(lvl, locked) { this._lockLvl = lvl; this._locked = locked; }

  _tone(freq, dur, vol, type = 'sine', slideTo = null) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.sfx); o.start(t); o.stop(t + dur + 0.02);
  }
  _noiseHit(dur, vol, freq, q = 1, slideTo = null) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const s = c.createBufferSource(); s.buffer = this._noiseBuffer(dur + 0.1);
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (slideTo) f.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.sfx); s.start(t); s.stop(t + dur + 0.05);
  }
  gun() { this._noiseHit(0.07, 0.5, 2600, 0.7, 500); }
  gunHit() { this._noiseHit(0.06, 0.25, 4000, 1, 1200); }
  missileFire() { this._noiseHit(0.9, 0.5, 3200, 0.6, 300); this._tone(300, 0.7, 0.15, 'sawtooth', 90); }
  enemyMissile() { this._tone(1600, 0.5, 0.2, 'square', 500); }
  explosion(dist = 0) {
    const v = clamp(1 - dist / 6000, 0.08, 1);
    this._noiseHit(1.4, 0.9 * v, 1400, 0.4, 60);
    this._tone(90, 1.1, 0.6 * v, 'sine', 28);
  }
  chaff() { this._noiseHit(0.3, 0.25, 6000, 2, 2000); }
  gear() { this._tone(220, 0.3, 0.2, 'square', 110); }
  hook() { this._tone(160, 0.25, 0.25, 'square', 80); }
  trap() { this._noiseHit(0.7, 0.6, 800, 0.8, 100); this._tone(120, 0.5, 0.4, 'sawtooth', 45); }
  radioClick() { this._noiseHit(0.04, 0.18, 3500, 3); }
  kill() { this._tone(520, 0.12, 0.25, 'square'); setTimeout(() => this._tone(780, 0.18, 0.25, 'square'), 120); }
  fail() { this._tone(300, 0.5, 0.3, 'sawtooth', 90); }
  podDrop() { this._tone(500, 0.3, 0.2, 'sine', 200); }

  // ---------- music: original composition, 4-bar loop, ~112 BPM ----------
  _startSequencer() {
    this.bpm = 112; this.step = 0; this.nextT = 0;
    const A2 = 110, B2 = 123.47, D3 = 146.83, E3 = 164.81, F3 = 174.61, G3 = 196, A3 = 220;
    // bass: driving 8ths — Am | Am | F | G
    this.bassLine = [
      A2,A2,A3,A2, A2,A3,A2,A2,  A2,A2,A3,A2, A2,G3/2,A2,B2,
      F3,F3,F3,F3, F3,E3,F3,E3, G3,G3,G3,G3, G3,B2,D3,G3];
    // lead (16ths over 4 bars, 0 = rest) — original heroic melody
    const E5 = 659.3, D5 = 587.3, C5 = 523.3, A4 = 440, B4 = 493.9, F5 = 698.5, G5 = 784, A5 = 880;
    this.lead = [
      0,0,0,0, E5,0,D5,C5,  A4,0,C5,0, E5,0,0,0,
      0,0,0,0, G5,0,F5,E5, F5,0,E5,D5, E5,0,0,0,
      0,0,0,0, E5,0,D5,C5, A4,0,C5,0, E5,0,G5,0,
      A5,0,G5,E5, D5,0,E5,0, C5,0,0,0, B4,0,0,0];
    this.chords = [
      [A3, C5/2*2, E3*2], [A3, 261.6, E3*2], [F3, A3, 261.6*2/2], [G3, B2, D3*2]];
    setInterval(() => this._musicTick(), 40);
  }
  _musicTick() {
    if (!this.ctx || !this.musicOn) return;
    const c = this.ctx, spb = 60 / this.bpm / 4; // 16th
    if (this.nextT < c.currentTime) this.nextT = c.currentTime + 0.05;
    while (this.nextT < c.currentTime + 0.18) {
      const s = this.step % 64, t = this.nextT;
      if (s % 2 === 0) this._mnote(this.bassLine[(s / 2) | 0], t, spb * 1.8, 0.16, 'sawtooth', 700);
      const L = this.lead[s]; if (L) this._mnote(L, t, spb * 2.6, 0.10, 'square', 2400);
      if (s % 16 === 0) for (const f of this.chords[(s / 16) | 0]) this._mnote(f * 2, t, spb * 10, 0.05, 'sawtooth', 1800);
      if (s % 4 === 2) this._mhat(t);
      this.nextT += spb; this.step++;
    }
  }
  _mnote(freq, t, dur, vol, type, cutoff) {
    const c = this.ctx;
    const o = c.createOscillator(), g = c.createGain(), f = c.createBiquadFilter();
    o.type = type; o.frequency.value = freq;
    f.type = 'lowpass'; f.frequency.value = cutoff;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(f); f.connect(g); g.connect(this.mus); o.start(t); o.stop(t + dur + 0.02);
  }
  _mhat(t) {
    const c = this.ctx;
    const s = c.createBufferSource(); s.buffer = this._noiseBuffer(0.06);
    const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
    const g = c.createGain(); g.gain.setValueAtTime(0.06, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    s.connect(f); f.connect(g); g.connect(this.mus); s.start(t);
  }
}
