import { fileURLToPath } from 'node:url';
import { createContext, type CreateContextOptions } from '../src/context.ts';
import { silentLogger } from '../src/core/logger.ts';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export function testContext(opts: CreateContextOptions & { env?: Record<string, string> } = {}) {
  return createContext({
    rootDir: ROOT,
    logger: opts.logger ?? silentLogger,
    sleep: async () => {},
    llm: opts.llm,
    envOverrides: { DATABASE_URL: 'sqlite::memory:', DRY_RUN: 'true', ...(opts.env ?? {}) },
  });
}
