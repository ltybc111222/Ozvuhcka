import { createStore, del, entries, get, set } from 'idb-keyval';
import type { Take, TakeKey } from '../types';
import { b64ToBytes, bytesToB64, cleanGeminiPcm } from '../utils/wav';

// Всё живёт в IndexedDB браузера: перезагрузка страницы ничего не теряет.
const takes = createStore('odyssey-voice', 'takes');
const prefs = createStore('odyssey-voice-prefs', 'prefs');
/** Прежние дубли реплики (выбранный лежит в takes). */
const history = createStore('odyssey-voice-history', 'takes');
export const HISTORY_MAX = 6;

/**
 * Записи до исправления хранили ответ Gemini целиком (WAV с блоком C2PA) как
 * будто это PCM: при загрузке вытаскиваем отсчёты и пересохраняем.
 */
function heal(t: Take): Take | null {
  const c = cleanGeminiPcm(b64ToBytes(t.pcm), t.rate);
  if (!c.fixed) return null;
  return { ...t, pcm: bytesToB64(c.pcm), rate: c.rate, durationSec: c.pcm.length / 2 / c.rate };
}

export async function loadTakes(): Promise<Map<TakeKey, Take>> {
  const all = await entries<TakeKey, Take>(takes);
  const out = new Map<TakeKey, Take>();
  for (const [k, t] of all) {
    const h = heal(t);
    if (h) await set(k, h, takes);
    out.set(k, h ?? t);
  }
  return out;
}
export const saveTake = (k: TakeKey, t: Take) => set(k, t, takes);
export const dropTake = (k: TakeKey) => del(k, takes);

export async function loadHistory(k: TakeKey): Promise<Take[]> {
  const list = (await get<Take[]>(k, history)) ?? [];
  const healed = list.map((t) => heal(t) ?? t);
  if (healed.some((t, i) => t !== list[i])) await set(k, healed, history);
  return healed;
}
export const saveHistory = (k: TakeKey, list: Take[]) => set(k, list.slice(0, HISTORY_MAX), history);

/** Новый дубль становится выбранным, прежний уходит в историю. */
export async function commitTake(k: TakeKey, t: Take, prev?: Take): Promise<void> {
  if (prev) await saveHistory(k, [prev, ...(await loadHistory(k))]);
  await saveTake(k, t);
}

export const loadPref = <T,>(k: string) => get<T>(k, prefs);
export const savePref = (k: string, v: unknown) => set(k, v, prefs);

/** Сделать выбранным дубль из истории; нынешний встаёт на его место первым. */
export async function pickTake(k: TakeKey, i: number, cur?: Take): Promise<Take | null> {
  const list = await loadHistory(k);
  const t = list[i];
  if (!t) return null;
  const rest = list.filter((_, j) => j !== i);
  await saveHistory(k, cur ? [cur, ...rest] : rest);
  await saveTake(k, t);
  return t;
}

export async function dropHistory(k: TakeKey, i: number): Promise<void> {
  await saveHistory(k, (await loadHistory(k)).filter((_, j) => j !== i));
}
