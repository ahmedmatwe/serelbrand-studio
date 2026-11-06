import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ProviderError } from '../../core/errors.ts';
import { RateLimiter, withRetry } from '../../core/retry.ts';
import type { TTSProvider, TTSResult } from '../media.ts';

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

  private async once(text: string): Promise<Buffer> {
    await this.o.limiter.take();
    const res = await this.o.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.o.model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.o.apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${this.o.style}\n\n${text}` }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.o.voice } } } },
      }),
      signal: AbortSignal.timeout(300_000),
    }).catch((err: Error) => { throw new ProviderError('gemini-tts', `Network error: ${err.message}`, true, { cause: err }); });
    const j = (await res.json().catch(() => ({}))) as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[]; error?: { message?: string } };
    if (!res.ok) throw new ProviderError('gemini-tts', `HTTP ${res.status}: ${j.error?.message ?? res.statusText}`, res.status === 429 || res.status >= 500);
    const b64 = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
    if (!b64) throw new ProviderError('gemini-tts', 'No audio in response', true);
    return Buffer.from(b64, 'base64');
  }

  async synthesize(text: string, outPath: string): Promise<TTSResult> {
    const pcm = await withRetry(() => this.once(text), { attempts: 3, baseDelayMs: 20_000, sleep: this.o.sleep });
    // Separate file name so the renderer's own "<scene>.wav" conversion never overwrites the source.
    const path = outPath.replace(/\.[^./]+$/, '') + '.gemini.wav';
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, pcmToWav(pcm));
    return { audioPath: path, durationSec: pcm.length / (SAMPLE_RATE * 2), characters: text.length, voice: this.o.voice };
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
  synthesize(text: string, outPath: string) {
    return this.primary.synthesize(text, outPath);
  }
}
