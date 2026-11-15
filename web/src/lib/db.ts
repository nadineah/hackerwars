import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations';

/** A thin synchronous wrapper over Node's built-in SQLite (no native add-on to build). */
export type Db = DatabaseSync;

export const dataDir = (): string => path.resolve(process.env.DATA_DIR || './data');

const GLOBAL_KEY = Symbol.for('whimsyweb.db');
type G = typeof globalThis & { [GLOBAL_KEY]?: Map<string, Db> };

/**
 * Opens (once per file, even across Next.js hot reloads) and migrates a database. `':memory:'` gives a
 * fresh private database, which is what the tests use.
 */
export function openDb(file?: string): Db {
  const target = file ?? path.join(dataDir(), 'whimsyweb.db');
  if (target === ':memory:') return migrate(configure(new DatabaseSync(':memory:')));
  const g = globalThis as G;
  const cache = (g[GLOBAL_KEY] ??= new Map());
  let db = cache.get(target);
  if (!db) {
    mkdirSync(path.dirname(target), { recursive: true });
    db = migrate(configure(new DatabaseSync(target)));
    cache.set(target, db);
  }
  return db;
}

function configure(db: Db): Db {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** Applies every migration that has not run yet, each in its own transaction. Idempotent. */
export function migrate(db: Db): Db {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = new Set((db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    tx(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, Date.now());
    });
  }
  return db;
}

/** Runs `fn` in a write transaction: commits on return, rolls back on throw. Not re-entrant. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw e;
  }
}

/** Typed helpers so callers do not sprinkle casts everywhere. */
export const all = <T>(db: Db, sql: string, ...params: SqlParam[]): T[] => db.prepare(sql).all(...params) as T[];
export const get = <T>(db: Db, sql: string, ...params: SqlParam[]): T | undefined => db.prepare(sql).get(...params) as T | undefined;
export const run = (db: Db, sql: string, ...params: SqlParam[]) => db.prepare(sql).run(...params);
export type SqlParam = string | number | bigint | null | Uint8Array;

export const newId = (): string => crypto.randomUUID();
