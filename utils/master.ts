/**
 * Доводка дубля до стандарта игры (README «Озвучка» в game-sod), чтобы в студии
 * звучало так же, как в игре: тишина по краям ≤ 0,1 с с короткими затуханиями,
 * громкость −16 LUFS (ITU-R BS.1770), пики не выше −2 dBFS (запас под Opus,
 * в игре цель −1,5 dBTP). Сырой звук Gemini горячий, поэтому лимитер обязателен.
 * Окончательную OGG делает tools/voice/import-studio-zip.mjs в game-sod.
 */
export const TARGET_LUFS = -16;
const CEIL_DB = -2;

export type Mastered = { pcm: Uint8Array; lufs: number; peakDb: number; durationSec: number };

function toFloat(pcm: Uint8Array): Float32Array {
  const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = new Float32Array(pcm.byteLength >> 1);
  for (let i = 0; i < out.length; i++) out[i] = v.getInt16(i * 2, true) / 32768;
  return out;
}

function toPcm(x: Float32Array): Uint8Array {
  const out = new Uint8Array(x.length * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < x.length; i++) v.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), true);
  return out;
}

const db = (a: number) => 20 * Math.log10(Math.max(a, 1e-9));

/** Обрезка тишины (окна по 10 мс, порог −55 dBFS) + затухания 15 / 60 мс. */
function trim(x: Float32Array, rate: number): Float32Array {
  const w = Math.max(1, Math.round(rate * 0.01));
  const loud = (i: number) => {
    let s = 0; for (let j = i; j < Math.min(x.length, i + w); j++) s += x[j] * x[j];
    return db(Math.sqrt(s / w)) > -55;
  };
  let a = 0, b = x.length;
  while (a < x.length && !loud(a)) a += w;
  while (b - w > a && !loud(b - w)) b -= w;
  if (a >= b) return x;
  a = Math.max(0, a - Math.round(rate * 0.04));
  b = Math.min(x.length, b + Math.round(rate * 0.09));
  const y = x.slice(a, b);
  const fin = Math.min(y.length, Math.round(rate * 0.015)), fout = Math.min(y.length, Math.round(rate * 0.06));
  for (let i = 0; i < fin; i++) y[i] *= i / fin;
  for (let i = 0; i < fout; i++) y[y.length - 1 - i] *= i / fout;
  return y;
}

function biquad(x: Float32Array, b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** Интегральная громкость по BS.1770-4 (K-фильтр под любую частоту, гейты −70 и −10). */
export function lufs(x: Float32Array, rate: number): number {
  let w0 = 2 * Math.PI * 1681.9744509555319 / rate, c = Math.cos(w0);
  const A = Math.pow(10, 3.99984385397 / 40), al = Math.sin(w0) / (2 * 0.7071752369554193), sA = 2 * Math.sqrt(A) * al;
  let k = biquad(x, A * ((A + 1) + (A - 1) * c + sA), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - sA),
    (A + 1) - (A - 1) * c + sA, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - sA);
  w0 = 2 * Math.PI * 38.13547087613982 / rate; c = Math.cos(w0);
  const al2 = Math.sin(w0) / (2 * 0.5003270373253953);
  k = biquad(k, (1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al2, -2 * c, 1 - al2);
  const n = Math.round(rate * 0.4), step = Math.round(rate * 0.1);
  const z: number[] = [];
  for (let i = 0; i + n <= k.length || (i === 0 && k.length); i += step) {
    const e = Math.min(k.length, i + n); let s = 0;
    for (let j = i; j < e; j++) s += k[j] * k[j];
    z.push(s / (e - i));
    if (e === k.length) break;
  }
  const L = (m: number) => -0.691 + 10 * Math.log10(Math.max(m, 1e-12));
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  const g1 = z.filter((m) => L(m) > -70);
  if (!g1.length) return -70;
  const rel = L(mean(g1)) - 10;
  return L(mean(g1.filter((m) => L(m) > rel)));
}

/** Усиление + лимитер с упреждением 5 мс и отпусканием 60 мс. */
function gainLimit(x: Float32Array, rate: number, gainDb: number): Float32Array {
  const g0 = Math.pow(10, gainDb / 20), ceil = Math.pow(10, CEIL_DB / 20);
  const y = x.map((v) => v * g0);
  const la = Math.max(1, Math.round(rate * 0.005)), rel = Math.exp(-1 / (rate * 0.06));
  const need = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) need[i] = Math.min(1, ceil / Math.max(Math.abs(y[i]), 1e-9));
  // Наименьшее нужное усиление на окне упреждения, потом плавный подъём назад к 1.
  const g = new Float32Array(y.length);
  // Минимум на окне [i, i+la) — монотонной очередью, за O(n): фрагменты рассказа длинные.
  const q = new Int32Array(y.length); let qh = 0, qt = 0;
  let cur = 1;
  for (let i = 0, j = 0; i < y.length; i++) {
    for (; j < Math.min(y.length, i + la); j++) { while (qt > qh && need[q[qt - 1]] >= need[j]) qt--; q[qt++] = j; }
    while (q[qh] < i) qh++;
    const m = need[q[qh]];
    cur = m < cur ? m : 1 - (1 - cur) * rel;
    g[i] = Math.min(cur, need[i]);
  }
  // Атака без ступенек: усиление снижается линейно за окно упреждения.
  for (let i = y.length - 2; i >= 0; i--) g[i] = Math.min(g[i], g[i + 1] + 1 / la);
  for (let i = 0; i < y.length; i++) y[i] *= g[i];
  return y;
}

export function master(pcm: Uint8Array, rate: number): Mastered {
  const x = trim(toFloat(pcm), rate);
  let gain = TARGET_LUFS - lufs(x, rate), y = x;
  for (let pass = 0; pass < 3; pass++) {
    y = gainLimit(x, rate, gain);
    const d = TARGET_LUFS - lufs(y, rate);
    if (Math.abs(d) < 0.3) break;
    gain += d;
  }
  let peak = 0; for (const v of y) peak = Math.max(peak, Math.abs(v));
  return { pcm: toPcm(y), lufs: Math.round(lufs(y, rate) * 10) / 10, peakDb: Math.round(db(peak) * 10) / 10, durationSec: y.length / rate };
}
