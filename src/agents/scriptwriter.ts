import { z } from 'zod';
import { Agent, countWords, type AgentContext } from './base.ts';
import { ScriptLLM, type Script } from './schemas.ts';
import { loadPrompt } from '../prompts.ts';
import { scriptProblems } from './stage-checks.ts';
import { researchTopic, type ResearchSource } from './research.ts';
import { StudioError } from '../core/errors.ts';

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
export function spokenText(s: Pick<Script, 'opening' | 'scenes' | 'cta' | 'ending'> & { format?: Script['format'] }): string {
  return s.scenes.map((_, i) => narratedSceneText(s, i)).join('\n');
}

const EditorLLM = z.object({ problems: z.array(z.object({ scene: z.number().int().default(0), problem: z.string().min(5) })).default([]) });

/**
 * A strict editor reads the narration as the viewer will hear it: is each video/Short on its topic, does it
 * start at the beginning (never mid-story, never "he"/"this" before saying who/what), and does every sentence
 * follow from the one before? Returns fix instructions (empty = OK, or the check is unavailable).
 */
export async function editorProblems(ctx: AgentContext, input: Pick<ScriptInput, 'videoId' | 'format'>, d: Pick<Script, 'opening' | 'scenes' | 'cta' | 'ending' | 'mainTitle'>, topics?: { title: string; subject: string }[]): Promise<string[]> {
  if (ctx.providers.llm.name.startsWith('mock')) return [];
  const units = input.format === 'short'
    ? d.scenes.map((sc, i) => ({ scene: sc.n, topic: topics?.[i] ? `${topics[i]!.title} (${topics[i]!.subject})` : sc.onScreenText, narration: sc.voiceover }))
    : [{ scene: 0, topic: d.mainTitle, narration: spokenText({ ...d, format: input.format }) }];
  const r = await ctx.providers.llm.generateJson({
    task: 'script.editor',
    tier: 'light',
    system: 'You are a strict YouTube script editor. Each unit is narration a viewer hears from second 0 with no other context (each Short is watched alone). Report ONLY real problems: ' +
      '(1) OFF-TOPIC: the narration is not clearly about its topic (e.g. a story Short that never names or tells the company/person of its topic, or drifts into generic advice); ' +
      '(2) NO START: the first sentence does not say plainly what this is about, or it starts mid-story / with a pronoun or reference the viewer cannot know ("he", "this decision", "then"); ' +
      '(3) JUMPS: a sentence does not follow from the previous one, a claim appears from nowhere, or the ending does not pay off the opening. ' +
      'Write each problem as a short English rewrite instruction naming the scene and the exact sentence. Return {"problems":[]} if the narration is clear and coherent. JSON only.',
    prompt: JSON.stringify({ format: input.format, units }),
    schema: EditorLLM,
    videoId: input.videoId,
    maxOutputTokens: 2000,
  }).catch(() => undefined);
  return (r?.data.problems ?? []).slice(0, 6).map((p) => (p.scene ? `Scene ${p.scene}: ${p.problem}` : p.problem));
}


export class ScriptwriterAgent extends Agent<ScriptInput, Script> {
  readonly name = 'scriptwriter';
  readonly artifactKind = 'script';

