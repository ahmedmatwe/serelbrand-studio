import { Agent, countWords } from './base.ts';
import { ScriptLLM, type Script } from './schemas.ts';
import { loadPrompt } from '../prompts.ts';

export interface ScriptInput { videoId: string; title: string; angle?: string; format: 'long' | 'short'; audience?: string }

/** Spoken text only (what the narrator actually reads). */
export function spokenText(s: Pick<Script, 'opening' | 'scenes' | 'cta' | 'ending'>): string {
  return [s.opening, ...s.scenes.map((x) => x.voiceover), s.cta, s.ending].join('\n');
}

export class ScriptwriterAgent extends Agent<ScriptInput, Script> {
  readonly name = 'scriptwriter';
  readonly artifactKind = 'script';

  protected async execute(input: ScriptInput): Promise<Script> {
    const t = this.ctx.config.thresholds.script;
    const target =
      input.format === 'long'
        ? { minWords: t.longForm.minMinutes * t.arabicWordsPerMinute, maxWords: t.longForm.maxMinutes * t.arabicWordsPerMinute }
        : { minWords: 240, maxWords: 3 * Math.floor(((t.short.maxSeconds - 8) / 60) * t.arabicWordsPerMinute) };
    // "short" = a Shorts pack: 3 independent mini-stories, each rendered as its own vertical Short.
    const pack = input.format === 'short'
      ? { shortsPack: 'Write EXACTLY 3 scenes. Each scene is a complete, independent YouTube Short of 40–55 seconds (90–115 spoken words): curiosityGap = its hook question (the first line), voiceover = the full mini-story with a clear payoff, onScreenText = a 2–4 word title. Keep opening, cta and ending to one short sentence each.' }
      : {};
    const res = await this.ctx.providers.llm.generateJson({
      task: 'script.write',
      tier: 'writing',
      system: loadPrompt('scriptwriter'),
      prompt: JSON.stringify({ ...input, ...pack, targetWords: target, dialect: this.ctx.config.channel.dialect }),
      schema: ScriptLLM,
      maxOutputTokens: 16000,
      videoId: input.videoId,
    });
    // Never trust the model's own length estimate — measure it, and ask once for a deeper version if too short.
    let data = res.data;
    if (countWords(spokenText(data)) < target.minWords * 0.9) {
      const words = countWords(spokenText(data));
      const exp = await this.ctx.providers.llm.generateJson({
        task: 'script.expand',
        tier: 'writing',
        system: loadPrompt('scriptwriter'),
        prompt: JSON.stringify({
          instruction: `The script has ${words} spoken words but needs ${target.minWords}–${target.maxWords}. Expand it with real substance (context, concrete examples, analysis, clear transitions) — no filler, no repetition, no new unsupported numbers. You may add scenes. Keep hooks, titles and tone. Return the complete script.`,
          script: data,
        }),
        schema: ScriptLLM,
        maxOutputTokens: 16000,
        videoId: input.videoId,
        vars: { previous: data },
      });
      if (countWords(spokenText(exp.data)) > words) data = exp.data;
    }
    const wordCount = countWords(spokenText(data));
    const estimatedDurationSec = Math.round((wordCount / t.arabicWordsPerMinute) * 60);
    this.ctx.repos.videos.update(input.videoId, { status: 'scripted', title: data.mainTitle });
    return { ...data, wordCount, estimatedDurationSec, format: input.format };
  }
}
