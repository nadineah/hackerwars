import type { CollectAnswer } from './browser';
import { approvalCovers, type DashData, type DashState, type Dashboard, type JobResult } from './schema';
import * as store from './store';
import { hashHex } from './util';

export const ALARM = 'ww-dash-tick';
/** Marks "do not retry automatically": the user has to act (approve, sign in, fix the script) and press refresh. */
export const NEVER = 8.64e15;

export const LIMITS_RUN = {
  backoffBase: 5 * 60_000,
  backoffMax: 6 * 3600_000,
  maxAutoFailures: 6,
  concurrency: 2,
  manualMinGapMs: 30_000,
  tickBudgetMs: 4 * 60_000,
  runTimeoutMs: 120_000,
} as const;

export interface SchedulerDeps {
  /** Runs the dashboard's collect script. Production wires this to the offscreen sandbox. */
  collect: (d: Dashboard) => Promise<CollectAnswer>;
  now: () => number;
  random: () => number;
  /** Called at startup to close collector tabs a dead worker left behind. */
  closeOrphans?: () => Promise<number>;
}

/** Exponential backoff with jitter: 5 min, 10, 20, 40 ... capped at 6 h. */
export function backoffDelay(failures: number, random = 0.5): number {
  const base = Math.min(LIMITS_RUN.backoffMax, LIMITS_RUN.backoffBase * 2 ** Math.max(0, failures - 1));
  return Math.round(base * (0.9 + random * 0.2));
}

/** In-process bookkeeping. After a worker restart this is empty on purpose: the persisted lease is what we recover from. */
const inflight = new Map<string, Promise<RunOutcome>>();
export const _resetForTests = () => inflight.clear();

export type RunOutcome = 'ran' | 'already-running' | 'missing' | 'nothing-to-do' | 'needs-approval' | 'paused' | 'recent' | 'backoff' | 'skipped';

const fresh = (dashboardId: string, now: number): DashState => ({ dashboardId, status: 'idle', nextCheckAt: now, consecutiveFailures: 0 });
export const hasWork = (d: Dashboard): boolean => d.collect.trim().length > 0;

/** Runs ONE dashboard's collect script now, never overlapping itself. Every path ends by persisting an honest state. */
export function runDashboard(id: string, deps: SchedulerDeps, opts: { manual?: boolean } = {}): Promise<RunOutcome> {
  if (inflight.has(id)) return Promise.resolve('already-running');
  const p = doRun(id, deps, opts).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

async function doRun(id: string, deps: SchedulerDeps, opts: { manual?: boolean }): Promise<RunOutcome> {
  const dash = await store.getDashboard(id);
  if (!dash) return 'missing';
  if (!hasWork(dash)) return 'nothing-to-do';
  const t0 = deps.now();
  let state = (await store.getState(id)) ?? fresh(id, t0);
  if (state.status === 'paused') return 'paused';
  if (!approvalCovers(dash.approval, dash)) {
    await store.putState({ ...state, status: 'needs-approval', nextCheckAt: NEVER, lastError: 'Permission needed: approve the sites this dashboard reads.', errorCode: 'needs-approval' });
    return 'needs-approval';
  }
  if (opts.manual && state.lastAttemptAt && t0 - state.lastAttemptAt < LIMITS_RUN.manualMinGapMs && state.status === 'ok') return 'recent';
  if ((state.backoffUntil ?? 0) > t0) return 'backoff';

  state = { ...state, status: 'running', runningSince: t0, runId: `${t0}-${Math.floor(deps.random() * 1e9)}` };
  await store.putState(state); // the lease: if the worker dies now, recovery finds a stale 'running' state

  let answer: CollectAnswer;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    answer = await Promise.race<CollectAnswer>([
      deps.collect(dash),
      new Promise<CollectAnswer>((res) => {
        timer = setTimeout(() => res({ ok: false, error: 'The update took too long and was stopped.', code: 'timeout' }), LIMITS_RUN.runTimeoutMs);
      }),
    ]);
  } catch (e: any) {
    answer = { ok: false, error: String(e?.message ?? e).slice(0, 160), code: 'unexpected' };
  } finally {
    if (timer) clearTimeout(timer);
  }
  const t1 = deps.now();
  const prev = await store.getState(id); // pick up anything (e.g. a pause) set while we ran
  const base: DashState = { ...(prev ?? state), lastAttemptAt: t1, runningSince: undefined, runId: undefined };
  const paused = prev?.status === 'paused';
  const log = (o: string): JobResult => ({ at: t1, dashboardId: id, name: dash.name, ok: answer.ok, outcome: o, ms: t1 - t0 });

  if (answer.ok) {
    const hash = hashHex(JSON.stringify(answer.value));
    const changed = hash !== state.contentHash;
    const next: DashState = { ...base, status: paused ? 'paused' : 'ok', consecutiveFailures: 0, lastError: undefined, errorCode: undefined, backoffUntil: undefined, lastSuccessAt: t1, nextCheckAt: t1 + dash.intervalMinutes * 60_000, contentHash: hash };
    if (changed) next.lastChangeAt = t1;
    // Unchanged data is not rewritten: no storage churn, no spurious "updated" signals.
    const data: DashData | null = changed ? { value: answer.value, at: t1, bytes: answer.bytes } : null;
    await store.commitCollection(id, next, data, log(changed ? 'changed' : 'unchanged'));
    return 'ran';
  }

  // Failure: keep the last good data, say why, back off, and stop retrying things only the user can fix.
  const code = answer.code ?? 'error';
  const status = code === 'signin' ? 'needs-signin' : code === 'not-approved' || code === 'tabs-not-approved' ? 'needs-approval' : code === 'captcha' || code === 'bad-result' || code === 'too-large' ? 'needs-attention' : 'error';
  const failures = base.consecutiveFailures + 1;
  const userMustAct = status !== 'error';
  const exhausted = !userMustAct && failures >= LIMITS_RUN.maxAutoFailures;
  const wait = backoffDelay(failures, deps.random());
  const next: DashState = {
    ...base,
    status: paused ? 'paused' : exhausted ? 'needs-attention' : status,
    consecutiveFailures: failures,
    lastError: exhausted ? `${answer.error} Automatic retries stopped after ${failures} failures; press Refresh to try again.` : answer.error,
    errorCode: code,
    backoffUntil: userMustAct || exhausted ? undefined : t1 + wait,
    nextCheckAt: userMustAct || exhausted ? NEVER : t1 + wait,
  };
  await store.commitCollection(id, next, null, log(code));
  return 'ran';
}

