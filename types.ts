export type Lang = 'ru' | 'en';

export type CastMember = { name: string; voice: string; style: string };

export type ScriptLine = {
  who: string;
  folder: string;
  file: string;
  when: string;
  ru: string;
  en: string;
  status: string;
  path_ru: string;
  path_en: string;
};

export type VoiceScript = { cast: Record<string, CastMember>; lines: ScriptLine[] };

/** Ключ дубля: строка + язык (у каждой реплики два файла). */
export type TakeKey = `${string}/${string}|${Lang}`;

export type Take = {
  /** PCM 16-бит моно, base64 (как отдаёт Gemini). */
  pcm: string;
  rate: number;
  voice: string;
  model: string;
  temperature: number;
  durationSec: number;
  /** Текст, по которому записано: правка текста делает дубль устаревшим. */
  text: string;
  style: string;
  at: number;
};

export type TtsModel = 'gemini-3.8-flash-tts' | 'gemini-3.8-flash-lite-tts' | 'gemini-3.1-flash-tts-preview';

export type Settings = {
  model: TtsModel;
  temperature: number;
  /** Пауза между запросами очереди, мс. */
  gapMs: number;
  lang: Lang | 'both';
};

/** Prebuilt-голоса Gemini TTS и короткая характеристика. */
export const VOICES: [string, string][] = [
  ['Zephyr', 'светлый'], ['Puck', 'бодрый'], ['Charon', 'ровный'], ['Kore', 'твёрдый'],
  ['Fenrir', 'взволнованный'], ['Leda', 'молодой'], ['Orus', 'твёрдый, низкий'], ['Aoede', 'лёгкий'],
  ['Callirrhoe', 'спокойный'], ['Autonoe', 'светлый'], ['Enceladus', 'с придыханием'], ['Iapetus', 'чёткий'],
  ['Umbriel', 'спокойный'], ['Algieba', 'бархатный'], ['Despina', 'мягкий'], ['Erinome', 'чёткий'],
  ['Algenib', 'хриплый'], ['Rasalgethi', 'деловой'], ['Laomedeia', 'бодрый'], ['Achernar', 'мягкий'],
  ['Alnilam', 'твёрдый'], ['Schedar', 'ровный'], ['Gacrux', 'зрелый'], ['Pulcherrima', 'напористый'],
  ['Achird', 'дружелюбный'], ['Zubenelgenubi', 'простой'], ['Vindemiatrix', 'нежный'], ['Sadachbia', 'живой'],
  ['Sadaltager', 'знающий'], ['Sulafat', 'тёплый'],
];

export const takeKey = (l: ScriptLine, lang: Lang): TakeKey => `${l.folder}/${l.file}|${lang}`;
