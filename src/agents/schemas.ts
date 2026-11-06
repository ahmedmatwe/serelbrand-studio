import { z } from 'zod';

const level = z.enum(['low', 'medium', 'high']);
export type Level = z.infer<typeof level>;

// ---------- Trend research ----------
export const TopicIdeaLLM = z.object({
  title: z.string().min(5),
  angle: z.string(),
  seedQuery: z.string(),
  targetAudience: z.string(),
  searchIntent: z.enum(['informational', 'entertainment', 'curiosity', 'problem-solving', 'news']),
  trendStatus: z.enum(['rising', 'stable', 'declining', 'evergreen']),
  competition: level,
  monetization: level,
  copyrightRisk: level,
  policyRisk: level,
  recommendedFormat: z.enum(['long', 'short', 'both']),
  emotionalTrigger: z.string(),
  contentGap: z.string(),
  explanation: z.string(),
});
export const TrendResearchLLM = z.object({ ideas: z.array(TopicIdeaLLM).min(3) });
export type TopicIdea = z.infer<typeof TopicIdeaLLM> & { opportunityScore: number; scoreBreakdown: Record<string, number> };

// ---------- Strategy ----------
export const StrategyLLM = z.object({
  pillars: z.array(z.object({ name: z.string(), description: z.string(), share: z.number().min(0).max(1) })).min(2),
  series: z.array(z.object({ name: z.string(), pillar: z.string(), episodes: z.array(z.string()).min(2) })).min(1),
  backlog: z.array(z.object({
    title: z.string(),
    pillar: z.string(),
    kind: z.enum(['evergreen', 'trending']),
    shortsAngles: z.array(z.string()).default([]),
  })).min(4),
  experiments: z.array(z.object({ hypothesis: z.string(), variable: z.string(), metric: z.string() })).min(1),
});
export type StrategyLLMOut = z.infer<typeof StrategyLLM>;

export interface CalendarEntry {
  day: number;
  date: string;
  format: 'long' | 'short';
  title: string;
  pillar: string;
  kind: 'evergreen' | 'trending' | 'experiment';
  linkedLongTitle?: string;
}

// ---------- Script ----------
export const ScriptLLM = z.object({
  hooks: z.array(z.string().min(10)).min(3),
  mainTitle: z.string().min(5),
  altTitles: z.array(z.string()).min(5),
  opening: z.string().min(20),
  scenes: z.array(z.object({
    n: z.number().int().positive(),
    purpose: z.string(),
    voiceover: z.string().min(10),
    onScreenText: z.string().default(''),
    curiosityGap: z.string().optional(),
    transition: z.string(),
  })).min(3),
  cta: z.string(),
  ending: z.string(),
  nextVideoSuggestion: z.string(),
});
export type Script = z.infer<typeof ScriptLLM> & { wordCount: number; estimatedDurationSec: number; format: 'long' | 'short' };

// ---------- Fact-check ----------
export const FactCheckLLM = z.object({
  claims: z.array(z.object({
    claim: z.string(),
    sceneN: z.number().int().nullable(),
    type: z.enum(['fact', 'statistic', 'opinion', 'prediction', 'quote']),
    sourceUrl: z.string().nullable(),
    sourceTitle: z.string().nullable(),
    sourceDate: z.string().nullable(),
    confidence: level,
    notes: z.string(),
    /** 3–6 English keywords to find evidence (Wikipedia / web). */
    searchQuery: z.string().default(''),
  })),
});
export const JudgeLLM = z.object({
  verdict: z.enum(['supported', 'contradicted', 'not_found']),
  /** Exact sentence copied from the source text that proves the verdict. */
  quote: z.string(),
  correction: z.string().nullable(),
});
export type ClaimStatus = 'verified' | 'needs_review' | 'unverified' | 'not_applicable';
export type CheckedClaim = z.infer<typeof FactCheckLLM>['claims'][number] & {
  status: ClaimStatus;
  humanReviewRequired: boolean;
  reasons: string[];
  /** Evidence gathered by the automatic verifier. */
  evidence?: { url: string; quote: string; verdict: 'supported' | 'contradicted' }[];
  contradicted?: boolean;
};
export interface FactCheckReport { claims: CheckedClaim[]; overall: 'verified' | 'needs_review' | 'blocked'; summary: string }

// ---------- Production blueprint ----------
export const BlueprintLLM = z.object({
  scenes: z.array(z.object({
    n: z.number().int().positive(),
    voiceover: z.string(),
    footage: z.string(),
    assetSource: z.enum(['generated', 'stock', 'original-graphic', 'screen-recording']),
    visualPrompt: z.string(),
    /** 2–4 English keywords for stock search (Pexels works best in English). */
    stockQuery: z.string().default(''),
    onScreenText: z.string().default(''),
    motion: z.string(),
    sfx: z.string().default(''),
    musicMood: z.string(),
    transition: z.string(),
    subtitleNotes: z.string().default(''),
    editingNotes: z.string().default(''),
  })).min(1),
  music: z.object({ mood: z.string(), source: z.enum(['youtube-audio-library', 'licensed-library', 'original', 'none']) }),
  voice: z.object({ style: z.string(), pace: z.string() }),
});
export type BlueprintScene = z.infer<typeof BlueprintLLM>['scenes'][number] & { durationSec: number; startSec: number };
export type Blueprint = Omit<z.infer<typeof BlueprintLLM>, 'scenes'> & { scenes: BlueprintScene[]; totalDurationSec: number };

// ---------- Thumbnail ----------
export const ThumbnailLLM = z.object({
  concepts: z.array(z.object({
    mainVisual: z.string(),
    subject: z.string(),
    background: z.string(),
    palette: z.array(z.string()).min(2),
    text: z.string(),
    composition: z.string(),
    contrast: z.string(),
    emotion: z.string(),
    ctrRationale: z.string(),
    accuracyNote: z.string(),
  })).min(3).max(5),
});
export type ThumbnailConcept = z.infer<typeof ThumbnailLLM>['concepts'][number] & { textWordCount: number; valid: boolean; problems: string[] };

// ---------- SEO / packaging ----------
export const SeoLLM = z.object({
  primaryTitle: z.string(),
  altTitles: z.array(z.string()).min(5),
  description: z.string().min(50),
  keywords: z.array(z.string()).min(3),
  tags: z.array(z.string()),
  hashtags: z.array(z.string()).max(15),
  pinnedComment: z.string(),
  endScreen: z.string(),
  playlist: z.string(),
  followUps: z.array(z.string()),
});
export type SeoPackage = z.infer<typeof SeoLLM> & { chapters: { startSec: number; label: string }[]; fullDescription: string };
