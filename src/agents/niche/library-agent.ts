/**
 * The library agent: keeps «سر الموبايل» stocked with topics that are TRUE, NEW to the viewer and VARIED.
 *
 * Every cycle (cheap when nothing changed):
 *   1. removals — topics the owner dropped with the «🗑️ شيل» button on Telegram are never made;
 *   2. duplicates — near-repeats of each other or of a video already made are removed (one of each idea stays);
 *   3. proof — every waiting topic is checked against a live Google search (current phones, exact menus/codes);
 *      no proof found → it is removed. A topic is produced only once it carries this proof;
 *   4. growth — while fewer than STOCK_TARGET proven topics are waiting, new ones are researched for the
 *      families that are running low (apps/social, codes, iPhone, Android/Samsung, free tools), each through
 *      research → independent fact-check → search proof, at most FAMILY_CAP per family per run;
 *   5. telling the owner — new topics arrive on Telegram with a remove button; a low stock or a stop is alerted.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentContext } from '../base.ts';
import { family, loadPhoneLibrary, type PhoneSecret } from './phone-library.ts';
import { requestedEntries, vetRequest, writeRequestedLibrary } from './topic-requests.ts';

/** ~15 days of production waiting at all times (3 a day); refilled every cycle, never only when it runs out. */
export const STOCK_TARGET = 45;
export const LOW_STOCK = 15;
const FAMILY_CAP = 3;
export const FAMILY_AR: Record<string, string> = { apps: 'تطبيقات وسوشيال ميديا', code: 'أكواد سرية', ios: 'آيفون', android: 'أندرويد وسامسونج', free: 'أدوات مجانية بدل المدفوعة' };
const FAMILY_HINT: Record<string, string> = {
  apps: 'hidden features of WhatsApp, Instagram, TikTok, Facebook, YouTube, Telegram, Snapchat, X, Chrome, Google Maps, Google Photos, Gmail',
  code: 'real, harmless dial codes that SHOW information (IMEI, battery/network/test info screens, call-forwarding status) on iPhone / Android / Samsung — never codes that change or reset anything',
  ios: 'hidden iPhone settings and gestures (accessibility, camera, keyboard, Photos, Notes, Safari, Focus, Control Center, Action button, Shortcuts)',
  android: 'hidden Android and Samsung One UI settings and gestures (Pixel and Samsung included: Good Lock, Modes and Routines, Edge panels, Developer options safe toggles, Quick Share)',
  free: 'free official tools from Google / Apple / Microsoft / Adobe that replace a paid app (scanning, editing, transcribing, translating, AI)',
};
/** Official help sites: a proof from one of these counts double. */
const OFFICIAL = /(support\.apple\.com|apple\.com|support\.google\.com|blog\.google|android\.com|samsung\.com|faq\.whatsapp\.com|blog\.whatsapp\.com|help\.instagram\.com|facebook\.com|about\.fb\.com|support\.tiktok\.com|newsroom\.tiktok\.com|telegram\.org|youtube\.com|microsoft\.com|adobe\.com|help\.snapchat\.com|help\.x\.com)/i;

type Req = ReturnType<typeof requestedEntries>[number];
const save = (ctx: AgentContext, r: Req) => ctx.repos.artifacts.save({ videoId: null, kind: 'topic_request', agent: 'library-agent', data: r });

/** Ids of library topics whose video was really made (crashed productions give their topics back). */
export function usedTopicIds(ctx: AgentContext): Set<string> {
  const crashed = new Set(ctx.repos.artifacts.listKind<{ blockers: string[] }>('auto_blocked').filter((a) => a.data.blockers.some((b) => b.startsWith('production failed'))).map((a) => a.video_id));
  return new Set(ctx.repos.artifacts.listKind<{ topics?: { subject: string }[] }>('calendar_entry').filter((a) => !crashed.has(a.video_id)).flatMap((a) => (a.data.topics ?? []).map((t) => t.subject)));
}

