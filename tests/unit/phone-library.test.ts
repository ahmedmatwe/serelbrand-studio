import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPhoneLibrary, pickPhoneSecrets, secretSource } from '../../src/agents/niche/phone-library.ts';
import { ROOT } from '../helpers.ts';
import { alignWords, scriptWords, timedChunks } from '../../src/media/align.ts';
import { buildAss } from '../../src/media/ass.ts';

const lib = loadPhoneLibrary(ROOT)!;

test('phone library: every entry is complete, unique and safe', () => {
  const ids = new Set<string>();
  for (const s of lib.secrets) {
    assert.ok(!ids.has(s.id), `duplicate ${s.id}`); ids.add(s.id);
    assert.ok(s.title && s.onScreen && s.steps.length && s.result && s.use && s.facts.length > 80, s.id);
    assert.ok(lib.sources[s.source]?.startsWith('https://'), `${s.id} source`);
    // Never anything that wipes, resets or changes network settings.
    assert.doesNotMatch(s.onScreen + s.steps.join(' '), /2767|7780|##002#|\*#\*#7780|factory|ضبط المصنع|مسح كل البيانات|إعادة الضبط/i, s.id);
  }
  assert.ok(lib.secrets.length >= 30);
});

test('phone library: a pack mixes a code, an iPhone and an Android secret, never repeating', () => {
  const p = pickPhoneSecrets(lib, new Set());
  assert.equal(p.length, 3);
  assert.equal(p[0]!.kind, 'code');
  assert.ok(p[1]!.id.startsWith('ios-'));
  assert.ok(!p[2]!.id.startsWith('ios-') && p[2]!.kind !== 'code');
  const next = pickPhoneSecrets(lib, new Set(p.map((x) => x.id)));
  assert.ok(next.every((x) => !p.includes(x)));
  assert.match(secretSource(lib, p[0]!).excerpt, /\*#06#/);
});

test('captions: measured word-by-word highlight with a pop-in', () => {
  const words = alignWords(scriptWords('اكتب الكود ده في الاتصال'), ['اكتب', 'الكود', 'ده', 'في', 'الاتصال'].map((w, i) => ({ w, s: i * 0.5, e: i * 0.5 + 0.4 })), 3).words;
  const [c] = timedChunks(words, 0, 3, 7);
  assert.equal(c!.karaokeCs.length, 5);
  assert.equal(Math.round(c!.karaokeCs[1]!), 50, 'each word lasts until the next one starts');
  const ass = buildAss({ width: 1080, height: 1920, styles: [{ name: 'Sub', font: 'X', size: 80, color: '#FFD400', secondary: '#FFFFFF', outline: '#000000', outlineWidth: 4, alignment: 5, marginV: 0 }], events: [{ ...c!, style: 'Sub', pop: true }] });
  assert.match(ass, /\\fscx86\\fscy86\\t\(0,110,\\fscx100\\fscy100\)/);
  assert.equal((ass.match(/\{\\k\d+\}/g) ?? []).length, 5);
});
