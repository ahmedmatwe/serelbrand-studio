import { z } from 'zod';
import { ProviderError, ValidationError } from '../../core/errors.ts';
import type { LLMProvider, LLMRequest, LLMResult, ModelTier } from './types.ts';

export interface GeminiOptions {
  apiKey: string;
  models: Record<ModelTier, string>;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Extra attempts with validation feedback when the model returns JSON that does not match the schema. */
  repairAttempts?: number;
  timeoutMs?: number;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  error?: { code?: number; message?: string; status?: string };
}

/** Pulls the first JSON object/array out of a model reply (tolerates ```json fences). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1]! : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.search(/[[{]/);
    const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw new ValidationError('Model reply is not JSON');
  }
}

/**
 * Google Gemini via the public REST API (works on the free tier of Google AI Studio).
 * The API key is sent in a header, never in the URL, so it cannot leak into logs of request URLs.
 */
/** Models out of daily quota in this process. */
const exhaustedToday = new Set<string>();

export class GeminiLLM implements LLMProvider {
  readonly name = 'gemini';
  private readonly o: Required<Omit<GeminiOptions, 'fetchImpl'>> & { fetchImpl: typeof fetch };

  constructor(o: GeminiOptions) {
    if (!o.apiKey) throw new ProviderError('gemini', 'GEMINI_API_KEY is missing', false);
    this.o = {
      fetchImpl: o.fetchImpl ?? fetch,
      baseUrl: o.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta',
      repairAttempts: o.repairAttempts ?? 3,
      timeoutMs: o.timeoutMs ?? 180_000,
      apiKey: o.apiKey,
      models: o.models,
    };
  }

  private async call(model: string, system: string, userText: string, maxOutputTokens: number, images: { mimeType: string; data: string; label?: string }[] = []): Promise<{ text: string; inTok: number; outTok: number }> {
    let res: Response;
    try {
      res = await this.o.fetchImpl(`${this.o.baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.o.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: userText }, ...images.flatMap((im) => [...(im.label ? [{ text: im.label }] : []), { inlineData: { mimeType: im.mimeType, data: im.data } }])] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.7, maxOutputTokens },
        }),
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
    } catch (err) {
      throw new ProviderError('gemini', `Network error: ${(err as Error).message}`, true, { cause: err });
    }
    const data = (await res.json().catch(() => ({}))) as GeminiResponse;
    if (!res.ok) {
      const msg = data.error?.message ?? res.statusText;
      // 429 = free-tier quota/rate limit; 5xx = transient. 400/401/403/404 = config problem, do not retry.
      const retryable = res.status === 429 || res.status >= 500;
      const hint = res.status === 429 ? ' (free-tier rate limit — will back off)' : res.status === 404 ? ` (model "${model}" not found — check GEMINI_MODEL_*)` : '';
      throw new ProviderError('gemini', `HTTP ${res.status}: ${msg}${hint}`, retryable);
    }
    if (data.promptFeedback?.blockReason) throw new ProviderError('gemini', `Prompt blocked: ${data.promptFeedback.blockReason}`, false);
    const cand = data.candidates?.[0];
    if (cand?.finishReason && ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(cand.finishReason))
      throw new ProviderError('gemini', `Response blocked (${cand.finishReason})`, false);
    const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    if (!text) throw new ProviderError('gemini', `Empty response (finishReason=${cand?.finishReason ?? 'unknown'})`, cand?.finishReason !== 'MAX_TOKENS');
    if (cand?.finishReason === 'MAX_TOKENS') throw new ProviderError('gemini', 'Response truncated (MAX_TOKENS) — raise maxOutputTokens', false);
    const u = data.usageMetadata ?? {};
    return { text, inTok: u.promptTokenCount ?? 0, outTok: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
  }

  /**
   * Tries each model in a comma-separated list ("a,b,c") in order: a busy/over-quota model (503/429)
   * or a retired one (404) falls through to the next. Other errors stop immediately.
   */
  private async callWithFallback(models: string[], system: string, userText: string, maxOutputTokens: number, images?: { mimeType: string; data: string; label?: string }[]) {
    let last: unknown;
    // Models whose DAILY free quota is used up are skipped for the rest of this run (no wasted calls/backoff).
    const live = models.filter((m) => !exhaustedToday.has(m));
    for (const model of live.length ? live : models) {
      try {
        return { ...(await this.call(model, system, userText, maxOutputTokens, images)), model };
      } catch (err) {
        last = err;
        const m = (err as Error).message;
        if (!(err instanceof ProviderError) || !/HTTP (503|429|404)/.test(m)) throw err;
        if (/HTTP 429/.test(m) && /PerDay|per ?day|free_tier_requests/i.test(m)) exhaustedToday.add(model);
      }
    }
    throw last;
  }

  async generateJson<T>(req: LLMRequest<T>): Promise<LLMResult<T>> {
    const models = this.o.models[req.tier].split(',').map((m) => m.trim()).filter(Boolean);
    let model = models[0]!;
    const jsonSchema = JSON.stringify(z.toJSONSchema(req.schema, { unrepresentable: 'any' }));
    const base = `${req.prompt}\n\nReturn ONLY one JSON value that validates against this JSON Schema:\n${jsonSchema}`;
    let prompt = base;
    let inTok = 0;
    let outTok = 0;
    let lastIssues = '';
    for (let attempt = 0; attempt <= this.o.repairAttempts; attempt++) {
      // Each repair attempt starts from the next model, so one model's bad streak can't sink the task.
      const order = [...models.slice(attempt % models.length), ...models.slice(0, attempt % models.length)];
      const r = await this.callWithFallback(order, req.system, prompt, req.maxOutputTokens ?? 16_384, req.images);
      model = r.model;
      inTok += r.inTok;
      outTok += r.outTok;
      let parsedJson: unknown;
      try {
        parsedJson = extractJson(r.text);
      } catch {
        lastIssues = 'Reply was not valid JSON';
        prompt = `${base}\n\nYour previous reply was not valid JSON. Reply with JSON only.`;
        continue;
      }
      const parsed = req.schema.safeParse(parsedJson);
      if (parsed.success) return { data: parsed.data, usage: { inputTokens: inTok, outputTokens: outTok, model } };
      lastIssues = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      prompt = `${base}\n\nYour previous reply failed validation: ${lastIssues}\nFix these problems and reply with the complete corrected JSON only.`;
    }
    throw new ValidationError(`Gemini output did not match schema for "${req.task}": ${lastIssues}`);
  }
}
