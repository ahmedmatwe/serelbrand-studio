/**
 * Remotion (motion-graphics Shorts, motion/). The project uses TypeScript 7, whose API Remotion's esbuild loader
 * can't read tsconfig with — so the loader gets its TS/JSX settings here directly.
 */
import { Config } from '@remotion/cli/config';

const TSCONFIG = { compilerOptions: { jsx: 'react-jsx', target: 'es2020', module: 'esnext', moduleResolution: 'bundler' } };

function patch(rules: unknown[]): void {
  for (const r of rules as { use?: unknown; loader?: string; options?: Record<string, unknown>; oneOf?: unknown[]; rules?: unknown[] }[]) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.loader === 'string' && r.loader.includes('esbuild-loader')) r.options = { ...(r.options ?? {}), tsconfigRaw: TSCONFIG };
    if (Array.isArray(r.use)) patch(r.use as unknown[]);
    if (Array.isArray(r.oneOf)) patch(r.oneOf);
    if (Array.isArray(r.rules)) patch(r.rules);
  }
}

Config.overrideWebpackConfig((c) => {
  patch((c.module?.rules ?? []) as unknown[]);
  return c;
});
