import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY_PATTERN = /(api[_-]?key|secret|token|password|authorization|refresh)/i;
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]{8,}/g, // Anthropic
  /sk-[A-Za-z0-9]{20,}/g, // generic "sk-" keys
  /ya29\.[A-Za-z0-9_\-]+/g, // Google OAuth access tokens
  /1\/\/[A-Za-z0-9_\-]{20,}/g, // Google refresh tokens
  /Bearer\s+[A-Za-z0-9._\-]+/gi,
];

const REDACTED = '[REDACTED]';

/** Removes secrets from any value before it is logged. Never throws. */
export function redact(value: unknown, knownSecrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 8) return '[DEPTH]';
  if (typeof value === 'string') {
    let out = value;
    for (const s of knownSecrets) if (s && s.length >= 6) out = out.split(s).join(REDACTED);
    for (const p of SECRET_VALUE_PATTERNS) out = out.replace(p, REDACTED);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, knownSecrets, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redact(value.message, knownSecrets, depth + 1) };
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? REDACTED : redact(v, knownSecrets, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  scope?: string;
  /** Optional JSONL file sink. */
  file?: string;
  /** Raw secret values to scrub (e.g. API keys loaded from env). */
  secrets?: readonly string[];
  /** Write human-readable lines to stderr. Default true. */
  console?: boolean;
  /** Test hook: receives every redacted record. */
  sink?: (record: Record<string, unknown>) => void;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? 'info';
  const secrets = opts.secrets ?? [];
  if (opts.file) mkdirSync(dirname(opts.file), { recursive: true });

  const write = (lvl: LogLevel, msg: string, data?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const record = redact(
      { ts: new Date().toISOString(), level: lvl, scope: opts.scope ?? 'app', msg, ...(data ?? {}) },
      secrets,
    ) as Record<string, unknown>;
    opts.sink?.(record);
    if (opts.file) appendFileSync(opts.file, JSON.stringify(record) + '\n');
    if (opts.console !== false) {
      const extra = data ? ' ' + JSON.stringify(redact(data, secrets)) : '';
      process.stderr.write(`[${lvl.toUpperCase()}] ${record.scope}: ${record.msg}${extra}\n`);
    }
  };

  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    child: (scope) => createLogger({ ...opts, scope: opts.scope ? `${opts.scope}.${scope}` : scope }),
  };
}

export const silentLogger: Logger = createLogger({ console: false, level: 'error' });
