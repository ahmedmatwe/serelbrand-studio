import type { AgentContext } from '../agents/base.ts';
import type { FactCheckReport, Script, SeoPackage, Blueprint } from '../agents/schemas.ts';
import type { ComplianceReport } from '../agents/compliance.ts';
import type { QualityReport } from '../agents/quality.ts';
import type { ThumbnailOutput } from '../agents/thumbnail.ts';
import type { OptimizationReport } from '../analytics/optimization.ts';
import type { PrePublicationReport } from './prepublication.ts';
import type { PublishLog } from '../publishing/publisher.ts';
import { composeDescription } from '../agents/seo.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const badge = (text: string, tone: 'ok' | 'warn' | 'bad' | 'info') => `<span class="b ${tone}">${esc(text)}</span>`;
const tone = (score: number, min: number) => (score >= min ? 'ok' : score >= min - 20 ? 'warn' : 'bad');

/** Self-contained Arabic (RTL) HTML report for one video: everything a reviewer needs on one page. */
export function renderVideoReport(ctx: AgentContext, videoId: string): string {
  const get = <T>(k: string) => ctx.repos.artifacts.latest<T>(videoId, k)?.data;
  const v = ctx.repos.videos.get(videoId);
  const script = get<Script>('script');
  const fc = get<FactCheckReport>('fact_check');
  const bp = get<Blueprint>('blueprint');
  const th = get<ThumbnailOutput>('thumbnails');
  const seo = get<SeoPackage>('seo_package');
  const comp = get<ComplianceReport>('compliance_report');
  const q = get<QualityReport>('quality_report');
  const pre = get<PrePublicationReport>('prepublication_report');
  const pub = get<PublishLog>('publish_log');
  const opt = get<OptimizationReport>('optimization_report');
  const snaps = ctx.repos.analytics.forVideo(videoId);
  const t = ctx.config.thresholds;

  const sec = (title: string, body: string) => (body ? `<section><h2>${esc(title)}</h2>${body}</section>` : '');
  const table = (head: string[], rows: unknown[][]) =>
    `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

  const summary = pre
    ? `<div class="cards">
        <div class="card"><div class="k">الجودة</div><div class="v">${badge(`${pre.qualityScore}/100`, tone(pre.qualityScore, t.quality.minScoreToPublish))}</div></div>
        <div class="card"><div class="k">الامتثال</div><div class="v">${badge(`${pre.complianceScore}/100`, tone(pre.complianceScore, t.compliance.minScoreToPublish))}</div><div class="s">${esc(pre.complianceLabel)}</div></div>
        <div class="card"><div class="k">الحقوق</div><div class="v">${badge(pre.copyrightStatus, pre.copyrightStatus === 'clear' ? 'ok' : pre.copyrightStatus === 'needs_review' ? 'warn' : 'bad')}</div></div>
        <div class="card"><div class="k">تدقيق الحقائق</div><div class="v">${badge(pre.factCheckStatus, pre.factCheckStatus === 'verified' ? 'ok' : pre.factCheckStatus === 'needs_review' ? 'warn' : 'bad')}</div></div>
        <div class="card"><div class="k">مخاطر الربح</div><div class="v">${badge(pre.monetizationRisk, pre.monetizationRisk === 'low' ? 'ok' : pre.monetizationRisk === 'medium' ? 'warn' : 'bad')}</div></div>
        <div class="card"><div class="k">المدة / التكلفة</div><div class="v">${mmss(pre.durationSec)}</div><div class="s">$${pre.estimatedCostUsd}</div></div>
      </div>
      <p class="rec ${pre.recommendation}">${esc(pre.recommendationText)}</p>
      ${pre.hardBlockers.length ? `<h3>موانع النشر</h3><ul>${pre.hardBlockers.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
      ${pre.warnings.length ? `<h3>تحذيرات</h3><ul>${pre.warnings.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
      ${pre.requiredFixes.length ? `<h3>التعديلات المطلوبة</h3><ul>${[...new Set(pre.requiredFixes)].map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
      <p class="muted">موعد مقترح: ${esc(pre.proposedPublishAt)} — ${esc(pre.publishTimeRationale)}</p>`
    : '<p>لم يُنشأ تقرير ما قبل النشر بعد.</p>';

  const html = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(seo?.primaryTitle ?? v?.title ?? videoId)}</title>
<style>
:root{--bg:#f7f7f5;--fg:#1d1d1b;--mut:#6b6b66;--card:#fff;--line:#e4e4df;--ok:#1f7a4d;--okb:#e3f3ea;--warn:#8a5a00;--warnb:#fdf1d8;--bad:#a12622;--badb:#fbe4e2;--info:#1e4f8a;--infob:#e3edf9}
@media (prefers-color-scheme:dark){:root{--bg:#151514;--fg:#ecece8;--mut:#a3a39c;--card:#1e1e1c;--line:#33332f;--okb:#173a28;--ok:#7fd3a6;--warnb:#3b2e10;--warn:#f0c46a;--badb:#401b19;--bad:#f2928c;--infob:#162b45;--info:#8db9ef}}
*{box-sizing:border-box}body{margin:0;font-family:"Geeza Pro","Baghdad",system-ui,sans-serif;background:var(--bg);color:var(--fg);line-height:1.7}
main{max-width:1000px;margin:auto;padding:24px}h1{font-size:1.6rem;margin:.2em 0}h2{font-size:1.15rem;border-bottom:1px solid var(--line);padding-bottom:6px;margin-top:2em}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 20px;margin:16px 0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}.card{border:1px solid var(--line);border-radius:10px;padding:10px}.k{color:var(--mut);font-size:.85rem}.v{font-size:1.2rem;margin-top:4px}.s{color:var(--mut);font-size:.8rem}
.b{display:inline-block;padding:1px 10px;border-radius:999px;font-size:.9em}.ok{background:var(--okb);color:var(--ok)}.warn{background:var(--warnb);color:var(--warn)}.bad{background:var(--badb);color:var(--bad)}.info{background:var(--infob);color:var(--info)}
.rec{font-weight:600;padding:10px 14px;border-radius:10px}.rec.blocked,.rec.needs_fixes{background:var(--badb);color:var(--bad)}.rec.approve_with_caution{background:var(--warnb);color:var(--warn)}.rec.ready_for_approval{background:var(--okb);color:var(--ok)}
table{width:100%;border-collapse:collapse;font-size:.92rem}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:right;vertical-align:top}th{color:var(--mut);font-weight:500}
.muted{color:var(--mut);font-size:.9rem}pre{white-space:pre-wrap;background:var(--bg);padding:12px;border-radius:8px;font-family:inherit}
.dry{background:var(--infob);color:var(--info);padding:8px 12px;border-radius:8px;font-size:.9rem}
</style></head><body><main>
<p class="dry">${ctx.config.env.DRY_RUN ? 'وضع تجريبي (Dry-Run): كل البيانات من مزودات تجريبية، ولا يوجد رفع حقيقي.' : 'وضع حقيقي'}</p>
<h1>${esc(seo?.primaryTitle ?? v?.title)}</h1>
<p class="muted">${esc(videoId)} · الحالة: ${esc(v?.status)} · ${esc(v?.format)} ${v?.youtube_video_id ? `· YouTube: ${esc(v.youtube_video_id)} (${esc(v.visibility)})` : ''}</p>
${sec('تقرير ما قبل النشر', summary)}
${script ? sec('السكريبت', `<p class="muted">${script.wordCount} كلمة · ~${mmss(script.estimatedDurationSec)}</p>
  <h3>الـHooks</h3><ol>${script.hooks.map((h) => `<li>${esc(h)}</li>`).join('')}</ol>
  <h3>عناوين بديلة</h3><ul>${script.altTitles.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
  ${table(['#', 'الغرض', 'التعليق الصوتي', 'نص على الشاشة', 'فجوة فضول'], script.scenes.map((s) => [s.n, esc(s.purpose), esc(s.voiceover), esc(s.onScreenText), esc(s.curiosityGap ?? '')]))}
  <p><b>CTA:</b> ${esc(script.cta)}</p><p><b>الفيديو التالي:</b> ${esc(script.nextVideoSuggestion)}</p>`) : ''}
${fc ? sec('تدقيق الحقائق', `<p>${esc(fc.summary)}</p>${table(['#', 'الادعاء', 'النوع', 'المصدر', 'الحالة', 'ملاحظات'], fc.claims.map((c, i) => [i, esc(c.claim), esc(c.type), c.sourceUrl ? esc(c.sourceUrl) : '—', badge(c.status, c.status === 'verified' || c.status === 'not_applicable' ? 'ok' : c.status === 'needs_review' ? 'warn' : 'bad'), esc([...c.reasons, c.notes].filter(Boolean).join(' · '))]))}`) : ''}
${comp ? sec('فحص الامتثال', `<p>${badge(comp.label, comp.label === 'Low risk' ? 'ok' : comp.label === 'Needs human review' ? 'warn' : 'bad')} ${comp.requiresSyntheticDisclosure ? badge('يتطلب إفصاح محتوى اصطناعي', 'info') : ''}</p>
  ${comp.issues.length ? table(['الفحص', 'الخطورة', 'المشكلة', 'الحل'], comp.issues.map((x) => [esc(x.check), badge(x.severity, x.severity === 'low' ? 'info' : x.severity === 'medium' ? 'warn' : 'bad'), esc(x.message), esc(x.fix)])) : '<p>لا توجد مشاكل.</p>'}
  <p class="muted">${esc(comp.disclaimer)}</p>`) : ''}
${q ? sec('فحص الجودة', `${table(['المعيار', 'الدرجة', 'الوزن', 'ملاحظة'], Object.entries(q.criteria).map(([k, c]) => [esc(k), c.score === null ? badge('بعد الـrender', 'info') : badge(String(c.score), c.score >= 70 ? 'ok' : c.score >= 50 ? 'warn' : 'bad'), c.weight, esc(c.note)]))}<p class="muted">${esc(q.method)}</p>`) : ''}
${bp ? sec('خطة الإنتاج', table(['#', 'البداية', 'المدة', 'اللقطة', 'المصدر', 'الحركة', 'الموسيقى', 'الانتقال'], bp.scenes.map((s) => [s.n, mmss(s.startSec), `${s.durationSec}s`, esc(s.footage), esc(s.assetSource), esc(s.motion), esc(s.musicMood), esc(s.transition)])) + `<p class="muted">الموسيقى: ${esc(bp.music.mood)} (${esc(bp.music.source)}) · الصوت: ${esc(bp.voice.style)}</p>`) : ''}
${th ? sec('مفاهيم الصورة المصغّرة', table(['#', 'النص', 'الصورة', 'الألوان', 'العاطفة', 'صالح؟'], th.concepts.map((c, i) => [i === th.recommendedIndex ? `${i} ⭐` : i, esc(c.text), esc(c.mainVisual), c.palette.map((p) => `<span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:${esc(p)};border:1px solid var(--line)"></span>`).join(' '), esc(c.emotion), c.valid ? badge('نعم', 'ok') : badge(c.problems.join('؛ '), 'bad')]))) : ''}
${seo ? sec('الـSEO والتغليف', `<p><b>الكلمات المفتاحية:</b> ${seo.keywords.map(esc).join('، ')}</p><p><b>التعليق المثبت:</b> ${esc(seo.pinnedComment)}</p><p><b>Playlist:</b> ${esc(seo.playlist)} · <b>End screen:</b> ${esc(seo.endScreen)}</p><h3>الوصف الكامل</h3><pre>${esc(composeDescription(seo, fc, get<{ assets: { source: string; attribution?: string; pageUrl?: string }[] }>('render')?.assets))}</pre>`) : ''}
${pub ? sec('سجل الرفع', `<p>${esc(pub.provider)} · ${esc(pub.youtubeVideoId)} · ${esc(pub.visibility)} · ${esc(pub.uploadedAt)} · محاولات: ${pub.attempts}</p>`) : ''}
${snaps.length ? sec('الأداء', table(['النقطة', 'الظهور', 'CTR', 'المشاهدات', 'متوسط المشاهدة', 'نسبة المشاهدة', 'مشتركين'], snaps.map((s) => [`${s.checkpointHours}h`, s.metrics.impressions, `${((s.metrics.ctr ?? 0) * 100).toFixed(1)}%`, s.metrics.views, mmss(s.metrics.avgViewDurationSec ?? 0), `${((s.metrics.avgPercentViewed ?? 0) * 100).toFixed(0)}%`, s.metrics.subscribersGained])) + `<p class="muted">المصدر: ${esc(snaps[0]!.source)}</p>`) : ''}
${opt ? sec('التشخيص والتوصيات', `<p>الثقة: ${badge(`${Math.round(opt.confidence * 100)}%`, opt.confidence >= 0.6 ? 'ok' : 'warn')} · حجم العينة: ${opt.sampleSize} فيديو</p>
  ${opt.diagnoses.map((d) => `<h3>${esc(d.finding)}</h3><p class="muted">${esc(d.metric)} = ${d.value} مقابل ${Number(d.benchmark.toFixed(4))} (${esc(d.benchmarkSource)})</p><ul>${d.recommendations.map((r) => `<li><b>${esc(r.variable)}:</b> ${esc(r.action)}</li>`).join('')}</ul>`).join('')}
  ${opt.experiment ? `<p><b>تجربة مقترحة:</b> ${esc(opt.experiment.hypothesis)} — ${esc(opt.experiment.rule)}</p>` : ''}
  <ul>${opt.caveats.map((c) => `<li class="muted">${esc(c)}</li>`).join('')}</ul>`) : ''}
<p class="muted">تم الإنشاء: ${new Date().toISOString()} · لا يوجد ضمان لعدد مشاهدات أو أرباح أو قبول من YouTube.</p>
</main></body></html>`;
  return html;
}
