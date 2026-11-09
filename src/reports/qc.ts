/**
 * Final pre-export quality checklist (the 15 questions of the production playbook), computed from artifacts.
 * `critical` items block automatic publishing when they fail.
 */
import type { AgentContext } from '../agents/base.ts';
import type { Brief, FactCheckReport, Script, SeoPackage } from '../agents/schemas.ts';
import type { ComplianceReport } from '../agents/compliance.ts';
import type { ThumbnailOutput } from '../agents/thumbnail.ts';
import type { RenderOutput } from '../media/renderer.ts';
import { duplicateSentenceRatio } from '../agents/compliance.ts';
import { spokenText } from '../agents/scriptwriter.ts';
import { countWords } from '../agents/base.ts';

export interface QcItem { q: string; pass: boolean; critical: boolean; note: string }

/** Words that mark placeholder/test output (proper word boundaries). */
export const EXPERIMENTAL = /(?:^|[\s_\-(])(test|demo|sample|mock|lorem|ipsum|placeholder|تجريبي|تجريبية)(?:$|[\s_\-)])/iu;

/**
 * Shorts of a pack that must NOT be uploaded (no verified fact of their own, or flagged by the editor), when
 * at least one other Short of the pack is fine: the good ones go out, the bad one is held back.
 */
export function packExclusions(ctx: AgentContext, videoId: string): number[] {
  const script = ctx.repos.artifacts.latest<Script>(videoId, 'script')?.data;
  if (!script || script.format !== 'short') return [];
  const fc = ctx.repos.artifacts.latest<FactCheckReport>(videoId, 'fact_check')?.data;
  const editor = ctx.repos.artifacts.latest<{ problems: string[] }>(videoId, 'editor_review')?.data;
  const render = ctx.repos.artifacts.latest<{ shorts?: { scenes: number[]; heldReason?: string }[] }>(videoId, 'render')?.data;
  const immodest = new Set((render?.shorts ?? []).filter((x) => x.heldReason).flatMap((x) => x.scenes));
  const bad = script.scenes.filter((sc) => immodest.has(sc.n) ||
    !(fc?.claims ?? []).some((c) => c.status === 'verified' && c.sceneN === sc.n) ||
    (editor?.problems ?? []).some((p) => new RegExp(`^Scene ${sc.n}\\b`).test(p))).map((sc) => sc.n);
  // Immodest Shorts are held back in every case; other problems only when part of the pack is still fine.
  return bad.length < script.scenes.length ? bad : [...immodest];
}

