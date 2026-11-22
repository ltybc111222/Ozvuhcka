/** base64 → байты. */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** PCM 16-бит моно → WAV (RIFF). */
export function pcmToWav(pcm: Uint8Array, rate: number): Blob {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, pcm.length, true);
  return new Blob([header, pcm.slice().buffer], { type: 'audio/wav' });
}

/** Частота из mimeType вида "audio/L16;codec=pcm;rate=24000". */
export function rateOf(mime: string | undefined): number {
  const m = /rate=(\d+)/.exec(mime ?? '');
  return m ? Number(m[1]) : 24000;
}

export const durationOf = (pcmB64: string, rate: number) => (b64ToBytes(pcmB64).length / 2) / rate;

export function formatDuration(sec: number): string {
  const s = Math.round(sec * 10) / 10;
  return s < 60 ? `${s.toFixed(1)} с` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const tag = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const isWav = (b: Uint8Array, o: number) => b.length > o + 12 && tag(b, o) === 'RIFF' && tag(b, o + 8) === 'WAVE';

/**
 * Gemini TTS в inlineData кладёт не голый PCM, как обещает mimeType, а целый WAV:
 * заголовок RIFF, данные и в хвосте блок C2PA (метка «создано ИИ»). Прочитанный
 * как PCM, такой ответ даёт щелчок в начале и шум с обрывом в конце. Достаём из
 * него только отсчёты. Уже сохранённые записи бывают и в двойной обёртке.
 */
export function cleanGeminiPcm(bytes: Uint8Array, rateHint: number): { pcm: Uint8Array; rate: number; fixed: boolean } {
  let o = 0;
  if (!isWav(bytes, 0)) return { pcm: bytes, rate: rateHint, fixed: false };
  if (isWav(bytes, 44)) o = 44;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let rate = rateHint;
  for (let p = o + 12; p + 8 <= bytes.length;) {
    const id = tag(bytes, p), size = v.getUint32(p + 4, true);
    if (id === 'fmt ') rate = v.getUint32(p + 12, true);
    if (id === 'data') {
      const end = Math.min(bytes.length, p + 8 + size);
      return { pcm: bytes.slice(p + 8, end - ((end - p - 8) % 2)), rate, fixed: true };
    }
    p += 8 + size + (size % 2);
  }
  return { pcm: bytes, rate: rateHint, fixed: false };
}

export function bytesToB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
