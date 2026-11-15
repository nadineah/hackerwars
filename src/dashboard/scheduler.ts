import { collectSource, type CollectDeps, type Outcome } from './collect';
import { contentHash, normalize } from './records';
import { approvalCovers, effectiveInfo, type JobResult, type Source, type SourceState } from './schema';
import * as store from './store';

export const ALARM = 'ww-dash-tick';
/** Marks "do not retry automatically": the user has to act (sign in, approve, fix selectors) and press refresh. */
export const NEVER = 8.64e15;

export const LIMITS_RUN = {
  backoffBase: 5 * 60_000,
  backoffMax: 6 * 3600_000,
  maxAutoFailures: 6,
  concurrency: 3,
  hostGapMs: 4000,
  manualMinGapMs: 30_000,
  tickBudgetMs: 4 * 60_000,
} as const;

export interface SchedulerDeps {
  /** Performs one collection. Production wires this to collectSource + offscreen + tabs. */
  collect: (src: Source, state: SourceState | null) => Promise<Outcome>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  /** Called at startup to close collector tabs a dead worker left behind. */
  closeOrphans?: () => Promise<number>;
}

export const productionDeps = (c: CollectDeps, extra: Pick<SchedulerDeps, 'closeOrphans'>): SchedulerDeps => ({
  collect: (s, st) => collectSource(s, st, c),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: Math.random,
  ...extra,
});

/** Exponential backoff with jitter: 5 min, 10, 20, 40 ... capped at 6 h. */
export function backoffDelay(failures: number, random = 0.5): number {
  const base = Math.min(LIMITS_RUN.backoffMax, LIMITS_RUN.backoffBase * 2 ** Math.max(0, failures - 1));
  return Math.round(base * (0.9 + random * 0.2));
}

/** In-process bookkeeping. After a worker restart these are empty on purpose: the persisted lease is what we recover from. */
const inflight = new Map<string, Promise<RunOutcome>>();
const hostLast = new Map<string, number>();
export const _resetForTests = () => {
  inflight.clear();
  hostLast.clear();
};

export type RunOutcome = 'ran' | 'already-running' | 'missing' | 'needs-approval' | 'paused' | 'recent' | 'backoff' | 'skipped';

const freshState = (sourceId: string, now: number): SourceState => ({ sourceId, status: 'idle', nextCheckAt: now, consecutiveFailures: 0 });

