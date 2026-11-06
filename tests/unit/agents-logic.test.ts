import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countWords } from '../../src/agents/base.ts';
import { NICHE_CANDIDATES, WEIGHTS } from '../../src/agents/niche/candidates.ts';
import { scoreNiche, selectNiches } from '../../src/agents/niche/niche-selector.ts';
import { opportunityScore } from '../../src/agents/trend-research.ts';
import { buildCalendar, weeklySlots } from '../../src/agents/content-strategy.ts';
import { evaluateClaim, summarize } from '../../src/agents/fact-checker.ts';
import { validateConcept } from '../../src/agents/thumbnail.ts';
import { duplicateSentenceRatio, titleSupport } from '../../src/agents/compliance.ts';

test('countWords: handles Arabic diacritics (shadda/tashkeel) as part of the word', () => {
  assert.equal(countWords('قرار واحد غيّر كل شيء'), 5);
  assert.equal(countWords('مُحَمَّدٌ ذَهَبَ'), 2);
  assert.equal(countWords('سنة 2007 و٢٠١١'), 3); // attached و is part of the word
});

test('niche: weights sum to 100 and there are at least 10 candidates', () => {
  assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 100);
  assert.ok(NICHE_CANDIDATES.length >= 10);
});

test('niche: perfect ratings score 100, zero ratings score 0', () => {
  const base = NICHE_CANDIDATES[0]!;
  const all = (v: number) => Object.fromEntries(Object.keys(base.ratings).map((k) => [k, v])) as typeof base.ratings;
  assert.equal(scoreNiche({ ...base, ratings: all(10) }).score, 100);
  assert.equal(scoreNiche({ ...base, ratings: all(0) }).score, 0);
});

test('niche: unsafe niches are never primary even with the highest score', () => {
  const unsafe = { ...NICHE_CANDIDATES[0]!, id: 'unsafe', ratings: { ...Object.fromEntries(Object.keys(NICHE_CANDIDATES[0]!.ratings).map((k) => [k, 10])), policySafety: 2 } as any };
  const r = selectNiches([unsafe, ...NICHE_CANDIDATES]);
  assert.equal(r.ranked[0]!.id, 'unsafe');
  assert.notEqual(r.primary, 'unsafe');
  assert.ok(!r.top3.includes('unsafe'));
});

test('niche: confidence is capped when data is only estimated', () => {
  const r = selectNiches(NICHE_CANDIDATES, 'expert-estimates');
  assert.ok(r.confidence.value <= 0.65);
  assert.equal(r.backups.length, 2);
  assert.throws(() => selectNiches(NICHE_CANDIDATES.slice(0, 5)), /At least 10/);
});

test('opportunity score: bounded 0..100 and rewards safety', () => {
  const idea = { title: 'x x x x x', angle: '', seedQuery: 'q', targetAudience: '', searchIntent: 'curiosity', trendStatus: 'evergreen', competition: 'low', monetization: 'high', copyrightRisk: 'low', policyRisk: 'low', recommendedFormat: 'both', emotionalTrigger: '', contentGap: '', explanation: '' } as const;
  const safe = opportunityScore(idea, { query: 'q', interest: 80, momentum: 0, competition: 30, relatedQuestions: [] }).score;
  const risky = opportunityScore({ ...idea, copyrightRisk: 'high', policyRisk: 'high' }, { query: 'q', interest: 80, momentum: 0, competition: 30, relatedQuestions: [] }).score;
  assert.ok(safe <= 100 && safe >= 0);
  assert.ok(safe > risky);
});

test('calendar: respects weekly frequency and never repeats a Short title', () => {
  assert.deepEqual(weeklySlots(2), [0, 3]);
  const backlog = [
    { title: 'A', pillar: 'p', kind: 'evergreen' as const, shortsAngles: ['a1'] },
    { title: 'B', pillar: 'p', kind: 'trending' as const, shortsAngles: [] },
  ];
  const cal = buildCalendar(backlog, { startDate: new Date('2026-11-07'), days: 28, longPerWeek: 2, shortsPerWeek: 4 });
  assert.equal(cal.filter((c) => c.format === 'long').length, 2, 'each backlog topic used once — no repeats');
  assert.ok(cal.filter((c) => c.format === 'short').length >= 4);
  const shorts = cal.filter((c) => c.format === 'short').map((c) => c.title);
  assert.equal(new Set(shorts).size, shorts.length);
  assert.ok(cal.filter((c) => c.format === 'short').every((c) => c.linkedLongTitle));
});

const claim = (o: Partial<Parameters<typeof evaluateClaim>[0]>) => ({ claim: 'c', sceneN: 1, type: 'fact' as const, sourceUrl: 'https://example.org/a', sourceTitle: 't', sourceDate: '2025-01-01', confidence: 'high' as const, notes: '', searchQuery: '', ...o });

test('fact-check: rules decide status, not the model', () => {
  const now = new Date('2026-11-06');
  assert.equal(evaluateClaim(claim({}), now).status, 'needs_review', 'model-suggested https sources are never auto-verified');
  assert.equal(evaluateClaim(claim({}), now, { modelSourced: false }).status, 'verified');
  assert.equal(evaluateClaim(claim({ sourceUrl: null }), now).status, 'unverified');
  assert.equal(evaluateClaim(claim({ sourceUrl: 'mock://x' }), now).status, 'needs_review');
  assert.equal(evaluateClaim(claim({ confidence: 'medium' }), now, { modelSourced: false }).status, 'needs_review');
  assert.equal(evaluateClaim(claim({ type: 'statistic', sourceDate: '2015-01-01' }), now, { modelSourced: false }).status, 'needs_review');
  assert.equal(evaluateClaim(claim({ type: 'opinion', sourceUrl: null }), now).status, 'not_applicable');
  assert.equal(summarize([evaluateClaim(claim({ sourceUrl: null }), now)]).overall, 'blocked');
  assert.equal(summarize([evaluateClaim(claim({}), now, { modelSourced: false })]).overall, 'verified');
});

test('thumbnail: enforces max words and accuracy note', () => {
  const base = { mainVisual: 'هاتف', subject: '', background: '', palette: ['#000', '#fff'], text: 'ليه وقعت؟', composition: '', contrast: '', emotion: '', ctrRationale: '', accuracyNote: 'ok' };
  assert.ok(validateConcept(base, 5).valid);
  assert.ok(!validateConcept({ ...base, text: 'واحد اثنين ثلاثة أربعة خمسة ستة' }, 5).valid);
  assert.ok(!validateConcept({ ...base, accuracyNote: ' ' }, 5).valid);
});

test('compliance helpers: title support and duplicate detection', () => {
  assert.ok(titleSupport('قصة نوكيا والموبايلات', 'دي قصة شركة نوكيا وصناعة الموبايلات') >= 0.99);
  assert.ok(titleSupport('أسرار الفضاء الخارجي', 'قصة شركة نوكيا') < 0.4);
  assert.equal(duplicateSentenceRatio('جملة أولى طويلة هنا كفاية. جملة ثانية مختلفة تماماً عنها.'), 0);
  assert.ok(duplicateSentenceRatio('نفس الجملة تتكرر هنا كل مرة. نفس الجملة تتكرر هنا كل مرة. نفس الجملة تتكرر هنا كل مرة.') > 0.5);
});
