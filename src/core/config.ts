import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ConfigError } from './errors.ts';

const providerMode = z.enum(['mock', 'real']);

const EnvSchema = z.object({
  DRY_RUN: z.string().default('true').transform((v) => v.toLowerCase() !== 'false'),
  /** Hard guarantee: providers that can create a paid charge stay disabled. */
  FREE_ONLY: z.string().default('true').transform((v) => v.toLowerCase() !== 'false'),
  ALLOW_PUBLIC_PUBLISHING: z.string().default('false').transform((v) => v.toLowerCase() === 'true'),
  LLM_PROVIDER: z.enum(['mock', 'gemini']).default('mock'),
  TTS_PROVIDER: z.enum(['mock', 'macos', 'gemini']).default('mock'),
  IMAGE_PROVIDER: providerMode.default('mock'),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  /** Max YouTube uploads per Pacific day (free API quota ≈ 6 uploads). */
  YOUTUBE_DAILY_UPLOADS: z.coerce.number().int().positive().default(6),
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  /** Facebook Page + linked Instagram account (Meta Graph API). Empty = cross-posting off. */
  META_PAGE_ID: z.string().optional(),
  META_PAGE_TOKEN: z.string().optional(),
  META_IG_USER_ID: z.string().optional(),
  META_GRAPH_VERSION: z.string().default('v27.0'),
  TIKTOK_ACCESS_TOKEN: z.string().optional(),
  /** Buffer API key: TikTok posting through Buffer (its TikTok app is approved). Empty = off. */
  BUFFER_API_KEY: z.string().optional(),
  TIKTOK_PRIVACY_LEVEL: z.string().default('SELF_ONLY'),
  STOCK_PROVIDER: z.enum(['mock', 'pexels', 'pixabay']).default('mock'),
  YOUTUBE_PROVIDER: providerMode.default('mock'),
  TRENDS_PROVIDER: providerMode.default('mock'),
  GEMINI_API_KEY: z.string().optional(),
  /** Optional key from a second Google AI Studio project: used when the first one's daily free quota runs out. */
  GEMINI_API_KEY_2: z.string().optional(),
  GEMINI_MODEL_WRITING: z.string().default('gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3-flash-preview,gemini-flash-latest,gemini-3.5-flash-lite'),
  /** Search-grounded fact checks (library proof): models whose free tier includes Google Search. */
  GEMINI_MODEL_SEARCH: z.string().default('gemini-2.5-flash,gemini-2.5-flash-lite,gemini-flash-latest,gemini-flash-lite-latest'),
  GEMINI_MODEL_LIGHT: z.string().default('gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-flash-lite-latest,gemini-3.5-flash,gemini-3.6-flash,gemini-3-flash-preview'),
  /** true = Google AI Studio free tier: cost is recorded as $0. */
  GEMINI_FREE_TIER: z.string().default('true').transform((v) => v.toLowerCase() !== 'false'),
  /** Max LLM requests per minute (keep under the free-tier limit). */
  LLM_RPM: z.coerce.number().positive().default(8),
  MACOS_VOICE: z.string().default('Majed'),
  /** Strict automatic fact verification (web + Wikipedia evidence). */
  AUTO_VERIFY: z.string().default('false').transform((v) => v.toLowerCase() === 'true'),
  /** Autopilot approves videos that pass EVERY gate (no human). */
  AUTO_APPROVE: z.string().default('false').transform((v) => v.toLowerCase() === 'true'),
  GEMINI_TTS_MODEL: z.string().default('gemini-3.8-flash-tts,gemini-3.1-flash-tts-preview,gemini-3.8-flash-lite-tts,gemini-2.5-flash-preview-tts'),
  GEMINI_TTS_VOICE: z.string().default('Charon'),
  GEMINI_TTS_STYLE: z.string().default('Native Egyptian speaker from Cairo. Speak in natural Egyptian colloquial Arabic (عامية مصرية) with authentic Egyptian pronunciation and intonation (e.g. ج as in Cairo, ق often as a glottal stop, Egyptian vowels) — like a friendly, energetic Egyptian tech YouTuber talking to a friend. Never Modern Standard Arabic pronunciation. Warm, lively, clear, medium-fast pace.'),
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_MODEL_WRITING: z.string().default('claude-sonnet-5-5'),
  LLM_MODEL_LIGHT: z.string().default('claude-haiku-5-5'),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  PEXELS_API_KEY: z.string().optional(),
  PIXABAY_API_KEY: z.string().optional(),
  YOUTUBE_CLIENT_ID: z.string().optional(),
  YOUTUBE_CLIENT_SECRET: z.string().optional(),
  YOUTUBE_REFRESH_TOKEN: z.string().optional(),
  DATABASE_URL: z.string().default('sqlite:./data/studio.db'),
  /** 27 = Education, 22 = People & Blogs, 25 = News & Politics, 28 = Science & Technology */
  YOUTUBE_CATEGORY_ID: z.string().default('27'),
  MONTHLY_BUDGET_USD: z.coerce.number().positive().default(100),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const ChannelSchema = z.object({
  channelName: z.string(),
  language: z.string(),
  dialect: z.string(),
  targetCountries: z.array(z.string()).min(1),
  audience: z.object({ ageRange: z.string(), gender: z.string(), interests: z.array(z.string()) }),
  niche: z.string().nullable(),
  formats: z.array(z.enum(['long', 'short'])).min(1),
  publishing: z.object({ longPerWeek: z.number().int().min(0), shortsPerWeek: z.number().int().min(0) }),
  style: z.string(),
  faceless: z.boolean(),
  competitors: z.array(z.string()),
  /** Broad on-topic stock searches for shots nothing specific fits (never an empty coloured card). */
  fallbackFootage: z.array(z.string()).default([]),
});

const ThresholdsSchema = z.object({
  compliance: z.object({ minScoreToPublish: z.number().min(0).max(100) }),
  quality: z.object({ minScoreToPublish: z.number().min(0).max(100) }),
  script: z.object({
    arabicWordsPerMinute: z.number().positive(),
    longForm: z.object({ minMinutes: z.number(), maxMinutes: z.number() }),
    short: z.object({ maxSeconds: z.number() }),
  }),
  packaging: z.object({
    maxTitleChars: z.number(),
    maxThumbnailWords: z.number(),
    minAltTitles: z.number(),
    minHooks: z.number(),
  }),
  analytics: z.object({ checkpointsHours: z.array(z.number()), minVideosForStrategicConclusion: z.number() }),
  jobs: z.object({ maxAttempts: z.number().int().min(1), baseBackoffMs: z.number().min(0) }),
});

export type Env = z.infer<typeof EnvSchema>;
/** Where `youtube:auth` stores the OAuth client + refresh token (0600). */
export const YOUTUBE_AUTH_FILE = 'data/secrets/youtube.json';
export type ChannelConfig = z.infer<typeof ChannelSchema>;
export type Thresholds = z.infer<typeof ThresholdsSchema>;

export interface AppConfig {
  env: Env;
  channel: ChannelConfig;
  thresholds: Thresholds;
  rootDir: string;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Cannot read config file ${path}: ${(err as Error).message}`);
  }
}

function parse<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid ${label}: ${issues}`);
  }
  return r.data;
}

