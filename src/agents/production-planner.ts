import { Agent, countWords } from './base.ts';
import { BlueprintLLM, type Blueprint, type Script } from './schemas.ts';
import { loadPrompt } from '../prompts.ts';

export interface ProductionInput { videoId: string; script: Script }

/** Recomputes scene timing from the voice-over length (min 3s per scene for visuals to register). */
export function timeScenes(scenes: ReturnType<typeof BlueprintLLM.parse>['scenes'], wpm: number): Blueprint['scenes'] {
  let start = 0;
  return scenes.map((s) => {
    const durationSec = Math.max(3, Math.round((countWords(s.voiceover) / wpm) * 60));
    const out = { ...s, durationSec, startSec: start };
    start += durationSec;
    return out;
  });
}

export class ProductionPlannerAgent extends Agent<ProductionInput, Blueprint> {
  readonly name = 'production-planner';
  readonly artifactKind = 'blueprint';

  protected async execute(input: ProductionInput): Promise<Blueprint> {
    const res = await this.ctx.providers.llm.generateJson({
      task: 'production.blueprint',
      tier: 'writing',
      system: loadPrompt('production-planner'),
      prompt: JSON.stringify({ scenes: input.script.scenes, format: input.script.format, aspect: input.script.format === 'short' ? '9:16' : '16:9' }),
      schema: BlueprintLLM,
      maxOutputTokens: 8000,
      videoId: input.videoId,
    });
    const scenes = timeScenes(res.data.scenes, this.ctx.config.thresholds.script.arabicWordsPerMinute);
    const last = scenes.at(-1)!;
    this.ctx.repos.videos.update(input.videoId, { status: 'planned' });
    return { ...res.data, scenes, totalDurationSec: last.startSec + last.durationSec };
  }
}
