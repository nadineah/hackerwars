import { SCHEMA_VERSION, repairDashboard, type DashData, type DashState, type Dashboard, type JobResult } from './schema';
import { newId } from './util';

/**
 * Dashboard storage (chrome.storage.local). Reads are safe from any extension page; WRITES go through the worker's
 * single queue.   dash:<id> Dashboard   dstate:<id> DashState   ddata:<id> DashData   dkv:<id> per-dashboard notes/settings
 *                 dchat:<id> chat       dset DashSettings       dlog JobResult[] (last 40)
 */
export const K = {
  dash: (id: string) => `dash:${id}`,
  state: (id: string) => `dstate:${id}`,
  data: (id: string) => `ddata:${id}`,
  kv: (id: string) => `dkv:${id}`,
  chat: (id: string) => `dchat:${id}`,
  settings: 'dset',
  log: 'dlog',
} as const;

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
  return Object.entries(await area().get(null)).filter(([k]) => k.startsWith(prefix));
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
export async function getState(id: string): Promise<DashState | null> {
  const r = await area().get(K.state(id));
  return (r[K.state(id)] as DashState | undefined) ?? null;
}
export async function listStates(): Promise<DashState[]> {
  return (await allOf('dstate:')).map(([, v]) => v as DashState);
}
export async function getData(id: string): Promise<DashData | null> {
  const r = await area().get(K.data(id));
  return (r[K.data(id)] as DashData | undefined) ?? null;
}
export async function getLog(): Promise<JobResult[]> {
  const r = await area().get(K.log);
  return (r[K.log] as JobResult[] | undefined) ?? [];
}
export async function getKV(id: string): Promise<Record<string, unknown>> {
  const r = await area().get(K.kv(id));
  return (r[K.kv(id)] as Record<string, unknown> | undefined) ?? {};
}

export const saveDashboard = (d: Dashboard) =>
  write(async () => {
    await area().set({ [K.dash(d.id)]: d });
  });

export const putState = (s: DashState) =>
  write(async () => {
    await area().set({ [K.state(s.dashboardId)]: s });
  });

/** Atomic update of one dashboard's state. */
export const patchState = (id: string, fn: (s: DashState | null) => DashState | null) =>
  write(async () => {
    const next = fn((await getState(id)) ?? null);
    if (next) await area().set({ [K.state(id)]: next });
    return next;
  });

/** Data + state in ONE storage write, so a crash cannot leave data without its freshness (or vice versa). */
export const commitCollection = (id: string, state: DashState, data: DashData | null, log: JobResult) =>
  write(async () => {
    const entries: Record<string, unknown> = { [K.state(id)]: state, [K.log]: [log, ...(await getLog())].slice(0, 40) };
    if (data) entries[K.data(id)] = data;
    await area().set(entries);
  });

export const setKV = (id: string, key: string, value: unknown) =>
  write(async () => {
    const kv = await getKV(id);
    if (value === undefined || value === null) delete kv[key];
    else kv[key] = value;
    await area().set({ [K.kv(id)]: kv });
  });

/** Forgets what was collected (keeps the dashboard and its approval). */
export const clearData = (id: string) =>
  write(async () => {
    await area().remove(K.data(id));
    const st = await getState(id);
    if (st) await area().set({ [K.state(id)]: { ...st, contentHash: undefined, lastChangeAt: undefined, lastSuccessAt: undefined, nextCheckAt: Date.now() } });
  });

/** Deletes a dashboard with its schedule, collected data, notes and chat. */
export const deleteDashboard = (id: string) =>
  write(async () => {
    await area().remove([K.dash(id), K.state(id), K.data(id), K.kv(id), K.chat(id)]);
  });

export async function duplicateDashboard(id: string): Promise<Dashboard | null> {
  const d = await getDashboard(id);
  if (!d) return null;
  // The copy starts unapproved: approval belongs to the dashboard the user actually reviewed.
  const copy: Dashboard = { ...d, id: newId('dash'), name: `${d.name} (copy)`.slice(0, 60), createdAt: Date.now(), updatedAt: Date.now(), approval: null };
  await saveDashboard(copy);
  return copy;
}

/** Brings storage to the current version: repairs dashboards and drops version-1 sources and cached records. Idempotent. */
export const migrate = () =>
  write(async () => {
    const all = await area().get(null);
    const sets: Record<string, unknown> = {};
    const drop: string[] = [];
    for (const [k, raw] of Object.entries(all)) {
      if (k.startsWith('dash:')) {
        const d = repairDashboard(raw);
        if (d) sets[k] = d;
        else drop.push(k);
      } else if (k.startsWith('dsrc:') || k.startsWith('drec:')) drop.push(k);
      else if (k.startsWith('dstate:') && (raw as { sourceId?: string }).sourceId !== undefined) drop.push(k);
    }
    sets[K.settings] = await getSettings();
    await area().set(sets);
    if (drop.length) await area().remove(drop);
  });