  protected async execute(input: ScriptInput): Promise<Script> {
    const t = this.ctx.config.thresholds.script;
    const target =
      input.format === 'long'
        ? { minWords: t.longForm.minMinutes * t.arabicWordsPerMinute, maxWords: t.longForm.maxMinutes * t.arabicWordsPerMinute }
        : { minWords: /phone|mobile/i.test(this.ctx.config.channel.niche ?? '') ? 210 : 240, maxWords: 3 * Math.floor(((t.short.maxSeconds - 8) / 60) * t.arabicWordsPerMinute) };
    // A Shorts pack covers 3 DIFFERENT topics (planned by the autopilot), one Short each.
    const topics = this.ctx.repos.artifacts.latest<{ topics?: { title: string; subject: string; angle: string; kind?: string; sourceUrl?: string }[] }>(input.videoId, 'calendar_entry')?.data.topics;
    const phone = /phone|mobile|موبايل/i.test(this.ctx.config.channel.niche ?? '');
    // "short" = a Shorts pack: 3 independent mini-stories, each rendered as its own vertical Short.
    const order = topics?.length === 3 ? ` — scene 1 is about "${topics[0]!.title}", scene 2 about "${topics[1]!.title}", scene 3 about "${topics[2]!.title}" (three DIFFERENT subjects; scene N tells ONLY topic N)` : '';
    const pack = input.format === 'short' && phone
      ? { shortsPack: 'Write EXACTLY 3 scenes. Each scene is a complete, independent YouTube Short of 30–45 seconds (70–100 spoken words) in natural EGYPTIAN Arabic, like a friend showing you a secret on his phone — fast, warm, excited, never formal' + order + '. ' +
          'Structure of every scene: (1) HOOK in the first sentence (≤ 12 words): the surprising benefit, e.g. "فيه كود لو كتبته في موبايلك هيقولك…", "الآيفون بتاعك فيه زرار سري ورا الضهر!"; ' +
          '(2) the exact steps the viewer follows RIGHT NOW: the code written in digits/symbols exactly (e.g. *#06#) or the settings path in the words the phone shows (الإعدادات ← تسهيلات الاستخدام ← اللمس ← النقر على الظهر), one short step per sentence; ' +
          '(3) what they will see and one concrete use for it; (4) which phones it works on (آيفون / أندرويد / سامسونج) and any difference; (5) one short punchy closing line that invites sharing ("ابعتها لصاحبك اللي مش عارفها"). ' +
          'Only steps and facts stated in the sources; never codes that reset, erase or unlock anything. curiosityGap = the hook question; onScreenText = the code itself or the feature name (1–4 words, e.g. "*#06#", "النقر على الظهر"). Keep opening, cta and ending to one short sentence each.', topics }
      : input.format === 'short'
      ? { shortsPack: 'Write EXACTLY 3 scenes. Each scene is a complete, independent YouTube Short of 40–55 seconds (90–115 spoken words)' + (topics?.length === 3 ? ` — scene 1 is about "${topics[0]!.title}", scene 2 about "${topics[1]!.title}", scene 3 about "${topics[2]!.title}" (three DIFFERENT subjects; scene N tells ONLY topic N — never mix them, never borrow facts from another scene's topic, and for a story the company/person is named in the first sentence)` : '') + '. The FIRST sentence states the secret/idea (and names the company if it is a story), so the viewer knows within 2 seconds what it is about and why it matters to them; then the proof in a few concrete beats (the documented fact, experiment, example or story, with numbers from the sources) using everyday, filmable examples (a price tag, a shop shelf, a menu, an office meeting…); then the takeaway in one clear sentence and how the viewer can apply it in their own work or project (one practical step). curiosityGap = its hook question, onScreenText = the subject name (1–3 words). Keep opening, cta and ending to one short sentence each.', topics }
      : {};
    // Real sources first: facts in the script must come from them, so verification can confirm them.
    // Sequential (not parallel): Wikipedia throttles bursts from cloud IPs.
    const perTopic: ResearchSource[][] = [];
    for (const t of topics ?? []) perTopic.push(await researchTopic(this.ctx, input.videoId, `${t.subject} ${t.angle}`, t.title, t.subject, t.sourceUrl ? [t.sourceUrl] : []).catch(() => []));
    // Never write a Short blind: a topic without any source produced a vague, off-topic Short before.
    const blind = (topics ?? []).filter((_, i) => !perTopic[i]!.length);
    if (blind.length && this.ctx.providers.web.name !== 'mock-web') throw new StudioError('NO_SOURCES', `No sources found for: ${blind.map((t) => t.subject).join(', ')} — another topic will be tried`, false);
    const sources = topics?.length ? perTopic.flat() : await researchTopic(this.ctx, input.videoId, input.title, input.angle).catch(() => []);
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
    // Rule checks + an editor's read: on topic, starts at the beginning, every sentence follows the last.
    const check = async (d: typeof data) => [
      ...scriptProblems({ ...d, format: input.format }, target, this.ctx.config.channel.dialect),
      ...(await editorProblems(this.ctx, input, d, topics)),
    ];
    let problems = await check(data);
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
      const next = await check(rev.data);
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
