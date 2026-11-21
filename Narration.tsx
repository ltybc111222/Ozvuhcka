import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import embedded from './data/narration.json';
import { VOICES, fragKey, type CastMember, type Fragment, type Narration as Story, type Settings, type Take, type TakeKey } from './types';
import { explain, synthesize } from './services/tts';
import { dropTake, loadPref, savePref, saveTake } from './services/store';
import { b64ToBytes, download, formatDuration, pcmToWav } from './utils/wav';

const TAGS = ['<short pause>', '<long pause>', '<sigh>', '<exhales>'];
const ACUTE = '́';
/** Тишина между фрагментами в общем файле, с. */
const JOIN_GAP = 1.2;
type State = 'none' | 'ready' | 'stale' | 'busy' | 'error';
const sleep = (ms: number, s?: AbortSignal) => new Promise<void>((ok, no) => {
  const t = setTimeout(ok, ms);
  s?.addEventListener('abort', () => { clearTimeout(t); no(new Error('abort')); }, { once: true });
});
const story = embedded as Story;
const plain = (t: string) => t.replace(/<[^>]+>/g, ' ').replace(new RegExp(ACUTE, 'g'), '').replace(/\s+/g, ' ').trim();

type Props = {
  settings: Settings;
  takes: Map<TakeKey, Take>;
  setTakes: React.Dispatch<React.SetStateAction<Map<TakeKey, Take>>>;
};

export default function NarrationView({ settings, takes, setTakes }: Props) {
  const [narrator, setNarrator] = useState<CastMember>(story.narrator);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [sel, setSel] = useState(story.fragments[0].id);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [queue, setQueue] = useState<{ done: number; total: number } | null>(null);
  const [ready, setReady] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    (async () => {
      const [n, t] = await Promise.all([loadPref<CastMember>('story-narrator'), loadPref<Record<string, string>>('story-text')]);
      if (n) setNarrator({ ...story.narrator, ...n });
      if (t) setTexts(t);
      setReady(true);
    })().catch(() => setReady(true));
  }, []);
  useEffect(() => { if (ready) void savePref('story-narrator', narrator); }, [narrator, ready]);
  useEffect(() => { if (ready) void savePref('story-text', texts); }, [texts, ready]);

  const textOf = useCallback((f: Fragment) => texts[f.id] ?? f.text, [texts]);
  const stateOf = useCallback((f: Fragment): State => {
    if (busy.has(f.id)) return 'busy';
    if (errors.has(f.id)) return 'error';
    const t = takes.get(fragKey(f));
    if (!t) return 'none';
    return t.text === textOf(f) && t.voice === narrator.voice && t.style === narrator.style ? 'ready' : 'stale';
  }, [busy, errors, takes, textOf, narrator]);

  const missing = useMemo(() => story.fragments.filter((f) => stateOf(f) !== 'ready' && stateOf(f) !== 'busy'), [stateOf]);
  const recorded = story.fragments.filter((f) => takes.has(fragKey(f)));
  const total = recorded.reduce((s, f) => s + takes.get(fragKey(f))!.durationSec, 0);
  const cur = story.fragments.find((f) => f.id === sel) ?? story.fragments[0];

  const generate = useCallback(async (f: Fragment, signal?: AbortSignal) => {
    setBusy((b) => new Set(b).add(f.id));
    setErrors((m) => { const n = new Map(m); n.delete(f.id); return n; });
    try {
      const take = await synthesize({ text: textOf(f), style: narrator.style, voice: narrator.voice, model: settings.model, temperature: settings.temperature, lang: 'ru' }, signal);
      await saveTake(fragKey(f), take);
      setTakes((m) => new Map(m).set(fragKey(f), take));
    } catch (e) {
      setErrors((m) => new Map(m).set(f.id, explain(e)));
      throw e;
    } finally {
      setBusy((b) => { const n = new Set(b); n.delete(f.id); return n; });
    }
  }, [textOf, narrator, settings, setTakes]);

  const runQueue = async () => {
    const jobs = missing.slice();
    if (!jobs.length) return;
    const ac = new AbortController(); abort.current = ac;
    setQueue({ done: 0, total: jobs.length });
    try {
      for (let i = 0; i < jobs.length; i++) {
        for (let attempt = 0; ; attempt++) {
          try { await generate(jobs[i], ac.signal); break; } catch (e) {
            if (ac.signal.aborted) throw e;
            if (attempt >= 2) break;
            await sleep(3000 * (attempt + 1), ac.signal);
          }
        }
        setQueue({ done: i + 1, total: jobs.length });
        if (i < jobs.length - 1) await sleep(settings.gapMs, ac.signal);
      }
    } catch { /* остановлено */ } finally { abort.current = null; setQueue(null); }
  };

  const fileOf = (f: Fragment) => `${String(story.fragments.indexOf(f) + 1).padStart(2, '0')}_${f.id.replace(/^\d+_/, '')}.wav`;

  const exportZip = async () => {
    const zip = new JSZip();
    const manifest = recorded.map((f) => {
      const t = takes.get(fragKey(f))!;
      zip.file(fileOf(f), pcmToWav(b64ToBytes(t.pcm), t.rate));
      return { file: fileOf(f), title: f.title, voice: t.voice, model: t.model, temperature: t.temperature, durationSec: +t.durationSec.toFixed(2), text: t.text, style: t.style };
    });
    zip.file('manifest.json', JSON.stringify(manifest, null, 1));
    download(await zip.generateAsync({ type: 'blob' }), 'odyssey-story-ch1.zip');
  };

  // Один файл: фрагменты по порядку, между ними тишина. Склеиваем только при одной частоте.
  const exportJoined = () => {
    const parts = recorded.map((f) => takes.get(fragKey(f))!);
    const rate = parts[0].rate;
    if (parts.some((p) => p.rate !== rate)) { alert('Фрагменты записаны с разной частотой, склеить нельзя.'); return; }
    const gap = new Uint8Array(Math.round(JOIN_GAP * rate) * 2);
    const chunks = parts.flatMap((p, i) => (i ? [gap, b64ToBytes(p.pcm)] : [b64ToBytes(p.pcm)]));
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    download(pcmToWav(out, rate), 'odyssey-story-ch1-full.wav');
  };

  return (
    <div className="body">
      <aside className="side">
        <section className="card">
          <label>Голос рассказчика
            <select value={narrator.voice} onChange={(e) => setNarrator({ ...narrator, voice: e.target.value })}>
              {VOICES.map(([v, d]) => <option key={v} value={v}>{v} · {d}</option>)}
            </select>
          </label>
          <label>Инструкция стиля (не читается вслух)
            <textarea rows={5} value={narrator.style} onChange={(e) => setNarrator({ ...narrator, style: e.target.value })} />
          </label>
          <span className="muted small">Голос и стиль общие для всего рассказа. Смена делает записанные фрагменты устаревшими.</span>
        </section>
        <div className="row2" style={{ marginBottom: 8 }}>
          {queue ? (
            <button className="btn" onClick={() => abort.current?.abort()}>■ Стоп ({queue.done}/{queue.total})</button>
          ) : (
            <button className="btn primary" disabled={!missing.length} onClick={runQueue}>▶ Озвучить недостающее ({missing.length})</button>
          )}
        </div>
        <div className="row2" style={{ marginBottom: 8 }}>
          <button className="btn" disabled={!recorded.length} onClick={exportZip}>⤓ Фрагменты (zip)</button>
          <button className="btn" disabled={!recorded.length} onClick={exportJoined}>⤓ Одним файлом</button>
        </div>
        <div className="muted small">Записано {recorded.length} из {story.fragments.length} · {formatDuration(total)}</div>
        <div className="group">
          {story.fragments.map((f, i) => (
            <button key={f.id} className={`row ${f.id === cur.id ? 'sel' : ''}`} onClick={() => setSel(f.id)}>
              <span className="dots"><i className={`dot ${stateOf(f)}`} /></span>
              <span className="rtext"><b>{i + 1}. {f.title}</b><br /><span className="clip">{plain(textOf(f))}</span></span>
            </button>
          ))}
        </div>
      </aside>
      <main className="main">
        <div className="when">{story.title} · фрагмент {story.fragments.indexOf(cur) + 1} из {story.fragments.length} · <span className="warn">{cur.status}</span></div>
        <h1>{cur.title}</h1>
        <FragmentCard key={cur.id} f={cur} text={textOf(cur)} state={stateOf(cur)} take={takes.get(fragKey(cur))} error={errors.get(cur.id)}
          locked={!!queue} file={fileOf(cur)}
          onText={(t) => setTexts((m) => ({ ...m, [cur.id]: t }))}
          onReset={() => setTexts((m) => { const n = { ...m }; delete n[cur.id]; return n; })}
          onGenerate={() => generate(cur).catch(() => {})}
          onDrop={async () => { await dropTake(fragKey(cur)); setTakes((m) => { const n = new Map(m); n.delete(fragKey(cur)); return n; }); }} />
      </main>
    </div>
  );
}

