import type { KnowledgeRepo } from '../database/repositories.ts';

/**
 * Publishing slots (UTC). Starting assumption for an Egypt + Gulf audience:
 *  - long videos 17:00 UTC  (19:00 Cairo · 20:00 Riyadh) — evening viewing;
 *  - Shorts 11:00 / 15:00 / 18:00 UTC (13:00 / 17:00 / 20:00 Cairo) — lunch break, after work, evening.
 * Once the channel has enough data, `learnPublishSlots` replaces these with the hours that performed best.
 */
export const DEFAULT_SLOTS_UTC = { long: [17], short: [11, 15, 18] };
const MIN_LEAD_MS = 60 * 60_000; // never schedule less than 1 hour ahead (time to upload + process)

export type SlotFormat = 'long' | 'short';

/** Learned slots from the knowledge base ("long_utc_hours=17" / "short_utc_hours=11,15,18"), if backed by enough videos. */
export function currentSlots(knowledge: KnowledgeRepo, minSamples: number): { slots: typeof DEFAULT_SLOTS_UTC; learned: { long?: number; short?: number } } {
  const slots = { long: [...DEFAULT_SLOTS_UTC.long], short: [...DEFAULT_SLOTS_UTC.short] };
  const learned: { long?: number; short?: number } = {};
  for (const k of knowledge.byCategory('publish_time')) {
    if (k.sample_size < minSamples) continue;
    const m = k.insight.match(/^(long|short)_utc_hours=([\d,]+)$/);
    const legacy = k.insight.match(/^utc_hour=(\d{1,2})$/); // older single-hour insight = long videos
    const f: SlotFormat | undefined = m ? (m[1] as SlotFormat) : legacy ? 'long' : undefined;
    const hours = m ? m[2]! : legacy?.[1];
    if (!f || !hours) continue;
    if (learned[f] !== undefined) continue; // byCategory is sorted by confidence: keep the best one
    slots[f] = hours.split(',').map(Number).filter((h) => h >= 0 && h < 24);
    learned[f] = k.sample_size;
  }
  return { slots, learned };
}

/** The next `count` slot times after `from` (+1 h lead). */
export function nextSlots(hours: number[], from: Date, count: number): string[] {
  const out: string[] = [];
  const sorted = [...new Set(hours)].sort((a, b) => a - b);
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  for (let day = 0; out.length < count && day < 30; day++) {
    for (const h of sorted) {
      const t = new Date(d.getTime() + day * 86_400_000 + h * 3_600_000);
      if (t.getTime() - from.getTime() >= MIN_LEAD_MS && out.length < count) out.push(t.toISOString());
    }
  }
  return out;
}

export function proposePublishTime(
  knowledge: KnowledgeRepo,
  opts: { now?: Date; minSamples: number; format?: SlotFormat },
): { at: string; rationale: string } {
  const now = opts.now ?? new Date();
  const format = opts.format ?? 'long';
  const { slots, learned } = currentSlots(knowledge, opts.minSamples);
  const at = nextSlots(slots[format], now, 1)[0]!;
  const cairo = (iso: string) => `${String((new Date(iso).getUTCHours() + 2) % 24).padStart(2, '0')}:00 بتوقيت القاهرة`;
  return {
    at,
    rationale: learned[format]
      ? `أفضل ساعة من بيانات القناة (${learned[format]} فيديو) — ${cairo(at)}`
      : `افتراض مبدئي لجمهور مصر/الخليج — ${cairo(at)} — بيتحدث تلقائياً بعد ${opts.minSamples} فيديوهات`,
  };
}