export function qualityChecklist(ctx: AgentContext, videoId: string): QcItem[] {
  const get = <T>(k: string) => ctx.repos.artifacts.latest<T>(videoId, k)?.data;
  const script = get<Script>('script');
  const brief = get<Brief>('brief');
  const fc = get<FactCheckReport>('fact_check');
  const comp = get<ComplianceReport>('compliance_report');
  const seo = get<SeoPackage>('seo_package');
  const th = get<ThumbnailOutput>('thumbnails');
  const r = get<RenderOutput>('render');
  const items: QcItem[] = [];
  const add = (q: string, pass: boolean, critical: boolean, note: string) => items.push({ q, pass, critical, note });
  const hook = script?.hooks[0] ?? '';
  const first = script?.scenes[0];
  // Placeholder/test output only (titles + voice). Narration is NOT scanned: "اختبار السوق" or "عينة من العملاء"
  // are normal words in a business video.
  const experimental = EXPERIMENTAL;
  add('هل الناتج حقيقي وليس تجريبياً؟', Boolean(script && r) && !experimental.test([script?.mainTitle, seo?.primaryTitle, r?.voice.provider, r?.voice.voice].filter(Boolean).join(' ')) && !r?.voice.provider.toLowerCase().includes('mock'), true, `الصوت: ${r?.voice.provider ?? 'غير موجود'} — ${r?.voice.voice ?? ''}`);
  const sceneWords = script?.scenes.map((s) => countWords(s.voiceover)) ?? [];
  add('هل كل فيديو له موضوع ونص كامل؟', sceneWords.length > 0 && sceneWords.every((n) => n >= (script?.format === 'short' ? 35 : 20)), true, sceneWords.length ? `كلمات المشاهد: ${sceneWords.join(' / ')}` : 'لا توجد مشاهد منطوقة');
  const editor = get<{ problems: string[] }>('editor_review');
  const held = packExclusions(ctx, videoId);
  const editorLeft = (editor?.problems ?? []).filter((p) => !held.some((n) => new RegExp(`^Scene ${n}\\b`).test(p)));
  if (held.length) add('هل كل الشورتس جاهزة للنشر؟', true, false, `الشورت رقم ${held.join(' و ')} اتأجل لأنه فيه مشكلة، والباقي هيتنشر`);
  const rnd = get<RenderOutput>('render');
  const modestOk = (rnd?.shorts ?? []).some((x) => !(x as { heldReason?: string }).heldReason) || !(rnd?.shorts ?? []).length;
  add('هل كل اللقطات محتشمة؟', modestOk, true, (rnd?.shorts ?? []).filter((x) => (x as { heldReason?: string }).heldReason).map((x) => `${x.title}: ${(x as { heldReason?: string }).heldReason}`).join(' / ') || 'المراجعة كادر كادر عدّت');
  add('هل كل فيديو بيبدأ بموضوعه وكلامه مترابط؟', !editorLeft.length, true, editorLeft.length ? editorLeft.slice(0, 2).join(' / ') : 'المحرر راجع النص النهائي');
  add('هل أول 10 ثوانٍ قوية؟', Boolean(script) && countWords(hook) <= 30 && Boolean(first?.curiosityGap || first?.beat === 'hook' || /[؟?]/.test(hook)), true, `Hook: ${countWords(hook)} كلمة`);
  add('هل الوعد واضح؟', Boolean(brief?.promise && script?.opening), true, brief?.promise ?? 'لا يوجد brief');
  const dup = script ? duplicateSentenceRatio(spokenText(script)) : 1;
  add('هل لا يوجد حشو؟', dup < 0.1, true, `تكرار الجمل ${(dup * 100).toFixed(0)}%`);
  const avgScene = r && r.scenes.length ? r.scenes.reduce((a, s) => a + s.duration, 0) / r.scenes.length : 0;
  add('هل المشاهد يتلقى قيمة باستمرار؟ (تغيير كل 20–40 ث)', avgScene > 0 && avgScene <= 45, false, `متوسط المشهد ${Math.round(avgScene)} ث`);
  const shotNote = r?.measurements.notes.find((n) => /shots \(one per sentence/.test(n));
  const avgShot = Number(shotNote?.match(/~([\d.]+)s each/)?.[1] ?? 99);
  add('هل الإيقاع مناسب؟ (لقطة كل ≤ 6 ث)', avgShot <= 6, false, shotNote ?? 'لا توجد لقطات');
  add('هل الصوت واضح؟', (r?.measurements.audioScore ?? 0) >= 80, true, `Audio ${r?.measurements.audioScore ?? 0}/100`);
  add('هل الموسيقى لا تغطي الفويس أوفر؟', true, false, 'Ducking تلقائي تحت الصوت (أو بدون موسيقى)');
  add('هل النصوص مقروءة على الهاتف؟', true, false, 'كابشن كبير بحدود سوداء، 4–6 كلمات للسطر');
  const best = th?.concepts[th.recommendedIndex];
  const photo = Boolean(r?.assets.some((a) => a.kind === 'image' && a.license !== 'generated-owned') || r?.thumbnailPath);
  // YouTube Shorts don't use a custom thumbnail (a frame is picked from the video), so it can't block a Shorts pack.
  add('هل الصورة المصغرة واضحة؟', script?.format === 'short' || Boolean(best && best.textWordCount <= 4 && photo), script?.format !== 'short', best ? `"${best.text}" (${best.textWordCount} كلمات)` : 'لا يوجد مفهوم صالح');
  const misleading = comp?.issues.some((i) => i.check.startsWith('packaging.')) ?? true;
  add('هل العنوان جذاب وغير مضلل؟', !misleading, true, seo?.primaryTitle ?? '');
  add('هل هناك مصادر موثوقة؟', fc?.overall === 'verified', true, fc?.summary ?? '');
  // A story with no proven facts is filler, even if nothing in it is false.
  const verified = fc?.claims.filter((c) => c.status === 'verified').length ?? 0;
  if (script?.format === 'short') {
    // A Shorts pack: EVERY Short needs at least one verified fact of its own (no empty Short).
    // Claims without a scene number are attributed by their numbers / words appearing in that Short.
    const inScene = (claim: string, text: string) => {
      const nums = claim.match(/[0-9٠-٩]+/g) ?? [];
      if (nums.length) return nums.every((n) => text.includes(n));
      const words = claim.split(/\s+/).filter((w) => w.length > 3);
      return words.length > 0 && words.filter((w) => text.includes(w)).length / words.length >= 0.6;
    };
    const perShort = script.scenes.map((sc) => fc?.claims.filter((c) => c.status === 'verified' && (c.sceneN === sc.n || (c.sceneN == null && inScene(c.claim, sc.voiceover)))).length ?? 0);
    const excluded = packExclusions(ctx, videoId);
    const empty = script.scenes.filter((sc, i) => perShort[i] === 0 && !excluded.includes(sc.n)).length;
    add('هل في الفيديو معلومات حقيقية مؤكدة كفاية؟', perShort.length > 0 && empty === 0, true, `معلومات مؤكدة لكل شورت: ${perShort.join(' / ')}${empty ? ` — ${empty} شورت بدون معلومة مؤكدة` : ''}`);
  } else {
    add('هل في الفيديو معلومات حقيقية مؤكدة كفاية؟', verified >= 4, true, `${verified} معلومة مؤكدة (المطلوب 4 على الأقل)`);
  }
  add('هل الفيديو مناسب لسياسات يوتيوب؟', comp?.label === 'Low risk', true, comp?.label ?? '');
  add('هل النهاية تشجع على مشاهدة فيديو آخر؟', Boolean(script?.nextVideoSuggestion), false, script?.nextVideoSuggestion ?? '');
  add('هل تم تجهيز نسخة Shorts؟', script?.format === 'short' || (r?.shorts.length ?? 0) > 0, false, `${r?.shorts.length ?? 0} Shorts`);
  add('هل تم تجهيز خطة اختبار وتحسين؟', (seo?.abTest?.titles.length ?? 0) >= 2 || (brief?.best3?.length ?? 0) >= 2, false, 'عناوين بديلة للاختبار');
  return items;
}

export const qcBlockers = (items: QcItem[]) => items.filter((i) => i.critical && !i.pass).map((i) => `QC: ${i.q} — ${i.note}`);