/** Marks leases left by a dead worker (or a hung run) as interrupted so the dashboard is retried instead of stuck. */
export async function recoverStale(deps: SchedulerDeps): Promise<number> {
  const now = deps.now();
  let n = 0;
  for (const st of await store.listStates()) {
    if (st.status !== 'running' || inflight.has(st.dashboardId)) continue;
    await store.putState({ ...st, status: 'error', runningSince: undefined, runId: undefined, lastError: 'The last update was interrupted (the browser or extension restarted). Retrying.', errorCode: 'interrupted', nextCheckAt: now });
    n++;
  }
  return n;
}

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
      results[id] = await runDashboard(id, deps, { manual: opts.manual });
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIMITS_RUN.concurrency, ids.length) }, worker));
  return results;
}

/** Which dashboards are due right now, most overdue first. */
export async function dueDashboards(now: number): Promise<string[]> {
  if ((await store.getSettings()).paused) return [];
  const states = new Map((await store.listStates()).map((s) => [s.dashboardId, s]));
  return (await store.listDashboards())
    .filter((d) => !d.paused && hasWork(d) && approvalCovers(d.approval, d))
    .map((d) => ({ d, st: states.get(d.id) }))
    .filter(({ st }) => !st || (st.status !== 'paused' && st.status !== 'running' && st.nextCheckAt <= now && (st.backoffUntil ?? 0) <= now))
    .sort((a, b) => (a.st?.nextCheckAt ?? 0) - (b.st?.nextCheckAt ?? 0))
    .map(({ d }) => d.id);
}

/** The alarm handler: collect everything that is due. No loops of its own; the next alarm schedules the next tick. */
export async function tick(deps: SchedulerDeps): Promise<Record<string, RunOutcome>> {
  await recoverStale(deps);
  return pool(await dueDashboards(deps.now()), deps, { budgetMs: LIMITS_RUN.tickBudgetMs });
}

/** User pressed Refresh. Respects pauses and backoff. */
export const refresh = (ids: string[], deps: SchedulerDeps) => pool([...new Set(ids)], deps, { manual: true });

/** Opening a dashboard: the page shows cached data immediately; here we refresh it only if it is stale. */
export async function refreshStaleFor(id: string, deps: SchedulerDeps): Promise<Record<string, RunOutcome>> {
  const d = await store.getDashboard(id);
  if (!d || d.paused || !hasWork(d) || (await store.getSettings()).paused || !approvalCovers(d.approval, d)) return {};
  const st = await store.getState(id);
  const now = deps.now();
  if (st?.status === 'paused' || st?.status === 'running' || (st?.backoffUntil ?? 0) > now || st?.nextCheckAt === NEVER) return {};
  if (st?.lastSuccessAt && now - st.lastSuccessAt < d.intervalMinutes * 60_000) return {};
  return pool([id], deps, {});
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
  await tick(deps);
}
