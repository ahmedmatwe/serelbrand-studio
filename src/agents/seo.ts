import { Agent } from './base.ts';
import { SeoLLM, type Blueprint, type FactCheckReport, type Script, type SeoPackage } from './schemas.ts';
import { loadPrompt } from '../prompts.ts';
import { titleProblems } from './stage-checks.ts';

export interface SeoInput { videoId: string; script: Script; blueprint: Blueprint; factCheck?: FactCheckReport }

export const fmtTime = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
};

/**
 * YouTube chapter rules: first at 0:00, at least 3 chapters, each >= 10 seconds.
 * Short scenes are merged into the previous chapter.
 */
export function buildChapters(script: Script, blueprint: Blueprint): SeoPackage['chapters'] {
  const chapters: SeoPackage['chapters'] = [];
  for (const scene of blueprint.scenes) {
    const s = script.scenes.find((x) => x.n === scene.n);
    const label = (s?.onScreenText || s?.purpose || `جزء ${scene.n}`).trim();
    const prev = chapters.at(-1);
    if (prev && scene.startSec - prev.startSec < 10) continue;
    chapters.push({ startSec: chapters.length === 0 ? 0 : scene.startSec, label });
  }
  return chapters.length >= 3 ? chapters : [];
}

/**
 * Description = hook text + chapters + verified sources + hashtags.
 * Re-composed at upload time so sources verified by a human after the SEO step are included.
 */
export function composeDescription(
  seo: Pick<SeoPackage, 'description' | 'hashtags' | 'chapters'>,
  factCheck?: FactCheckReport,
  stockAssets: { source: string; attribution?: string; pageUrl?: string }[] = [],
): string {
  const creditsFor = (src: string) => [...new Map(stockAssets.filter((a) => a.source === src && a.pageUrl).map((a) => [a.pageUrl, `- ${a.attribution ?? src}: ${a.pageUrl}`])).values()];
  const credits = creditsFor('pexels');
  const pixabay = creditsFor('pixabay');
  const sources = (factCheck?.claims ?? []).filter((c) => c.status === 'verified' && c.sourceUrl).map((c) => `- ${c.sourceTitle ?? c.sourceUrl}: ${c.sourceUrl}`);
  return [
    seo.description,
    seo.chapters.length ? '\n⏱️ الفصول:\n' + seo.chapters.map((c) => `${fmtTime(c.startSec)} ${c.label}`).join('\n') : '',
    sources.length ? '\n📚 المصادر:\n' + [...new Set(sources)].join('\n') : '',
    credits.length ? '\n🎬 لقطات مجانية من Pexels (https://www.pexels.com):\n' + credits.join('\n') : '',
    pixabay.length ? '\n🎬 لقطات مجانية من Pixabay (https://pixabay.com):\n' + pixabay.join('\n') : '',
    '\n' + seo.hashtags.join(' '),
  ].filter(Boolean).join('\n');
}

export class SeoAgent extends Agent<SeoInput, SeoPackage> {
  readonly name = 'seo';
  readonly artifactKind = 'seo_package';

  protected async execute(input: SeoInput): Promise<SeoPackage> {
    const res = await this.ctx.providers.llm.generateJson({
      task: 'seo.package',
      tier: 'light',
      system: loadPrompt('seo'),
      prompt: JSON.stringify({ title: input.script.mainTitle, altTitles: input.script.altTitles, hooks: input.script.hooks, scenes: input.script.scenes.map((s) => s.purpose) }),
      schema: SeoLLM,
      videoId: input.videoId,
    });
    // Stage gate: the title must match the video and avoid clickbait — fix it now.
    let data = res.data;
    if (titleProblems(data.primaryTitle, input.script).length) {
      const alt = [...data.altTitles, ...input.script.altTitles, input.script.mainTitle].find((t) => !titleProblems(t, input.script).length);
      if (alt) data = { ...data, primaryTitle: alt, altTitles: [data.primaryTitle, ...data.altTitles.filter((t) => t !== alt)] };
      else {
        const re = await this.ctx.providers.llm.generateJson({
          task: 'seo.retitle',
          tier: 'light',
          system: loadPrompt('seo'),
          prompt: JSON.stringify({ instruction: 'Rewrite primaryTitle (and altTitles) to fix these problems. Return the full package.', problems: titleProblems(data.primaryTitle, input.script), package: data, scenes: input.script.scenes.map((s) => s.voiceover.slice(0, 200)) }),
          schema: SeoLLM,
          videoId: input.videoId,
          vars: { previous: data },
        }).catch(() => undefined);
        if (re && titleProblems(re.data.primaryTitle, input.script).length < titleProblems(data.primaryTitle, input.script).length) data = re.data;
      }
    }
    const chapters = input.script.format === 'long' ? buildChapters(input.script, input.blueprint) : [];
    const fullDescription = composeDescription({ ...data, chapters }, input.factCheck);
    this.ctx.repos.videos.update(input.videoId, { status: 'packaged' });
    return { ...data, chapters, fullDescription };
  }
}
