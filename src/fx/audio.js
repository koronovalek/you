import { clamp, lerp } from '../core/math.js';

/* ============================================================================
   ЗВУК — полностью синтезированный (WebAudio), без файлов.
   Пространство: слушатель едет с камерой, птицы сидят в кронах вокруг и звучат
   из своей точки (HRTF), всё идёт в общий «лесной» ревербератор с долгим
   хвостом, поэтому даже тихие звуки обретают глубину.
   День: зяблик, большая синица, певчий дрозд, кукушка вдали, дятел, вороны;
   на рассвете — хор. Ночь: сверчки, сова, козодой, лягушки у воды.
   Всегда: ветер в кронах и шелест листвы по порывам, плеск у берега, далёкая
   канонада. Взрыв приходит с задержкой по скорости звука и эхом от леса.
   Разрушения: треск ствола, скрип падения, удар кроны, щепа, звон железа.
============================================================================ */
export const AUDIO = { ctx: null, master: null, on: true, t: 0, next: {}, listener: { x: 0, y: 0, z: 0 } };
let noiseBuf, windGain, windFilter, leafGain, leafFilter, droneOsc, droneGain, droneFilter, cricketGain, lapGain, lapFilter, lapPan, brushGain, reverb, revSend;
const R = Math.random;
const rr = (a, b) => a + R() * (b - a);

function makeImpulse(ctx, dur, decay) {
  // хвост леса: ранние отражения от стволов + диффузный спад
  const n = Math.floor(ctx.sampleRate * dur), b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      d[i] = (R() * 2 - 1) * Math.pow(1 - t, decay) * (t < 0.02 ? t / 0.02 : 1) * 0.5;
    }
    for (let k = 0; k < 14; k++) {
      const at = Math.floor(rr(0.01, 0.18) * ctx.sampleRate);
      if (at < n) d[at] += (R() < 0.5 ? -1 : 1) * rr(0.2, 0.5);
    }
  }
  return b;
}

export function initAudio() {
  if (AUDIO.ctx) { AUDIO.ctx.resume(); return; }
  const C = window.AudioContext || window.webkitAudioContext;
  if (!C) return;
  const ctx = new C();
  AUDIO.ctx = ctx;
  AUDIO.master = ctx.createGain(); AUDIO.master.gain.value = 0.85;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -12; comp.ratio.value = 5; comp.attack.value = 0.004; comp.release.value = 0.25;
  AUDIO.master.connect(comp); comp.connect(ctx.destination);
  reverb = ctx.createConvolver(); reverb.buffer = makeImpulse(ctx, 3.2, 3.2);
  revSend = ctx.createGain(); revSend.gain.value = 0.5;
  revSend.connect(reverb); reverb.connect(AUDIO.master);
  // розовый шум для ветра, листвы, плеска и взрывов
  const len = ctx.sampleRate * 4;
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < len; i++) {
    const w = R() * 2 - 1;
    b0 = 0.997 * b0 + w * 0.029; b1 = 0.985 * b1 + w * 0.032; b2 = 0.95 * b2 + w * 0.048;
    d[i] = (b0 + b1 + b2 + w * 0.02) * 1.8;
  }
  const loop = (filterType, f, q) => {
    const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const fl = ctx.createBiquadFilter(); fl.type = filterType; fl.frequency.value = f; fl.Q.value = q;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(fl); fl.connect(g); src.start(0, R() * 3);
    return [g, fl];
  };
  [windGain, windFilter] = loop('bandpass', 500, 0.5); windGain.connect(AUDIO.master);
  // шелест листвы и хвои — высокий «шшш», дышит порывами
  [leafGain, leafFilter] = loop('highpass', 2600, 0.4); leafGain.connect(AUDIO.master); leafGain.connect(revSend);
  // плеск у берега: низкий шум с неровной огибающей
  [lapGain, lapFilter] = loop('lowpass', 700, 1.2);
  lapPan = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
  lapGain.connect(lapPan); lapPan.connect(AUDIO.master); lapGain.connect(revSend);
  // треск кустов и камыша при продирании
  [brushGain] = loop('bandpass', 3200, 0.8); brushGain.connect(AUDIO.master);
  // гул винтов: две детюненные пилы через ФНЧ
  droneGain = ctx.createGain(); droneGain.gain.value = 0;
  droneFilter = ctx.createBiquadFilter(); droneFilter.type = 'lowpass'; droneFilter.frequency.value = 900;
  droneOsc = [ctx.createOscillator(), ctx.createOscillator()];
  droneOsc.forEach((o, i) => { o.type = 'sawtooth'; o.frequency.value = 180 + i * 3.7; o.connect(droneFilter); o.start(); });
  droneFilter.connect(droneGain); droneGain.connect(AUDIO.master);
  cricketGain = ctx.createGain(); cricketGain.gain.value = 1; cricketGain.connect(AUDIO.master);
  Object.assign(AUDIO.next, { bird: 2, cuckoo: 25, pecker: 15, crow: 30, cricket: 0, owl: 30, nightjar: 60, frog: 3, shell: 20 });
}

