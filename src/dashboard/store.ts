import { SCHEMA_VERSION, validateDashboard, validateSourceConfig, type Approval, type Dashboard, type DashRecord, type JobResult, type Source, type SourceState } from './schema';
import { newId } from './util';

/**
 * Dashboard storage (chrome.storage.local). Reads are safe from any extension page; WRITES go through the
 * background worker's single queue. Every key is namespaced and versioned.
 *
 *   dash:<id>   Dashboard           dsrc:<id>  Source (+approval)       dstate:<id>  SourceState
 *   drec:<id>   DashRecord[]        dset       DashSettings             dlog         JobResult[] (last 40)
 */
export const K = {
  dash: (id: string) => `dash:${id}`,
  src: (id: string) => `dsrc:${id}`,
  state: (id: string) => `dstate:${id}`,
  rec: (id: string) => `drec:${id}`,
  chat: (id: string) => `dchat:${id}`,
  settings: 'dset',
  log: 'dlog',
} as const;
const isKey = (prefix: string) => (k: string) => k.startsWith(prefix);

export interface DashSettings {
  schemaVersion: number;
  /** Global pause: nothing is collected in the background while true. */
  paused: boolean;
}
export const DEFAULT_SETTINGS: DashSettings = { schemaVersion: SCHEMA_VERSION, paused: false };

let writeQueue: Promise<unknown> = Promise.resolve();
/** Serializes read-modify-write cycles. */
export function write<T>(job: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(job, job);
  writeQueue = run.catch(() => undefined);
  return run;
}

const area = () => chrome.storage.local;

async function allOf(prefix: string): Promise<[string, any][]> {
  const all = await area().get(null);
  return Object.entries(all).filter(([k]) => isKey(prefix)(k));
}

export async function getSettings(): Promise<DashSettings> {
  const r = await area().get(K.settings);
  return { ...DEFAULT_SETTINGS, ...(r[K.settings] ?? {}), schemaVersion: SCHEMA_VERSION };
}
export const setSettings = (patch: Partial<DashSettings>) =>
  write(async () => {
    await area().set({ [K.settings]: { ...(await getSettings()), ...patch } });
  });

