/**
 * Topics the owner sends to the Telegram bot ("موضوع: …", "اعمل فيديو عن …").
 * Each request is turned into a library entry only if it is true and safe:
 *   1. the researcher drafts it in the library's exact format (steps, result, codes, which phones…) under the
 *      same hard safety rules as every other topic, or explains why it can't;
 *   2. an independent fact-checker reviews every step/code and may correct, or reject it;
 *   3. accepted → it goes FIRST into the next Shorts pack (and through all the usual gates); the owner is told
 *      on Telegram what was accepted, or why not, and again when its video is made.
 * Requests wait in the bot (Cloudflare KV) until an autopilot cycle handles them.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { AgentContext } from '../base.ts';
import { loadPhoneLibrary, type PhoneSecret } from './phone-library.ts';
import { guardCodes } from '../../publishing/social.ts';

export const REQUESTED_FILE = 'data/requested-secrets.json';

export interface TopicRequest { id: string; text: string; at: string }
interface Requested { request: TopicRequest; status: 'approved' | 'rejected' | 'duplicate' | 'produced'; entry?: PhoneSecret; reason?: string; duplicateOf?: string }

const Ui = z.union([
  z.object({ type: z.literal('dialer'), code: z.string().regex(/^[0-9*#+]{2,20}$/), call: z.boolean().default(true) }),
  z.object({ type: z.literal('settings'), os: z.enum(['ios', 'android']), path: z.array(z.string().min(1).max(40)).min(1).max(6) }),
]);
const Entry = z.object({
  kind: z.enum(['code', 'feature', 'trick']),
  platforms: z.string().min(3).max(80),
  title: z.string().min(8).max(70),
  onScreen: z.string().min(2).max(30),
  steps: z.array(z.string().min(2).max(80)).min(1).max(6),
  result: z.string().min(10).max(220),
  use: z.string().min(10).max(220),
  facts: z.string().min(20).max(700),
  source: z.string(),
  ui: Ui.optional(),
  footage: z.array(z.string().min(3).max(40)).min(2).max(6),
});
const Draft = z.object({
  verdict: z.enum(['ok', 'duplicate', 'reject']),
  reasonArabic: z.string().max(300).default(''),
  duplicateOf: z.string().default(''),
  confidence: z.number().min(0).max(1),
  entry: Entry.optional(),
});
const Check = z.object({
  verdict: z.enum(['ok', 'fix', 'reject']),
  reasonArabic: z.string().max(300).default(''),
  confidence: z.number().min(0).max(1),
  fixed: Entry.partial().optional(),
});

const SAFETY = 'HARD SAFETY RULES: never codes or steps that erase, reset, unlock, root, change carrier settings, spy on others or bypass security; never anything that could damage the phone or lose data; ' +
  'only real, documented features/codes that work on current phones — say exactly which (iPhone / Android / Samsung, versions) and where it may differ. If you are not sure it works exactly like that, reject.';

/** The bot's pending requests (empty when the bot isn't connected). */
export async function fetchRequests(env: { BOT_URL?: string; BOT_INGEST_SECRET?: string }, fetchImpl: typeof fetch = fetch): Promise<TopicRequest[]> {
  if (!env.BOT_URL || !env.BOT_INGEST_SECRET) return [];
  const r = await fetchImpl(`${env.BOT_URL.replace(/\/$/, '')}/requests`, { headers: { authorization: `Bearer ${env.BOT_INGEST_SECRET}` } }).catch(() => undefined);
  if (!r || !r.ok) return [];
  const j = (await r.json().catch(() => ({}))) as { requests?: TopicRequest[] };
  return (j.requests ?? []).filter((x) => x && x.id && typeof x.text === 'string');
}

