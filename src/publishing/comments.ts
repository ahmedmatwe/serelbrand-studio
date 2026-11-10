/**
 * Community manager: answers new comments on our recent Shorts on YouTube, Facebook and Instagram, in friendly
 * Egyptian Arabic. Replies only from what the Short itself says (no invented facts), never with links or
 * requests for personal data, and skips spam, insults and sensitive topics. Answered comments raise engagement,
 * which makes each platform show the Short to more people. Every handled comment is remembered (never twice).
 */
import { z } from 'zod';
import type { AgentContext } from '../agents/base.ts';
import { allPosts, type Post } from '../analytics/learner.ts';
import { postNarration } from '../analytics/analyst.ts';
import type { IncomingComment } from '../providers/media.ts';

export interface CommentSources {
  unanswered: (platform: Post['platform'], mediaId: string) => Promise<IncomingComment[]>;
  reply: (platform: Post['platform'], commentId: string, text: string) => Promise<string>;
}
export interface Replied { platform: string; author: string; comment: string; reply: string }

const Plan = z.object({ replies: z.array(z.object({ id: z.string(), action: z.enum(['reply', 'skip']), reply: z.string().max(400).default(''), why: z.string().max(120).default('') })) });
const NAME: Record<string, string> = { youtube: '▶️ يوتيوب', facebook: '📘 فيسبوك', instagram: '📸 إنستجرام' };

/** Safety net on top of the model: no links, handles, phone numbers or over-long replies ever go out. */
export function safeReply(text: string): string | undefined {
  const t = text.trim();
  if (t.length < 2 || t.length > 300) return undefined;
  if (/https?:|www\.|\.com|@\w|\+?\d[\d\s-]{7,}|واتساب\s*\d|ابعت(لي)?\s*رقم|inbox|DM/i.test(t)) return undefined;
  return t;
}

export async function answerComments(ctx: AgentContext, src: CommentSources, now = new Date(), max = 15): Promise<{ replied: Replied[]; notes: string[] }> {
  const handled = new Set(ctx.repos.artifacts.listKind<{ ids: string[] }>('comment_replies').flatMap((a) => a.data.ids));
  const recent = allPosts(ctx).filter((p) => new Date(p.publish_at) <= now && now.getTime() - new Date(p.publish_at).getTime() < 7 * 86_400_000);
  const replied: Replied[] = [];
  const notes: string[] = [];
  const ids: string[] = [];
  const blocked = new Set<string>();
  for (const p of recent) {
    if (replied.length >= max || blocked.has(p.platform)) continue;
    const fresh = (await src.unanswered(p.platform, p.external_id).catch((e: Error) => { notes.push(`${p.platform}: ${e.message.slice(0, 120)}`); return []; }))
      .filter((c) => !handled.has(c.id) && c.text?.trim()).slice(0, max - replied.length);
    if (!fresh.length) continue;
    const r = await ctx.providers.llm.generateJson({
      task: 'comments.reply',
      tier: 'light',
      system: 'You answer comments for "سر الموبايل", an Egyptian Arabic channel of phone/app secret Shorts. For each comment decide reply or skip. ' +
        'Reply (natural Egyptian Arabic, warm, ≤ 25 words, at most one emoji): thank people, answer questions ONLY with what the Short\'s narration says (if the answer is not in it, say honestly you are not sure and that the question is a good idea for a coming video — no promises of dates), ' +
        'and when it fits invite them to try it, save the video or follow for more secrets. Address the person naturally; never repeat the same sentence for every comment. ' +
        'Never include links, @handles, phone numbers, prices, or ask for personal data / private messages. Never argue. ' +
        'Skip: spam, ads, links, insults, sexual/political/religious debate, anything you cannot answer safely, and comments that are not in Arabic or English. JSON only.',
      prompt: JSON.stringify({ platform: p.platform, shortTitle: p.title, narration: postNarration(ctx, p) ?? p.title, comments: fresh.map((c) => ({ id: c.id, author: c.author, text: c.text.slice(0, 500) })) }),
      schema: Plan,
      maxOutputTokens: 2000,
    }).catch(() => undefined);
    if (!r) continue;
    for (const d of (r.data as z.infer<typeof Plan>).replies) {
      const c = fresh.find((x) => x.id === d.id);
      if (!c) continue;
      const text = d.action === 'reply' ? safeReply(d.reply) : undefined;
      if (!text) { ids.push(c.id); continue; }
      try {
        await src.reply(p.platform, c.id, text);
        ids.push(c.id);
        replied.push({ platform: p.platform, author: c.author, comment: c.text.slice(0, 120), reply: text });
      } catch (e) {
        const msg = (e as Error).message;
        // A missing permission is a setup problem: stop trying on that platform this cycle and say so once.
        if (/permission|\(#200\)|\(#10\)|not authorized|insufficient/i.test(msg)) { blocked.add(p.platform); notes.push(`${p.platform}: ${msg.slice(0, 160)}`); break; }
        notes.push(`${p.platform}: ${msg.slice(0, 120)}`);
      }
    }
  }
  if (ids.length) ctx.repos.artifacts.save({ videoId: null, kind: 'comment_replies', agent: 'community', data: { ids, replied } });
  return { replied, notes };
}

/** Telegram summary of what was answered. */
export function repliesMessage(replied: Replied[]): string | undefined {
  if (!replied.length) return undefined;
  const lines = replied.slice(0, 6).map((r) => `${NAME[r.platform] ?? r.platform} — ${r.author}: «${r.comment}»\n↩️ «${r.reply}»`);
  return `💬 رديت على ${replied.length} تعليق:\n\n${lines.join('\n\n')}${replied.length > 6 ? `\n\n… و${replied.length - 6} تانيين` : ''}`;
}
