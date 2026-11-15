import { getSettings as getAppSettings, addUsage } from '../shared/storage';
import { providerOf } from '../shared/types';
import { applyProposal, inspectList, propose } from './ai';
import { handleBridge, type BridgeCtx } from './bridge';
import { closeOrphanTabs, outlineOffscreen, renderPage, runCollectOffscreen } from './browser';
import { ALARM, ensureAlarm, reconcile, refresh, refreshStaleFor, tick, type SchedulerDeps } from './scheduler';
import { approvalCovers, approvalFor, hostAllowed, newDashboard, normalizeDomain, validateCode, type Dashboard } from './schema';
import * as store from './store';
import { newId } from './util';

/**
 * Background side of Dashboard mode: the alarm that drives the scheduler, startup reconciliation, the message API used
 * by the dashboard page, and the page-render relay used by sandboxed scripts. Only extension pages may call it.
 */

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  /** Problems/limits found while applying a proposal, shown to the user as notes. */
  notes?: string[];
  at: number;
}

export const schedulerDeps: SchedulerDeps = {
  collect: (d) =>
    runCollectOffscreen({
      code: d.collect,
      dashboardId: d.id,
      // Only what the user approved AND the dashboard still asks for.
      domains: d.domains.filter((h) => d.approval?.domains.includes(h)),
      backgroundTabs: !!d.approval?.backgroundTabs && d.backgroundTabs,
    }),
  now: () => Date.now(),
  random: Math.random,
  closeOrphans: closeOrphanTabs,
};

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

const fromOurPage = (sender: chrome.runtime.MessageSender) => sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));

export function initDashboardBackground(opts: { enqueue: <T>(job: () => Promise<T>) => Promise<T> }): void {
  // Listeners are registered synchronously at worker start, as MV3 requires, so a wake-up by alarm is never missed.
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void withKeepAlive(() => tick(schedulerDeps)).catch(() => undefined);
  });
  chrome.runtime.onStartup.addListener(() => void withKeepAlive(() => reconcile(schedulerDeps)).catch(() => undefined));
  chrome.runtime.onInstalled.addListener(() => void withKeepAlive(() => reconcile(schedulerDeps)).catch(() => undefined));
  void ensureAlarm().catch(() => undefined); // cheap and idempotent: if Chrome dropped the alarm, bring it back

  chrome.runtime.onMessage.addListener((msg: DashMessage | RenderMessage, sender, sendResponse) => {
    if (msg?.type === 'ww:render') {
      if (!fromOurPage(sender)) return;
      relayRender(msg as RenderMessage).then(sendResponse);
      return true;
    }
    if (msg?.type !== 'ww:dash') return;
    // Extension pages opened as tabs carry sender.tab, so the check is "from one of OUR pages", not "has no tab".
    if (!fromOurPage(sender)) return;
    handle(msg as DashMessage, opts.enqueue)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true;
  });
}

export type DashMessage = { type: 'ww:dash'; op: string; [k: string]: any };
export type RenderMessage = { type: 'ww:render'; dashboardId?: string; url: string; waitFor?: string; waitMs: number };

/** Page rendering for sandboxed scripts. The dashboard's stored approval is re-checked here, whatever the caller claims. */
async function relayRender(m: RenderMessage) {
  const d = typeof m.dashboardId === 'string' ? await store.getDashboard(m.dashboardId) : null;
  if (!d || !d.approval || !d.approval.backgroundTabs || !d.backgroundTabs) return { ok: false, error: 'Background tabs are not approved for this dashboard.' };
  let host: string;
  try {
    host = new URL(m.url).hostname;
  } catch {
    return { ok: false, error: 'Bad address.' };
  }
  if (!hostAllowed(d.approval.domains, host) || !d.domains.some((x) => hostAllowed([x], host))) return { ok: false, error: 'That site is not approved for this dashboard.' };
  return withKeepAlive(() => renderPage(m.url, { waitFor: m.waitFor, waitMs: Math.min(15_000, Math.max(500, Number(m.waitMs) || 6000)), allowNewTab: true }));
}

async function fetchPage(url: string): Promise<{ text: string; contentType: string } | { error: string }> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { error: 'That is not a valid address.' };
  }
  const ctx: BridgeCtx = { domains: [normalizeDomain(host) ?? ''], backgroundTabs: false, fetch: (...a) => fetch(...a), render: async () => ({ ok: false }), counter: { requests: 0 } };
  const r = await handleBridge(ctx, { op: 'fetch', url });
  return r.ok ? { text: String((r.result as { body: string }).body).slice(0, 900_000), contentType: String((r.result as { contentType: string }).contentType ?? '') } : { error: r.error };
}

