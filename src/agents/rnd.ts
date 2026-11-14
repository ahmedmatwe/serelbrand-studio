/**
 * The motion researcher (R&D team, weekly): reads what the editing critic disliked, the analyst's motion lessons,
 * the live experiments and the recurring errors, then (1) nudges the motion style itself in small, safe steps and
 * (2) writes the 3 most valuable next improvements — the ones that need new code go to the owner on Telegram
 * ("نفّذ" in the chat and they get built). The team never stops improving the videos.
 */
import { z } from 'zod';
import type { AgentContext } from './base.ts';
import { motionLessons, motionStyle, stepStyle } from '../media/motion.ts';
import { labSummary } from '../lab/lab.ts';
import { errorSummary } from '../lab/errors.ts';

const Out = z.object({
  tune: z.object({ camera: z.number().min(0).max(1).optional(), captionSize: z.number().min(52).max(80).optional(), flash: z.number().min(0).max(0.4).optional() }).default({}),
  proposals: z.array(z.object({ title: z.string().max(80), why: z.string().max(200), needsCode: z.boolean() })).max(3),
});

export async function motionResearch(ctx: AgentContext, now = new Date()): Promise<string | undefined> {
  const last = ctx.repos.artifacts.latest<{ at: string }>(null, 'rnd_report')?.data.at;
  if ((last && now.getTime() - new Date(last).getTime() < 6.5 * 86_400_000) || ctx.providers.llm.name.startsWith('mock')) return undefined;
  const l = motionLessons(ctx);
  const r = await ctx.providers.llm.generateJson({
    task: 'rnd.motion', tier: 'writing',
    system: 'You lead R&D for the motion graphics of "سر الموبايل" (Egyptian Arabic phone/AI-tool Shorts drawn with Remotion: acted-out UI screens, 3D + animated emoji objects timed on the words, fast cuts with peak-aligned sound effects, ducked music, studio dark theme with one orange accent). ' +
      'From the critic notes, the analyst rules, the experiments and the errors: (1) tune = small safe changes to camera (0–1), captionSize (52–80), flash (0–0.4) only if the evidence asks for it; ' +
      '(2) proposals = the 3 most valuable next improvements to make the videos more professional and more watched (new screen types, new animations, pacing, sound, libraries to add…), each with a short Arabic title and why (simple Egyptian Arabic), needsCode = true when it needs new code. JSON only.',
    prompt: JSON.stringify({ criticNotes: l.criticNotes, rules: l.rules, experiments: labSummary(ctx, now), errors: errorSummary(ctx, now), currentStyle: motionStyle(ctx) }),
    schema: Out, maxOutputTokens: 2000,
  }).catch(() => undefined);
  if (!r) return undefined;
  const o = r.data as z.infer<typeof Out>;
  const next = stepStyle(motionStyle(ctx), o.tune);
  if (next) ctx.repos.knowledge.add({ category: 'learning', insight: `motion_style=${JSON.stringify(next)}`, evidence: 'R&D motion researcher', confidence: now.getTime() / 1e13, sampleSize: 1 });
  ctx.repos.artifacts.save({ videoId: null, kind: 'rnd_report', agent: 'rnd', data: { at: now.toISOString(), tune: o.tune, proposals: o.proposals } });
  const lines = ['🔬 فريق التطوير — اقتراحات الأسبوع للموشن:', ...o.proposals.map((p, i) => `${i + 1}. ${p.title}${p.needsCode ? ' 🛠️' : ' ✅ (اتطبّق لوحده)'}\n   ${p.why}`)];
  if (next) lines.push('', '🎛️ ظبطنا شكل الموشن خطوة صغيرة حسب ملاحظات الناقد.');
  if (o.proposals.some((p) => p.needsCode)) lines.push('', '🛠️ = محتاج كود: قولّي في الشات «نفّذ اقتراحات فريق التطوير» وأنا أبنيها.');
  return lines.join('\n');
}