/** Runs ONE source now, never overlapping itself. Every path ends by persisting an honest state. */
export function runSource(id: string, deps: SchedulerDeps, opts: { manual?: boolean } = {}): Promise<RunOutcome> {
  if (inflight.has(id)) return Promise.resolve('already-running');
  const p = doRun(id, deps, opts).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

async function doRun(id: string, deps: SchedulerDeps, opts: { manual?: boolean }): Promise<RunOutcome> {
  const src = await store.getSource(id);
  if (!src) return 'missing';
  const t0 = deps.now();
  let state = (await store.getState(id)) ?? freshState(id, t0);
  if (state.status === 'paused') return 'paused';
  if (!approvalCovers(src.approval, src)) {
    await store.putState({ ...state, status: 'needs-approval', nextCheckAt: NEVER, lastError: 'Permission needed: approve automatic updates for this source.', errorCode: 'needs-approval' });
    return 'needs-approval';
  }
  if (opts.manual && state.lastAttemptAt && t0 - state.lastAttemptAt < LIMITS_RUN.manualMinGapMs && state.status === 'ok') return 'recent';
  if ((state.backoffUntil ?? 0) > t0) return 'backoff'; // also honors the server's Retry-After on manual refreshes

  const runId = `${t0}-${Math.floor(deps.random() * 1e9)}`;
  state = { ...state, status: 'running', runningSince: t0, runId };
  await store.putState(state); // the lease: if the worker dies now, recovery finds a stale 'running' state

  // Polite to each host, whatever the number of sources.
  const host = new URL(src.url).hostname;
  // The slot is reserved synchronously, so sources on one host that start together are staggered, not simultaneous.
  const startAt = Math.max(deps.now(), (hostLast.get(host) ?? 0) + LIMITS_RUN.hostGapMs);
  hostLast.set(host, startAt);
  if (startAt > deps.now()) await deps.sleep(startAt - deps.now());

  const info = effectiveInfo(src.kind, src.config);
  let outcome: Outcome;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    outcome = await Promise.race<Outcome>([
      deps.collect(src, state),
      new Promise<Outcome>((res) => {
        timer = setTimeout(() => res({ ok: false, code: 'timeout', message: 'The update took too long and was stopped.', status: 'error' }), info.timeoutMs + 10_000);
      }),
    ]);
  } catch (e: any) {
    outcome = { ok: false, code: 'unexpected', message: String(e?.message ?? e).slice(0, 120), status: 'error' };
  } finally {
    if (timer) clearTimeout(timer);
  }
  const t1 = deps.now();
  hostLast.set(host, Math.max(hostLast.get(host) ?? 0, t1));

  const prev = await store.getState(id); // pick up anything (e.g. a pause) set while we ran
  const base: SourceState = { ...(prev ?? state), lastAttemptAt: t1, runningSince: undefined, runId: undefined };
  const paused = prev?.status === 'paused';
  const log = (o: string, items?: number): JobResult => ({ at: t1, sourceId: id, sourceName: src.name, ok: outcome.ok, outcome: o, items, ms: t1 - t0 });

  if (outcome.ok) {
    const next: SourceState = { ...base, status: paused ? 'paused' : 'ok', consecutiveFailures: 0, lastError: undefined, errorCode: undefined, backoffUntil: undefined, lastSuccessAt: t1, nextCheckAt: t1 + src.intervalMinutes * 60_000 };
    if (outcome.notModified) return commit(id, next, null, log('not-modified'));
    next.etag = outcome.etag ?? next.etag;
    next.lastModified = outcome.lastModified ?? next.lastModified;
    if (src.kind === 'page-change') {
      const text = outcome.watchText ?? undefined;
      let changed = false;
      if (text !== undefined && text !== state.watchText) {
        next.previousWatchText = state.watchText;
        next.watchText = text;
        if (state.watchText !== undefined) {
          next.lastChangeAt = t1;
          changed = true;
        }
      }
      return commit(id, next, null, log(changed ? 'changed' : 'unchanged'));
    }
    const records = normalize(src, outcome.items, t1, await store.getRecords(id));
    const hash = contentHash(records);
    const changed = hash !== state.contentHash;
    next.contentHash = hash;
    if (changed) next.lastChangeAt = t1;
    // Unchanged content is not rewritten: no storage churn, no spurious "updated" signals.
    return commit(id, next, changed ? records : null, log(changed ? 'changed' : 'unchanged', records.length));
  }

  // Failure: keep the last good data, record why, back off, and stop retrying things only the user can fix.
  const failures = base.consecutiveFailures + 1;
  const userMustAct = outcome.status === 'needs-signin' || outcome.status === 'needs-attention' || outcome.status === 'needs-approval';
  const exhausted = !userMustAct && failures >= LIMITS_RUN.maxAutoFailures;
  const wait = Math.max(backoffDelay(failures, deps.random()), outcome.retryAfterMs ?? 0);
  const next: SourceState = {
    ...base,
    status: paused ? 'paused' : exhausted ? 'needs-attention' : outcome.status,
    consecutiveFailures: failures,
    lastError: exhausted ? `${outcome.message} Automatic retries stopped after ${failures} failures; press Refresh to try again.` : outcome.message,
    errorCode: outcome.code,
    // Only a server-given Retry-After blocks a manual refresh once automatic retries have stopped.
    backoffUntil: userMustAct || exhausted ? (outcome.retryAfterMs ? t1 + outcome.retryAfterMs : undefined) : t1 + wait,
    nextCheckAt: userMustAct || exhausted ? NEVER : t1 + wait,
  };
  return commit(id, next, null, log(outcome.code));
}

async function commit(id: string, state: SourceState, records: Parameters<typeof store.commitCollection>[2], log: JobResult): Promise<RunOutcome> {
  await store.commitCollection(id, state, records, log);
  return 'ran';
}

