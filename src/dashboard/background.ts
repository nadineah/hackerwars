import { getSettings as getAppSettings, addUsage } from '../shared/storage';
import { providerOf } from '../shared/types';
import { applyProposal, propose } from './ai';
import { collectRendered, closeOrphanTabs, parseOffscreen } from './browser';
import { collectSource, fetchText, type CollectDeps, type Outcome } from './collect';
import { ALARM, ensureAlarm, productionDeps, reconcile, refresh, refreshStaleFor, tick, type SchedulerDeps } from './scheduler';
import { SCHEMA_VERSION, approvalCovers, approvalFor, effectiveInfo, newDashboard, validateDashboard, validateSourceInput, type Dashboard, type Source, type SourceInput } from './schema';
import * as store from './store';
import { newId } from './util';

/**
 * Background side of Dashboard mode: the alarm that drives the scheduler, startup reconciliation, and the message
 * API used by the dashboard page. Only extension pages may call it (never content scripts, never web pages).
 */

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  /** Problems/limits found while applying a proposal, shown to the user as notes. */
  notes?: string[];
  at: number;
}

const collectDeps: CollectDeps = { fetch: (...a) => fetch(...a), parse: parseOffscreen, rendered: collectRendered, allowLocal: false };
export const schedulerDeps: SchedulerDeps = productionDeps(collectDeps, { closeOrphans: closeOrphanTabs });

// An extension worker is stopped 30 s after it last did anything. A collection that is waiting on the network keeps
// it alive by calling an extension API on an interval, and lets go when no work is left.
let busy = 0;
let beat: ReturnType<typeof setInterval> | null = null;
export async function withKeepAlive<T>(job: () => Promise<T>): Promise<T> {
  busy++;
  if (!beat) beat = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => undefined), 20_000);
  try {
    return await job();
  } finally {
    if (--busy === 0 && beat) {
      clearInterval(beat);
      beat = null;
    }
  }
}

export function initDashboardBackground(opts: { enqueue: <T>(job: () => Promise<T>) => Promise<T> }): void {
  // Listeners are registered synchronously at worker start, as MV3 requires, so a wake-up by alarm is never missed.
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void withKeepAlive(() => tick(schedulerDeps)).catch(() => undefined);
  });
  chrome.runtime.onStartup.addListener(() => void withKeepAlive(() => reconcile(schedulerDeps)).catch(() => undefined));
  chrome.runtime.onInstalled.addListener(() => void withKeepAlive(() => reconcile(schedulerDeps)).catch(() => undefined));
  // Cheap and idempotent: if Chrome dropped the alarm, bring it back whenever the worker starts.
  void ensureAlarm().catch(() => undefined);

  chrome.runtime.onMessage.addListener((msg: DashMessage, sender, sendResponse) => {
    if (msg?.type !== 'ww:dash') return;
    // Extension pages opened as tabs carry sender.tab, so the check is "from one of OUR pages", not "has no tab".
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
    handle(msg, opts.enqueue)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true;
  });
}

export type DashMessage = { type: 'ww:dash'; op: string; [k: string]: any };

const settingsOpts = {}; // developer overrides (allowLocal / fastIntervals) are never reachable from the UI

async function validContext() {
  const sources = await store.listSources();
  return { sources, ctx: { sourceIds: new Set(sources.map((s) => s.id)), newId } };
}

async function fetchPage(url: string): Promise<{ text: string } | { error: string }> {
  const probe = validateSourceInput({ kind: 'html', url, config: { itemSelector: 'body', fields: { title: {} } } }, settingsOpts);
  if (!probe.ok) return { error: probe.errors.join('; ') };
  const src = { ...probe.value, approval: null } as Source;
  const got = await fetchText(src, null, collectDeps, false);
  return 'text' in got ? { text: got.text.slice(0, 900_000) } : 'notModified' in got ? { error: 'No content.' } : { error: got.ok ? 'Unexpected.' : got.message };
}

async function removeSourceEverywhere(id: string) {
  for (const d of await store.listDashboards()) {
    const widgets = d.widgets.flatMap<Dashboard['widgets'][number]>((w) => {
      if (w.type === 'updates') return w.sourceIds.includes(id) ? (w.sourceIds.length > 1 ? [{ ...w, sourceIds: w.sourceIds.filter((x) => x !== id) }] : []) : [w];
      if ((w.type === 'list' || w.type === 'page-change') && w.sourceId === id) return [];
      return [w];
    });
    if (widgets.length !== d.widgets.length || JSON.stringify(widgets) !== JSON.stringify(d.widgets)) await store.saveDashboard({ ...d, widgets: widgets as Dashboard['widgets'], updatedAt: Date.now() });
  }
  await store.removeSource(id);
}

