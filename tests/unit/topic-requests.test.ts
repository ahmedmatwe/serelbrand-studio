import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { handleTopicRequests, priorityIds, vetRequest } from '../../src/agents/niche/topic-requests.ts';
import { loadPhoneLibrary, pickPhoneSecrets } from '../../src/agents/niche/phone-library.ts';
import type { AgentContext } from '../../src/agents/base.ts';

const ENTRY = {
  kind: 'feature', platforms: 'واتساب على آيفون وأندرويد', title: 'اخفي آخر ظهور في واتساب من غير ما حد يعرف', onScreen: 'آخر ظهور',
  steps: ['الإعدادات', 'الخصوصية', 'آخر ظهور ومتصل الآن', 'لا أحد'], result: 'محدش هيشوف إمتى كنت فاتح واتساب آخر مرة.',
  use: 'مفيد لو عايز تقرا الرسايل براحتك من غير ضغط.', facts: 'WhatsApp: Settings > Privacy > Last seen and online > Nobody. | من الإعدادات ← الخصوصية.',
  source: 'whatsapp', ui: { type: 'settings', os: 'android', path: ['الإعدادات', 'الخصوصية', 'آخر ظهور ومتصل الآن'] }, footage: ['whatsapp privacy settings', 'phone chat app'],
};

function setup(replies: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), 'req-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  cpSync(resolve('config/phone-secrets.json'), join(root, 'config/phone-secrets.json'));
  const arts: { kind: string; data: unknown }[] = [];
  const calls: string[] = [];
  const ctx = {
    config: { rootDir: root },
    providers: { llm: { name: 'fake', generateJson: async (r: { task: string }) => { calls.push(r.task); const x = replies.shift(); if (!x) throw new Error('no reply'); return { data: x }; } } },
    repos: { artifacts: { save: (a: { kind: string; data: unknown }) => arts.push(a), listKind: (k: string) => arts.filter((a) => a.kind === k) } },
  } as unknown as AgentContext;
  return { ctx, root, arts, calls };
}

test('topic request: drafted + fact-checked → approved entry in library format', async () => {
  const { ctx, calls } = setup([{ verdict: 'ok', confidence: 0.9, entry: ENTRY }, { verdict: 'fix', confidence: 0.85, fixed: { platforms: 'واتساب (آيفون وأندرويد)' } }]);
  const r = await vetRequest(ctx, { id: '1', text: 'إزاي أخفي آخر ظهور في واتساب', at: '' });
  assert.equal(r.status, 'approved');
  assert.equal(r.entry!.id, 'req-1');
  assert.equal(r.entry!.platforms, 'واتساب (آيفون وأندرويد)', 'the fact-checker’s correction is applied');
  assert.deepEqual(calls, ['topic.request.draft', 'topic.request.factcheck']);
});

test('topic request: unsure or rejected by the fact-checker → not made, with the reason', async () => {
  const low = setup([{ verdict: 'ok', confidence: 0.5, entry: ENTRY }]);
  assert.equal((await vetRequest(low.ctx, { id: '2', text: 'x', at: '' })).status, 'rejected');
  const no = setup([{ verdict: 'ok', confidence: 0.9, entry: ENTRY }, { verdict: 'reject', confidence: 0.9, reasonArabic: 'الخطوات دي اتغيرت' }]);
  const r = await vetRequest(no.ctx, { id: '3', text: 'x', at: '' });
  assert.equal(r.status, 'rejected');
  assert.equal(r.reason, 'الخطوات دي اتغيرت');
});

test('topic request: full cycle — bot requests → reply on Telegram → first in the next pack → marked done', async () => {
  const { ctx, root } = setup([{ verdict: 'ok', confidence: 0.9, entry: ENTRY }, { verdict: 'ok', confidence: 0.9 }]);
  const posts: { url: string; body: { requestsDone: string[]; messages: string[] } }[] = [];
  const fakeFetch = (async (url: string, init?: { body?: string }) => {
    if (url.endsWith('/requests')) return new Response(JSON.stringify({ requests: [{ id: '7', text: 'آخر ظهور واتساب', at: '' }] }));
    posts.push({ url, body: JSON.parse(init!.body!) });
    return new Response('{}');
  }) as typeof fetch;
  const env = { BOT_URL: 'https://bot.example', BOT_INGEST_SECRET: 's' };
  const msgs = await handleTopicRequests(ctx, new Set(), env as NodeJS.ProcessEnv, fakeFetch);
  assert.match(msgs[0]!, /اتقبل/);
  assert.deepEqual(posts[0]!.body.requestsDone, ['7']);
  // the approved topic is in the library and goes first
  const lib = loadPhoneLibrary(root)!;
  assert.ok(lib.secrets.some((s) => s.id === 'req-7'));
  assert.deepEqual(priorityIds(ctx, new Set()), ['req-7']);
  assert.equal(pickPhoneSecrets(lib, new Set(), 3, undefined, priorityIds(ctx, new Set()))[0]!.id, 'req-7');
  // next cycle, once its video was made: one announcement, then never again
  const again = await handleTopicRequests(ctx, new Set(['req-7']), {} as NodeJS.ProcessEnv, fakeFetch);
  assert.match(again[0]!, /اتعمل/);
  assert.deepEqual(await handleTopicRequests(ctx, new Set(['req-7']), {} as NodeJS.ProcessEnv, fakeFetch), []);
});

test('library researcher: when stock is low, ideas are vetted and only approved ones are added; a failed model call retries next cycle', async () => {
  const { growLibrary } = await import('../../src/agents/niche/topic-requests.ts');
  const ideas = { ideas: [{ topic: 'ابعت رسالة في تيليجرام من غير صوت', category: 'telegram' }, { topic: 'كود يفتح أي موبايل', category: 'code' }] };
  // idea list, then: idea 1 draft ok + check ok, idea 2 rejected by the drafter
  const { ctx, root } = setup([ideas, { verdict: 'ok', confidence: 0.9, entry: { ...ENTRY, source: 'telegram' } }, { verdict: 'ok', confidence: 0.9 }, { verdict: 'reject', confidence: 0.9, reasonArabic: 'مش آمن' }]);
  const used = new Set(loadPhoneLibrary(root)!.secrets.map((s) => s.id));
  const msgs = await growLibrary(ctx, used, new Date('2026-11-12T08:00:00Z'));
  assert.match(msgs[0]!, /ضاف 1/);
  assert.ok(loadPhoneLibrary(root)!.secrets.some((s) => s.id.startsWith('req-auto-')));
  assert.deepEqual(priorityIds(ctx, used), [], 'researcher topics are not pushed ahead like the owner’s');
  assert.deepEqual(await growLibrary(ctx, used, new Date('2026-11-12T11:00:00Z')), [], 'once a day');
  const failing = setup([]);
  assert.deepEqual(await growLibrary(failing.ctx, new Set(loadPhoneLibrary(failing.root)!.secrets.map((s) => s.id)), new Date('2026-11-12T08:00:00Z')), []);
  assert.equal(failing.arts.filter((a) => a.kind === 'library_growth').length, 0, 'failure does not block the day');
});
