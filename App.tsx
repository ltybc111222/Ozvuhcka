import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import embedded from './data/voiceScript.json';
import { VOICES, takeKey, type CastMember, type Lang, type ScriptLine, type Settings, type Take, type TakeKey, type VoiceScript } from './types';
import { explain, synthesize } from './services/tts';
import { dropTake, loadPref, loadTakes, savePref, saveTake } from './services/store';
import { b64ToBytes, download, formatDuration, pcmToWav } from './utils/wav';

const TAGS = ['<short pause>', '<long pause>', '<sigh>', '<exhales>'];
const ACUTE = '́';
const DEFAULTS: Settings = { model: 'gemini-3.8-flash-tts', temperature: 1, gapMs: 1500, lang: 'both' };
type LineState = 'none' | 'ready' | 'stale' | 'busy' | 'error';
const lineId = (l: ScriptLine) => `${l.folder}/${l.file}`;
const sleep = (ms: number, s?: AbortSignal) => new Promise<void>((ok, no) => {
  const t = setTimeout(ok, ms);
  s?.addEventListener('abort', () => { clearTimeout(t); no(new Error('abort')); }, { once: true });
});

export default function App() {
  const [script, setScript] = useState<VoiceScript>(embedded as VoiceScript);
  const [castEdits, setCastEdits] = useState<Record<string, Partial<CastMember>>>({});
  const [textEdits, setTextEdits] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [takes, setTakes] = useState<Map<TakeKey, Take>>(new Map());
  const [busy, setBusy] = useState<Set<TakeKey>>(new Set());
  const [errors, setErrors] = useState<Map<TakeKey, string>>(new Map());
  const [sel, setSel] = useState<string>('');
  const [who, setWho] = useState<string>('');
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [queue, setQueue] = useState<{ done: number; total: number } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [ready, setReady] = useState(false);

  // Загрузка состояния из IndexedDB.
  useEffect(() => {
    (async () => {
      const [t, s, c, e, st] = await Promise.all([
        loadTakes(), loadPref<VoiceScript>('script'), loadPref<Record<string, Partial<CastMember>>>('cast'),
        loadPref<Record<string, string>>('text'), loadPref<Settings>('settings'),
      ]);
      setTakes(t);
      if (s?.lines?.length) setScript(s);
      if (c) setCastEdits(c);
      if (e) setTextEdits(e);
      if (st) setSettings({ ...DEFAULTS, ...st });
      setReady(true);
    })().catch(() => setReady(true));
  }, []);
  useEffect(() => { if (ready) void savePref('cast', castEdits); }, [castEdits, ready]);
  useEffect(() => { if (ready) void savePref('text', textEdits); }, [textEdits, ready]);
  useEffect(() => { if (ready) void savePref('settings', settings); }, [settings, ready]);

  const cast = useCallback((k: string): CastMember => {
    const base = script.cast[k] ?? { name: k, voice: 'Charon', style: '' };
    return { ...base, ...castEdits[k] };
  }, [script, castEdits]);
  const textOf = useCallback((l: ScriptLine, lang: Lang) => textEdits[takeKey(l, lang)] ?? l[lang], [textEdits]);
  const langs: Lang[] = settings.lang === 'both' ? ['ru', 'en'] : [settings.lang];

  const stateOf = useCallback((l: ScriptLine, lang: Lang): LineState => {
    const k = takeKey(l, lang);
    if (busy.has(k)) return 'busy';
    if (errors.has(k)) return 'error';
    const t = takes.get(k);
    if (!t) return 'none';
    const c = cast(l.who);
    return t.text === textOf(l, lang) && t.voice === c.voice && t.style === c.style ? 'ready' : 'stale';
  }, [busy, errors, takes, cast, textOf]);

  const visible = useMemo(() => script.lines.filter((l) =>
    (!who || l.who === who) && (!onlyMissing || langs.some((g) => stateOf(l, g) !== 'ready'))), [script, who, onlyMissing, langs, stateOf]);
  const missing = useMemo(() => visible.flatMap((l) => langs.filter((g) => {
    const s = stateOf(l, g); return s === 'none' || s === 'stale' || s === 'error';
  }).map((g) => [l, g] as const)), [visible, langs, stateOf]);
  const current = script.lines.find((l) => lineId(l) === sel) ?? visible[0] ?? script.lines[0];

  const generate = useCallback(async (l: ScriptLine, lang: Lang, signal?: AbortSignal) => {
    const k = takeKey(l, lang), c = cast(l.who);
    setBusy((b) => new Set(b).add(k));
    setErrors((m) => { const n = new Map(m); n.delete(k); return n; });
    try {
      const take = await synthesize({ text: textOf(l, lang), style: c.style, voice: c.voice, model: settings.model, temperature: settings.temperature, lang }, signal);
      await saveTake(k, take);
      setTakes((m) => new Map(m).set(k, take));
    } catch (e) {
      setErrors((m) => new Map(m).set(k, explain(e)));
      throw e;
    } finally {
      setBusy((b) => { const n = new Set(b); n.delete(k); return n; });
    }
  }, [cast, textOf, settings]);

  // Очередь: по одному, пауза между запросами, до двух повторов на ошибке.
  const runQueue = async () => {
    const jobs = missing.slice();
    if (!jobs.length) return;
    const ac = new AbortController(); abort.current = ac;
    setQueue({ done: 0, total: jobs.length });
    try {
      for (let i = 0; i < jobs.length; i++) {
        const [l, g] = jobs[i];
        for (let attempt = 0; ; attempt++) {
          try { await generate(l, g, ac.signal); break; } catch (e) {
            if (ac.signal.aborted) throw e;
            if (attempt >= 2) break;
            await sleep(3000 * (attempt + 1), ac.signal);
          }
        }
        setQueue({ done: i + 1, total: jobs.length });
        if (i < jobs.length - 1) await sleep(settings.gapMs, ac.signal);
      }
    } catch { /* остановлено */ } finally {
      abort.current = null; setQueue(null);
    }
  };

  const exportZip = async () => {
    const zip = new JSZip();
    const manifest: unknown[] = [];
    for (const l of script.lines) for (const g of ['ru', 'en'] as Lang[]) {
      const t = takes.get(takeKey(l, g));
      if (!t) continue;
      const path = (g === 'ru' ? l.path_ru : l.path_en).replace(/\.ogg$/, '.wav');
      zip.file(path, pcmToWav(b64ToBytes(t.pcm), t.rate));
      manifest.push({ path, who: cast(l.who).name, lang: g, voice: t.voice, model: t.model, temperature: t.temperature, durationSec: +t.durationSec.toFixed(2), text: t.text, style: t.style });
    }
    zip.file('manifest.json', JSON.stringify(manifest, null, 1));
    download(await zip.generateAsync({ type: 'blob' }), 'odyssey-voice-ch1.zip');
  };

  const openJson = async (f: File) => {
    try {
      const s = JSON.parse(await f.text()) as VoiceScript;
      if (!s.cast || !Array.isArray(s.lines)) throw new Error('нет cast/lines');
      setScript(s); await savePref('script', s);
    } catch (e) { alert(`Не похоже на сценарий: ${explain(e)}`); }
  };

  const folders = useMemo(() => {
    const m = new Map<string, ScriptLine[]>();
    for (const l of visible) m.set(l.folder, [...(m.get(l.folder) ?? []), l]);
    return [...m];
  }, [visible]);
  const doneCount = script.lines.reduce((n, l) => n + langs.filter((g) => stateOf(l, g) === 'ready').length, 0);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <div className="title">Odyssey Quest · студия озвучки</div>
          <div className="muted">Глава 1 · {script.lines.length} реплик · готово {doneCount} из {script.lines.length * langs.length}</div>
        </div>
        <div className="controls">
          <label>Модель
            <select value={settings.model} onChange={(e) => setSettings({ ...settings, model: e.target.value as Settings['model'] })}>
              <option value="gemini-3.8-flash-tts">3.8 Flash TTS</option>
              <option value="gemini-3.8-flash-lite-tts">3.8 Lite TTS</option>
              <option value="gemini-3.1-flash-tts-preview">3.1 Flash TTS</option>
            </select>
          </label>
          <label>Темп. {settings.temperature.toFixed(1)}
            <input type="range" min={0.2} max={1.5} step={0.1} value={settings.temperature} onChange={(e) => setSettings({ ...settings, temperature: +e.target.value })} />
          </label>
          <label>Пауза, с
            <input type="number" min={0} max={30} step={0.5} value={settings.gapMs / 1000} onChange={(e) => setSettings({ ...settings, gapMs: Math.max(0, +e.target.value * 1000) })} />
          </label>
          <div className="seg">
            {(['ru', 'en', 'both'] as const).map((g) => (
              <button key={g} className={settings.lang === g ? 'on' : ''} onClick={() => setSettings({ ...settings, lang: g })}>{g === 'both' ? 'RU+EN' : g.toUpperCase()}</button>
            ))}
          </div>
          {queue ? (
            <button className="btn" onClick={() => abort.current?.abort()}>■ Стоп ({queue.done}/{queue.total})</button>
          ) : (
            <button className="btn primary" disabled={!missing.length} onClick={runQueue}>▶ Озвучить недостающее ({missing.length})</button>
          )}
          <button className="btn" disabled={!takes.size} onClick={exportZip}>⤓ Скачать всё (zip)</button>
          <label className="btn file">Открыть JSON<input type="file" accept=".json" onChange={(e) => e.target.files?.[0] && openJson(e.target.files[0])} /></label>
        </div>
      </header>

      <div className="body">
        <aside className="side">
          <div className="filters">
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">Все персонажи</option>
              {Object.keys(script.cast).map((k) => <option key={k} value={k}>{cast(k).name}</option>)}
            </select>
            <label className="check"><input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> только неготовые</label>
          </div>
          {folders.map(([folder, lines]) => (
            <div key={folder} className="group">
              <div className="gname">{folder}</div>
              {lines.map((l) => (
                <button key={lineId(l)} className={`row ${current && lineId(current) === lineId(l) ? 'sel' : ''}`} onClick={() => setSel(lineId(l))}>
                  <span className="dots">{langs.map((g) => <i key={g} className={`dot ${stateOf(l, g)}`} title={`${g.toUpperCase()}: ${stateOf(l, g)}`} />)}</span>
                  <span className="rtext"><b>{l.file}</b><span className="muted"> · {cast(l.who).name}</span><br /><span className="clip">{textOf(l, 'ru').replace(/<[^>]+>/g, '').replace(new RegExp(ACUTE, 'g'), '')}</span></span>
                </button>
              ))}
            </div>
          ))}
        </aside>

        {current && (
          <main className="main">
            <div className="when">{current.when} · <span className={current.status === 'утверждено' ? 'ok' : 'warn'}>{current.status}</span></div>
            <h1>{cast(current.who).name}: {current.file}</h1>
            <CastPanel k={current.who} c={cast(current.who)} onChange={(p) => setCastEdits((m) => ({ ...m, [current.who]: { ...m[current.who], ...p } }))} />
            {langs.map((g) => (
              <TakeCard key={g} line={current} lang={g} text={textOf(current, g)} state={stateOf(current, g)}
                take={takes.get(takeKey(current, g))} error={errors.get(takeKey(current, g))} locked={!!queue}
                onText={(t) => setTextEdits((m) => ({ ...m, [takeKey(current, g)]: t }))}
                onReset={() => setTextEdits((m) => { const n = { ...m }; delete n[takeKey(current, g)]; return n; })}
                onGenerate={() => generate(current, g).catch(() => {})}
                onDrop={async () => { await dropTake(takeKey(current, g)); setTakes((m) => { const n = new Map(m); n.delete(takeKey(current, g)); return n; }); }} />
            ))}
          </main>
        )}
      </div>
    </div>
  );
}

