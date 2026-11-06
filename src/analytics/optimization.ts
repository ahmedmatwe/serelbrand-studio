import { Agent, type AgentContext } from '../agents/base.ts';
import { StudioError } from '../core/errors.ts';

export type Variable = 'thumbnail' | 'title' | 'hook' | 'pacing' | 'duration' | 'topic' | 'seo' | 'cta' | 'publish_time' | 'follow_up';

export interface Diagnosis {
  finding: string;
  metric: string;
  value: number;
  benchmark: number;
  benchmarkSource: 'channel-median' | 'assumed-default';
  recommendations: { variable: Variable; action: string }[];
}

export interface OptimizationReport {
  videoId: string;
  checkpointHours: number;
  sampleSize: number;
  strategicConclusionsAllowed: boolean;
  confidence: number;
  diagnoses: Diagnosis[];
  experiment: { variable: Variable; hypothesis: string; metric: string; rule: string } | null;
  knowledgeWritten: number;
  caveats: string[];
}

/** Assumed defaults until the channel has its own baseline. Industry ranges vary widely; treat as rough. */
const DEFAULTS = { ctr: 0.045, avgPercentViewed: 0.4, subsPerView: 0.008, impressionsRatio: 1 };

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Metrics of OTHER uploaded videos at the same checkpoint. */
export function channelBaseline(ctx: AgentContext, excludeId: string, checkpoint: number) {
  const others = ctx.repos.videos.list().filter((v) => v.youtube_video_id && v.id !== excludeId);
  const rows = others
    .map((v) => ctx.repos.analytics.forVideo(v.id).find((s) => s.checkpointHours === checkpoint)?.metrics)
    .filter((m): m is Record<string, number> => Boolean(m));
  return {
    n: rows.length,
    ctr: median(rows.map((r) => r.ctr!)),
    avgPercentViewed: median(rows.map((r) => r.avgPercentViewed!)),
    impressions: median(rows.map((r) => r.impressions!)),
    subsPerView: median(rows.map((r) => (r.views ? r.subscribersGained! / r.views : 0))),
  };
}

export function confidenceFor(checkpointHours: number, baselineN: number, minVideos: number) {
  const time = checkpointHours >= 168 ? 0.6 : checkpointHours >= 72 ? 0.5 : checkpointHours >= 24 ? 0.35 : 0.2;
  const data = baselineN >= minVideos ? 0.2 : (baselineN / minVideos) * 0.1;
  // Without a channel baseline (< 3 other videos) a single video can never support a confident conclusion.
  const cap = baselineN < 3 ? 0.4 : 0.85;
  return Number(Math.min(cap, time + data).toFixed(2));
}

export class OptimizationAgent extends Agent<{ videoId: string }, OptimizationReport> {
  readonly name = 'optimization';
  readonly artifactKind = 'optimization_report';