/* ---------- Узлы ---------- */
function env(g, t0, a, peak, dec) {
  g.gain.cancelScheduledValues(t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + dec);
}
function pan(ctx, x) { const p = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain(); if (p.pan) p.pan.value = clamp(x, -1, 1); return p; }
/** Источник в мире: HRTF-панорама, затухание с расстоянием, посыл в ревер. */
function spot(x, y, z, o = {}) {
  const ctx = AUDIO.ctx;
  const p = ctx.createPanner();
  p.panningModel = o.cheap ? 'equalpower' : 'HRTF'; p.distanceModel = 'inverse';
  p.refDistance = o.ref ?? 6; p.rolloffFactor = o.roll ?? 1; p.maxDistance = 2000;
  if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; } else p.setPosition(x, y, z);
  const out = ctx.createGain(); out.gain.value = o.gain ?? 1;
  out.connect(p); p.connect(AUDIO.master);
  const send = ctx.createGain(); send.gain.value = o.wet ?? 0.5;
  out.connect(send); send.connect(revSend);
  // воздух глушит верхи на дистанции
  const L = AUDIO.listener, dist = Math.hypot(x - L.x, y - L.y, z - L.z);
  if (dist > 25) {
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = clamp(18000 / (1 + dist / 60), 900, 18000);
    f.connect(out); return { in: f, dist };
  }
  return { in: out, dist };
}
function around(rMin, rMax, hMin, hMax) {
  const a = R() * Math.PI * 2, r = rr(rMin, rMax), L = AUDIO.listener;
  return [L.x + Math.cos(a) * r, L.y + rr(hMin, hMax), L.z + Math.sin(a) * r];
}
function tone(ctx, dst, t0, type, f0, f1, dur, peak, a = 0.008) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), t0 + dur);
  env(g, t0, a, peak, dur);
  o.connect(g); g.connect(dst); o.start(t0); o.stop(t0 + a + dur + 0.05);
  return o;
}
function noise(ctx, dst, t0, type, f, q, dur, peak, a = 0.003) {
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
  const g = ctx.createGain(); env(g, t0, a, peak, dur);
  s.connect(fl); fl.connect(g); g.connect(dst);
  s.start(t0, R() * 3); s.stop(t0 + a + dur + 0.05);
  return fl;
}

