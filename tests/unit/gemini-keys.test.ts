import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { GeminiLLM } from '../../src/providers/llm/gemini.ts';
import { GeminiTTS } from '../../src/providers/tts/gemini-tts.ts';

const quota = () => new Response(JSON.stringify({ error: { message: 'Quota exceeded for metric generate_requests_per_model_per_day (PerDay)' } }), { status: 429 });

test('gemini keys: writing moves to the second key when the first one is out of daily quota', async () => {
  const used: string[] = [];
  const llm = new GeminiLLM({ apiKey: 'k1,k2', models: { writing: 'mA', light: 'mA' }, fetchImpl: (async (_u: string, init: RequestInit) => {
    const k = (init.headers as Record<string, string>)['x-goog-api-key']!; used.push(k);
    if (k === 'k1') return quota();
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }] }), { status: 200 });
  }) as unknown as typeof fetch });
  const r = await llm.generateJson({ task: 't', tier: 'light', system: 's', prompt: 'p', schema: z.object({ ok: z.boolean() }) });
  assert.deepEqual(r.data, { ok: true });
  assert.deepEqual(used, ['k1', 'k2']);
});

test('gemini keys: the voice moves to the second key when the first one is out of daily quota', async () => {
  const used: string[] = [];
  const pcm = Buffer.alloc(4800).toString('base64');
  const tts = new GeminiTTS({ apiKey: 'k1,k2', model: 'tA', voice: 'Charon', style: '', sleep: async () => {}, fetchImpl: (async (_u: string, init: RequestInit) => {
    const k = (init.headers as Record<string, string>)['x-goog-api-key']!; used.push(k);
    if (k === 'k1') return quota();
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: pcm, mimeType: 'audio/l16; rate=24000' } }] } }] }), { status: 200 });
  }) as unknown as typeof fetch });
  const wav = await (tts as unknown as { once: (t: string) => Promise<Buffer> }).once('أهلاً');
  assert.equal(wav.subarray(0, 4).toString('latin1'), 'RIFF');
  assert.deepEqual(used, ['k1', 'k2']);
});