/**
 * Marks leases left by a dead worker (or a hung run) as interrupted so the source is retried instead of stuck.
 * `inflight` is empty after a restart, so a persisted 'running' state with no live promise is dead by definition.
 */
export async function recoverStale(deps: SchedulerDeps): Promise<number> {
  const now = deps.now();
  let n = 0;
  for (const st of await store.listStates()) {
    if (st.status !== 'running' || inflight.has(st.sourceId)) continue;
    await store.putState({ ...st, status: 'error', runningSince: undefined, runId: undefined, lastError: 'The last update was interrupted (the browser or extension restarted). Retrying.', errorCode: 'interrupted', nextCheckAt: now });
    n++;
  }
  return n;
}

/** Runs sources with bounded concurrency and a time budget; stops starting new work when the budget is spent. */
async function pool(ids: string[], deps: SchedulerDeps, opts: { manual?: boolean; budgetMs?: number }): Promise<Record<string, RunOutcome>> {
  const results: Record<string, RunOutcome> = {};
  const queue = ids.slice();
  const start = deps.now();
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (opts.budgetMs && deps.now() - start > opts.budgetMs) {
        results[id] = 'skipped';
        continue;
      }
      results[id] = await runSource(id, deps, { manual: opts.manual });
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIMITS_RUN.concurrency, ids.length) }, worker));
  return results;
}

/** Which sources are due right now, most overdue first. */
export async function dueSources(now: number): Promise<string[]> {
  if ((await store.getSettings()).paused) return [];
  const needed = store.neededSourceIds(await store.listDashboards(), { activeOnly: true });
  const states = new Map((await store.listStates()).map((s) => [s.sourceId, s]));
  return (await store.listSources())
    .filter((s) => needed.has(s.id) && approvalCovers(s.approval, s))
    .map((s) => ({ s, st: states.get(s.id) }))
    .filter(({ st }) => !st || (st.status !== 'paused' && st.status !== 'running' && st.nextCheckAt <= now && (st.backoffUntil ?? 0) <= now))
    .sort((a, b) => (a.st?.nextCheckAt ?? 0) - (b.st?.nextCheckAt ?? 0))
    .map(({ s }) => s.id);
}

/** The alarm handler: collect everything that is due. No loops of its own; the next alarm schedules the next tick. */
export async function tick(deps: SchedulerDeps): Promise<Record<string, RunOutcome>> {
  await recoverStale(deps);
  return pool(await dueSources(deps.now()), deps, { budgetMs: LIMITS_RUN.tickBudgetMs });
}

/** User pressed Refresh (one source, a dashboard, or everything). Respects source pauses, backoff and Retry-After. */
export async function refresh(ids: string[], deps: SchedulerDeps): Promise<Record<string, RunOutcome>> {
  return pool([...new Set(ids)], deps, { manual: true });
}

/** Opening a dashboard: the UI shows cached data immediately (it reads storage); here we refresh only what is stale. */
export async function refreshStaleFor(dashboardId: string, deps: SchedulerDeps): Promise<Record<string, RunOutcome>> {
  const d = await store.getDashboard(dashboardId);
  if (!d || d.paused || (await store.getSettings()).paused) return {};
  const now = deps.now();
  const stale: string[] = [];
  for (const id of store.sourceIdsOf(d, { activeOnly: true })) {
    const [src, st] = await Promise.all([store.getSource(id), store.getState(id)]);
    if (!src || !approvalCovers(src.approval, src) || st?.status === 'paused' || st?.status === 'running') continue;
    if ((st?.backoffUntil ?? 0) > now || st?.nextCheckAt === NEVER) continue;
    if (!st?.lastSuccessAt || now - st.lastSuccessAt >= src.intervalMinutes * 60_000) stale.push(id);
  }
  return pool(stale, deps, {});
}

export async function ensureAlarm(): Promise<void> {
  if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
}

/** Startup / install / update: make the alarm exist, repair interrupted state, clean up, and catch up. */
export async function reconcile(deps: SchedulerDeps): Promise<void> {
  await ensureAlarm();
  await deps.closeOrphans?.().catch(() => undefined);
  await store.migrate();
  await recoverStale(deps);
  await store.gcSources({ minAgeMs: 24 * 3600_000 });
  await tick(deps);
}