/* ---------- Птицы и ночные голоса ---------- */
function chaffinch(ctx, t) {
  // зяблик: трель с ускорением и понижением, в конце — «росчерк»
  const n = spot(...around(12, 45, 5, 16), { ref: 8 });
  const notes = Math.floor(rr(9, 14)), base = rr(4200, 5200);
  let tt = t;
  for (let i = 0; i < notes; i++) {
    const k = i / notes, f = base * (1 - k * 0.35);
    tone(ctx, n.in, tt, 'sine', f * 1.08, f * 0.9, 0.05, 0.05);
    tt += lerp(0.12, 0.06, k);
  }
  tone(ctx, n.in, tt + 0.02, 'sine', 3000, 5200, 0.09, 0.06);
  tone(ctx, n.in, tt + 0.14, 'sine', 5200, 2400, 0.16, 0.06);
}
function greatTit(ctx, t) {
  // большая синица: «ти-ти-та» звонко, несколько раз
  const n = spot(...around(8, 35, 4, 12), { ref: 7 });
  const hi = rr(5400, 6200), lo = hi * rr(0.66, 0.75), reps = Math.floor(rr(3, 6));
  for (let i = 0; i < reps; i++) {
    const t0 = t + i * 0.36;
    tone(ctx, n.in, t0, 'sine', hi, hi * 0.97, 0.07, 0.05);
    tone(ctx, n.in, t0 + 0.13, 'sine', lo, lo * 0.95, 0.12, 0.05);
  }
}
function thrush(ctx, t) {
  // певчий дрозд: короткие фразы, каждая повторяется 2–3 раза
  const n = spot(...around(18, 55, 6, 18), { ref: 9 });
  let tt = t;
  for (let ph = 0; ph < 3; ph++) {
    const shape = [rr(2200, 3800), rr(2500, 4500), rr(1800, 3200)], reps = Math.floor(rr(2, 4));
    for (let r = 0; r < reps; r++) {
      shape.forEach((f, j) => {
        const o = tone(ctx, n.in, tt + j * 0.09, 'sine', f, f * rr(0.8, 1.25), 0.08, 0.045);
        const lfo = ctx.createOscillator(), lg = ctx.createGain();
        lfo.frequency.value = rr(25, 45); lg.gain.value = f * 0.04; lfo.connect(lg); lg.connect(o.frequency);
        lfo.start(tt + j * 0.09); lfo.stop(tt + j * 0.09 + 0.15);
      });
      tt += 0.34;
    }
    tt += rr(0.4, 0.9);
  }
}
function cuckoo(ctx, t) {
  // кукушка вдали: «ку-ку», малая терция вниз
  const n = spot(...around(70, 140, 8, 20), { ref: 20, wet: 0.8 });
  const f = rr(620, 700), reps = Math.floor(rr(4, 11));
  for (let i = 0; i < reps; i++) {
    const t0 = t + i * rr(0.85, 0.95);
    tone(ctx, n.in, t0, 'sine', f, f * 0.98, 0.16, 0.12, 0.03);
    tone(ctx, n.in, t0 + 0.24, 'sine', f * 0.84, f * 0.82, 0.3, 0.1, 0.03);
  }
}
function woodpecker(ctx, t) {
  // дробь дятла: 12–20 ударов, частота нарастает, громкость спадает
  const n = spot(...around(25, 80, 5, 14), { ref: 12, wet: 0.7 });
  const hits = Math.floor(rr(12, 20)), f = rr(1100, 1900);
  let tt = t;
  for (let i = 0; i < hits; i++) {
    noise(ctx, n.in, tt, 'bandpass', f, 6, 0.025, 0.5 * (1 - i / hits * 0.6), 0.001);
    tt += lerp(0.07, 0.05, i / hits);
  }
}
function crow(ctx, t) {
  // ворона: хриплое «кар» — пила через форманту, с дрожью
  const n = spot(...around(40, 110, 10, 30), { ref: 15, wet: 0.7 });
  const reps = Math.floor(rr(2, 5));
  for (let i = 0; i < reps; i++) {
    const t0 = t + i * rr(0.45, 0.6);
    const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(rr(420, 520), t0); o.frequency.linearRampToValueAtTime(rr(330, 400), t0 + 0.3);
    f.type = 'bandpass'; f.frequency.value = 1300; f.Q.value = 3;
    const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 38; lg.gain.value = 60; lfo.connect(lg); lg.connect(o.frequency);
    env(g, t0, 0.03, 0.13, 0.28);
    o.connect(f); f.connect(g); g.connect(n.in);
    o.start(t0); o.stop(t0 + 0.4); lfo.start(t0); lfo.stop(t0 + 0.4);
  }
}
function owl(ctx, t) {
  const n = spot(...around(30, 80, 8, 18), { ref: 14, wet: 0.8 });
  for (const [dt, f, dur] of [[0, 420, 0.35], [0.55, 400, 0.18], [0.8, 410, 0.6]]) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(f, t + dt); o.frequency.linearRampToValueAtTime(f * 0.92, t + dt + dur);
    env(g, t + dt, 0.06, 0.12, dur);
    o.connect(g); g.connect(n.in); o.start(t + dt); o.stop(t + dt + dur + 0.2);
  }
}
function nightjar(ctx, t) {
  // козодой: долгое «тррррр» — тон с частой амплитудной модуляцией
  const n = spot(...around(30, 70, 2, 8), { ref: 12, wet: 0.7 });
  const dur = rr(3, 7), o = ctx.createOscillator(), g = ctx.createGain(), am = ctx.createGain(), lfo = ctx.createOscillator(), lg = ctx.createGain();
  o.type = 'triangle'; o.frequency.value = rr(900, 1300);
  lfo.frequency.value = rr(28, 36); lg.gain.value = 0.5; am.gain.value = 0.5;
  lfo.connect(lg); lg.connect(am.gain);
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.05, t + 0.3); g.gain.setValueAtTime(0.05, t + dur - 0.4); g.gain.linearRampToValueAtTime(0.0001, t + dur);
  o.connect(am); am.connect(g); g.connect(n.in);
  o.start(t); lfo.start(t); o.stop(t + dur + 0.1); lfo.stop(t + dur + 0.1);
}
function crickets(ctx, t, amt) {
  for (let k = 0; k < 3; k++) {
    const o = ctx.createOscillator(), g = ctx.createGain(), p = pan(ctx, R() * 2 - 1);
    o.type = 'sine'; o.frequency.value = 4200 + R() * 900;
    const t0 = t + R() * 0.5;
    for (let i = 0; i < 6; i++) { g.gain.setValueAtTime(0.0001, t0 + i * 0.07); g.gain.linearRampToValueAtTime(0.008 * amt, t0 + i * 0.07 + 0.01); g.gain.linearRampToValueAtTime(0.0001, t0 + i * 0.07 + 0.04); }
    o.connect(g); g.connect(p); p.connect(cricketGain); o.start(t0); o.stop(t0 + 0.6);
  }
}
function frog(ctx, t, x, z, amt) {
  // лягушка: низкое «ква» — пульсы 20–30 Гц через форманту
  const n = spot(x + rr(-6, 6), AUDIO.listener.y - 2, z + rr(-6, 6), { ref: 6, cheap: true, wet: 0.6, gain: amt });
  const reps = Math.floor(rr(2, 6)), f0 = rr(90, 150);
  for (let i = 0; i < reps; i++) {
    const t0 = t + i * rr(0.3, 0.5), o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'square'; o.frequency.value = f0;
    f.type = 'bandpass'; f.frequency.value = rr(500, 900); f.Q.value = 4;
    const am = ctx.createOscillator(), ag = ctx.createGain(); am.frequency.value = rr(20, 30); ag.gain.value = 0.05; am.connect(ag); ag.connect(g.gain);
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.05, t0 + 0.02); g.gain.linearRampToValueAtTime(0, t0 + 0.22);
    o.connect(f); f.connect(g); g.connect(n.in);
    o.start(t0); am.start(t0); o.stop(t0 + 0.25); am.stop(t0 + 0.25);
  }
}
function fishPlop(ctx, t, x, z) {
  const n = spot(x, AUDIO.listener.y - 1, z, { ref: 5, wet: 0.6 });
  tone(ctx, n.in, t, 'sine', rr(500, 800), rr(1400, 2200), 0.07, 0.12, 0.002);
  noise(ctx, n.in, t, 'lowpass', 1500, 1, 0.18, 0.18);
}

