import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeminiTTS, pcmToWav } from '../../src/providers/tts/gemini-tts.ts';
import { RateLimiter } from '../../src/core/retry.ts';

const audio = (bytes: number) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(bytes, 1).toString('base64') } }] } }] }), { status: 200 });

test('pcmToWav: valid 24 kHz mono 16-bit header', () => {
  const w = pcmToWav(Buffer.alloc(48000));
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.toString('ascii', 8, 12), 'WAVE');
  assert.equal(w.readUInt32LE(24), 24000);
  assert.equal(w.readUInt16LE(34), 16);
  assert.equal(w.readUInt32LE(40), 48000);
  assert.equal(w.length, 44 + 48000);
});

test('gemini tts: Charon voice, key in header, retries 429, writes WAV with correct duration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gtts-'));
  const calls: RequestInit[] = [];
  const responses = [new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 }), audio(96000)];
  const f = (async (_u: string, init: RequestInit) => { calls.push(init); return responses.shift()!; }) as unknown as typeof fetch;
  try {
    const tts = new GeminiTTS({ apiKey: 'AQ.TESTKEY', model: 'm', voice: 'Charon', style: 'اقرأ بهدوء:', fetchImpl: f, sleep: async () => {}, limiter: new RateLimiter(100, 100) });
    const r = await tts.synthesize('مرحبا', join(dir, 'scene-1.aiff'));
    assert.equal(calls.length, 2, 'retried after 429');
    assert.equal((calls[0]!.headers as Record<string, string>)['x-goog-api-key'], 'AQ.TESTKEY');
    const body = JSON.parse(String(calls[1]!.body));
    assert.equal(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Charon');
    assert.match(body.contents[0].parts[0].text, /^اقرأ بهدوء:\n\nمرحبا$/);
    assert.ok(r.audioPath.endsWith('scene-1.gemini.wav'), 'never collides with the renderer\'s scene-1.wav');
    assert.equal(r.durationSec, 2);
    assert.equal(readFileSync(r.audioPath).toString('ascii', 0, 4), 'RIFF');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gemini tts: non-retryable error surfaces immediately', async () => {
  let n = 0;
  const f = (async () => { n++; return new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 400 }); }) as unknown as typeof fetch;
  const tts = new GeminiTTS({ apiKey: 'k', model: 'm', voice: 'Charon', style: '', fetchImpl: f, sleep: async () => {}, limiter: new RateLimiter(100, 100) });
  await assert.rejects(tts.synthesize('x', '/tmp/x.aiff'), /HTTP 400/);
  assert.equal(n, 1);
});

test('gemini-tts: daily quota on one model moves to the next; WAV replies are kept as-is', async () => {
  const urls: string[] = [];
  const wav = pcmToWav(Buffer.alloc(24000 * 2), 24000);
  const replies = [
    new Response(JSON.stringify({ error: { message: 'Quota exceeded ... requests per day limit exceeded on Free Tier' } }), { status: 429 }),
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }] } }] }), { status: 200 }),
  ];
  const f = (async (url: string) => { urls.push(url); return replies.shift()!; }) as unknown as typeof fetch;
  const dir = mkdtempSync(join(tmpdir(), 'tts-'));
  const tts = new GeminiTTS({ apiKey: 'k', model: 'a-tts, b-tts', voice: 'Charon', style: '', fetchImpl: f, sleep: async () => {}, limiter: new RateLimiter(100, 100) });
  const r = await tts.synthesize('مرحبا', join(dir, 'x.aiff'));
  assert.ok(urls[0]!.includes('/a-tts:') && urls[1]!.includes('/b-tts:'));
  assert.equal(r.voice, 'Charon (b-tts)');
  assert.ok(Math.abs(r.durationSec - 1) < 0.01);
  assert.equal(readFileSync(r.audioPath).subarray(0, 4).toString('latin1'), 'RIFF');
  assert.equal(readFileSync(r.audioPath).length, wav.length, 'not double-wrapped');
  rmSync(dir, { recursive: true, force: true });
});