function CastPanel({ k, c, onChange }: { k: string; c: CastMember; onChange: (p: Partial<CastMember>) => void }) {
  return (
    <section className="card">
      <div className="row2">
        <label>Голос персонажа
          <select value={c.voice} onChange={(e) => onChange({ voice: e.target.value })}>
            {VOICES.map(([v, d]) => <option key={v} value={v}>{v} · {d}</option>)}
          </select>
        </label>
        <span className="muted small">Голос и стиль общие для всех реплик персонажа ({k}). Смена делает его дубли устаревшими.</span>
      </div>
      <label>Инструкция стиля (не читается вслух)
        <textarea rows={2} value={c.style} onChange={(e) => onChange({ style: e.target.value })} />
      </label>
    </section>
  );
}

function TakeCard(p: {
  line: ScriptLine; lang: Lang; text: string; state: LineState; take?: Take; error?: string; locked: boolean;
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
  const path = (p.lang === 'ru' ? p.line.path_ru : p.line.path_en).replace(/\.ogg$/, '.wav');
  const edited = p.text !== p.line[p.lang];
  return (
    <section className="card">
      <div className="row2">
        <b>{p.lang.toUpperCase()}</b>
        <span className={`badge ${p.state}`}>{{ none: 'нет записи', ready: 'готово', stale: 'устарело', busy: 'озвучиваю…', error: 'ошибка' }[p.state]}</span>
        <span className="muted small mono">{path}</span>
      </div>
      <div className="tags">
        {TAGS.map((t) => <button key={t} className="tag" onClick={() => insert(` ${t} `)}>{t}</button>)}
        {p.lang === 'ru' && <button className="tag" title="Ударение над гласной перед курсором" onClick={() => insert(ACUTE)}>ударение а́</button>}
        {edited && <button className="tag" onClick={p.onReset}>↺ как в сценарии</button>}
      </div>
      <textarea ref={ref} rows={3} className="script" value={p.text} onChange={(e) => p.onText(e.target.value)} />
      {p.error && <div className="err">{p.error}</div>}
      <div className="row2">
        <button className="btn primary" disabled={p.state === 'busy' || p.locked || !p.text.trim()} onClick={p.onGenerate}>{p.take ? '↻ Перезаписать' : '🎙 Озвучить'}</button>
        {p.take && <>
          <audio controls src={url} />
          <span className="muted small">{formatDuration(p.take.durationSec)} · {p.take.voice} · {p.take.model}</span>
          <button className="btn" onClick={() => download(pcmToWav(b64ToBytes(p.take!.pcm), p.take!.rate), path.split('/').pop()!)}>⤓ WAV</button>
          <button className="btn ghost" onClick={p.onDrop}>✕</button>
        </>}
      </div>
    </section>
  );
}
