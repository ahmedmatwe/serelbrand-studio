import { Agent } from './base.ts';
import { BriefLLM, type Brief } from './schemas.ts';
import { loadPrompt } from '../prompts.ts';

export interface BriefInput { videoId: string; title: string; format: 'long' | 'short' }

/** Phases 1–3 of the production playbook: strategy, psychology, 15 titles → best 3, claims to verify. */
export class CreativeBriefAgent extends Agent<BriefInput, Brief> {
  readonly name = 'creative-brief';
  readonly artifactKind = 'brief';
  protected async execute(input: BriefInput): Promise<Brief> {
    const { channel } = this.ctx.config;
    const res = await this.ctx.providers.llm.generateJson({
      task: 'brief.create',
      tier: 'writing',
      system: loadPrompt('creative-brief'),
      prompt: JSON.stringify({ topic: input.title, format: input.format, channel: channel.channelName, audience: channel.audience, countries: channel.targetCountries, style: 'documentary, cinematic, suspenseful, Egyptian-friendly Arabic' }),
      schema: BriefLLM,
      videoId: input.videoId,
      maxOutputTokens: 8000,
    });
    // best3 must come from the list; fall back to the 3 strongest if the model paraphrased.
    const titles = res.data.titles;
    const best3 = res.data.best3.every((b) => titles.some((t) => t.title === b))
      ? res.data.best3
      : [...titles].sort((a, b) => b.strength - a.strength).slice(0, 3).map((t) => t.title);
    return { ...res.data, best3 };
  }
}
