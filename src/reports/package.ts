/**
 * Production package (the 17 deliverables of the playbook) for one video, as Arabic Markdown.
 * Written to reports/packages/ and kept on the cloud `state` branch.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentContext } from '../agents/base.ts';
import type { Blueprint, Brief, FactCheckReport, Script, SeoPackage } from '../agents/schemas.ts';
import type { ThumbnailOutput } from '../agents/thumbnail.ts';
import type { RenderOutput } from '../media/renderer.ts';
import { fmtTime, composeDescription } from '../agents/seo.ts';
import { qualityChecklist } from './qc.ts';

const md = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderPackage(ctx: AgentContext, videoId: string): string {
  const get = <T>(k: string) => ctx.repos.artifacts.latest<T>(videoId, k)?.data;
  const v = ctx.repos.videos.get(videoId);
  const brief = get<Brief>('brief');
  const script = get<Script>('script');
  const bp = get<Blueprint>('blueprint');
  const th = get<ThumbnailOutput>('thumbnails');
  const seo = get<SeoPackage>('seo_package');
  const fc = get<FactCheckReport>('fact_check');
  const r = get<RenderOutput>('render');
  const L: string[] = [];
  const h = (t: string) => L.push('', `## ${t}`, '');

  L.push(`# ملف الإنتاج: ${seo?.primaryTitle ?? v?.title ?? videoId}`, '', `> ${videoId} · ${v?.format === 'short' ? 'باقة Shorts' : 'فيديو طويل'} · الحالة: ${v?.status ?? '—'}`);

  h('1. ملخص الفكرة');
  if (brief) L.push(`- **الفكرة المركزية:** ${brief.centralIdea}`, `- **الوعد:** ${brief.promise}`, `- **السؤال الكبير:** ${brief.bigQuestion}`, `- **المشاعر:** ${brief.emotions.join('، ')}`, `- **الجمهور الدقيق:** ${brief.targetViewer}`, `- **سبب الضغط:** ${brief.clickReason}`, `- **سبب الإكمال:** ${brief.stayReason}`, `- **اللحظة المفصلية:** ${brief.twist}`, `- **الزاوية المختلفة:** ${brief.uniqueAngle}`, `- **الدعوة للتفاعل:** ${brief.cta}`);

  h('2. أفضل عنوان');
  L.push(`**${seo?.primaryTitle ?? script?.mainTitle ?? ''}**`);
  if (brief) {
    L.push('', 'أفضل 3:', ...brief.best3.map((t) => `- ${t}`), '', '| العنوان | النوع | الفكرة النفسية | القوة | مناسب لـ |', '|---|---|---|---|---|');
    for (const t of brief.titles) L.push(`| ${md(t.title)} | ${t.type} | ${md(t.psychology)} | ${t.strength}/10 | ${t.bestFor} |`);
  }

  h('3. فكرة الصورة المصغرة');
  if (th) {
    th.concepts.forEach((c, i) => L.push(`### ${i === th.recommendedIndex ? '⭐ ' : ''}فكرة ${i + 1}: "${c.text}"`, `- العنصر الرئيسي: ${c.mainVisual} · الخلفية: ${c.background} · الألوان: ${(c.palette ?? []).join(' ')}`, `- التكوين: ${c.composition} · التباين: ${c.contrast} · العاطفة: ${c.emotion}`, `- عنصر الفضول: ${c.curiosityElement || '—'} · على الهاتف: ${c.mobileReadability || '—'} · تجنّب: ${c.avoid || '—'}`, c.aiPrompt ? `- **AI prompt:** \`${md(c.aiPrompt)}\`` : '', ''));
  }

  h('4. السيناريو الكامل');
  if (script) {
    L.push('**Hooks:**', ...script.hooks.map((x) => `- ${x}`), '', `**الافتتاحية:** ${script.opening}`);
    for (const s of script.scenes) {
      const d = s.delivery ?? { tone: 'هادئ وواثق', pace: 'medium', emphasis: [], pauseAfter: false };
      L.push('', `**[${s.chapter || s.purpose}] مشهد ${s.n} — ${s.beat ?? 'setup'}** _(${d.tone}، ${d.pace}${d.emphasis?.length ? `، تشديد: ${d.emphasis.join('، ')}` : ''}${d.pauseAfter ? '، صمت بعده' : ''})_`, s.voiceover);
    }
    L.push('', `**CTA:** ${script.cta}`, `**الخاتمة:** ${script.ending}`, `**الفيديو التالي:** ${script.nextVideoSuggestion}`);
  }

  h('5. جدول المشاهد');
  L.push('| التوقيت | التعليق الصوتي | الهدف | اللقطات (لكل جملة) | الحركة | المؤثرات | الموسيقى | الكابشن | الانتقال | ملاحظات المونتير |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const s of bp?.scenes ?? []) {
    const sc = script?.scenes.find((x) => x.n === s.n);
    const rs = r?.scenes.find((x) => x.n === s.n);
    L.push(`| ${fmtTime(Math.round(rs?.start ?? s.startSec))} | ${md(s.voiceover.slice(0, 120))}… | ${md(sc?.purpose)} | ${md(s.footage)} | ${md(s.motion)} + Pan/Zoom لكل لقطة | ${sc?.beat === 'reveal' || sc?.beat === 'hook' ? 'Impact' : 'Whoosh'} | ${md(s.musicMood)} | ${md(s.onScreenText)} | ${md(s.transition)} | ${md(s.editingNotes)} |`);
  }

  h('6. قائمة المواد المطلوبة');
  const assets = r?.assets ?? [];
  L.push(`- ${assets.filter((a) => a.kind === 'video').length} فيديو Stock · ${assets.filter((a) => a.kind === 'image').length} صورة · صوت: ${r?.voice.voice ?? '—'} (${r?.voice.provider ?? '—'})`);
  for (const a of assets.filter((x) => x.pageUrl)) L.push(`- ${a.kind}: ${a.attribution ?? ''} — ${a.pageUrl}`);

  h('7. Prompt الفويس أوفر');
  L.push('```', `${ctx.config.env.GEMINI_TTS_STYLE}`, `Voice: ${ctx.config.env.GEMINI_TTS_VOICE} — رجل 30–40 سنة، راوي وثائقي واثق، طبيعي وغير آلي.`, 'تعليمات لكل مشهد مأخوذة من عمود delivery في السيناريو (النبرة، السرعة، التشديد، الصمت).', '```');

  h('8. Prompt الصور والمشاهد');
  for (const s of bp?.scenes ?? []) L.push(`- **مشهد ${s.n}:** \`${md(s.visualPrompt)}\` — بحث Stock: \`${md(s.stockQuery)}\``);

  h('9. خطة المونتاج');
  L.push('- لقطة لكل جملة (2.5–5.5 ث)، Pan يمين/يسار أو Push-in على كل لقطة فيديو، Ken Burns للصور.', '- نص الفصل يظهر أول كل مشهد (Fade 300ms)، والكابشن بالكلمة المنوّرة.', '- Whoosh مع كل انتقال مشهد، Impact عند الـHook ولحظة الكشف، صمت درامي بعد الجمل الكبيرة.', '- هوية ثابتة: تدرّج لوني داكن خفيف، خط عربي واحد، أصفر للتمييز.');

  h('10. الكابشن');
  L.push(`- عربي: \`${r?.captionsPath?.split('/').pop() ?? '—'}\` · إنجليزي: \`${r?.captionsEnPath?.split('/').pop() ?? '—'}\``, '- القواعد: 4–6 كلمات للسطر، الكلمة المنطوقة بالأصفر والباقي أبيض، حدود سوداء سميكة، في الثلث السفلي (الطويل) / منتصف الشاشة (Shorts).');

  h('11. وصف يوتيوب');
  if (seo) L.push(`**أول سطرين:** ${seo.firstTwoLines || seo.description.split('\n')[0]}`, '', '```', composeDescription(seo, fc, r?.assets), '```');

  h('12. الكلمات المفتاحية والوسوم');
  if (seo) L.push(`- أساسية: ${(seo.primaryKeywords?.length ? seo.primaryKeywords : seo.keywords).join('، ')}`, `- ثانوية: ${(seo.secondaryKeywords ?? []).join('، ') || '—'}`, `- Tags: ${seo.tags.join(', ')}`, `- Hashtags: ${seo.hashtags.join(' ')}`);

  h('13. الفصول الزمنية');
  for (const c of seo?.chapters ?? []) L.push(`- ${fmtTime(c.startSec)} ${c.label}`);

  h('14. التعليق المثبت');
  L.push(seo?.pinnedComment ?? '—', '', 'دعوات التفاعل:', ...(seo?.engagementPrompts ?? []).map((x) => `- ${x}`));

  h('15. خطة المقاطع القصيرة');
  for (const s of r?.shorts ?? []) L.push(`- **${s.title}** (${Math.round(s.durationSec)} ث)`);
  if (seo?.shortForm) L.push('', `- Shorts: ${seo.shortForm.shorts}`, `- TikTok: ${seo.shortForm.tiktok}`, `- Reels: ${seo.shortForm.reels}`);
  if (seo?.communityPosts?.length) L.push('', 'منشورات المجتمع:', ...seo.communityPosts.map((x) => `- ${x}`));
  if (seo?.promotion48h?.length) L.push('', 'أول 48 ساعة:', ...seo.promotion48h.map((x) => `- ${x}`));

  h('16. قائمة فحص الجودة قبل التصدير');
  L.push('| السؤال | النتيجة | ملاحظة |', '|---|---|---|');
  for (const q of qualityChecklist(ctx, videoId)) L.push(`| ${q.q}${q.critical ? ' (أساسي)' : ''} | ${q.pass ? '✅' : '❌'} | ${md(q.note)} |`);

  h('17. خطة التحليل بعد النشر');
  L.push('| النتيجة | الإجراء |', '|---|---|',
    '| CTR منخفض | جرّب العنوان/الصورة البديلة (Test & Compare) — متغير واحد |',
    '| هبوط في أول 30 ث | Hook أقصر، ادخل في الصدمة مباشرة، أول لقطة أقوى |',
    '| هبوط في المنتصف | فجوة فضول جديدة + لقطة/مؤثر عند نقطة الهبوط، قص الحشو |',
    '| مشاهدات جيدة واشتراكات قليلة | CTA مربوط بالسلسلة + End screen للحلقة التالية |',
    '| تعليقات كثيرة ومشاهدة منخفضة | الموضوع يثير نقاش: اعمل Short منه + Community post |',
    '| المشاهدة من البحث عالية | اعمل فيديوهات متابعة بنفس الكلمات المفتاحية |',
    '| المشاهدة من الاقتراحات عالية | كرّر نفس الزاوية والصورة المصغرة في الفيديو التالي |',
    '', 'نقاط القياس: 1س، 6س، 24س، 72س، 7 أيام، 28 يوم — ولا استنتاجات استراتيجية قبل 8 فيديوهات.');
  return L.join('\n') + '\n';
}

export function writePackage(ctx: AgentContext, videoId: string): string {
  const dir = resolve(ctx.config.rootDir, 'reports/packages');
  mkdirSync(dir, { recursive: true });
  const v = ctx.repos.videos.get(videoId);
  const path = resolve(dir, `${(v?.created_at ?? new Date().toISOString()).slice(0, 10)}-${videoId}.md`);
  writeFileSync(path, renderPackage(ctx, videoId));
  return path;
}