/** Drafts + fact-checks one request. Never throws. */
export async function vetRequest(ctx: AgentContext, req: TopicRequest): Promise<Requested> {
  const lib = loadPhoneLibrary(ctx.config.rootDir);
  const known = (lib?.secrets ?? []).map((s) => ({ id: s.id, title: s.title }));
  const example = lib?.secrets.find((s) => s.ui?.type === 'settings') ?? lib?.secrets[0];
  const draft = await ctx.providers.llm.generateJson({
    task: 'topic.request.draft',
    tier: 'writing',
    system: 'You research a Short topic the channel owner asked for ("سر الموبايل": Egyptian Arabic phone/app secrets). ' +
      'Turn the request into ONE library entry in exactly the format of `example` (Egyptian Arabic fields; facts = the precise English facts + Arabic summary; source = one key of `sources`; ui = a dialer code or the settings path to draw, when it applies; footage = English stock searches that literally show the topic). ' +
      'verdict "duplicate" with duplicateOf = the id when `known` already has the same secret; "reject" with reasonArabic (short, polite Egyptian Arabic) when it is not about phones/apps, unsafe, not real, or you are not sure the steps are exactly right. ' +
      SAFETY + ' confidence = how sure you are every step and code is exactly correct (0–1). JSON only.',
    prompt: JSON.stringify({ request: req.text, example, sources: Object.keys(lib?.sources ?? {}), known }),
    schema: Draft,
    maxOutputTokens: 2500,
  }).catch(() => undefined);
  const d = draft?.data as z.infer<typeof Draft> | undefined;
  if (!d) return { request: req, status: 'rejected', reason: 'مقدرتش أراجع الموضوع دلوقتي (الذكاء الاصطناعي مش متاح) — ابعته تاني بعد شوية.' };
  if (d.verdict === 'duplicate' && known.some((k) => k.id === d.duplicateOf)) return { request: req, status: 'duplicate', duplicateOf: d.duplicateOf };
  if (d.verdict !== 'ok' || !d.entry || d.confidence < 0.75) return { request: req, status: 'rejected', reason: d.reasonArabic || 'مش متأكد إن المعلومة دي صح 100%، فمش هعمل عنها فيديو.' };
  const check = await ctx.providers.llm.generateJson({
    task: 'topic.request.factcheck',
    tier: 'writing',
    system: 'You are an independent, strict fact-checker for a phone-secrets channel. Check EVERY step, menu name, code and claim of this entry against what you know of current iPhone/Android/Samsung versions. ' +
      'verdict "ok" if all correct; "fix" with `fixed` = only the corrected fields (keep the same language/format) when something small is wrong (a menu name, a version, a phone it does not work on); "reject" with reasonArabic if it is wrong, unsafe or you cannot be sure. ' +
      SAFETY + ' confidence 0–1 that the final entry is exactly right. JSON only.',
    prompt: JSON.stringify({ request: req.text, entry: d.entry }),
    schema: Check,
    maxOutputTokens: 2000,
  }).catch(() => undefined);
  const c = check?.data as z.infer<typeof Check> | undefined;
  if (!c || c.verdict === 'reject' || c.confidence < 0.75) return { request: req, status: 'rejected', reason: c?.reasonArabic || 'المراجعة مقدرتش تتأكد من الخطوات — مش هعمل فيديو بمعلومة مش مضمونة.' };
  const e = { ...d.entry, ...(c.verdict === 'fix' ? c.fixed : {}) } as z.infer<typeof Entry>;
  // A code must appear exactly the same everywhere it is written (a reversed code is a wrong code).
  if (e.ui?.type === 'dialer') {
    const code = e.ui.code;
    for (const k of ['title', 'onScreen', 'result', 'use'] as const) e[k] = guardCodes(e[k], code) ?? e[k];
    e.steps = e.steps.map((s) => guardCodes(s, code) ?? s);
  }
  const entry: PhoneSecret = { id: `req-${req.id}`, ...e, source: lib?.sources[e.source] ? e.source : 'android' };
  return { request: req, status: 'approved', entry };
}

