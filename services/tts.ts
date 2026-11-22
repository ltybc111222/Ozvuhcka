import { GoogleGenAI, Modality } from '@google/genai';
import { b64ToBytes, bytesToB64, cleanGeminiPcm, rateOf } from '../utils/wav';
import type { Take, TtsModel } from '../types';

let client: GoogleGenAI | null = null;
function ai(): GoogleGenAI {
  const key = process.env.API_KEY || process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Нет ключа Gemini API (GEMINI_API_KEY). В AI Studio он подставляется сам.');
  // speechConfig и speechMetadata есть только в v1beta; SDK по умолчанию может уйти в v1 (локально так и было: 400).
  return (client ??= new GoogleGenAI({ apiKey: key, apiVersion: 'v1beta' }));
}

export type TtsRequest = { text: string; style: string; voice: string; model: TtsModel; temperature: number; lang: 'ru' | 'en' };

/**
 * Одна реплика. Стиль идёт в speechMetadata.style — модель его не читает вслух;
 * метки <short pause>, <long pause>, <sigh>, <exhales> и ударения остаются в тексте.
 */
export async function synthesize(r: TtsRequest, signal?: AbortSignal): Promise<Take> {
  const res = await ai().models.generateContent({
    model: r.model,
    contents: [{ role: 'user', parts: [{ text: r.text, speechMetadata: r.style.trim() ? { style: r.style.trim() } : undefined }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      temperature: r.temperature,
      abortSignal: signal,
      speechConfig: {
        languageCode: r.lang,
        voiceConfig: { prebuiltVoiceConfig: { voiceName: r.voice } },
      },
    },
  });
  const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  const data = part?.inlineData?.data;
  if (!data) {
    const why = res.candidates?.[0]?.finishReason ?? res.promptFeedback?.blockReason ?? 'нет аудио в ответе';
    throw new Error(`Модель не вернула звук: ${why}`);
  }
  const clean = cleanGeminiPcm(b64ToBytes(data), rateOf(part?.inlineData?.mimeType));
  const rate = clean.rate;
  return {
    pcm: bytesToB64(clean.pcm), rate, voice: r.voice, model: r.model, temperature: r.temperature,
    durationSec: clean.pcm.length / 2 / rate, text: r.text, style: r.style, at: Date.now(),
  };
}

/** Понятный текст ошибки для карточки (лимиты, ключ, сеть). */
export function explain(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (dailyQuota(e)) {
    const h = /retry in (?:(\d+)h)?(?:(\d+)m)?/i.exec(m);
    const when = h ? ` Сброс примерно через ${h[1] ?? 0} ч ${h[2] ?? 0} мин.` : '';
    return `Дневной лимит бесплатного тарифа Gemini исчерпан (${/limit: (\d+)/.exec(m)?.[1] ?? '10'} запросов в сутки на модель).${when} Снять лимит: включить оплату в AI Studio.`;
  }
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(m)) return 'Лимит запросов Gemini: подождите минуту или увеличьте паузу очереди.';
  if (/API key|PERMISSION_DENIED|401|403/i.test(m)) return 'Ключ Gemini не подошёл или нет доступа к модели.';
  if (/abort/i.test(m)) return 'Остановлено.';
  return m.length > 300 ? m.slice(0, 300) + '…' : m;
}

/** Дневная квота: ждать и повторять бессмысленно, очередь надо остановить. */
export function dailyQuota(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /per ?day|PerDay/i.test(m);
}