  protected async execute({ videoId }: { videoId: string }): Promise<OptimizationReport> {
    const snaps = this.ctx.repos.analytics.forVideo(videoId);
    const latest = snaps.at(-1);
    if (!latest) throw new StudioError('NO_DATA', `No analytics for ${videoId} yet`);
    const m = latest.metrics;
    const minVideos = this.ctx.config.thresholds.analytics.minVideosForStrategicConclusion;
    const base = channelBaseline(this.ctx, videoId, latest.checkpointHours);
    const useChannel = base.n >= 3;
    const bm = (k: 'ctr' | 'avgPercentViewed' | 'subsPerView') => (useChannel && Number.isFinite(base[k]) ? base[k] : DEFAULTS[k]);
    const src = useChannel ? 'channel-median' : 'assumed-default';
    const diagnoses: Diagnosis[] = [];

    if (m.ctr! < bm('ctr') * 0.85)
      diagnoses.push({ finding: 'CTR أقل من المعتاد: التغليف (العنوان/الصورة) لا يقنع من يرى الفيديو', metric: 'ctr', value: m.ctr!, benchmark: bm('ctr'), benchmarkSource: src,
        recommendations: [{ variable: 'thumbnail', action: 'جرّب مفهوم صورة مصغّرة بديل (Test & Compare) بنص أقصر وتباين أعلى' }, { variable: 'title', action: 'عنوان أوضح يحمل الوعد الأساسي في أول 40 حرف' }] });
    if (m.avgPercentViewed! < bm('avgPercentViewed') * 0.85)
      diagnoses.push({ finding: 'نسبة المشاهدة منخفضة: المشاهد يخرج مبكراً', metric: 'avgPercentViewed', value: m.avgPercentViewed!, benchmark: bm('avgPercentViewed'), benchmarkSource: src,
        recommendations: [{ variable: 'hook', action: 'اختصر المقدمة لأقل من 15 ثانية وادخل في الموضوع فوراً' }, { variable: 'pacing', action: 'غيّر اللقطة كل 4–7 ثوانٍ وأضف فجوات فضول في منتصف الفيديو' }] });
    if (useChannel && m.impressions! < base.impressions * 0.5 && m.ctr! >= bm('ctr'))
      diagnoses.push({ finding: 'الـCTR جيد لكن الظهور قليل: الطلب على الموضوع أو الـSEO ضعيف', metric: 'impressions', value: m.impressions!, benchmark: base.impressions, benchmarkSource: 'channel-median',
        recommendations: [{ variable: 'seo', action: 'راجع الكلمات المفتاحية في أول سطرين من الوصف' }, { variable: 'topic', action: 'قلّل هذا النوع من المواضيع حتى تتأكد البيانات' }] });
    const spv = m.views ? m.subscribersGained! / m.views : 0;
    if (spv < bm('subsPerView') * 0.7)
      diagnoses.push({ finding: 'تحويل ضعيف لمشتركين', metric: 'subsPerView', value: Number(spv.toFixed(4)), benchmark: bm('subsPerView'), benchmarkSource: src,
        recommendations: [{ variable: 'cta', action: 'اربط الـCTA بالسلسلة ("الحلقة الجاية…") بدل طلب اشتراك عام' }] });
    if (!diagnoses.length)
      diagnoses.push({ finding: 'الأداء ضمن المعتاد أو أفضل', metric: 'ctr', value: m.ctr!, benchmark: bm('ctr'), benchmarkSource: src,
        recommendations: [{ variable: 'follow_up', action: 'اعمل فيديو متابعة بنفس الزاوية + 2–3 Shorts منه' }] });

    const confidence = confidenceFor(latest.checkpointHours, base.n, minVideos);
    const strategicConclusionsAllowed = base.n + 1 >= minVideos && latest.checkpointHours >= 168;
    const top = diagnoses[0]!.recommendations[0]!;
    const experiment = top.variable === 'follow_up' ? null : {
      variable: top.variable,
      hypothesis: `تغيير ${top.variable} وحده سيحسّن ${diagnoses[0]!.metric}`,
      metric: diagnoses[0]!.metric,
      rule: 'غيّر متغيراً واحداً فقط، وقارن بعد 7 أيام على الأقل، ولا تعمم من فيديو واحد.',
    };

    // Knowledge is only written from mature data (>= 7 days) and always carries its sample size.
    let knowledgeWritten = 0;
    if (latest.checkpointHours >= 168) {
      const sampleSize = base.n + 1;
      for (const d of diagnoses) {
        this.ctx.repos.knowledge.add({ category: d.recommendations[0]!.variable === 'thumbnail' || d.recommendations[0]!.variable === 'title' ? d.recommendations[0]!.variable : 'audience', insight: d.finding, evidence: `${videoId}@${latest.checkpointHours}h ${d.metric}=${d.value} vs ${d.benchmark} (${d.benchmarkSource})`, confidence, sampleSize });
        knowledgeWritten++;
      }
    }

    const caveats = [
      latest.source === 'mock' ? 'البيانات تجريبية (Mock) وليست من YouTube.' : '',
      !useChannel ? 'لا يوجد خط أساس للقناة بعد (أقل من 3 فيديوهات)؛ المقارنة مع قيم افتراضية تقريبية.' : '',
      !strategicConclusionsAllowed ? `لا استنتاجات استراتيجية قبل ${minVideos} فيديوهات وبيانات 7 أيام.` : '',
    ].filter(Boolean);

    return { videoId, checkpointHours: latest.checkpointHours, sampleSize: base.n + 1, strategicConclusionsAllowed, confidence, diagnoses, experiment, knowledgeWritten, caveats };
  }
}

/**
 * Learns the best publishing hours per format from mature data (7-day views by UTC publish hour).
 * Writes "long_utc_hours=H" / "short_utc_hours=a,b,c" to the knowledge base once there are enough videos.
 */
export function learnPublishSlots(ctx: AgentContext, minVideos: number): { long?: number[]; short?: number[] } {
  const learned: { long?: number[]; short?: number[] } = {};
  for (const format of ['long', 'short'] as const) {
    const rows: { hour: number; views: number }[] = [];
    for (const v of ctx.repos.videos.list().filter((x) => x.youtube_video_id && x.format === format)) {
      const at = v.scheduled_at ?? ctx.repos.artifacts.latest<{ uploadedAt: string }>(v.id, 'publish_log')?.data.uploadedAt;
      const m = ctx.repos.analytics.forVideo(v.id).find((s) => s.checkpointHours === 168)?.metrics;
      if (at && m) rows.push({ hour: new Date(at).getUTCHours(), views: m.views ?? 0 });
    }
    if (rows.length < minVideos) continue;
    const by = new Map<number, number[]>();
    for (const r of rows) by.set(r.hour, [...(by.get(r.hour) ?? []), r.views]);
    const ranked = [...by.entries()].filter(([, vs]) => vs.length >= 2).map(([h, vs]) => ({ h, avg: vs.reduce((a, b) => a + b, 0) / vs.length })).sort((a, b) => b.avg - a.avg);
    if (!ranked.length) continue;
    const hours = ranked.slice(0, format === 'long' ? 1 : 3).map((x) => x.h).sort((a, b) => a - b);
    learned[format] = hours;
    const insight = `${format}_utc_hours=${hours.join(',')}`;
    const prev = ctx.repos.knowledge.byCategory('publish_time').find((k) => k.insight.startsWith(`${format}_utc_hours=`));
    if (prev?.insight !== insight) ctx.repos.knowledge.add({ category: 'publish_time', insight, evidence: `${rows.length} ${format} videos, 7-day views by publish hour`, confidence: Math.min(0.85, 0.4 + rows.length * 0.02), sampleSize: rows.length });
  }
  return learned;
}