/** What the assistant gets when it asks to look at a public page: structure plus a short, masked text sample. No cookies are used. */
async function lookAt(url: string): Promise<string> {
  const page = await fetchPage(url);
  if ('error' in page) return `(could not fetch: ${page.error})`;
  const head = page.text.trimStart().slice(0, 40).toLowerCase();
  const sample = (t: string) => t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]').slice(0, 2500);
  if (/json/.test(page.contentType) || /^[{[]/.test(head)) return `JSON response (start):\n${sample(page.text)}`;
  if (/xml/.test(page.contentType) || /^<\?xml|^<rss|^<feed/.test(head)) return `XML/feed response (start):\n${sample(page.text)}`;
  const o = await outlineOffscreen(page.text);
  return `HTML page. Text sample: ${o.text}\nStructure:\n${o.outline}`;
}

async function handle(msg: DashMessage, enqueue: <T>(j: () => Promise<T>) => Promise<T>): Promise<Record<string, unknown>> {
  switch (msg.op) {
    case 'create': {
      if ((await store.listDashboards()).length >= 30) throw new Error('You have reached the limit of 30 dashboards.');
      const d = newDashboard(newId('dash'), String(msg.name || 'Untitled dashboard').slice(0, 60));
      await store.saveDashboard(d);
      return { dashboard: d };
    }
    case 'save': {
      const existing = await store.getDashboard(String(msg.dashboard?.id));
      if (!existing) throw new Error('That dashboard no longer exists.');
      const v = validateCode(msg.dashboard, existing);
      if (!v.ok) throw new Error(v.errors.join('; '));
      // The approval is never taken from the page: only the approve operation grants it.
      const saved: Dashboard = { ...existing, ...v.value, name: v.value.name ?? existing.name, paused: msg.dashboard.paused === true, updatedAt: Date.now() };
      await store.saveDashboard(saved);
      if (!approvalCovers(saved.approval, saved) && saved.collect.trim()) await store.patchState(saved.id, (s) => ({ ...(s ?? { dashboardId: saved.id, consecutiveFailures: 0, nextCheckAt: Date.now() }), status: 'needs-approval' }));
      return { dashboard: saved };
    }
    case 'duplicate':
      return { dashboard: await store.duplicateDashboard(String(msg.id)) };
    case 'delete':
      await store.deleteDashboard(String(msg.id));
      return {};
    case 'setPaused': {
      const d = await store.getDashboard(String(msg.id));
      if (!d) throw new Error('Dashboard not found.');
      await store.saveDashboard({ ...d, paused: !!msg.paused, updatedAt: Date.now() });
      return {};
    }
    case 'setGlobalPaused':
      await store.setSettings({ paused: !!msg.paused });
      return {};
    case 'approve': {
      const d = await store.getDashboard(String(msg.id));
      if (!d) throw new Error('Dashboard not found.');
      let next = d;
      if (msg.intervalMinutes !== undefined || msg.backgroundTabs !== undefined) {
        const v = validateCode({ ...d, intervalMinutes: msg.intervalMinutes ?? d.intervalMinutes, backgroundTabs: msg.backgroundTabs ?? d.backgroundTabs }, d);
        if (!v.ok) throw new Error(v.errors.join('; '));
        next = { ...d, intervalMinutes: v.value.intervalMinutes, backgroundTabs: v.value.backgroundTabs };
      }
      next = { ...next, approval: approvalFor(next), updatedAt: Date.now() };
      await store.saveDashboard(next);
      await store.putState({ dashboardId: next.id, status: 'idle', nextCheckAt: Date.now(), consecutiveFailures: 0 });
      // Refresh immediately, in the background; the page watches storage for the result.
      void withKeepAlive(() => refresh([next.id], schedulerDeps)).catch(() => undefined);
      return { dashboard: next };
    }
    case 'revoke': {
      const d = await store.getDashboard(String(msg.id));
      if (d) await store.saveDashboard({ ...d, approval: null, updatedAt: Date.now() });
      await store.patchState(String(msg.id), (s) => (s ? { ...s, status: 'needs-approval', nextCheckAt: 8.64e15 } : s));
      return {};
    }
    case 'pauseCollect': {
      const id = String(msg.id);
      await store.patchState(id, (s) => ({ ...(s ?? { dashboardId: id, consecutiveFailures: 0, nextCheckAt: Date.now() }), ...(msg.paused ? { status: 'paused' as const } : { status: 'idle' as const, nextCheckAt: Date.now(), backoffUntil: undefined }) }));
      if (!msg.paused) void withKeepAlive(() => refresh([id], schedulerDeps)).catch(() => undefined);
      return {};
    }
    case 'clearData':
      await store.clearData(String(msg.id));
      return {};
    case 'refresh': {
      const ids: string[] = msg.all ? (await store.listDashboards()).map((d) => d.id) : [String(msg.id)];
      return { results: await withKeepAlive(() => refresh(ids, schedulerDeps)) };
    }
    case 'open':
      // Cached data is already on screen (the page reads storage); refresh only if stale, in the background.
      void withKeepAlive(() => refreshStaleFor(String(msg.id), schedulerDeps)).catch(() => undefined);
      return {};
    case 'kvSet':
      await store.setKV(String(msg.id), String(msg.key).slice(0, 80), msg.value);
      return {};
    case 'chat': {
      const id = String(msg.id);
      const [d, settings] = await Promise.all([store.getDashboard(id), getAppSettings()]);
      if (!d) throw new Error('Dashboard not found.');
      const provider = providerOf(settings.model);
      const apiKey = provider === 'anthropic' ? settings.apiKey : settings.openaiKey;
      if (!apiKey) throw new Error(`Add your ${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key in WhimsyWeb settings to use the assistant.`);
      const history: ChatTurn[] = (await chrome.storage.local.get(store.K.chat(id)))[store.K.chat(id)] ?? [];
      const errors = Array.isArray(msg.errors) ? msg.errors.map((e: unknown) => String(e).slice(0, 300)).slice(0, 6) : [];
      const state = await store.getState(id);
      // The assistant may look at any public page itself (up to 3 rounds): it asks via "inspect", we fetch without cookies
      // and show it the structure and a short text sample, then it answers again. Collected data is never part of this.
      const outlines: { url: string; text: string }[] = [];
      const looked: string[] = [];
      let raw!: Awaited<ReturnType<typeof propose>>['raw'];
      for (let round = 0; round < 4; round++) {
        raw = (await withKeepAlive(() => propose({ apiKey, model: settings.model, history, prompt: String(msg.prompt ?? ''), dashboard: d, state, errors, outlines }))).raw;
        await enqueue(() => addUsage(provider, settings.model, raw.usage)).catch(() => undefined);
        const urls = inspectList(raw.toolInput).filter((u) => !looked.includes(u));
        if (!urls.length || round === 3) break;
        for (const u of urls) {
          looked.push(u);
          outlines.push({ url: u, text: await withKeepAlive(() => lookAt(u)) });
        }
      }
      const applied = applyProposal(raw.toolInput, d);
      if (applied.changed) await store.saveDashboard(applied.dashboard);
      if (applied.changed && applied.dashboard.collect.trim() && !approvalCovers(applied.dashboard.approval, applied.dashboard)) {
        await store.patchState(id, (s) => ({ ...(s ?? { dashboardId: id, consecutiveFailures: 0, nextCheckAt: Date.now() }), status: 'needs-approval' }));
      } else if (applied.changed && applied.dashboard.collect.trim()) {
        void withKeepAlive(() => refresh([id], schedulerDeps)).catch(() => undefined);
      }
      const turns: ChatTurn[] = [...history, { role: 'user', text: String(msg.prompt ?? '').slice(0, 2000), at: Date.now() }, { role: 'assistant', text: applied.reply || (applied.changed ? 'Updated the dashboard.' : 'No changes.'), notes: [...(looked.length ? [`Looked at: ${looked.join(", ")}`] : []), ...applied.problems], at: Date.now() }].slice(-40) as ChatTurn[];
      await chrome.storage.local.set({ [store.K.chat(id)]: turns });
      return { reply: applied.reply, problems: applied.problems, changed: applied.changed, needsApproval: applied.needsApproval, previous: d, truncated: raw.truncated };
    }
    case 'clearChat':
      await chrome.storage.local.remove(store.K.chat(String(msg.id)));
      return {};
    default:
      throw new Error(`Unknown dashboard operation "${String(msg.op)}".`);
  }
}
