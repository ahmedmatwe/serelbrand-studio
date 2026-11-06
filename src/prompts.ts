import { readFileSync } from 'node:fs';

const cache = new Map<string, string>();
const SHARED = 'shared-rules';

/** Loads prompts/<name>.md, prefixed with the shared safety/quality rules. */
export function loadPrompt(name: string): string {
  const read = (n: string) => {
    if (!cache.has(n)) cache.set(n, readFileSync(new URL(`../prompts/${n}.md`, import.meta.url), 'utf8'));
    return cache.get(n)!;
  };
  return `${read(SHARED)}\n\n---\n\n${read(name)}`;
}