function FragmentCard(p: {
  f: Fragment; text: string; state: State; take?: Take; error?: string; locked: boolean; file: string;
  onText: (t: string) => void; onReset: () => void; onGenerate: () => void; onDrop: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const url = useMemo(() => p.take ? URL.createObjectURL(pcmToWav(b64ToBytes(p.take.pcm), p.take.rate)) : '', [p.take]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const insert = (s: string) => {
    const el = ref.current; if (!el) return;
    const a = el.selectionStart ?? p.text.length, b = el.selectionEnd ?? a;
    p.onText(p.text.slice(0, a) + s + p.text.slice(b));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + s.length, a + s.length); });
  };
  return (
    <section className="card">
      <div className="row2">
        <span className={`badge ${p.state}`}>{{ none: 'нет записи', ready: 'готово', stale: 'устарело', busy: 'озвучиваю…', error: 'ошибка' }[p.state]}</span>
        <span className="muted small">{p.text.length} знаков · примерно {Math.round(plain(p.text).length / 14)} с</span>
        <span className="muted small mono">{p.file}</span>
      </div>
      <div className="tags">
        {TAGS.map((t) => <button key={t} className="tag" onClick={() => insert(` ${t} `)}>{t}</button>)}
        <button className="tag" title="Ударение над гласной перед курсором" onClick={() => insert(ACUTE)}>ударение а́</button>
        {p.text !== p.f.text && <button className="tag" onClick={p.onReset}>↺ как в сценарии</button>}
      </div>
      <textarea ref={ref} rows={18} className="script" value={p.text} onChange={(e) => p.onText(e.target.value)} />
      {p.error && <div className="err">{p.error}</div>}
      <div className="row2">
        <button className="btn primary" disabled={p.state === 'busy' || p.locked || !p.text.trim()} onClick={p.onGenerate}>{p.take ? '↻ Перезаписать' : '🎙 Озвучить'}</button>
        {p.take && <>
          <audio controls src={url} />
          <span className="muted small">{formatDuration(p.take.durationSec)} · {p.take.voice} · {p.take.model}</span>
          <button className="btn" onClick={() => download(pcmToWav(b64ToBytes(p.take!.pcm), p.take!.rate), p.file)}>⤓ WAV</button>
          <button className="btn ghost" onClick={p.onDrop}>✕</button>
        </>}
      </div>
    </section>
  );
}
