import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ProviderError } from '../../core/errors.ts';
import { RateLimiter, withRetry } from '../../core/retry.ts';
import type { TTSProvider, TTSResult, VoiceDirection } from '../media.ts';

const PACE_EN = { slow: 'slow, with clear pauses', medium: 'medium, natural', fast: 'brisk and energetic' } as const;

/**
 * Performance notes for the voice model. Kept in ENGLISH and in a labelled notes block: notes written in
 * Arabic right before the Arabic text were read aloud by the model ("اقرأ النص التالي… النبرة… شدّد على…"),
 * which put ~10 s of instructions at the start of a video and shifted every cut and caption after it.
 * Emphasis word lists are never sent (they were read out too).
 */
export function directionNote(d?: VoiceDirection): string {
  if (!d) return '';
  return [d.tone ? `Tone: ${d.tone}.` : '', d.pace ? `Pace: ${PACE_EN[d.pace]}.` : ''].filter(Boolean).join(' ');
}

/** The full TTS prompt: director's notes, then the transcript, which is the ONLY thing to be spoken. */
export function ttsPrompt(style: string, text: string, d?: VoiceDirection): string {
  const notes = [style.trim(), directionNote(d)].filter(Boolean).join(' ');
  if (!notes) return text;
  return [
    'Read the TRANSCRIPT aloud exactly, word for word, in Arabic. Speak nothing else: never read these notes, headings or the word "transcript".',
    '### DIRECTOR\'S NOTES',
    notes,
    '### TRANSCRIPT',
    text,
  ].join('\n');
}

const SAMPLE_RATE = 24_000; // Gemini TTS returns 16-bit mono PCM at 24 kHz

/** Wraps raw 16-bit mono PCM in a WAV header. */
export function pcmToWav(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export interface GeminiTTSOptions {
  apiKey: string;
  /** One model or a comma-separated fallback list (each model has its own free daily quota). */
  model: string;
  voice: string;
  /** Natural-language direction prepended to the text (Gemini TTS is steerable by prompt). */
  style: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  limiter?: RateLimiter;
}

/** Natural-sounding Gemini TTS (free tier). Same API key as the Gemini LLM; the key goes in a header. */
export class GeminiTTS implements TTSProvider {
  readonly name = 'gemini-tts';
  private readonly o: GeminiTTSOptions & { fetchImpl: typeof fetch; limiter: RateLimiter };

  constructor(o: GeminiTTSOptions) {
    if (!o.apiKey) throw new ProviderError('gemini-tts', 'GEMINI_API_KEY is missing', false);
    this.o = { ...o, fetchImpl: o.fetchImpl ?? fetch, limiter: o.limiter ?? new RateLimiter(2, 6 / 60) };
  }

  /** (model, key) pairs in order: each model on each key (a second key = another project's free quota). */
  private readonly combos: { model: string; key: string }[] = [];
  private idx = 0;
  /** Model currently used (sticky until its daily quota runs out on every key). */
  get model(): string { return this.combos[this.idx]!.model; }
  private get models(): unknown[] { return this.combos; }

  private async once(text: string, direction?: VoiceDirection): Promise<Buffer> {
    if (!this.combos.length) {
      const keys = this.o.apiKey.split(',').map((k) => k.trim()).filter(Boolean);
      this.combos.push(...this.o.model.split(',').map((m) => m.trim()).filter(Boolean).flatMap((model) => keys.map((key) => ({ model, key }))));
    }
    await this.o.limiter.take();
    const res = await this.o.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.combos[this.idx]!.key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: ttsPrompt(this.o.style, text, direction) }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.o.voice } } } },
      }),
      signal: AbortSignal.timeout(600_000),
    }).catch((err: Error) => { throw new ProviderError('gemini-tts', `Network error: ${err.message}`, true, { cause: err }); });
    const j = (await res.json().catch(() => ({}))) as { candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[]; error?: { message?: string } };
    const msg = j.error?.message ?? res.statusText;
    // Daily free quota of this model used up → move to the next model (its quota is separate).
    if (res.status === 429 && /per day|PerDay/i.test(msg)) {
      if (this.idx < this.models.length - 1) { this.idx++; return this.once(text, direction); }
      throw new ProviderError('gemini-tts', `TTS_DAILY_QUOTA: ${msg.slice(0, 300)}`, false);
    }
    if (res.status === 404 && this.idx < this.models.length - 1) { this.idx++; return this.once(text, direction); }
    if (!res.ok) throw new ProviderError('gemini-tts', `HTTP ${res.status}: ${msg}`, res.status === 429 || res.status >= 500);
    const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
    if (!part?.data) throw new ProviderError('gemini-tts', 'No audio in response', true);
    const buf = Buffer.from(part.data, 'base64');
    // Newer models return a complete WAV; older ones raw 16-bit PCM (audio/l16; rate=24000).
    if (buf.subarray(0, 4).toString('latin1') === 'RIFF') return buf;
    const rate = Number(part.mimeType?.match(/rate=(\d+)/)?.[1] ?? SAMPLE_RATE);
    return pcmToWav(buf, rate);
  }

  async synthesize(text: string, outPath: string, direction?: VoiceDirection): Promise<TTSResult> {
    const wav = await withRetry(() => this.once(text, direction), { attempts: 3, baseDelayMs: 20_000, sleep: this.o.sleep });
    // Separate file name so the renderer's own "<scene>.wav" conversion never overwrites the source.
    const path = outPath.replace(/\.[^./]+$/, '') + '.gemini.wav';
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, wav);
    const rate = wav.readUInt32LE(24) || SAMPLE_RATE;
    const channels = wav.readUInt16LE(22) || 1;
    return { audioPath: path, durationSec: Math.max(0, wav.length - 44) / (rate * 2 * channels), characters: text.length, voice: `${this.o.voice} (${this.model})` };
  }
}

/**
 * Primary voice with a whole-video fallback. The renderer re-voices ALL scenes with the fallback
 * if the primary fails part-way, so one video never mixes two voices.
 */
export class FallbackTTS implements TTSProvider {
  readonly name: string;
  readonly primary: TTSProvider;
  readonly fallback: TTSProvider;
  constructor(primary: TTSProvider, fallback: TTSProvider) {
    this.primary = primary;
    this.fallback = fallback;
    this.name = primary.name;
  }
  synthesize(text: string, outPath: string, direction?: VoiceDirection) {
    return this.primary.synthesize(text, outPath, direction);
  }
}

/** Seconds until the quota resets, parsed from Google's "Please retry in 11h37m27s" (default: 12h). */
export function quotaResetSeconds(message: string): number {
  const m = message.match(/retry in\s+(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i);
  if (!m || (!m[1] && !m[2] && !m[3])) return 12 * 3600;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Math.ceil(Number(m[3] ?? 0));
}