/* ---------- Звуки мира ---------- */
function distOf(x, y, z) { const L = AUDIO.listener; return Math.hypot(x - L.x, y - L.y, z - L.z); }
/** Разовый звук в точке мира. kind — вариант (материал обломка, поверхность шага). */
export function sfx(type, x, y, z, k = 1, kind = null) {
  const ctx = AUDIO.ctx;
  if (!ctx || !AUDIO.on) return;
  const d = distOf(x, y, z);
  if (d > 260 || (type === 'clatter' && d > 60)) return;
  const t = ctx.currentTime + d / 343;
  const n = spot(x, y, z, { ref: type === 'step' ? 2 : 7, wet: type === 'step' ? 0.15 : 0.6, cheap: type === 'step' || type === 'clatter' });
  switch (type) {
    case 'crack': {
      // излом ствола: резкий хлопок, затем сухая дробь волокон
      noise(ctx, n.in, t, 'highpass', 1800, 0.7, 0.08, 0.9 * k, 0.001);
      tone(ctx, n.in, t, 'triangle', 180, 70, 0.25, 0.4 * k, 0.002);
      for (let i = 0; i < 16; i++) noise(ctx, n.in, t + 0.05 + R() * 0.7, 'bandpass', rr(1500, 4500), 3, 0.015, rr(0.1, 0.35) * k, 0.001);
      break;
    }
    case 'creak': {
      // скрип падающего ствола: низкая пила через подвижную форманту
      const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain(), dur = rr(1.2, 2.2);
      o.type = 'sawtooth'; o.frequency.setValueAtTime(rr(80, 120), t); o.frequency.linearRampToValueAtTime(rr(40, 60), t + dur);
      f.type = 'bandpass'; f.Q.value = 7; f.frequency.setValueAtTime(700, t); f.frequency.linearRampToValueAtTime(320, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.16 * k, t + 0.3); g.gain.linearRampToValueAtTime(0.0001, t + dur);
      o.connect(f); f.connect(g); g.connect(n.in); o.start(t); o.stop(t + dur + 0.1);
      for (let i = 0; i < 6; i++) noise(ctx, n.in, t + rr(0.1, dur), 'bandpass', rr(1200, 3000), 4, 0.02, 0.2 * k, 0.001);
      break;
    }
    case 'thud': {
      // удар кроны: низкий «бум», хлёст веток и шуршание хвои
      tone(ctx, n.in, t, 'sine', 70, 32, 0.6, 0.8 * k, 0.004);
      noise(ctx, n.in, t, 'lowpass', 400, 1, 0.5, 0.7 * k, 0.005);
      noise(ctx, n.in, t, 'highpass', 2500, 0.5, 1.1, 0.35 * k, 0.02);
      for (let i = 0; i < 10; i++) noise(ctx, n.in, t + rr(0, 0.4), 'bandpass', rr(800, 2500), 3, 0.03, 0.25 * k, 0.001);
      break;
    }
    case 'splinter': {
      for (let i = 0; i < 8; i++) noise(ctx, n.in, t + rr(0, 0.12), 'bandpass', rr(600, 1800), 5, rr(0.04, 0.09), 0.5 * k, 0.001);
      noise(ctx, n.in, t, 'highpass', 2500, 0.6, 0.25, 0.4 * k);
      break;
    }
    case 'clatter': {
      if (kind === 'metal') for (const f of [rr(700, 1000), rr(2100, 2600), rr(3500, 4300)]) tone(ctx, n.in, t, 'sine', f, f * 0.995, rr(0.3, 0.7), 0.1 * k, 0.001);
      else noise(ctx, n.in, t, 'bandpass', rr(700, 1600), 6, 0.05, 0.35 * k, 0.001);
      break;
    }
    case 'step': {
      const surf = kind || 'grass';
      if (surf === 'water') { noise(ctx, n.in, t, 'lowpass', 1300, 1, 0.22, 0.25 * k, 0.01); tone(ctx, n.in, t + 0.03, 'sine', 400, 900, 0.06, 0.05 * k); }
      else if (surf === 'wood') { noise(ctx, n.in, t, 'bandpass', 380, 3, 0.07, 0.4 * k, 0.001); tone(ctx, n.in, t, 'sine', 140, 90, 0.08, 0.2 * k, 0.001); }
      else if (surf === 'dirt') noise(ctx, n.in, t, 'lowpass', 900, 0.8, 0.09, 0.3 * k, 0.002);
      else { noise(ctx, n.in, t, 'bandpass', 2600, 0.9, 0.12, 0.16 * k, 0.01); noise(ctx, n.in, t, 'lowpass', 500, 0.8, 0.07, 0.18 * k, 0.002); }
      break;
    }
    case 'splash': {
      noise(ctx, n.in, t, 'lowpass', 2000, 0.7, 0.6, 0.6 * k, 0.005);
      for (let i = 0; i < 5; i++) tone(ctx, n.in, t + rr(0.05, 0.4), 'sine', rr(500, 900), rr(1200, 2500), 0.05, 0.05 * k, 0.002);
      break;
    }
  }
}
/** Взрыв: треск + низкий удар + эхо леса, дальний — глухой и с задержкой. */
export function boom(dist, size = 1, x = 0) {
  const ctx = AUDIO.ctx;
  if (!ctx || !AUDIO.on) return;
  const t = ctx.currentTime + dist / 343;
  const vol = clamp(size * 1.6 / (1 + dist / 25), 0.02, 1.4);
  const src = ctx.createBufferSource(); src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = 'lowpass';
  f.frequency.setValueAtTime(lerp(6000, 700, clamp(dist / 250, 0, 1)), t);
  f.frequency.exponentialRampToValueAtTime(120, t + 1.8);
  const g = ctx.createGain(); env(g, t, 0.005, vol, 1.6 + size * 0.6);
  const p = pan(ctx, x);
  src.connect(f); f.connect(g); g.connect(p); p.connect(AUDIO.master);
  const send = ctx.createGain(); send.gain.value = 0.8; g.connect(send); send.connect(revSend);
  src.start(t, R() * 2); src.stop(t + 3);
  const o = ctx.createOscillator(), og = ctx.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(26, t + 0.7);
  env(og, t, 0.004, vol * 0.95, 0.8);
  o.connect(og); og.connect(AUDIO.master); o.start(t); o.stop(t + 1.1);
  // эхо от стены леса: 2–3 глухих повтора
  for (let i = 0; i < 3; i++) {
    const te = t + rr(0.35, 1.4) + i * 0.4, s2 = ctx.createBufferSource(); s2.buffer = noiseBuf;
    const f2 = ctx.createBiquadFilter(); f2.type = 'lowpass'; f2.frequency.value = 500 - i * 100;
    const g2 = ctx.createGain(); env(g2, te, 0.03, vol * 0.18 / (i + 1), 1.2);
    const p2 = pan(ctx, rr(-1, 1));
    s2.connect(f2); f2.connect(g2); g2.connect(p2); p2.connect(AUDIO.master);
    s2.start(te, R() * 2); s2.stop(te + 1.5);
  }
}
/** Щелчок взрывателя под ногой. */
export function click() {
  const ctx = AUDIO.ctx;
  if (!ctx) return;
  const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'square'; o.frequency.setValueAtTime(1800, t); o.frequency.exponentialRampToValueAtTime(400, t + 0.03);
  env(g, t, 0.001, 0.2, 0.05); o.connect(g); g.connect(AUDIO.master); o.start(t); o.stop(t + 0.1);
}
/** Звон в ушах после близкого разрыва. */
export function tinnitus(k) {
  const ctx = AUDIO.ctx;
  if (!ctx || k < 0.1) return;
  const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine'; o.frequency.value = 3900;
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.05 * k, t + 0.1); g.gain.exponentialRampToValueAtTime(0.0001, t + 4 * k);
  o.connect(g); g.connect(AUDIO.master); o.start(t); o.stop(t + 4.5);
  AUDIO.master.gain.setValueAtTime(0.25, t); AUDIO.master.gain.linearRampToValueAtTime(0.85, t + 3 * k);
}
/** Рыба плеснула: звук из точки (кольца рисует озеро). */
export function fishSound(x, z) {
  const ctx = AUDIO.ctx;
  if (ctx && AUDIO.on && distOf(x, AUDIO.listener.y, z) < 90) fishPlop(ctx, ctx.currentTime + distOf(x, AUDIO.listener.y, z) / 343, x, z);
}

