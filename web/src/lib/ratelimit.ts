import { get, run, type Db } from './db';
import { AppError } from './validation';

export interface RateResult {
  ok: boolean;
  remaining: number;
  retryAfterMs: number;
}

/**
 * Fixed-window counter stored in the database, so limits survive restarts and apply across server
 * processes sharing one database. `bucket` should combine the action and the actor, for example
 * "publish:user:<id>" or "report:ip:<hash>".
 */
export function checkRateLimit(db: Db, bucket: string, limit: number, windowMs: number, now = Date.now()): RateResult {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  run(db, 'INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1) ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1', bucket, windowStart);
  const row = get<{ count: number }>(db, 'SELECT count FROM rate_limits WHERE bucket = ? AND window_start = ?', bucket, windowStart)!;
  // Opportunistic cleanup of windows that can no longer matter.
  if (Math.random() < 0.02) run(db, 'DELETE FROM rate_limits WHERE window_start < ?', now - 24 * 3600 * 1000);
  return { ok: row.count <= limit, remaining: Math.max(0, limit - row.count), retryAfterMs: windowStart + windowMs - now };
}

/** Throws a 429 AppError when the limit is exceeded. */
export function enforceRateLimit(db: Db, bucket: string, limit: number, windowMs: number): void {
  const r = checkRateLimit(db, bucket, limit, windowMs);
  if (!r.ok) throw new AppError(429, `You are doing that too quickly. Try again in ${Math.ceil(r.retryAfterMs / 1000)} seconds.`);
}

/** Per-action policies in one place. */
export const POLICY = {
  publish: { limit: 10, windowMs: 3600_000 },
  draftSave: { limit: 120, windowMs: 3600_000 },
  upload: { limit: 30, windowMs: 3600_000 },
  report: { limit: 10, windowMs: 3600_000 },
  signInEmail: { limit: 5, windowMs: 900_000 },
  save: { limit: 300, windowMs: 3600_000 },
} as const;
