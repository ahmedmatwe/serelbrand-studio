import { resolve } from 'node:path';
import { loadConfig, SECRET_ENV_KEYS, type AppConfig } from './core/config.ts';
import { createLogger, type Logger } from './core/logger.ts';
import { AuditLog } from './core/audit.ts';
import { CostTracker } from './core/cost.ts';
import { ConfigError } from './core/errors.ts';
import { openDb, type Db } from './database/db.ts';
import { AgentStateRepo, AnalyticsRepo, ApprovalRepo, ArtifactRepo, KnowledgeRepo, VideoRepo } from './database/repositories.ts';
import { MockLLM } from './providers/llm/mock.ts';
import { TrackedLLM } from './providers/llm/tracked.ts';
import type { LLMProvider } from './providers/llm/types.ts';
import { GeminiLLM } from './providers/llm/gemini.ts';
import { MacSayTTS } from './providers/tts/macos-say.ts';
import { FallbackTTS, GeminiTTS } from './providers/tts/gemini-tts.ts';
import { RateLimiter } from './core/retry.ts';
import { PexelsStock } from './providers/stock/pexels.ts';
import { WikimediaStock } from './providers/stock/wikimedia.ts';
import { CloudflareImage } from './providers/image/cloudflare.ts';
import { PixabayStock } from './providers/stock/pixabay.ts';
import { RealYouTube } from './providers/youtube/youtube.ts';
import { MockWeb, RealWeb } from './providers/web/web.ts';
import { loadAuth, TokenSource } from './providers/youtube/oauth.ts';
import { YOUTUBE_AUTH_FILE } from './core/config.ts';
import { MockImage, MockStock, MockTrends, MockTTS, MockYouTube } from './providers/media.ts';
import { JobQueue } from './queue/queue.ts';
import type { AgentContext } from './agents/base.ts';
import { registerStepHandlers } from './workflows/steps.ts';

export interface CreateContextOptions {
  rootDir?: string;
  envOverrides?: Record<string, string>;
  /** Inject a provider (tests). */
  llm?: LLMProvider;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
}

function notYet(kind: string): never {
  throw new ConfigError(`${kind}=real is not implemented yet (planned for a later phase). Use mock.`);
}

