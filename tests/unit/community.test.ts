import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerComments, repliesMessage, safeReply } from '../../src/publishing/comments.ts';
import { chooseTitles } from '../../src/agents/title-editor.ts';

function ctxWith(llm: (r: any) => any, posts: any[] = []) {
  const arts: { kind: string; data: any }[] = [];
  return {
    arts,
    ctx: {
      db: { all: () => posts.map((p) => ({ ...p, metrics: JSON.stringify(p.metrics ?? {}) })), run: () => {} },
      repos: {
        knowledge: { byCategory: () => [] },
        artifacts: { latest: () => undefined, listKind: (k: string) => arts.filter((a) => a.kind === k), save: (a: any) => { arts.push(a); } },
      },
      providers: { llm: { generateJson: async (r: any) => ({ data: llm(r) }) } },
    } as any,
  };
}
const post = (platform: string, id: string) => ({ id: `${platform}:${id}`, platform, external_id: id, title: 'اخفي إنك متصل', publish_at: '2026-11-10T09:00:00Z' });

test('comments: links, handles and phone numbers never go out', () => {
  assert.equal(safeReply('جربها وقولنا 😊'), 'جربها وقولنا 😊');
  assert.equal(safeReply('شوف https://x.com'), undefined);
  assert.equal(safeReply('كلمني على 01012345678'), undefined);
  assert.equal(safeReply('تابع @someone'), undefined);
});

test('comments: replies once per comment, skips what the model skips, stops on a missing permission', async () => {
  const comments: Record<string, any[]> = {
    youtube: [{ id: 'y1', text: 'هي بتشتغل على الآيفون؟', author: 'Ali', at: '' }, { id: 'y2', text: 'اشترك في قناتي', author: 'spam', at: '' }],
    facebook: [{ id: 'f1', text: 'حلو', author: 'Mona', at: '' }],
  };
  const sent: string[] = [];
  const { ctx } = ctxWith((r) => ({ replies: JSON.parse(r.prompt).comments.map((c: any) => c.id === 'y2' ? { id: c.id, action: 'skip' } : { id: c.id, action: 'reply', reply: 'أيوه بتشتغل، جربها 👌' }) }), [post('youtube', 'v1'), post('facebook', 'r1')]);
  const src = {
    unanswered: async (pl: string) => comments[pl] ?? [],
    reply: async (pl: string, id: string, text: string) => { if (pl === 'facebook') throw new Error('Meta f1/comments: (#200) Permissions error'); sent.push(`${id}:${text}`); return 'r'; },
  };
  const now = new Date('2026-11-10T12:00:00Z');
  const a = await answerComments(ctx, src as any, now);
  assert.deepEqual(sent, ['y1:أيوه بتشتغل، جربها 👌']);
  assert.equal(a.replied.length, 1);
  assert.ok(a.notes.some((n) => n.startsWith('facebook') && n.includes('#200')));
  const b = await answerComments(ctx, src as any, now);
  assert.equal(b.replied.length, 0, 'never answers the same comment twice');
  assert.match(repliesMessage(a.replied)!, /رديت على 1 تعليق/);
});

test('titles: picks the best of several titles; falls back to the old title when the model fails', async () => {
  const { ctx } = ctxWith(() => ({ shorts: [{ n: 1, candidates: [{ title: 'محدش يعرف إنك أونلاين على واتساب', style: 'benefit', score: 9 }, { title: 'سر في واتساب', style: 'vague', score: 4 }, { title: 'إزاي تخفي ظهورك؟', style: 'question', score: 7 }], best: 'محدش يعرف إنك أونلاين على واتساب' }] }));
  const picks = await chooseTitles(ctx, [{ n: 1, title: 'اخفي إنك متصل على واتساب عن الكل', narration: '...' }]);
  assert.equal(picks[0]!.to, 'محدش يعرف إنك أونلاين على واتساب');
  assert.equal(picks[0]!.style, 'benefit');
  const bad = ctxWith(() => { throw new Error('HTTP 503'); });
  assert.deepEqual(await chooseTitles(bad.ctx, [{ n: 1, title: 'x title', narration: '...' }]), []);
});
