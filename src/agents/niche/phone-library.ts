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
}
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

const family = (s: PhoneSecret) => (s.kind === 'code' ? 'code' : s.id.startsWith('ios-') ? 'ios' : 'android');

/**
 * Three unused secrets for today's pack, mixed for variety: a code, an iPhone secret and an Android/Samsung
 * secret when available (one of each family first, then whatever is left).
 */
export function pickPhoneSecrets(lib: Library, usedIds: Set<string>, n = 3): PhoneSecret[] {
  const fresh = lib.secrets.filter((s) => !usedIds.has(s.id));
  const out: PhoneSecret[] = [];
  for (const f of ['code', 'ios', 'android']) {
    const s = fresh.find((x) => family(x) === f && !out.includes(x));
    if (s && out.length < n) out.push(s);
  }
  for (const s of fresh) if (out.length < n && !out.includes(s)) out.push(s);
  return out;
}
