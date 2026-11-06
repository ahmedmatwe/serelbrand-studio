import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeArabic } from '../../src/media/arabic-shaper.ts';
import { assColor, assText, assTime, buildAss, chunkSubtitles } from '../../src/media/ass.ts';
import { pickShortScenes, toSrt, timelineAss } from '../../src/media/renderer.ts';
import { filterPath } from '../../src/media/ffmpeg.ts';

const cps = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16));

test('shaper: contextual forms and lam-alef ligatures', () => {
  assert.deepEqual(cps(shapeArabic('بب')), ['fe91', 'fe90']); // initial + final
  assert.deepEqual(cps(shapeArabic('ببب')), ['fe91', 'fe92', 'fe90']); // medial in the middle
  assert.deepEqual(cps(shapeArabic('لا')), ['fefb']); // isolated lam-alef
  assert.deepEqual(cps(shapeArabic('ثلاثة')), ['fe9b', 'fefc', 'fe9b', 'fe94']); // ث initial, لا final, ث initial (joins ة), ة final
  assert.deepEqual(cps(shapeArabic('دب')), ['fea9', 'fe8f']); // د never joins forward
  assert.equal(shapeArabic('Nokia 2007'), 'Nokia 2007');
  assert.ok(!/[ء-ي]/.test(shapeArabic('قصة نوكيا: من القمة… للبيع')), 'no unshaped letters remain');
  // marks (shadda) are kept and do not break joining
  assert.deepEqual(cps(shapeArabic('غيّر')), ['fecf', 'fef4', '651', 'feae']);
});

test('ass: colors, times, escaping', () => {
  assert.equal(assColor('#112233'), '&H00332211');
  assert.equal(assTime(3661.5), '1:01:01.50');
  assert.ok(!assText('{\\b1}hack').includes('{'), 'override tags are neutralised');
  const doc = buildAss({ width: 100, height: 100, styles: [{ name: 'S', font: 'F', size: 10, color: '#fff', outline: '#000', outlineWidth: 1, alignment: 2, marginV: 5 }], events: [{ start: 0, end: 1, style: 'S', text: 'x' }, { start: 2, end: 2, style: 'S', text: 'empty' }] });
  assert.equal((doc.match(/^Dialogue:/gm) ?? []).length, 1, 'zero-length events dropped');
});

test('subtitles: chunks cover the scene, are ordered and short', () => {
  const text = 'في بداية الألفينات، كان تقريباً واحد من كل ثلاثة موبايلات في العالم بيحمل اسم شركة واحدة. شركة بدأت بتصنيع الورق في فنلندا';
  const c = chunkSubtitles(text, 10, 12, 9);
  assert.ok(c.length >= 3);
  assert.equal(c[0]!.start, 10);
  assert.ok(Math.abs(c.at(-1)!.end - 22) < 1e-6);
  assert.ok(c.every((x, i) => i === 0 || x.start >= c[i - 1]!.end - 1e-9));
  assert.ok(c.every((x) => x.text.split(' ').length <= 9));
  assert.equal(c.map((x) => x.text).join(' '), text);
});

test('srt and timeline: valid structure', () => {
  const srt = toSrt([{ start: 0, end: 1.5, text: 'أ' }, { start: 1.5, end: 3, text: 'ب' }]);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,500\nأ\n\n2\n00:00:01,500 --> 00:00:03,000\nب\n$/);
  const t = timelineAss([{ n: 1, start: 0, duration: 6, audioPath: '', voiceover: 'كلام كثير هنا للاختبار فقط', onScreenText: 'عنوان' }], { width: 1080, height: 1920, accent: '#FFD400', endCard: 'القصة كاملة' });
  assert.equal(t.subs.length, 1);
  assert.match(t.ass, /PlayResY: 1920/);
  assert.ok((t.ass.match(/^Dialogue:/gm) ?? []).length >= 3); // title + subtitle + end card
});

test('shorts: picks opening scenes within 58s', () => {
  assert.deepEqual(pickShortScenes([{ n: 1, duration: 20 }, { n: 2, duration: 30 }, { n: 3, duration: 20 }]), [1, 2]);
  assert.deepEqual(pickShortScenes([{ n: 1, duration: 70 }]), []);
});

test('ffmpeg filter paths are escaped', () => {
  assert.equal(filterPath("/a b/it's:x,y[1]"), "/a b/it\\'s\\:x\\,y\\[1\\]");
});

test('short script: hook + whole sentences within the word budget', async () => {
  const { shortScript } = await import('../../src/media/renderer.ts');
  const s = shortScript('سؤال البداية؟', 'جملة أولى قصيرة. جملة ثانية أطول شوية من الأولى. جملة ثالثة.', 9);
  assert.equal(s, 'سؤال البداية؟ جملة أولى قصيرة.');
  assert.equal(shortScript('', 'أ ب ج.', 2), '', 'never cuts a sentence in half');
});
