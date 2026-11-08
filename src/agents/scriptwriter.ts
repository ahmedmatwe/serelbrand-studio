import { Agent, countWords } from './base.ts';
import { ScriptLLM, type Script } from './schemas.ts';
import { loadPrompt } from '../prompts.ts';
import { scriptProblems } from './stage-checks.ts';
import { researchTopic } from './research.ts';

export interface ScriptInput { videoId: string; title: string; angle?: string; format: 'long' | 'short'; audience?: string }

/** Exact text sent to TTS for one scene. Shorts are independent; long videos include their spoken opening and ending. */
export function narratedSceneText(s: Pick<Script, 'opening' | 'scenes' | 'cta' | 'ending'> & { format?: Script['format'] }, index: number): string {
  const scene = s.scenes[index];
  if (!scene) return '';
  if (s.format === 'short') return scene.voiceover.trim();
  const parts = [scene.voiceover.trim()];
  if (index === 0 && s.opening.trim() && !scene.voiceover.includes(s.opening.trim())) parts.unshift(s.opening.trim());
  if (index === s.scenes.length - 1) {
    for (const tail of [s.cta, s.ending]) if (tail.trim() && !scene.voiceover.includes(tail.trim())) parts.push(tail.trim());
  }
  return parts.join(' ');
}

/** Spoken text only: this must stay identical to what the renderer sends to TTS. */
export function spokenText(s: Pick<Script, 'format' | 'opening' | 'scenes' | 'cta' | 'ending'>): string {
  return s.scenes.map((_, i) => narratedSceneText(s, i)).join('\n');
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
    // A Shorts pack covers 3 DIFFERENT topics (planned by the autopilot), one Short each.
    const topics = this.ctx.repos.artifacts.latest<{ topics?: { title: string; subject: string; angle: string }[] }>(input.videoId, 'calendar_entry')?.data.topics;
    // "short" = a Shorts pack: 3 independent mini-stories, each rendered as its own vertical Short.
    const pack = input.format === 'short'
      ? { shortsPack: 'Write EXACTLY 3 scenes. Each scene is a complete, independent YouTube Short of 40–55 seconds (90–115 spoken words)' + (topics?.length === 3 ? ` — scene 1 is about "${topics[0]!.title}", scene 2 about "${topics[1]!.title}", scene 3 about "${topics[2]!.title}" (three DIFFERENT subjects; each scene tells only its own topic)` : '') + '. The FIRST sentence states the secret/idea (and names the company if it is a story), so the viewer knows within 2 seconds what it is about and why it matters to them; then the proof in a few concrete beats (the documented fact, experiment, example or story, with numbers from the sources) using everyday, filmable examples (a price tag, a shop shelf, a menu, an office meeting…); then the takeaway in one clear sentence and how the viewer can apply it in their own work or project (one practical step). curiosityGap = its hook question, onScreenText = the subject name (1–3 words). Keep opening, cta and ending to one short sentence each.', topics }
      : {};
    // Real sources first: facts in the script must come from them, so verification can confirm them.
    const sources = topics?.length
      ? (await Promise.all(topics.map((t) => researchTopic(this.ctx, input.videoId, `${t.subject} ${t.angle}`, t.title).catch(() => [])))).flat()
      : await researchTopic(this.ctx, input.videoId, input.title, input.angle).catch(() => []);
    if (topics?.length) this.ctx.repos.artifacts.save({ videoId: input.videoId, kind: 'research', agent: 'research', data: { queries: topics.map((t) => t.subject), sources } });
    const sourcing = sources.length
      ? { sources, sourceRule: 'Use these sources as your ONLY basis for facts: every number, date, name, quote and event in the script must appear in one of them. Build the story from their most surprising concrete facts (at least 6 distinct facts for a long video, at least 2 per Short). Never invent or round figures differently.' }
      : {};
    const res = await this.ctx.providers.llm.generateJson({
      task: 'script.write',
      tier: 'writing',
      system: loadPrompt('scriptwriter'),
      prompt: JSON.stringify({ ...input, ...pack, ...sourcing, brief: this.ctx.repos.artifacts.latest(input.videoId, 'brief')?.data, targetWords: target, dialect: this.ctx.config.channel.dialect }),
      schema: ScriptLLM,
      maxOutputTokens: 16000,
      videoId: input.videoId,
    });
    // Never trust the model's own length estimate — measure it, and ask once for a deeper version if too short.
    let data = res.data;
    if (countWords(spokenText({ ...data, format: input.format })) < target.minWords * 0.9) {
      const words = countWords(spokenText({ ...data, format: input.format }));
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
      if (countWords(spokenText({ ...exp.data, format: input.format })) > words) data = exp.data;
    }
    // A Shorts pack is exactly 3 Shorts, even if the model wrote more scenes.
    if (input.format === 'short' && data.scenes.length > 3) data = { ...data, scenes: data.scenes.slice(0, 3) };
    // Stage gate: check the script now and fix the exact problems (up to 2 rewrites, keep the best).
    let problems = scriptProblems({ ...data, format: input.format }, target, this.ctx.config.channel.dialect);
    for (let i = 0; i < 2 && problems.length; i++) {
      const rev = await this.ctx.providers.llm.generateJson({
        task: 'script.revise',
        tier: 'writing',
        system: loadPrompt('scriptwriter'),
        prompt: JSON.stringify({ instruction: 'Fix ONLY these problems and return the complete script. Keep the facts, structure, length and tone; do not add new numbers or claims.', problems, script: data }),
        schema: ScriptLLM,
        maxOutputTokens: 16000,
        videoId: input.videoId,
        vars: { previous: data },
      }).catch(() => undefined);
      if (!rev) break;
      const next = scriptProblems({ ...rev.data, format: input.format }, target, this.ctx.config.channel.dialect);
      // Accept only a real improvement that did not gut the script.
      if (next.length >= problems.length || countWords(spokenText({ ...rev.data, format: input.format })) < countWords(spokenText({ ...data, format: input.format })) * 0.8) break;
      data = rev.data;
      problems = next;
    }
    if (problems.length) this.ctx.logger.child('scriptwriter').warn('script problems left after fixing', { videoId: input.videoId, problems });
    const wordCount = countWords(spokenText({ ...data, format: input.format }));
    const estimatedDurationSec = Math.round((wordCount / t.arabicWordsPerMinute) * 60);
    this.ctx.repos.videos.update(input.videoId, { status: 'scripted', title: data.mainTitle });
    return { ...data, wordCount, estimatedDurationSec, format: input.format };
  }
}
