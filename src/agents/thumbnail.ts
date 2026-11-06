import { Agent, countWords } from './base.ts';
import { ThumbnailLLM, type ThumbnailConcept } from './schemas.ts';
import { loadPrompt } from '../prompts.ts';

export interface ThumbnailInput { videoId: string; title: string; summary: string }
export interface ThumbnailOutput { concepts: ThumbnailConcept[]; recommendedIndex: number }

const LOGO_OR_FACE = /(logo|شعار|celebrity|مشهور|real person|وجه حقيقي)/i;

export function validateConcept(c: ReturnType<typeof ThumbnailLLM.parse>['concepts'][number], maxWords: number): ThumbnailConcept {
  const problems: string[] = [];
  const textWordCount = countWords(c.text);
  if (textWordCount === 0) problems.push('No text');
  if (textWordCount > maxWords) problems.push(`Text has ${textWordCount} words (max ${maxWords})`);
  if (!c.accuracyNote.trim()) problems.push('Missing accuracy note');
  if (LOGO_OR_FACE.test(c.mainVisual) && !/بدون|no /i.test(c.mainVisual + c.accuracyNote)) problems.push('May include a real logo or face — rights needed');
  return { ...c, textWordCount, valid: problems.length === 0, problems };
}

export class ThumbnailAgent extends Agent<ThumbnailInput, ThumbnailOutput> {
  readonly name = 'thumbnail';
  readonly artifactKind = 'thumbnails';

  protected async execute(input: ThumbnailInput): Promise<ThumbnailOutput> {
    const res = await this.ctx.providers.llm.generateJson({
      task: 'thumbnail.concepts',
      tier: 'light',
      system: loadPrompt('thumbnail'),
      prompt: JSON.stringify(input),
      schema: ThumbnailLLM,
      videoId: input.videoId,
    });
    const max = this.ctx.config.thresholds.packaging.maxThumbnailWords;
    const concepts = res.data.concepts.map((c) => validateConcept(c, max));
    // Prefer valid concepts with the fewest words (most readable on mobile).
    const ranked = concepts.map((c, i) => ({ c, i })).filter((x) => x.c.valid).sort((a, b) => a.c.textWordCount - b.c.textWordCount);
    return { concepts, recommendedIndex: ranked[0]?.i ?? -1 };
  }
}