/** Approved requested entries, oldest first, for the library loader (file) and the pack picker (ids). */
export function requestedEntries(ctx: AgentContext): Requested[] {
  // latest state per request
  const by = new Map<string, Requested>();
  for (const a of ctx.repos.artifacts.listKind<Requested>('topic_request')) by.set(a.data.request.id, a.data);
  return [...by.values()];
}
export function writeRequestedLibrary(ctx: AgentContext): void {
  const file = resolve(ctx.config.rootDir, REQUESTED_FILE);
  const entries = requestedEntries(ctx).filter((r) => r.entry && (r.status === 'approved' || r.status === 'produced')).map((r) => r.entry!);
  if (!entries.length && !existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ secrets: entries }, null, 1));
}
/** Library ids the owner asked for that are waiting to be made (approved requests + requested duplicates). */
export function priorityIds(ctx: AgentContext, used: Set<string>): string[] {
  return requestedEntries(ctx).map((r) => (r.status === 'approved' ? r.entry?.id : r.status === 'duplicate' ? r.duplicateOf : undefined)).filter((id): id is string => Boolean(id) && !used.has(id!));
}

/**
 * One cycle: vet the bot's new requests, tell the owner, and announce requested videos that were just made.
 * Returns Telegram lines; marks handled requests as done in the bot.
 */
export async function handleTopicRequests(ctx: AgentContext, used: Set<string>, env = process.env, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const msgs: string[] = [];
  const done: string[] = [];
  const seen = new Set(requestedEntries(ctx).map((r) => r.request.id));
  for (const req of (await fetchRequests(env, fetchImpl)).slice(0, 5)) {
    done.push(req.id);
    if (seen.has(req.id)) continue;
    const r = await vetRequest(ctx, req);
    ctx.repos.artifacts.save({ videoId: null, kind: 'topic_request', agent: 'topic-requests', data: r });
    const lib = loadPhoneLibrary(ctx.config.rootDir);
    if (r.status === 'approved') msgs.push(`✅ موضوعك اتراجع واتقبل:\n«${r.entry!.title}»\n\n📱 ${r.entry!.platforms}\n🪜 ${r.entry!.steps.join(' ← ')}\n✨ ${r.entry!.result}\n\n🎬 هيتعمل أول واحد في الإنتاج الجاي، وهبلّغك أول ما يجهز.`);
    else if (r.status === 'duplicate') {
      const dup = lib?.secrets.find((s) => s.id === r.duplicateOf);
      msgs.push(used.has(r.duplicateOf!) ? `ℹ️ الموضوع ده اتعمل قبل كده: «${dup?.title ?? r.duplicateOf}». ابعتلي موضوع تاني 🙌` : `✅ الموضوع ده موجود عندنا ومراجَع: «${dup?.title ?? r.duplicateOf}» — قدّمته أول واحد في الإنتاج الجاي.`);
    } else msgs.push(`❌ مش هعمل فيديو عن «${req.text.slice(0, 80)}»:\n${r.reason}`);
  }
  // Requested topics whose video was just made.
  for (const r of requestedEntries(ctx)) {
    const id = r.status === 'approved' ? r.entry?.id : undefined;
    if (id && used.has(id)) {
      ctx.repos.artifacts.save({ videoId: null, kind: 'topic_request', agent: 'topic-requests', data: { ...r, status: 'produced' } });
      msgs.push(`🎬 فيديو موضوعك «${r.entry!.title}» اتعمل وداخل جدول النشر — اكتب «فيديو» عشان تشوفه.`);
    }
  }
  writeRequestedLibrary(ctx);
  if ((done.length || msgs.length) && env.BOT_URL && env.BOT_INGEST_SECRET) {
    await fetchImpl(`${env.BOT_URL.replace(/\/$/, '')}/ingest`, { method: 'POST', headers: { authorization: `Bearer ${env.BOT_INGEST_SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify({ requestsDone: done, messages: msgs }) }).catch(() => undefined);
  }
  return msgs;
}