/** Waiting topics production may pick: unused, not skipped; researched ones only once proven. */
export function stockOf(lib: { secrets: PhoneSecret[] }, used: Set<string>): PhoneSecret[] {
  return lib.secrets.filter((s) => !used.has(s.id) && !s.skip && (!s.id.startsWith('req-') || s.verified || !s.id.startsWith('req-auto') && !s.id.startsWith('req-trend')));
}

const Proof = z.object({
  confirmed: z.boolean(),
  /** What is wrong or outdated in the entry (menu names, versions, phones), in English. */
  wrong: z.string().max(400).default(''),
  reasonArabic: z.string().max(300).default(''),
  confidence: z.number().min(0).max(1),
});

const Pages = z.object({ urls: z.array(z.string()).max(4) });

/**
 * Proof from the maker's own help pages: (1) find the official page(s) that document this feature, (2) READ them
 * (free URL context) and check the entry against what they say. Never throws.
 * reason 'unavailable' = could not check now (AI quota/network, or no official page loaded) — try again later.
 */
export async function proveWithSearch(ctx: AgentContext, e: PhoneSecret): Promise<{ ok: boolean; reason: string; sources: string[] }> {
  if (ctx.providers.llm.name.startsWith('mock')) return { ok: true, reason: '', sources: [] };
  const log = ctx.logger.child('library-agent');
  const pages = await ctx.providers.llm.generateJson({
    task: 'library.pages',
    tier: 'light',
    system: 'Give the exact URLs of the OFFICIAL help/support pages (support.apple.com, support.google.com, samsung.com, faq.whatsapp.com, help.instagram.com, facebook.com/help, support.tiktok.com, telegram.org, support.microsoft.com, helpx.adobe.com …) that document this phone feature or code. ' +
      'Only real pages you are confident exist (prefer specific article URLs, e.g. https://support.google.com/android/answer/9079661). Up to 3. JSON only.',
    prompt: JSON.stringify({ title: e.title, platforms: e.platforms, feature: e.onScreen, steps: e.steps, facts: e.facts.slice(0, 400) }),
    schema: Pages,
    maxOutputTokens: 600,
  }).catch((err) => { log.warn('proof pages failed', { id: e.id, error: String((err as Error).message).slice(0, 300) }); return undefined; });
  const urls = ((pages?.data as z.infer<typeof Pages> | undefined)?.urls ?? []).filter((u) => /^https:\/\//.test(u) && OFFICIAL.test(u)).slice(0, 3);
  if (!pages) return { ok: false, reason: 'unavailable', sources: [] };
  if (!urls.length) return { ok: false, reason: 'nopage', sources: [] };
  const r = await ctx.providers.llm.generateJson({
    task: 'library.proof',
    tier: 'light',
    readUrls: true,
    system: 'You are a strict fact-checker for a phone-tips channel. READ the official pages given in `pages` and check the entry against what they say (current iOS / Android / One UI / app versions). ' +
      'confirmed = true ONLY if the pages show the feature exists and works as described, and the steps/menu path/code match (small wording differences in menu names are fine). ' +
      'If a page does not load or does not cover it, do not guess: confirmed false. If the entry is wrong or outdated → confirmed false and say what is wrong. confidence 0–1. Reply with JSON only.',
    prompt: JSON.stringify({ pages: urls, entry: { title: e.title, platforms: e.platforms, code_or_feature: e.onScreen, steps: e.steps, result: e.result, facts: e.facts } }),
    schema: Proof,
    maxOutputTokens: 1500,
  }).catch((err) => { log.warn('proof failed', { id: e.id, error: String((err as Error).message).slice(0, 300) }); return undefined; });
  if (!r) return { ok: false, reason: 'unavailable', sources: [] };
  const d = r.data as z.infer<typeof Proof>;
  const read = (r.sources ?? []).map((x) => x.url || x.title).filter((u) => OFFICIAL.test(u));
  if (!read.length) return { ok: false, reason: 'nopage', sources: [] }; // the pages didn't load: not proof either way
  const ok = d.confirmed && d.confidence >= 0.8;
  return { ok, reason: ok ? '' : d.reasonArabic || (d.wrong ? `المعلومة فيها غلط: ${d.wrong.slice(0, 160)}` : 'الصفحة الرسمية ما أكدتهاش'), sources: read.slice(0, 3) };
}

const Dupes = z.object({ groups: z.array(z.object({ keep: z.string(), drop: z.array(z.string()).max(20), sameAsMade: z.string().default('') })).max(60) });

/**
 * Removes near-duplicates among the waiting researched topics and topics that repeat a video already made.
 * Runs only when the waiting set changed. Returns the number removed.
 */
async function removeDuplicates(ctx: AgentContext, lib: { secrets: PhoneSecret[] }, used: Set<string>): Promise<number> {
  const waiting = lib.secrets.filter((s) => !used.has(s.id) && !s.skip);
  const hash = createHash('sha1').update(waiting.map((s) => s.id).sort().join(',')).digest('hex');
  if (ctx.repos.artifacts.latest<{ hash: string }>(null, 'library_curation')?.data.hash === hash || ctx.providers.llm.name.startsWith('mock')) return 0;
  const made = lib.secrets.filter((s) => used.has(s.id)).map((s) => ({ id: s.id, title: s.title }));
  const r = await ctx.providers.llm.generateJson({
    task: 'library.dedupe',
    tier: 'light',
    system: 'You keep a list of phone-tip video topics free of repeats. Two topics are the SAME when a viewer would feel it is the same tip (same feature or setting, even with different wording, a different trend angle or another phone brand for the identical setting). ' +
      'Group the `waiting` topics that are the same; in each group keep the clearest, most specific one (prefer ids not starting with "req-trend" when equal) and drop the rest. ' +
      'Also, for any waiting topic that is the same as one in `made` (a video already published), put it in a group with keep = "" , drop = [its id], sameAsMade = that made id. Only list groups that drop something. JSON only.',
    prompt: JSON.stringify({ waiting: waiting.map((s) => ({ id: s.id, title: s.title, what: `${s.onScreen} — ${s.steps.join(' ← ')}`.slice(0, 160) })), made }),
    schema: Dupes,
    maxOutputTokens: 4000,
  }).catch(() => undefined);
  if (!r) return 0; // try again next cycle
  const byId = new Map(requestedEntries(ctx).filter((x) => x.entry).map((x) => [x.entry!.id, x]));
  let n = 0;
  for (const g of (r.data as z.infer<typeof Dupes>).groups) {
    for (const id of g.drop) {
      const req = byId.get(id);
      // Only researched topics are removed; the hand-reviewed base library (config) is never touched.
      if (!req || req.status !== 'approved' || id === g.keep || (!g.keep && !g.sameAsMade)) continue;
      save(ctx, { ...req, status: 'duplicate', duplicateOf: g.keep || g.sameAsMade, reason: g.sameAsMade ? 'اتعمل عنه فيديو قبل كده' : 'مكرر مع موضوع تاني' });
      n++;
    }
  }
  ctx.repos.artifacts.save({ videoId: null, kind: 'library_curation', agent: 'library-agent', data: { hash, removed: n, at: new Date().toISOString() } });
  return n;
}

const Ideas = z.object({ ideas: z.array(z.object({ topic: z.string().min(8).max(220), family: z.string().max(20) })).min(1).max(16) });

async function bot(path: string, body?: unknown): Promise<Response | undefined> {
  const url = process.env.BOT_URL, secret = process.env.BOT_INGEST_SECRET;
  if (!url || !secret) return undefined;
  return fetch(`${url.replace(/\/$/, '')}${path}`, body === undefined ? { headers: { authorization: `Bearer ${secret}` } } : { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => undefined);
}

export interface LibraryReport { stock: number; byFamily: Record<string, number>; added: string[]; removed: number; proven: number; rejected: number; vetoed: number }

export async function runLibraryAgent(ctx: AgentContext, o: { now?: Date; maxNew?: number; maxProofs?: number; notify?: boolean } = {}): Promise<LibraryReport> {
  const now = o.now ?? new Date();
  const log = ctx.logger.child('library-agent');
  const rep: LibraryReport = { stock: 0, byFamily: {}, added: [], removed: 0, proven: 0, rejected: 0, vetoed: 0 };
  writeRequestedLibrary(ctx, now);
  const used = usedTopicIds(ctx);
  const reqs = () => new Map(requestedEntries(ctx).filter((x) => x.entry).map((x) => [x.entry!.id, x]));

  // 1) The owner's removals.
  const vr = await bot('/vetoes');
  const vetoes = vr?.ok ? (((await vr.json().catch(() => ({}))) as { vetoes?: string[] }).vetoes ?? []) : [];
  for (const id of vetoes) { const r = reqs().get(id); if (r && r.status === 'approved') { save(ctx, { ...r, status: 'rejected', reason: 'اتشال بطلبك' }); rep.vetoed++; } }
  if (vetoes.length) await bot('/ingest', { vetoesDone: vetoes });

  // 2) Duplicates.
  writeRequestedLibrary(ctx, now);
  rep.removed = await removeDuplicates(ctx, loadPhoneLibrary(ctx.config.rootDir)!, used).catch(() => 0);

  // 3) Proof for waiting researched topics that don't have it yet (oldest first).
  let proofs = 0;
  for (const r of [...reqs().values()].filter((x) => x.status === 'approved' && !x.entry!.verified && (x.entry!.proofTries ?? 0) < 3 && !used.has(x.entry!.id))) {
    if (proofs >= (o.maxProofs ?? 15)) break;
    proofs++;
    const p = await proveWithSearch(ctx, r.entry!);
    if (p.reason === 'unavailable') break; // AI quota/network: try the rest next cycle
    // No official page could be read: tried again on later cycles; after 3 tries it stays a twice-checked topic
    // (used only when proven ones run short), so it is never retried forever.
    if (p.reason === 'nopage') { const tries = (r.entry!.proofTries ?? 0) + 1; save(ctx, { ...r, entry: { ...r.entry!, proofTries: tries } }); continue; }
    if (p.ok) { save(ctx, { ...r, entry: { ...r.entry!, verified: { at: now.toISOString(), sources: p.sources } } }); rep.proven++; }
    else { save(ctx, { ...r, status: 'rejected', reason: `البحث ما أكدهاش: ${p.reason}` }); rep.rejected++; }
  }
  writeRequestedLibrary(ctx, now);

  // 4) Growth for the families running low.
  let lib = loadPhoneLibrary(ctx.config.rootDir)!;
  let stock = stockOf(lib, used);
  // Growth counts proven topics + researched ones still waiting for their proof (so it doesn't over-produce ideas).
  const pendingProof = () => lib.secrets.filter((s) => !used.has(s.id) && !s.skip && /^req-(auto|trend)/.test(s.id) && !s.verified && (s.proofTries ?? 0) < 3).length;
  const count = (f: string) => stock.filter((s) => family(s) === f).length;
  if (stock.length + pendingProof() < STOCK_TARGET && !ctx.providers.llm.name.startsWith('mock')) {
    const fams = Object.keys(FAMILY_AR).sort((a, b) => count(a) - count(b));
    const need = fams.slice(0, 3);
    const ideas = await ctx.providers.llm.generateJson({
      task: 'library.ideas',
      tier: 'writing',
      system: 'You plan topics for "سر الموبايل" — Egyptian Arabic Shorts about secrets of phones and social media. Propose 14 DIFFERENT, specific topics. ' +
        `Most must come from these families that are running low: ${need.map((f) => `"${f}" (${FAMILY_HINT[f]})`).join('; ')}; a few from the others: ${fams.slice(3).map((f) => `"${f}"`).join(', ')}. ` +
        'Mix iPhone and Android, everyday usefulness (privacy, battery, storage, camera, typing, sharing, saving money/data) and wow. Each must be real, available today, documented by the maker, safe, and something fewer than 30% of users know — the viewer must think "إزاي معرفتش ده قبل كده؟". ' +
        'NO basics (screen recording, hide last seen, view once, dark mode, 2x speed, blocking, deleting a message). Never repeat or near-repeat anything in `existing`. ' +
        'topic = one Arabic line saying exactly the feature (what it does + where); family = one of apps, code, ios, android, free. JSON only.',
      prompt: JSON.stringify({ existing: lib.secrets.map((s) => s.title) }),
      schema: Ideas,
      maxOutputTokens: 4000,
    }).catch((err) => { log.warn('ideas failed', { error: String((err as Error).message).slice(0, 200) }); return undefined; });
    const perFam: Record<string, number> = {};
    let i = 0;
    const day = now.toISOString().slice(0, 13).replace(/\D/g, '');
    for (const idea of (ideas?.data as z.infer<typeof Ideas> | undefined)?.ideas ?? []) {
      if (rep.added.length >= (o.maxNew ?? 8) || stock.length + pendingProof() + rep.added.length >= STOCK_TARGET) break;
      if ((perFam[idea.family] ?? 0) >= FAMILY_CAP) continue;
      const r = await vetRequest(ctx, { id: `auto-${day}-${i++}`, text: idea.topic, at: now.toISOString() }, true);
      if (r.status !== 'approved') { save(ctx, { ...r, auto: true }); continue; }
      const p = await proveWithSearch(ctx, r.entry!);
      // Search not available right now: keep the twice-checked topic waiting; its proof is retried next cycle.
      if (p.reason === 'unavailable' || p.reason === 'nopage') { save(ctx, { ...r, auto: true, entry: { ...r.entry!, proofTries: p.reason === 'nopage' ? 1 : 0 } }); continue; }
      if (!p.ok) { save(ctx, { ...r, auto: true, status: 'rejected', reason: `البحث ما أكدهاش: ${p.reason}` }); rep.rejected++; continue; }
      save(ctx, { ...r, auto: true, entry: { ...r.entry!, verified: { at: now.toISOString(), sources: p.sources } } });
      perFam[family(r.entry!)] = (perFam[family(r.entry!)] ?? 0) + 1;
      rep.added.push(r.entry!.id);
    }
    writeRequestedLibrary(ctx, now);
    // New ideas are checked against everything known next run (duplicates included).
    lib = loadPhoneLibrary(ctx.config.rootDir)!;
    stock = stockOf(lib, used);
  }
  rep.stock = stock.length;
  for (const f of Object.keys(FAMILY_AR)) rep.byFamily[f] = stock.filter((s) => family(s) === f).length;

  // 5) Tell the owner.
  if (o.notify !== false) {
    const added = rep.added.map((id) => lib.secrets.find((s) => s.id === id)).filter((s): s is PhoneSecret => Boolean(s));
    const rich = added.length ? [{
      text: `📚 مكتبة المواضيع: ضفت ${added.length} مواضيع جديدة، كل واحد اتراجع واتأكد منه ببحث جوجل:\n\n${added.map((s, k) => `${k + 1}. ${s.title}\n    📱 ${s.platforms}`).join('\n')}\n\nلو في موضوع مش عاجبك دوس «🗑️ شيل» تحته ومش هيتعمل.\n📦 الجاهز دلوقتي: ${rep.stock} موضوع`,
      buttons: added.map((s, k) => [{ text: `🗑️ شيل ${k + 1}: ${s.title}`.slice(0, 60), data: `x:${s.id}` }]),
    }] : [];
    const day = now.toISOString().slice(0, 10);
    const alerts = rep.stock < LOW_STOCK ? [{ id: `low-stock-${day}`, text: `⚠️ مكتبة المواضيع قربت تخلص: فاضل ${rep.stock} موضوع جاهز (حوالي ${Math.floor(rep.stock / 3)} يوم إنتاج).\nالباحث شغال يضيف، ودوس «🔧 إصلاح» لو عايزه يجهّز دفعة دلوقتي. ولو عندك أفكار ابعتها: «موضوع: …»`, fix: 'library' }] : [];
    if (rich.length || alerts.length) await bot('/ingest', { rich, alerts });
  }
  log.info('library', { ...rep });
  return rep;
}