export async function listDashboards(): Promise<Dashboard[]> {
  return (await allOf('dash:')).map(([, v]) => v as Dashboard).sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function getDashboard(id: string): Promise<Dashboard | null> {
  const r = await area().get(K.dash(id));
  return (r[K.dash(id)] as Dashboard | undefined) ?? null;
}
export async function listSources(): Promise<Source[]> {
  return (await allOf('dsrc:')).map(([, v]) => v as Source);
}
export async function getSource(id: string): Promise<Source | null> {
  const r = await area().get(K.src(id));
  return (r[K.src(id)] as Source | undefined) ?? null;
}
export async function getState(id: string): Promise<SourceState | null> {
  const r = await area().get(K.state(id));
  return (r[K.state(id)] as SourceState | undefined) ?? null;
}
export async function listStates(): Promise<SourceState[]> {
  return (await allOf('dstate:')).map(([, v]) => v as SourceState);
}
export async function getRecords(id: string): Promise<DashRecord[]> {
  const r = await area().get(K.rec(id));
  return (r[K.rec(id)] as DashRecord[] | undefined) ?? [];
}
export async function getLog(): Promise<JobResult[]> {
  const r = await area().get(K.log);
  return (r[K.log] as JobResult[] | undefined) ?? [];
}

/** Source ids a dashboard's widgets use. */
export function sourceIdsOf(d: Dashboard, opts: { activeOnly?: boolean } = {}): string[] {
  const ids: string[] = [];
  for (const w of d.widgets) {
    if (opts.activeOnly && w.paused) continue;
    if (w.type === 'updates') ids.push(...w.sourceIds);
    else if (w.type === 'list' || w.type === 'page-change') ids.push(w.sourceId);
  }
  return [...new Set(ids)];
}

/** Sources that something currently wants updated: used by the scheduler and by delete-time cleanup. */
export function neededSourceIds(dashboards: Dashboard[], opts: { activeOnly: boolean }): Set<string> {
  const out = new Set<string>();
  for (const d of dashboards) {
    if (opts.activeOnly && d.paused) continue;
    sourceIdsOf(d, { activeOnly: opts.activeOnly }).forEach((id) => out.add(id));
  }
  return out;
}

export const saveDashboard = (d: Dashboard) =>
  write(async () => {
    await area().set({ [K.dash(d.id)]: d });
  });

export const putSource = (s: Source) =>
  write(async () => {
    await area().set({ [K.src(s.id)]: s });
  });

export const putState = (s: SourceState) =>
  write(async () => {
    await area().set({ [K.state(s.sourceId)]: s });
  });

/** Atomic update of one source's state. */
export const patchState = (id: string, fn: (s: SourceState | null) => SourceState | null) =>
  write(async () => {
    const cur = (await getState(id)) ?? null;
    const next = fn(cur);
    if (next) await area().set({ [K.state(id)]: next });
    return next;
  });

/** Records + state in ONE storage write, so a crash cannot leave data without its freshness (or vice versa). */
export const commitCollection = (id: string, state: SourceState, records: DashRecord[] | null, log: JobResult) =>
  write(async () => {
    const entries: Record<string, unknown> = { [K.state(id)]: state, [K.log]: [log, ...(await getLog())].slice(0, 40) };
    if (records) entries[K.rec(id)] = records;
    await area().set(entries);
  });

export const appendLog = (log: JobResult) =>
  write(async () => {
    await area().set({ [K.log]: [log, ...(await getLog())].slice(0, 40) });
  });

export const setApproval = (id: string, approval: Approval | null) =>
  write(async () => {
    const s = await getSource(id);
    if (s) await area().set({ [K.src(id)]: { ...s, approval, updatedAt: Date.now() } });
  });

/** Forgets what was collected for a source (cached items and change history) but keeps the source and its approval. */
export const clearSourceData = (id: string) =>
  write(async () => {
    await area().remove(K.rec(id));
    const st = await getState(id);
    if (st) await area().set({ [K.state(id)]: { ...st, contentHash: undefined, etag: undefined, lastModified: undefined, lastChangeAt: undefined, watchText: undefined, previousWatchText: undefined, lastSuccessAt: undefined, nextCheckAt: Date.now() } });
  });

/** Removes a source with its state and cached records. */
export const removeSource = (id: string) =>
  write(async () => {
    await area().remove([K.src(id), K.state(id), K.rec(id)]);
  });

/**
 * Deletes sources (and their cached data) that no dashboard references. A source another dashboard still uses
 * is kept, so deleting one dashboard never breaks or stops a different one.
 */
export const gcSources = () =>
  write(async () => {
    const needed = neededSourceIds(await listDashboards(), { activeOnly: false });
    const gone: string[] = [];
    for (const s of await listSources()) {
      if (!needed.has(s.id)) gone.push(K.src(s.id), K.state(s.id), K.rec(s.id));
    }
    if (gone.length) await area().remove(gone);
    return gone.length / 3;
  });

export const deleteDashboard = async (id: string) => {
  await write(async () => {
    await area().remove([K.dash(id), K.chat(id)]);
  });
  return gcSources();
};

/** Clone with new ids; sources are shared (same source id), so a duplicate does not double the network traffic. */
export async function duplicateDashboard(id: string): Promise<Dashboard | null> {
  const d = await getDashboard(id);
  if (!d) return null;
  const copy: Dashboard = { ...JSON.parse(JSON.stringify(d)), id: newId('dash'), name: `${d.name} (copy)`.slice(0, 60), createdAt: Date.now(), updatedAt: Date.now() };
  copy.widgets.forEach((w) => {
    w.id = newId('w');
  });
  await saveDashboard(copy);
  return copy;
}

/** Validates everything stored, repairing or dropping what an older/buggy version left behind. Idempotent. */
export const migrate = () =>
  write(async () => {
    const dashboards = await listDashboards();
    const sources = await listSources();
    const ctx = { sourceIds: new Set(sources.map((s) => s.id)), newId };
    const sets: Record<string, unknown> = {};
    const drop: string[] = [];
    for (const [k, raw] of await allOf('dash:')) {
      const v = validateDashboard(raw, ctx);
      if (v.dashboard) sets[k] = v.dashboard;
      else drop.push(k);
    }
    for (const s of sources) {
      const c = validateSourceConfig(s.kind, s.config);
      if (!c.ok) drop.push(K.src(s.id), K.state(s.id), K.rec(s.id));
      else sets[K.src(s.id)] = { ...s, config: c.value, schemaVersion: SCHEMA_VERSION };
    }
    sets[K.settings] = await getSettings();
    void dashboards;
    if (Object.keys(sets).length) await area().set(sets);
    if (drop.length) await area().remove(drop);
  });
