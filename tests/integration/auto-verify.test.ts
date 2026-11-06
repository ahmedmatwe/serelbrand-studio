import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testContext } from '../helpers.ts';
import { MockLLM } from '../../src/providers/llm/mock.ts';
import { MOCK_FIXTURES } from '../../src/providers/llm/fixtures.ts';
import { steps } from '../../src/workflows/steps.ts';
import type { WebProvider } from '../../src/providers/web/web.ts';
import type { AutoVerifyOutput } from '../../src/agents/auto-verifier.ts';

// Evidence for every fixture claim except the "1 in 3 phones" statistic, which only one site confirms.
const WIKI = 'Nokia was founded in 1865 as a pulp mill in Finland.\nApple announced the iPhone in 2007 at Macworld.\nIn February 2011 Nokia and Microsoft announced a partnership to use Windows Phone.\nIn September 2013 Microsoft announced it would acquire Nokia\'s Devices and Services business.\nAround the early 2000s roughly one in three mobile phones sold worldwide was a Nokia.';
const fakeWeb: WebProvider = {
  name: 'fake-web',
  async fetchText(url) { return { url, text: '' }; },
  async wikipedia(_q, lang) { return lang === 'en' ? [{ url: 'https://en.wikipedia.org/wiki/Nokia', text: WIKI }] : []; },
};
/** Judge that quotes the line containing the claim's year (verbatim) — or invents a quote for the statistic. */
const judge = (vars: Record<string, unknown>) => vars;
function fixtures(fixCalls: { n: number }) {
  return {
    ...MOCK_FIXTURES,
    'factcheck.judge': () => ({ verdict: 'supported', quote: '', correction: null }),
    'script.fixclaims': (v: Record<string, unknown>) => { fixCalls.n++; return v.previous; },
  };
}

test('auto-verify: verbatim-quoted facts pass; single-source statistic stays unverified, triggers script fix, then blocks', async () => {
  const fixCalls = { n: 0 };
  const llm = new MockLLM(fixtures(fixCalls));
  // Replace the judge with one that reads the prompt and quotes the matching line from the evidence.
  const origGen = llm.generateJson.bind(llm);
  llm.generateJson = (async (req: Parameters<typeof origGen>[0]) => {
    if (req.task !== 'factcheck.judge') return origGen(req);
    const { claim, sourceText } = JSON.parse(req.prompt) as { claim: string; sourceText: string };
    const year = claim.match(/\d{4}/)?.[0];
    const line = (sourceText as string).split('\n').find((l) => (year ? l.includes(year) : /one in three/.test(l))) ?? '';
    return { data: req.schema.parse({ verdict: line ? 'supported' : 'not_found', quote: line, correction: null }), usage: { inputTokens: 1, outputTokens: 1, model: 'judge' } };
  }) as typeof llm.generateJson;
  void judge;

  const ctx = testContext({ llm });
  const v = ctx.repos.videos.create({ title: 'نوكيا', format: 'long' });
  (ctx.providers as { web: WebProvider }).web = fakeWeb;
  await steps.scriptwriter(ctx, { videoId: v.id });
  await steps['fact-checker'](ctx, { videoId: v.id });
  const out = (await steps['auto-verifier'](ctx, { videoId: v.id, maxRounds: 1, cutUnproven: false })) as AutoVerifyOutput;

  const byText = (t: string) => out.claims.find((c) => c.claim.includes(t))!;
  assert.equal(byText('1865').status, 'verified');
  assert.equal(byText('1865').sourceUrl, 'https://en.wikipedia.org/wiki/Nokia');
  assert.equal(byText('2007').status, 'verified');
  assert.equal(byText('2013').status, 'verified');
  const stat = byText('ثلاثة');
  assert.equal(stat.type, 'statistic');
  assert.equal(stat.status, 'unverified', 'statistics need 2 independent sites');
  assert.equal(byText('رهان').status, 'not_applicable', 'opinions are not fact-checked');
  assert.equal(fixCalls.n, 1, 'script fixer called once for the unverifiable claim');
  assert.ok(out.removedClaims.length >= 1);
  assert.equal(out.overall, 'blocked', 'still unverified after the last round → never publishable');
  assert.equal(ctx.repos.artifacts.latest(v.id, 'fact_check')!.data && (ctx.repos.artifacts.latest<AutoVerifyOutput>(v.id, 'fact_check')!.data).overall, 'blocked');
  ctx.close();
});

test('auto-verify: a judge quote that is NOT in the page is ignored (no hallucinated evidence)', async () => {
  const llm = new MockLLM({ ...MOCK_FIXTURES, 'factcheck.judge': () => ({ verdict: 'supported', quote: 'Nokia was founded in 1865 by a famous engineer named Fredrik Idestam', correction: null }) });
  const ctx = testContext({ llm });
  (ctx.providers as { web: WebProvider }).web = fakeWeb;
  const v = ctx.repos.videos.create({ title: 'نوكيا', format: 'long' });
  await steps.scriptwriter(ctx, { videoId: v.id });
  await steps['fact-checker'](ctx, { videoId: v.id });
  const out = (await steps['auto-verifier'](ctx, { videoId: v.id, maxRounds: 0 })) as AutoVerifyOutput;
  assert.ok(out.claims.filter((c) => c.type !== 'opinion').every((c) => c.status === 'unverified'));
  ctx.close();
});

test('auto-verify: after the last round the unproven sentence is cut, so only proven facts remain', async () => {
  const llm = new MockLLM(fixtures({ n: 0 }));
  const origGen = llm.generateJson.bind(llm);
  llm.generateJson = (async (req: Parameters<typeof origGen>[0]) => {
    if (req.task !== 'factcheck.judge') return origGen(req);
    const { claim, sourceText } = JSON.parse(req.prompt) as { claim: string; sourceText: string };
    const year = claim.match(/\d{4}/)?.[0];
    const line = year ? sourceText.split('\n').find((l) => l.includes(year)) ?? '' : '';
    return { data: req.schema.parse({ verdict: line ? 'supported' : 'not_found', quote: line, correction: null }), usage: { inputTokens: 1, outputTokens: 1, model: 'judge' } };
  }) as typeof llm.generateJson;
  const ctx = testContext({ llm });
  (ctx.providers as { web: WebProvider }).web = fakeWeb;
  const v = ctx.repos.videos.create({ title: 'نوكيا', format: 'long' });
  await steps.scriptwriter(ctx, { videoId: v.id });
  await steps['fact-checker'](ctx, { videoId: v.id });
  const out = (await steps['auto-verifier'](ctx, { videoId: v.id, maxRounds: 0 })) as AutoVerifyOutput;
  assert.ok(out.claims.every((c) => c.status === 'verified' || c.status === 'not_applicable'), JSON.stringify(out.claims.map((c) => [c.claim, c.status])));
  assert.ok(out.removedClaims.length >= 1);
  assert.equal(out.overall, 'verified');
  ctx.close();
});