export function createContext(opts: CreateContextOptions = {}): AgentContext & { db: Db; close: () => void } {
  const config: AppConfig = loadConfig({ rootDir: opts.rootDir, envOverrides: opts.envOverrides });
  const { env } = config;
  const storedYt = loadAuth(resolve(config.rootDir, YOUTUBE_AUTH_FILE));
  const secrets = [...SECRET_ENV_KEYS.map((k) => env[k]), storedYt?.clientSecret, storedYt?.refreshToken].filter((v): v is string => Boolean(v));
  const logger = opts.logger ?? createLogger({ level: env.LOG_LEVEL, secrets, file: resolve(config.rootDir, 'data/logs/studio.jsonl') });

  const db = openDb(env.DATABASE_URL, config.rootDir);
  const audit = new AuditLog(db);
  const cost = new CostTracker(db, env.MONTHLY_BUDGET_USD, env.DRY_RUN);
  const repos = {
    videos: new VideoRepo(db),
    artifacts: new ArtifactRepo(db),
    agentState: new AgentStateRepo(db),
    approvals: new ApprovalRepo(db),
    analytics: new AnalyticsRepo(db),
    knowledge: new KnowledgeRepo(db),
  };

  const realYouTube = () => {
    const stored = loadAuth(resolve(config.rootDir, YOUTUBE_AUTH_FILE));
    const a = env.YOUTUBE_REFRESH_TOKEN && env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET
      ? { clientId: env.YOUTUBE_CLIENT_ID, clientSecret: env.YOUTUBE_CLIENT_SECRET, refreshToken: env.YOUTUBE_REFRESH_TOKEN }
      : stored;
    if (!a) throw new ConfigError('YouTube is not linked — run: npm run cli -- youtube:auth --client <client_secret.json>');
    return new RealYouTube({ tokens: new TokenSource(a), categoryId: env.YOUTUBE_CATEGORY_ID });
  };

  // In dry-run, every provider is forced to mock regardless of *_PROVIDER.
  const real = (mode: string) => mode !== 'mock' && !env.DRY_RUN;
  const useGemini = !opts.llm && real(env.LLM_PROVIDER) && env.LLM_PROVIDER === 'gemini';
  const rawLLM: LLMProvider =
    opts.llm ?? (useGemini ? new GeminiLLM({ apiKey: [env.GEMINI_API_KEY, env.GEMINI_API_KEY_2].filter(Boolean).join(','), models: { writing: env.GEMINI_MODEL_WRITING, light: env.GEMINI_MODEL_LIGHT, search: env.GEMINI_MODEL_SEARCH } }) : new MockLLM());
  const zero = { inputPerM: 0, outputPerM: 0 };
  const providers = {
    llm: new TrackedLLM(rawLLM, {
      cost, logger,
      // Free-tier 429s need real back-off: start at 15 s.
      attempts: useGemini ? 5 : config.thresholds.jobs.maxAttempts,
      baseDelayMs: useGemini ? 15_000 : config.thresholds.jobs.baseBackoffMs,
      sleep: opts.sleep,
      // Rate-limit only real providers; mocks run unthrottled.
      limiter: useGemini ? new RateLimiter(Math.max(1, Math.floor(env.LLM_RPM / 4)), env.LLM_RPM / 60) : new RateLimiter(1_000, 1_000),
      pricing: useGemini && env.GEMINI_FREE_TIER ? { writing: zero, light: zero } : undefined,
    }),
    trends: real(env.TRENDS_PROVIDER) ? notYet('TRENDS_PROVIDER') : new MockTrends(),
    tts: !real(env.TTS_PROVIDER)
      ? new MockTTS()
      : env.TTS_PROVIDER === 'gemini'
        // On macOS fall back to the built-in voice; elsewhere (cloud) fail so the next cycle retries — never publish silence.
        ? (process.platform === 'darwin'
          ? new FallbackTTS(new GeminiTTS({ apiKey: [env.GEMINI_API_KEY, env.GEMINI_API_KEY_2].filter(Boolean).join(','), model: env.GEMINI_TTS_MODEL, voice: env.GEMINI_TTS_VOICE, style: env.GEMINI_TTS_STYLE, sleep: opts.sleep }), new MacSayTTS(env.MACOS_VOICE))
          : new GeminiTTS({ apiKey: [env.GEMINI_API_KEY, env.GEMINI_API_KEY_2].filter(Boolean).join(','), model: env.GEMINI_TTS_MODEL, voice: env.GEMINI_TTS_VOICE, style: env.GEMINI_TTS_STYLE, sleep: opts.sleep }))
        : new MacSayTTS(env.MACOS_VOICE),
    // Cloudflare image generation can leave a free allocation and become billable. FREE_ONLY keeps it off.
    image: !env.FREE_ONLY && real(env.IMAGE_PROVIDER) && env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN ? new CloudflareImage({ accountId: env.CLOUDFLARE_ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN, sleep: opts.sleep }) : new MockImage(),
    stock: !real(env.STOCK_PROVIDER)
      ? new MockStock()
      : env.STOCK_PROVIDER === 'pixabay' ? new PixabayStock(env.PIXABAY_API_KEY!, { cacheDir: resolve(config.rootDir, 'data/stock-cache') }) : new PexelsStock(env.PEXELS_API_KEY!),
    youtube: real(env.YOUTUBE_PROVIDER) ? realYouTube() : new MockYouTube(),
    web: env.DRY_RUN ? new MockWeb() : new RealWeb(),
    photos: env.DRY_RUN ? undefined : new WikimediaStock(),
  };

  const queue = new JobQueue({
    db, agentState: repos.agentState, audit, logger,
    baseBackoffMs: config.thresholds.jobs.baseBackoffMs,
    defaultMaxAttempts: config.thresholds.jobs.maxAttempts,
  });

  const ctx = { config, logger, audit, cost, repos, providers, queue, db, close: () => db.close() };
  registerStepHandlers(ctx);
  logger.debug('context ready', { dryRun: env.DRY_RUN, llm: rawLLM.name });
  return ctx;
}
