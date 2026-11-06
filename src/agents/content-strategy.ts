import { Agent } from './base.ts';
import { StrategyLLM, type CalendarEntry, type StrategyLLMOut, type TopicIdea } from './schemas.ts';
import { loadPrompt } from '../prompts.ts';

export interface StrategyInput { niche: string; ideas?: TopicIdea[]; startDate?: string; days?: number; /** Topics already produced — never plan them (or close variants) again. */ avoid?: string[] }
export interface StrategyOutput {
  niche: string;
  pillars: StrategyLLMOut['pillars'];
  series: StrategyLLMOut['series'];
  experiments: StrategyLLMOut['experiments'];
  calendar: CalendarEntry[];
  summary: Record<'d30' | 'd60' | 'd90', { long: number; short: number }>;
}

/** Spreads `n` slots evenly over a 7-day week, returning weekday offsets 0..6. */
export function weeklySlots(n: number, offset = 0): number[] {
  if (n <= 0) return [];
  return Array.from({ length: Math.min(n, 7) }, (_, i) => (Math.floor((i * 7) / Math.min(n, 7)) + offset) % 7);
}

/** Deterministic calendar layout: long videos on fixed slots, Shorts on the others, each Short linked to the latest long video. */
export function buildCalendar(
  backlog: StrategyLLMOut['backlog'],
  opts: { startDate: Date; days: number; longPerWeek: number; shortsPerWeek: number },
): CalendarEntry[] {
  const longDays = new Set(weeklySlots(opts.longPerWeek));
  const shortDays = weeklySlots(opts.shortsPerWeek, 1);
  const out: CalendarEntry[] = [];
  let longIdx = 0;
  let lastLong: (typeof backlog)[number] | undefined;
  let lastLongTitle = '';
  let shortAngleIdx = 0;
  let longCount = 0;

  for (let day = 0; day < opts.days; day++) {
    const date = new Date(opts.startDate.getTime() + day * 86_400_000).toISOString().slice(0, 10);
    const wd = day % 7;
    // Each backlog topic is used once: no "(part 2)" repeats. When it runs out the autopilot plans fresh ideas.
    if (longDays.has(wd) && longIdx < backlog.length) {
      const item = backlog[longIdx]!;
      const cycle = 0;
      longIdx++;
      longCount++;
      lastLong = item;
      lastLongTitle = cycle ? `${item.title} (جزء ${cycle + 1})` : item.title;
      shortAngleIdx = 0;
      // Every 4th long video is flagged as a controlled experiment slot.
      out.push({ day: day + 1, date, format: 'long', title: lastLongTitle, pillar: item.pillar, kind: longCount % 4 === 0 ? 'experiment' : item.kind });
    }
    // A Short can share a day with a long video only if slots collide; keep max one Short per day.
    if (shortDays.includes(wd) && lastLong) {
      // Never repeat the same Short angle: once the planned angles run out, cut a new clip from the long video.
      // Planned angles are used on the first pass through the backlog only; later cycles cut fresh clips.
      const angles = lastLongTitle === lastLong.title ? lastLong.shortsAngles : [];
      const angle = shortAngleIdx < angles.length ? angles[shortAngleIdx]! : `مقتطف ${shortAngleIdx - angles.length + 1} من "${lastLongTitle}"`;
      shortAngleIdx++;
      out.push({ day: day + 1, date, format: 'short', title: `Short: ${angle}`, pillar: lastLong.pillar, kind: lastLong.kind, linkedLongTitle: lastLongTitle });
    }
  }
  return out;
}

export class ContentStrategyAgent extends Agent<StrategyInput, StrategyOutput> {
  readonly name = 'content-strategy';
  readonly artifactKind = 'content_strategy';

  protected async execute(input: StrategyInput): Promise<StrategyOutput> {
    const { publishing } = this.ctx.config.channel;
    const res = await this.ctx.providers.llm.generateJson({
      task: 'strategy.plan',
      tier: 'writing',
      system: loadPrompt('content-strategy'),
      prompt: JSON.stringify({ niche: input.niche, topIdeas: (input.ideas ?? []).slice(0, 15).map((i) => ({ title: i.title, score: i.opportunityScore })), publishing, backlogSize: 'at least 15 distinct long-video topics, each with 3 distinct Shorts angles', alreadyProducedDoNotRepeat: (input.avoid ?? []).slice(-200) }),
      schema: StrategyLLM,
    });
    const days = input.days ?? 90;
    const calendar = buildCalendar(res.data.backlog, {
      startDate: new Date(input.startDate ?? new Date().toISOString().slice(0, 10)),
      days,
      longPerWeek: publishing.longPerWeek,
      shortsPerWeek: publishing.shortsPerWeek,
    });
    const count = (d: number) => ({
      long: calendar.filter((c) => c.day <= d && c.format === 'long').length,
      short: calendar.filter((c) => c.day <= d && c.format === 'short').length,
    });
    return {
      niche: input.niche,
      pillars: res.data.pillars,
      series: res.data.series,
      experiments: res.data.experiments,
      calendar,
      summary: { d30: count(30), d60: count(60), d90: count(90) },
    };
  }
}
