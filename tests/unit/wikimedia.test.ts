import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WikimediaStock, reusableLicense } from '../../src/providers/stock/wikimedia.ts';
import { composeDescription } from '../../src/agents/seo.ts';
import { RateLimiter } from '../../src/core/retry.ts';

test('wikimedia: only PD / CC0 / CC BY are reusable — never SA/NC/ND', () => {
  for (const l of ['Public domain', 'CC0', 'CC BY 2.0', 'CC BY 4.0', 'PD-US']) assert.ok(reusableLicense(l), l);
  for (const l of ['CC BY-SA 4.0', 'CC BY-NC 2.0', 'CC BY-ND 3.0', 'Non-free', 'Fair use', '']) assert.ok(!reusableLicense(l), l);
});

test('wikimedia: maps results with attribution, filters licenses and small files, sends a User-Agent', async () => {
  let ua = '';
  const page = (title: string, license: string, width = 2000) => ({ title, index: 1, imageinfo: [{ url: `https://upload.wikimedia.org/x/${title}`, thumburl: `https://upload.wikimedia.org/t/${title}`, width, height: 1200, descriptionurl: `https://commons.wikimedia.org/wiki/${title}`, extmetadata: { LicenseShortName: { value: license }, Artist: { value: '<a href="#">Steve J</a>' }, ImageDescription: { value: 'Jeff Bezos at an event' } } }] });
  const f = (async (_u: string, init: RequestInit) => { ua = (init.headers as Record<string, string>)['user-agent']!; return new Response(JSON.stringify({ query: { pages: { 1: page('File:Jeff Bezos.jpg', 'CC BY 2.0'), 2: page('File:Bezos SA.jpg', 'CC BY-SA 4.0'), 3: page('File:tiny.jpg', 'CC0', 300) } } })); }) as unknown as typeof fetch;
  const w = new WikimediaStock({ fetchImpl: f, limiter: new RateLimiter(10, 10) });
  const r = await w.search('Jeff Bezos', 'image');
  assert.equal(r.length, 1);
  assert.equal(r[0]!.attribution, 'Steve J — CC BY 2.0, via Wikimedia Commons');
  assert.ok(r[0]!.tags!.includes('bezos'));
  assert.ok(ua.includes('SerElBrandStudio'));
  assert.deepEqual(await w.search('x', 'video'), []);
  const desc = composeDescription({ description: 'd', hashtags: [], chapters: [] }, undefined, r);
  assert.ok(desc.includes('Wikimedia Commons') && desc.includes('Steve J — CC BY 2.0'));
});
