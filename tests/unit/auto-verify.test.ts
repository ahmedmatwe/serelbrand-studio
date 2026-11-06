import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimNumbers, normalize, numbersCovered, quoteIsVerbatim, relevantExcerpt, siteOf } from '../../src/agents/auto-verifier.ts';
import { autoApproveBlockers } from '../../src/workflows/autopilot.ts';
import { htmlToText } from '../../src/providers/web/web.ts';

const PAGE = 'Nokia Corporation is a Finnish company.\nOn 3 September 2013, Microsoft announced that it would acquire Nokia\'s mobile device business for €5.44 billion.\nThe deal closed in April 2014.';

test('quotes count only when copied verbatim from the page', () => {
  assert.ok(quoteIsVerbatim("On 3 September 2013, Microsoft announced that it would acquire Nokia's mobile device business", PAGE));
  assert.ok(!quoteIsVerbatim('Microsoft bought Nokia phones in 2013 for about five billion euros', PAGE), 'paraphrase rejected');
  assert.ok(!quoteIsVerbatim('Nokia', PAGE), 'too short to prove anything');
  assert.equal(normalize('  مُحَمَّد   ٢٠١٣ “x” '), 'محمد 2013 "x"');
});

test('numbers and years in the claim must appear in the evidence', () => {
  assert.deepEqual(claimNumbers('باعت 250 مليون نسخة سنة ٢٠٠٣'), ['250', '2003']);
  assert.deepEqual(claimNumbers('1,000,000 unit'), ['1000000']);
  assert.ok(numbersCovered('صفقة 2013 بقيمة 5.44 مليار', 'in 2013 for €5.44 billion'));
  assert.ok(!numbersCovered('صفقة 2014', 'in 2013 for €5.44 billion'), 'wrong year rejected');
});

test('independent sites: all Wikipedias count as one site', () => {
  assert.equal(siteOf('https://en.wikipedia.org/wiki/Nokia'), 'wikipedia.org');
  assert.equal(siteOf('https://ar.wikipedia.org/wiki/x'), 'wikipedia.org');
  assert.equal(siteOf('https://www.nokia.com/about'), 'nokia.com');
});

test('excerpt keeps relevant paragraphs; html is reduced to text', () => {
  const ex = relevantExcerpt(`${'filler text about other things that matter not at all here. '.repeat(3)}\n${PAGE}`, ['Microsoft', 'acquire', '2013']);
  assert.match(ex, /Microsoft announced/);
  const h = htmlToText('<html><head><title>T</title><script>x()</script></head><body><p>Hello &amp; welcome</p><nav>menu</nav></body></html>');
  assert.equal(h.title, 'T');
  assert.equal(h.text, 'Hello & welcome');
});

const okReport = { hardBlockers: [], complianceScore: 98, qualityScore: 90, factCheckStatus: 'verified', copyrightStatus: 'clear', monetizationRisk: 'low', warnings: ['Enable YouTube "altered or synthetic content" disclosure on upload'] } as never;
const okRender = { measurements: { audioScore: 85 } } as never;

test('auto-approve: only when EVERY gate passes', () => {
  assert.deepEqual(autoApproveBlockers(okReport, okRender, 85), []);
  const r = (o: object) => ({ ...(okReport as object), ...o }) as never;
  assert.ok(autoApproveBlockers(r({ factCheckStatus: 'needs_review' }), okRender, 85).length);
  assert.ok(autoApproveBlockers(r({ qualityScore: 84 }), okRender, 85).length);
  assert.ok(autoApproveBlockers(r({ complianceScore: 89 }), okRender, 85).length);
  assert.ok(autoApproveBlockers(r({ copyrightStatus: 'needs_review' }), okRender, 85).length);
  assert.ok(autoApproveBlockers(r({ warnings: ['Quality: weak viewerValue (0)'] }), okRender, 85).length);
  assert.ok(autoApproveBlockers(okReport, { measurements: { audioScore: 0 } } as never, 85).length, 'silent audio blocks');
  assert.ok(autoApproveBlockers(okReport, undefined, 85).length, 'no render blocks');
});
