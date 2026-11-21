import { createStore, del, entries, get, set } from 'idb-keyval';
import type { Take, TakeKey } from '../types';

// Всё живёт в IndexedDB браузера: перезагрузка страницы ничего не теряет.
const takes = createStore('odyssey-voice', 'takes');
const prefs = createStore('odyssey-voice-prefs', 'prefs');

export const loadTakes = async () => new Map((await entries<TakeKey, Take>(takes)));
export const saveTake = (k: TakeKey, t: Take) => set(k, t, takes);
export const dropTake = (k: TakeKey) => del(k, takes);

export const loadPref = <T,>(k: string) => get<T>(k, prefs);
export const savePref = (k: string, v: unknown) => set(k, v, prefs);
