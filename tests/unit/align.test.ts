import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignWords, alignedCutPoints, normWord, scriptWords, similarity, timedChunks, type RecWord } from '../../src/media/align.ts';
import { layoutShots } from '../../src/media/shots.ts';
import { ttsPrompt } from '../../src/providers/tts/gemini-tts.ts';

const rec = (text: string, t0 = 0, step = 0.5): RecWord[] => text.split(' ').map((w, i) => ({ w, s: t0 + i * step, e: t0 + i * step + step * 0.8 }));

test('align: Arabic normalisation and fuzzy similarity', () => {
  assert.equal(normWord('أُسْعَارًا،'), 'اسعارا');
  assert.equal(normWord('٢٠٢٤'), '2024');
  assert.ok(similarity(normWord('يلتصق'), normWord('يلتسق')) >= 0.6, 'recogniser spelling slips still match');
  assert.ok(similarity('والنتيجه', 'النتيجه') >= 0.85, 'split/merged prefix');
  assert.ok(similarity('سوني', 'نينتندو') < 0.5);
});

test('align: speech read before the script (instructions read aloud) is detected and skipped', () => {
  const script = scriptWords('تأثير الإرساء هو السر النفسي الذي يجعل عقلك يعتمد على أول رقم.');
  const heard = [...rec('اقرأ النص التالي بصوت راوي وثائقي هادئ النبرة جاد'), ...rec('تأثير الإرساء هو السر النفسي الذي يجعل عقلك يعتمد على أول رقم', 6)];
  const al = alignWords(script, heard, 20);
  assert.ok(al.coverage > 0.9);
  assert.ok(al.leadIn >= 5, `lead-in ${al.leadIn}`);
  assert.equal(al.words[0]!.start, 6, 'first script word = when it is really said');
});

test('align: batch cut lands between the last word of a scene and the first of the next', () => {
  const a = 'السر الأول عن الأسعار ينتهي هنا.';
  const b = 'القصة الثانية عن سوني تبدأ الآن.';
  // The first scene is spoken slowly (1 s per word): proportional cutting would cut inside scene 1.
  const heard = [...rec('السر الأول عن الأسعار ينتهي هنا', 0, 1), ...rec('القصة الثانية عن سوني تبدأ الآن', 7, 0.4)];
  const al = alignWords(scriptWords(`${a} ${b}`), heard, 10);
  const [cut] = alignedCutPoints([a, b], al.words, [6.6]);
  assert.ok(cut! > 5.8 && cut! < 7, `cut ${cut}`);
});

test('align: unmatched words (numbers read out in full) are interpolated, not lost', () => {
  const al = alignWords(scriptWords('في عام 1974 أثبت كانمان الفكرة'), rec('في عام ألف وتسعمائة وأربعة وسبعين أثبت كانمان الفكرة'), 6);
  const n = al.words.find((w) => w.w === '1974')!;
  assert.ok(!n.matched && n.start >= al.words[1]!.end - 0.01 && n.end <= al.words[3]!.start + 0.01);
});

test('captions: timed by spoken words, no orphan word, never over long silences', () => {
  const words = alignWords(scriptWords('أنقذ المهندس كين كوتاراجي شركة سوني من ضياع مستقبل الألعاب.'), rec('أنقذ المهندس كين كوتاراجي شركة سوني من ضياع مستقبل الألعاب', 1), 8).words;
  const c = timedChunks(words, 10, 18, 4);
  assert.equal(c[0]!.start.toFixed(2), '10.95', 'appears when the first word is said (offset + 1 s)');
  assert.ok(c.every((x) => x.text.split(' ').length >= 2));
  for (let i = 1; i < c.length; i++) assert.ok(c[i]!.start >= c[i - 1]!.end - 1e-9, 'no overlap');
});

test('shots: cut where each sentence is actually spoken', () => {
  const shots = layoutShots([{ text: 'جملة أولى قصيرة.', query: 'a', start: 0 }, { text: 'جملة ثانية.', query: 'b', start: 4.2 }], 8);
  assert.equal(shots[0]!.query, 'a');
  assert.ok(Math.abs(shots[0]!.duration - 4.1) < 0.01, `first shot ${shots[0]!.duration}`);
  assert.ok(Math.abs(shots.reduce((s, x) => s + x.duration, 0) - 8) < 1e-6);
});

test('tts prompt: notes are labelled and in English, transcript last, no emphasis lists', () => {
  const p = ttsPrompt('Calm narrator.', 'النص هنا', { tone: 'جاد', pace: 'medium', emphasis: ['الإرساء'] });
  assert.match(p, /### TRANSCRIPT\nالنص هنا$/);
  assert.ok(!p.includes('الإرساء'), 'emphasis words were read aloud before — never sent');
  assert.ok(!p.includes('اقرأ'), 'no Arabic instruction verbs the voice could read');
});
