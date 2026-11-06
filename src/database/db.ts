import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigError } from '../core/errors.ts';

export type Param = SQLInputValue;
export type Row = Record<string, unknown>;

/**
 * Minimal DB abstraction. All repositories depend on this interface only,
 * so a PostgreSQL adapter can be added later without touching business code.
 */
export interface Db {
  run(sql: string, params?: Param[]): { changes: number };
  get<T = Row>(sql: string, params?: Param[]): T | undefined;
  all<T = Row>(sql: string, params?: Param[]): T[];
  transaction<T>(fn: () => T): T;
  close(): void;
}

const SCHEMA_VERSION = 1;

class SqliteDb implements Db {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  }
  run(sql: string, params: Param[] = []) {
    const r = this.db.prepare(sql).run(...params);
    return { changes: Number(r.changes) };
  }
  get<T = Row>(sql: string, params: Param[] = []) {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  all<T = Row>(sql: string, params: Param[] = []) {
    return this.db.prepare(sql).all(...params) as T[];
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  exec(sql: string) {
    this.db.exec(sql);
  }
  close() {
    this.db.close();
  }
}

/** Opens the DB from DATABASE_URL (`sqlite:<path>` or `sqlite::memory:`) and applies the schema. */
export function openDb(databaseUrl: string, rootDir = process.cwd()): Db {
  if (!databaseUrl.startsWith('sqlite:')) {
    throw new ConfigError(`Unsupported DATABASE_URL "${databaseUrl.split(':')[0]}:" — only sqlite is implemented in the MVP`);
  }
  const raw = databaseUrl.slice('sqlite:'.length);
  const path = raw === ':memory:' ? raw : resolve(rootDir, raw);
  const db = new SqliteDb(path);
  const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  db.exec(schema);
  if (!db.get('SELECT version FROM schema_version')) db.run('INSERT INTO schema_version (version) VALUES (?)', [SCHEMA_VERSION]);
  return db;
}

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
export const nowIso = () => new Date().toISOString();