async function handle(msg: DashMessage, enqueue: <T>(j: () => Promise<T>) => Promise<T>): Promise<Record<string, unknown>> {
  switch (msg.op) {
    case 'create': {
      const d = newDashboard(newId('dash'), String(msg.name || 'Untitled dashboard').slice(0, 60));
      await store.saveDashboard(d);
      return { dashboard: d };
    }
    case 'save': {
      const { ctx } = await validContext();
      const v = validateDashboard(msg.dashboard, ctx);
      if (!v.dashboard) throw new Error(v.errors.join('; '));
      const existing = await store.getDashboard(v.dashboard.id);
      if (!existing) throw new Error('That dashboard no longer exists.');
      const saved = { ...v.dashboard, createdAt: existing.createdAt, updatedAt: Date.now() };
      await store.saveDashboard(saved);
      await store.gcSources();
      return { dashboard: saved, errors: v.errors };
    }
    case 'duplicate':
      return { dashboard: await store.duplicateDashboard(String(msg.id)) };
    case 'delete':
      return { removedSources: await store.deleteDashboard(String(msg.id)) };
    case 'setPaused': {
      const d = await store.getDashboard(String(msg.id));
      if (!d) throw new Error('Dashboard not found.');
      await store.saveDashboard({ ...d, paused: !!msg.paused, updatedAt: Date.now() });
      return {};
    }
    case 'setGlobalPaused':
      await store.setSettings({ paused: !!msg.paused });
      return {};
    case 'addSource': {
      const v = validateSourceInput(msg.input as SourceInput, settingsOpts);
      if (!v.ok) return { ok: false, errors: v.errors } as any;
      const existing = await store.getSource(v.value.id);
      const src: Source = existing ?? { ...v.value, approval: null };
      if (!existing) {
        if ((await store.listSources()).length >= 40) throw new Error('Too many sources. Remove one you no longer use.');
        await store.putSource(src);
        await store.putState({ sourceId: src.id, status: 'needs-approval', nextCheckAt: Date.now(), consecutiveFailures: 0 });
      }
      return { source: src, existed: !!existing };
    }
    case 'preview': {
      // A one-off, user-requested test of a source so they can see what would be collected BEFORE approving it.
      const v = validateSourceInput(msg.input as SourceInput, settingsOpts);
      if (!v.ok) return { errors: v.errors };
      if (effectiveInfo(v.value.kind, v.value.config).method === 'rendered') return { errors: ['Preview is not available for pages that need JavaScript or sign-in. Approve the source to collect it.'] };
      const src = { ...v.value, approval: approvalFor(v.value) } as Source;
      const out = await withKeepAlive(() => collectSource(src, null, collectDeps));
      return out.ok ? { items: out.notModified ? [] : out.items.slice(0, 8), watchText: out.notModified ? undefined : out.watchText } : { failure: { code: out.code, message: out.message } };
    }
    case 'approve': {
      const src = await store.getSource(String(msg.sourceId));
      if (!src) throw new Error('Source not found.');
      let next = { ...src };
      if (msg.intervalMinutes !== undefined || msg.backgroundTabs !== undefined) {
        const v = validateSourceInput({ kind: src.kind, name: src.name, url: src.url, config: src.config, intervalMinutes: msg.intervalMinutes ?? src.intervalMinutes, backgroundTabs: msg.backgroundTabs ?? src.backgroundTabs }, settingsOpts);
        if (!v.ok) throw new Error(v.errors.join('; '));
        next = { ...src, intervalMinutes: v.value.intervalMinutes, backgroundTabs: v.value.backgroundTabs };
      }
      next.approval = approvalFor(next);
      next.updatedAt = Date.now();
      await store.putSource(next);
      await store.putState({ sourceId: next.id, status: 'idle', nextCheckAt: Date.now(), consecutiveFailures: 0 });
      // Refresh immediately, in the background; the page watches storage for the result.
      void withKeepAlive(() => refresh([next.id], schedulerDeps)).catch(() => undefined);
      return { source: next };
    }
    case 'updateSource': {
      const src = await store.getSource(String(msg.sourceId));
      if (!src) throw new Error('Source not found.');
      const p = msg.patch ?? {};
      const v = validateSourceInput({ kind: src.kind, name: p.name ?? src.name, url: src.url, config: p.config ?? src.config, intervalMinutes: p.intervalMinutes ?? src.intervalMinutes, backgroundTabs: p.backgroundTabs ?? src.backgroundTabs }, settingsOpts);
      if (!v.ok) return { errors: v.errors };
      // The id stays (widgets point at it); only the editable fields change. Access that grew needs a new approval.
      const next: Source = { ...src, name: v.value.name, config: v.value.config, intervalMinutes: v.value.intervalMinutes, backgroundTabs: v.value.backgroundTabs, updatedAt: Date.now() };
      const covered = approvalCovers(src.approval, next);
      if (!covered) next.approval = null;
      await store.putSource(next);
      if (!covered) await store.patchState(next.id, (s) => ({ ...(s ?? { sourceId: next.id, consecutiveFailures: 0, nextCheckAt: Date.now() }), status: 'needs-approval' }));
      else if (p.config) await store.patchState(next.id, (s) => (s ? { ...s, nextCheckAt: Date.now(), consecutiveFailures: 0, backoffUntil: undefined, contentHash: undefined } : s));
      return { source: next, needsApproval: !covered };
    }
    case 'pauseSource': {
      const id = String(msg.sourceId);
      await store.patchState(id, (s) => (msg.paused ? { ...(s ?? { sourceId: id, consecutiveFailures: 0, nextCheckAt: Date.now() }), status: 'paused' } : { ...(s ?? { sourceId: id, consecutiveFailures: 0, nextCheckAt: Date.now() }), status: 'idle', nextCheckAt: Date.now(), backoffUntil: undefined }));
      if (!msg.paused) void withKeepAlive(() => refresh([id], schedulerDeps)).catch(() => undefined);
      return {};
    }
    case 'removeSource':
      await removeSourceEverywhere(String(msg.sourceId));
      return {};
    case 'clearData': {
      const id = String(msg.sourceId);
      await store.clearSourceData(id);
      return {};
    }
    case 'refresh': {
      const ids: string[] = msg.all ? (await store.listDashboards()).flatMap((d) => store.sourceIdsOf(d, { activeOnly: false })) : msg.dashboardId ? store.sourceIdsOf((await store.getDashboard(String(msg.dashboardId)))!, { activeOnly: false }) : (msg.sourceIds ?? []).map(String);
      const results = await withKeepAlive(() => refresh(ids, schedulerDeps));
      return { results };
    }
    case 'open':
      // Cached data is already on screen (the page reads storage); refresh only what is stale, in the background.
      void withKeepAlive(() => refreshStaleFor(String(msg.dashboardId), schedulerDeps)).catch(() => undefined);
      return {};
    case 'discover': {
      const page = await fetchPage(String(msg.url));
      if ('error' in page) return { error: page.error };
      const r = await parseOffscreen({ op: 'outline', text: page.text, url: String(msg.url) });
      return r.ok ? { feeds: r.feeds ?? [] } : { error: r.error };
    }
    case 'chat': {
      const id = String(msg.dashboardId);
      const [d, settings] = await Promise.all([store.getDashboard(id), getAppSettings()]);
      if (!d) throw new Error('Dashboard not found.');
      const provider = providerOf(settings.model);
      const apiKey = provider === 'anthropic' ? settings.apiKey : settings.openaiKey;
      if (!apiKey) throw new Error(`Add your ${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key in WhimsyWeb settings to use the assistant.`);
      const history: ChatTurn[] = (await chrome.storage.local.get(store.K.chat(id)))[store.K.chat(id)] ?? [];
      const sources = await store.listSources();
      const states = Object.fromEntries((await store.listStates()).map((s) => [s.sourceId, s]));
      // Page structure is sent ONLY when the user explicitly asked the assistant to look at that page.
      let outline: { url: string; text: string } | undefined;
      if (typeof msg.inspectUrl === 'string' && msg.inspectUrl) {
        const page = await fetchPage(msg.inspectUrl);
        if ('error' in page) throw new Error(`Could not look at that page: ${page.error}`);
        const o = await parseOffscreen({ op: 'outline', text: page.text, url: msg.inspectUrl });
        if (!o.ok) throw new Error(o.error);
        outline = { url: msg.inspectUrl, text: o.outline ?? '' };
      }
      const ctrl = new AbortController();
      const { raw } = await withKeepAlive(() => propose({ apiKey, model: settings.model, history, prompt: String(msg.prompt ?? ''), context: { dashboard: d, sources, states }, outline, signal: ctrl.signal }));
      await enqueue(() => addUsage(provider, settings.model, raw.usage)).catch(() => undefined);
      const applied = applyProposal(raw.toolInput, d, sources, settingsOpts);
      if (applied.changed) {
        for (const s of applied.newSources) {
          await store.putSource(s);
          await store.putState({ sourceId: s.id, status: 'needs-approval', nextCheckAt: Date.now(), consecutiveFailures: 0 });
        }
        await store.saveDashboard(applied.dashboard);
        await store.gcSources();
      }
      const turns: ChatTurn[] = [...history, { role: 'user', text: String(msg.prompt ?? '').slice(0, 2000), at: Date.now() }, { role: 'assistant', text: applied.reply || (applied.changed ? 'Updated the dashboard.' : 'No changes.'), notes: applied.problems, at: Date.now() }].slice(-40) as ChatTurn[];
      await chrome.storage.local.set({ [store.K.chat(id)]: turns });
      return { reply: applied.reply, problems: applied.problems, changed: applied.changed, newSourceIds: applied.newSources.map((s) => s.id), previous: d, truncated: raw.truncated };
    }
    case 'clearChat':
      await chrome.storage.local.remove(store.K.chat(String(msg.dashboardId)));
      return {};
    default:
      throw new Error(`Unknown dashboard operation "${String(msg.op)}".`);
  }
}

export const __testing = { handle, SCHEMA_VERSION };
