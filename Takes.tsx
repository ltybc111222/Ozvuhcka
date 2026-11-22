import { useEffect, useMemo, useState } from 'react';
import type { Take, TakeKey } from './types';
import { dropHistory, loadHistory, pickTake } from './services/store';
import { master, type Mastered } from './utils/master';
import { b64ToBytes, download, formatDuration, pcmToWav } from './utils/wav';

// Доводка считается один раз на дубль.
const cache = new WeakMap<Take, Mastered>();
export function mastered(t: Take): Mastered {
  let m = cache.get(t);
  if (!m) { m = master(b64ToBytes(t.pcm), t.rate); cache.set(t, m); }
  return m;
}
/** WAV как в игре (доводка) или как прислал Gemini. */
export const wavOf = (t: Take, raw = false) => pcmToWav(raw ? b64ToBytes(t.pcm) : mastered(t).pcm, t.rate);

function useUrl(t: Take | undefined, raw: boolean) {
  const url = useMemo(() => (t ? URL.createObjectURL(wavOf(t, raw)) : ''), [t, raw]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return url;
}

/** Длина реплики против лимита из README «Озвучка» game-sod. */
export function lengthHint(sec: number, limit?: [number, number]): string | null {
  if (!limit) return null;
  if (sec > limit[1] + 0.05) return `длиннее нормы: ${sec.toFixed(1)} с при ${limit[1]} с`;
  if (sec < limit[0] - 0.05) return `короче нормы: ${sec.toFixed(1)} с при ${limit[0]} с`;
  return null;
}

export function TakePlayer({ take, file, limit }: { take: Take; file: string; limit?: [number, number] }) {
  const [raw, setRaw] = useState(false);
  const url = useUrl(take, raw);
  const m = mastered(take);
  const hint = lengthHint(m.durationSec, limit);
  return (
    <div className="player">
      <audio controls src={url} />
      <span className="muted small">
        {formatDuration(m.durationSec)}{limit && <> из {limit[0]}–{limit[1]} с</>} · {m.lufs} LUFS · пик {m.peakDb} · {take.voice} · {take.model} · t {take.temperature}
      </span>
      {hint && <span className="badge stale">{hint}</span>}
      <label className="check small" title="Сравнить с тем, что прислал Gemini, без доводки">
        <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> сырой
      </label>
      <button className="btn" onClick={() => download(wavOf(take), file)}>⤓ WAV</button>
    </div>
  );
}

/** Прежние дубли: послушать, сделать выбранным, удалить. */
export function TakeHistory({ k, take, onPick }: { k: TakeKey; take?: Take; onPick: (t: Take) => void }) {
  const [list, setList] = useState<Take[]>([]);
  const [playing, setPlaying] = useState<number | null>(null);
  useEffect(() => { let on = true; void loadHistory(k).then((l) => on && setList(l)); return () => { on = false; }; }, [k, take]);
  const url = useUrl(playing === null ? undefined : list[playing], false);
  if (!list.length) return null;
  return (
    <div className="history">
      <div className="muted small">Прежние дубли ({list.length}) — выбранный уходит в игру:</div>
      {list.map((t, i) => (
        <div key={t.at} className="hrow">
          <button className="btn ghost" onClick={() => setPlaying(playing === i ? null : i)}>{playing === i ? '■' : '▶'}</button>
          <span className="muted small">{formatDuration(mastered(t).durationSec)} · {t.voice} · t {t.temperature} · {new Date(t.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}{t.text !== take?.text ? ' · другой текст' : ''}</span>
          <button className="btn" onClick={async () => { const n = await pickTake(k, i, take); setPlaying(null); if (n) onPick(n); }}>★ Выбрать</button>
          <button className="btn ghost" onClick={async () => { await dropHistory(k, i); setPlaying(null); setList(await loadHistory(k)); }}>✕</button>
        </div>
      ))}
      {playing !== null && <audio autoPlay controls src={url} onEnded={() => setPlaying(null)} />}
    </div>
  );
}