/** Раз в кадр: слушатель, амбиент по времени суток, ветру, лесу и воде.
    s: {night, h, wind, gust, agl, drone, speed, pos, fwd, canopy, shore:{x,z,d}, brush} */
export function updateAudio(dt, s) {
  const ctx = AUDIO.ctx;
  if (!ctx) return;
  const t = ctx.currentTime, L = ctx.listener;
  if (s.pos) {
    AUDIO.listener.x = s.pos.x; AUDIO.listener.y = s.pos.y; AUDIO.listener.z = s.pos.z;
    if (L.positionX) {
      L.positionX.value = s.pos.x; L.positionY.value = s.pos.y; L.positionZ.value = s.pos.z;
      L.forwardX.value = s.fwd.x; L.forwardY.value = s.fwd.y; L.forwardZ.value = s.fwd.z;
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else { L.setPosition(s.pos.x, s.pos.y, s.pos.z); L.setOrientation(s.fwd.x, s.fwd.y, s.fwd.z, 0, 1, 0); }
  }
  AUDIO.master.gain.value = AUDIO.on ? (AUDIO.master.gain.value || 0.85) : 0;
  const on = AUDIO.on ? 1 : 0;
  const high = clamp(s.agl / 60, 0, 1.5);
  windGain.gain.setTargetAtTime(on * (0.04 + s.wind * 0.1) * (1 + high), t, 0.3);
  windFilter.frequency.setTargetAtTime(320 + s.wind * 480 + s.agl * 4, t, 0.3);
  // листва шумит, когда вокруг лес и дует порыв
  const canopy = s.canopy ?? 0.5, gust = s.gust ?? 0.5;
  leafGain.gain.setTargetAtTime(on * (0.012 + canopy * 0.05) * (0.25 + gust * s.wind * 1.4) * (1 - clamp(high, 0, 1) * 0.6), t, 0.4);
  leafFilter.frequency.setTargetAtTime(2200 + gust * 1800, t, 0.5);
  // плеск у берега: неровная огибающая, панорама на ближнюю точку уреза
  if (s.shore && s.pos) {
    const near = clamp(1 - s.shore.d / 24, 0, 1) * (1 - clamp(high, 0, 1));
    const lap = 0.55 + 0.45 * Math.sin(AUDIO.t * 1.3) * Math.sin(AUDIO.t * 0.71 + 1) + 0.25 * Math.sin(AUDIO.t * 3.1);
    lapGain.gain.setTargetAtTime(on * near * near * 0.09 * clamp(lap, 0.1, 1.3) * (0.6 + s.wind), t, 0.12);
    lapFilter.frequency.setTargetAtTime(500 + lap * 500, t, 0.2);
    if (lapPan.pan) {
      const dx = s.shore.x - s.pos.x, dz = s.shore.z - s.pos.z, l = Math.hypot(dx, dz) || 1;
      const rx = -s.fwd.z, rz = s.fwd.x, rl = Math.hypot(rx, rz) || 1;
      lapPan.pan.setTargetAtTime(clamp((dx * rx + dz * rz) / l / rl, -1, 1) * 0.8, t, 0.2);
    }
  }
  brushGain.gain.setTargetAtTime(on * clamp(s.brush ?? 0, 0, 1) * 0.12, t, 0.08);
  const drone = on && s.drone ? 0.018 + s.speed * 0.0016 : 0;
  droneGain.gain.setTargetAtTime(drone, t, 0.2);
  droneOsc[0].frequency.setTargetAtTime(170 + s.speed * 6, t, 0.2);
  droneOsc[1].frequency.setTargetAtTime(174 + s.speed * 6.3, t, 0.2);
  if (!AUDIO.on) return;
  AUDIO.t += dt;
  const N = AUDIO.next, T = AUDIO.t, h = s.h ?? 12;
  const day = 1 - s.night;
  // рассветный хор: с 4:30 до 8 птицы поют втрое чаще
  const chorus = h > 4.5 && h < 8 ? 3 : 1;
  const inForest = s.agl < 45;
  if (T > N.bird && day > 0.25 && inForest) {
    const r = R();
    (r < 0.45 ? chaffinch : r < 0.75 ? greatTit : thrush)(ctx, t);
    N.bird = T + (1.2 + R() * 5.5) / (day * chorus);
  }
  if (T > N.cuckoo && day > 0.5) { cuckoo(ctx, t); N.cuckoo = T + 45 + R() * 70; }
  if (T > N.pecker && day > 0.4 && inForest) { woodpecker(ctx, t); N.pecker = T + 18 + R() * 40; }
  if (T > N.crow && day > 0.3) { crow(ctx, t); N.crow = T + 30 + R() * 60; }
  if (T > N.cricket && s.night > 0.4) { crickets(ctx, t, s.night); N.cricket = T + 0.6 + R() * 1.2; }
  if (T > N.owl && s.night > 0.7) { owl(ctx, t); N.owl = T + 25 + R() * 50; }
  if (T > N.nightjar && s.night > 0.6) { nightjar(ctx, t); N.nightjar = T + 40 + R() * 60; }
  // лягушки у воды: в сумерках и ночью, ближе к берегу — громче
  if (s.shore && T > N.frog && (s.night > 0.3 || h > 19) && s.shore.d < 60) {
    frog(ctx, t, s.shore.x, s.shore.z, clamp(1 - s.shore.d / 60, 0.1, 1));
    N.frog = T + 0.4 + R() * 2.2;
  }
  if (T > N.shell) {
    // далёкая канонада за горизонтом: фронт рядом, но не здесь
    boom(1500 + R() * 2500, 2.2, R() * 2 - 1);
    if (R() < 0.5) setTimeout(() => boom(1800 + R() * 2000, 2.0, R() * 2 - 1), 900 + R() * 1500);
    N.shell = T + 25 + R() * 60;
  }
}
