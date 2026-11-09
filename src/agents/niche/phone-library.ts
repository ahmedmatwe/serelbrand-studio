/**
 * The approved phone-secrets library (config/phone-secrets.json). In this niche a wrong or harmful code is a
 * real risk, so topics come ONLY from reviewed entries, and the script is written from the entry itself
 * (it is the research source the verifier checks every claim against).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface PhoneSecret {
  id: string; kind: 'code' | 'feature' | 'trick'; platforms: string; title: string; onScreen: string;
  steps: string[]; result: string; use: string; facts: string; source: string;
  /** What the phone screen shows while the steps are explained (drawn by src/media/phone-ui.ts). */
  ui?: PhoneUi;
  /** Stock searches that literally show this secret's topic (tried for every sentence, best match picked by vision). */
  footage?: string[];
}
export type PhoneUi = { type: 'dialer'; code: string; call?: boolean } | { type: 'settings'; os: 'ios' | 'android'; path: string[] };
interface Library { sources: Record<string, string>; secrets: PhoneSecret[] }

export function loadPhoneLibrary(rootDir: string): Library | undefined {
  const p = resolve(rootDir, 'config/phone-secrets.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Library) : undefined;
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

export const family = (s: PhoneSecret) => (s.kind === 'code' ? 'code' : s.id.startsWith('ios-') ? 'ios' : 'android');

/**
 * Three unused secrets for today's pack, mixed for variety: a code, an iPhone secret and an Android/Samsung
 * secret when available (one of each family first, then whatever is left).
 */
export function pickPhoneSecrets(lib: Library, usedIds: Set<string>, n = 3, weights?: Record<string, number>): PhoneSecret[] {
  // Secrets we can SHOW on a drawn phone screen first (the viewer sees exactly what is being said).
  const fresh = lib.secrets.filter((s) => !usedIds.has(s.id)).sort((a, b) => Number(Boolean(b.ui)) - Number(Boolean(a.ui)));
  const out: PhoneSecret[] = [];
  // Learned appetite: the family audiences watch most gets a second slot (variety still kept: ≥ 2 families).
  const order = ['code', 'ios', 'android'].sort((a, b) => (weights?.[b] ?? 1) - (weights?.[a] ?? 1));
  const best = order[0]!;
  const plan = weights && (weights[best] ?? 1) >= 1.3 ? [best, best, order[1]!] : order;
  for (const f of plan) {
    const s = fresh.find((x) => family(x) === f && !out.includes(x));
    if (s && out.length < n) out.push(s);
  }
  for (const s of fresh) if (out.length < n && !out.includes(s)) out.push(s);
  return out;
}
