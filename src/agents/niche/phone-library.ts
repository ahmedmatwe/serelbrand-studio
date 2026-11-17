/**
 * The approved phone-secrets library (config/phone-secrets.json). In this niche a wrong or harmful code is a
 * real risk, so topics come ONLY from reviewed entries, and the script is written from the entry itself
 * (it is the research source the verifier checks every claim against).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface PhoneSecret {
  id: string; kind: 'code' | 'feature' | 'trick' | 'freealt'; platforms: string; title: string; onScreen: string;
  steps: string[]; result: string; use: string; facts: string; source: string;
  /** What the phone screen shows while the steps are explained (drawn by src/media/phone-ui.ts). */
  ui?: PhoneUi;
  /** Stock searches that literally show this secret's topic (tried for every sentence, best match picked by vision). */
  footage?: string[];
  /** Proven by the library agent against a live Google search (sources = the pages found). */
  verified?: { at: string; sources: string[] };
  /** Times the library agent could not load an official page to prove it (stops retrying at 3). */
  proofTries?: number;
  /** Too well known to be worth a Short (most viewers already use it) — never picked. */
  skip?: string;
  /** Tied to a trend in Egypt (set by the trend scout): the hook opens on it. */
  trend?: { name: string; link: string; hookAngle: string; heat: number; urgency: 'now' | 'soon'; at: string };
}
export type PhoneUi = { type: 'dialer'; code: string; call?: boolean } | { type: 'settings'; os: 'ios' | 'android'; path: string[] }
  /** "Why pay?" topics: a paid tool and the free one that does the same job (drawn as a versus scene). */
  | { type: 'versus'; paid: { name: string; note: string }; free: { name: string; note: string; color?: string; /** How the narrator says it (Arabic), to time its card. */ say?: string[] } };
interface Library { sources: Record<string, string>; secrets: PhoneSecret[] }

export function loadPhoneLibrary(rootDir: string): Library | undefined {
  const p = resolve(rootDir, 'config/phone-secrets.json');
  if (!existsSync(p)) return undefined;
  const lib = JSON.parse(readFileSync(p, 'utf8')) as Library;
  // + topics the owner asked for on Telegram, after research + fact-check (written each cycle from the DB).
  const req = resolve(rootDir, 'data/requested-secrets.json');
  if (existsSync(req)) {
    try { const extra = (JSON.parse(readFileSync(req, 'utf8')) as { secrets?: PhoneSecret[] }).secrets ?? []; lib.secrets = [...lib.secrets, ...extra.filter((e) => !lib.secrets.some((s) => s.id === e.id))]; } catch { /* ignore a broken file */ }
  }
  return lib;
}

/** The entry as a research source: everything the narrator may say, nothing else. */
export function secretSource(lib: Library, s: PhoneSecret) {
  return {
    url: lib.sources[s.source] ?? lib.sources.android!,
    title: s.title,
    excerpt: [
      `${s.title} (${s.platforms})`,
      `الكود/الميزة: ${s.onScreen}`,
      `الخطوات: ${s.steps.join(' ← ')}`,
      `النتيجة: ${s.result}`,
      `الاستخدام: ${s.use}`,
      s.facts,
    ].join('\n'),
  };
}

const APP_SOURCES = new Set(['whatsapp', 'instagram', 'facebook', 'tiktok', 'youtube', 'maps', 'gboard', 'telegram', 'x', 'snapchat', 'chrome', 'google']);
export const family = (s: PhoneSecret) => (s.kind === 'freealt' ? 'free' : s.id.startsWith('app-') || APP_SOURCES.has(s.source) ? 'apps' : s.kind === 'code' ? 'code' : s.id.startsWith('ios-') || s.source === 'apple' ? 'ios' : 'android');

/**
 * Three unused secrets for today's pack, mixed for variety: a code, an iPhone secret and an Android/Samsung
 * secret when available (one of each family first, then whatever is left).
 */
export function pickPhoneSecrets(lib: Library, usedIds: Set<string>, n = 3, weights?: Record<string, number>, first: string[] = []): PhoneSecret[] {
  // Secrets we can SHOW on a drawn phone screen first (the viewer sees exactly what is being said).
  const fresh = lib.secrets.filter((s) => !usedIds.has(s.id) && !s.skip).sort((a, b) => Number(Boolean(b.ui)) - Number(Boolean(a.ui)));
  // Topics the owner asked for come first.
  const out: PhoneSecret[] = first.map((id) => fresh.find((s) => s.id === id)).filter((s): s is PhoneSecret => Boolean(s)).slice(0, n);
  // Learned appetite: the family audiences watch most gets a second slot (variety still kept: ≥ 2 families).
  // Families: big-app secrets, phone codes, iPhone, Android, free alternatives to paid (AI) tools. Daily: the 3 best-performing families; on ties the
  // family used least so far goes first, so every kind keeps rotating in.
  const usedCount = (f: string) => lib.secrets.filter((x) => usedIds.has(x.id) && family(x) === f).length;
  const order = ['apps', 'code', 'ios', 'android', 'free'].sort((a, b) => (weights?.[b] ?? 1) - (weights?.[a] ?? 1) || usedCount(a) - usedCount(b));
  const best = order[0]!;
  const plan = weights && (weights[best] ?? 1) >= 1.3 ? [best, best, order[1]!] : order.slice(0, n);
  for (const f of plan) {
    const s = fresh.find((x) => family(x) === f && !out.includes(x));
    if (s && out.length < n) out.push(s);
  }
  for (const s of fresh) if (out.length < n && !out.includes(s)) out.push(s);
  return out;
}