/**
 * Loads `.env` (if present) + config/*.json and validates everything.
 * `overrides` lets tests inject env values without touching process.env.
 */
export function loadConfig(opts: { rootDir?: string; envOverrides?: Record<string, string> } = {}): AppConfig {
  const rootDir = resolve(opts.rootDir ?? process.cwd());
  const envFile = resolve(rootDir, '.env');
  if (!opts.envOverrides && existsSync(envFile)) process.loadEnvFile(envFile);

  const rawEnv = opts.envOverrides ?? process.env;
  // Empty strings in .env mean "not set".
  const cleaned = Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => v !== undefined && v !== ''));
  const env = parse(EnvSchema, cleaned, '.env');

  if (env.LLM_PROVIDER === 'gemini' && !env.GEMINI_API_KEY) {
    throw new ConfigError('LLM_PROVIDER=gemini requires GEMINI_API_KEY (free key: https://aistudio.google.com/apikey)');
  }
  if (env.TTS_PROVIDER === 'gemini' && !env.GEMINI_API_KEY) {
    throw new ConfigError('TTS_PROVIDER=gemini requires GEMINI_API_KEY');
  }
  if (env.FREE_ONLY && !env.GEMINI_FREE_TIER) {
    throw new ConfigError('FREE_ONLY=true requires GEMINI_FREE_TIER=true');
  }
  if (env.STOCK_PROVIDER === 'pexels' && !env.PEXELS_API_KEY) {
    throw new ConfigError('STOCK_PROVIDER=pexels requires PEXELS_API_KEY (free key: https://www.pexels.com/api/)');
  }
  if (env.STOCK_PROVIDER === 'pixabay' && !env.PIXABAY_API_KEY) {
    throw new ConfigError('STOCK_PROVIDER=pixabay requires PIXABAY_API_KEY (free key: https://pixabay.com/api/docs/)');
  }
  if (env.YOUTUBE_PROVIDER === 'real' && !(env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET && env.YOUTUBE_REFRESH_TOKEN) && !existsSync(resolve(rootDir, YOUTUBE_AUTH_FILE))) {
    throw new ConfigError('YOUTUBE_PROVIDER=real needs a linked channel — run: npm run cli -- youtube:auth --client <client_secret.json>');
  }

  const channel = parse(ChannelSchema, readJson(resolve(rootDir, 'config/channel.json')), 'config/channel.json');
  const thresholds = parse(ThresholdsSchema, readJson(resolve(rootDir, 'config/thresholds.json')), 'config/thresholds.json');
  return { env, channel, thresholds, rootDir };
}

/** Names of env vars that hold secrets — used by the logger for redaction. */
export const SECRET_ENV_KEYS = [
  'GEMINI_API_KEY',
  'GEMINI_API_KEY_2',
  'ANTHROPIC_API_KEY',
  'ELEVENLABS_API_KEY',
  'PEXELS_API_KEY',
  'PIXABAY_API_KEY',
  'YOUTUBE_CLIENT_SECRET',
  'YOUTUBE_REFRESH_TOKEN',
  'META_PAGE_TOKEN',
  'TIKTOK_ACCESS_TOKEN',
  'BUFFER_API_KEY',
] as const;
