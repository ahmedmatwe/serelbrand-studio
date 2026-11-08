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

test('phone screen: dialer types the code when it is spoken; settings walk the path in order', async () => {
  const { phoneUiEvents, codeTimes, pathTimes } = await import('../../src/media/phone-ui.ts');
  const say = (t: string) => scriptWords(t).map((w, i) => ({ w, start: i * 0.5, end: i * 0.5 + 0.4, matched: true }));
  const d = say('افتح الاتصال واكتب نجمة، شباك، صفر، ستة، شباك. هيظهرلك الرقم.');
  assert.deepEqual(codeTimes(d, '*#06#'), [1.5, 2, 2.5, 3, 3.5]);
  const ev = phoneUiEvents({ type: 'dialer', code: '*#06#' }, d, 10, 8, 1080)!;
  assert.ok(ev.some((e) => e.text.endsWith('*#06#') && e.start === 13.5), 'full code shown when the last symbol is said');
  const s = say('ادخل على الإعدادات وبعدين تسهيلات الاستخدام واختار اللمس وبعدين النقر على الظهر.');
  const t = pathTimes(s, ['الإعدادات', 'تسهيلات الاستخدام', 'اللمس', 'النقر على الظهر']);
  assert.ok(t.every((x, i) => Number.isFinite(x) && (i === 0 || x > t[i - 1]!)), JSON.stringify(t));
  assert.ok(phoneUiEvents({ type: 'settings', os: 'ios', path: ['الإعدادات', 'تسهيلات الاستخدام', 'اللمس', 'النقر على الظهر'] }, s, 0, 10, 1080)!.length > 20);
  assert.equal(phoneUiEvents({ type: 'dialer', code: '*#06#' }, say('كلام مالوش علاقة بالكود خالص'), 0, 5, 1080), undefined, 'never shown when not said');
  for (const x of lib.secrets) if (x.ui?.type === 'dialer') assert.equal(x.ui.code, x.onScreen, x.id);
  assert.ok(lib.secrets.every((x) => (x.footage?.length ?? 0) >= 3), 'every secret has its own visuals');
});

test('verification: claims taken from a reviewed library entry are verified against it; foreign claims are not', async () => {
  const { libraryCovers } = await import('../../src/agents/auto-verifier.ts');
  const e = lib.secrets.find((x) => x.id === 'ios-silence-unknown')!;
  // The exact claims the web verifier wrongly deleted in a real run.
  assert.ok(libraryCovers("iPhone has a 'Silence Unknown Callers' feature that sends unknown numbers to voicemail.", e));
  assert.ok(libraryCovers("In iOS 18, the Phone settings can be found under the 'Apps' section in the Settings app.", e));
  assert.ok(libraryCovers('نظام iOS يحتوي على ميزة إسكات المتصلين المجهولين في إعدادات الهاتف لكتم الأرقام غير المسجلة مع حفظها في سجل المكالمات.', e));
  assert.ok(!libraryCovers('Apple sold 230 million iPhones in 2015.', e), 'unrelated numbers never pass');
  assert.ok(!libraryCovers('اكتب الكود *#9900# عشان تسرّع الموبايل', lib.secrets.find((x) => x.id === 'code-imei')!), 'a code not in the entry never passes');
});
