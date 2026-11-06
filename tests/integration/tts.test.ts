import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MacSayTTS } from '../../src/providers/tts/macos-say.ts';

test('macOS say: synthesizes Arabic speech offline (skipped off macOS / without Majed)', async (t) => {
  if (!(await MacSayTTS.available('Majed'))) return t.skip('Majed voice not available');
  const dir = mkdtempSync(join(tmpdir(), 'tts-'));
  try {
    const r = await new MacSayTTS('Majed').synthesize('مرحباً، هذا اختبار للصوت العربي.', join(dir, 'a.wav'));
    assert.ok(r.audioPath.endsWith('.aiff'));
    assert.ok(existsSync(r.audioPath));
    assert.ok(r.durationSec > 1 && r.durationSec < 10, `duration ${r.durationSec}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
