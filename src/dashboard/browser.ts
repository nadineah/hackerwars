import type { CollectRequest } from '../shared/types';
import type { RenderResult } from './bridge';
import { RENDER_TIMEOUT_MS } from './schema';
import { sameSiteHost } from './util';

/** Browser-API glue for the worker: the offscreen document (which runs collect scripts) and the rendered-page (tab) reader. */

// ------------------------------------------------------------------------------------------ offscreen document
let creating: Promise<void> | null = null;
async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL('offscreen.html');
  const ctxs = await (chrome.runtime as any).getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (ctxs?.length) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({ url: 'offscreen.html', reasons: [chrome.offscreen.Reason.IFRAME_SCRIPTING, chrome.offscreen.Reason.DOM_PARSER], justification: 'Run dashboard collect scripts inside a sandboxed frame while no dashboard page is open.' })
      .catch((e: Error) => {
        if (!/single offscreen|already exists/i.test(e.message)) throw e;
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

export interface CollectJob {
  code: string;
  dashboardId: string;
  domains: string[];
  backgroundTabs: boolean;
}
export type CollectAnswer = { ok: true; value: unknown; bytes: number } | { ok: false; error: string; code?: string };

/** Asks the offscreen document to run a collect script. */
export async function runCollectOffscreen(job: CollectJob): Promise<CollectAnswer> {
  await ensureOffscreen();
  const res = (await chrome.runtime.sendMessage({ target: 'ww-offscreen', op: 'collect', ...job })) as CollectAnswer | undefined;
  return res ?? { ok: false, error: 'The collector did not answer.', code: 'no-answer' };
}

// ------------------------------------------------------------------------------------------ rendered pages
const TABS_KEY = 'dcollectTabs'; // ids of tabs the COLLECTOR created: the only tabs it may ever close

async function rememberTab(id: number, add: boolean) {
  const cur = ((await chrome.storage.session.get(TABS_KEY))[TABS_KEY] as number[] | undefined) ?? [];
  const next = add ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
  await chrome.storage.session.set({ [TABS_KEY]: next });
}

/** Closes collector tabs left behind if the worker died mid-collection. Never touches any other tab. */
export async function closeOrphanTabs(): Promise<number> {
  const ids = ((await chrome.storage.session.get(TABS_KEY))[TABS_KEY] as number[] | undefined) ?? [];
  let closed = 0;
  for (const id of ids) {
    try {
      await chrome.tabs.remove(id);
      closed++;
    } catch {
      /* already gone */
    }
  }
  await chrome.storage.session.set({ [TABS_KEY]: [] });
  return closed;
}

let tabChain: Promise<unknown> = Promise.resolve();
/** Only ONE managed tab at a time, so background collection can never flood the user's browser. */
const oneTab = <T>(job: () => Promise<T>): Promise<T> => {
  const run = tabChain.then(job, job);
  tabChain = run.catch(() => undefined);
  return run;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const canon = (u: string): string => {
  try {
    const x = new URL(u);
    x.hash = '';
    return x.toString();
  } catch {
    return u;
  }
};

async function ask(tabId: number, req: CollectRequest, tries: number): Promise<RenderResult | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = (await chrome.tabs.sendMessage(tabId, { type: 'ww:collect', ...req })) as RenderResult | undefined;
      if (r) return r;
    } catch {
      /* content script not ready yet */
    }
    await sleep(600);
  }
  return null;
}

function waitComplete(tabId: number, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(t);
      resolve(v);
    };
    const listener = (id: number, info: { status?: string }) => id === tabId && info.status === 'complete' && done(true);
    const t = setTimeout(() => done(false), ms);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => tab.status === 'complete' && done(true), () => done(false));
  });
}

/**
 * Returns a page's HTML after its scripts ran. Order of preference:
 *  1. a tab the USER already has open on exactly this page (read only; never navigated, reloaded or closed);
 *  2. one inactive collector-created tab (only if the caller was approved for background tabs): bounded wait,
 *     content-script read, then closed. Only tabs the collector created are ever closed.
 */
export async function renderPage(url: string, opts: { waitFor?: string; waitMs: number; allowNewTab: boolean }): Promise<RenderResult> {
  const req: CollectRequest = { url, waitFor: opts.waitFor, waitMs: opts.waitMs };
  const want = canon(url);
  const deadline = Date.now() + RENDER_TIMEOUT_MS;

  const existing = (await chrome.tabs.query({})).find((t) => t.id !== undefined && t.status === 'complete' && !t.discarded && t.url && canon(t.url) === want);
  if (existing?.id !== undefined) {
    const r = await ask(existing.id, req, 1);
    if (r) return r;
  }
  if (!opts.allowNewTab) return { ok: false, error: 'Open this page in a tab, or allow background tabs for this dashboard so it can update on its own.' };

  return oneTab(async () => {
    let tabId: number | undefined;
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id;
      if (tabId === undefined) return { ok: false, error: 'Could not open a background tab.' };
      await rememberTab(tabId, true);
      if (!(await waitComplete(tabId, Math.max(1000, deadline - Date.now())))) return { ok: false, error: 'The page did not finish loading in time.' };
      const now = await chrome.tabs.get(tabId);
      if (!now.url || !sameSiteHost(new URL(now.url).hostname, new URL(url).hostname)) return { ok: false, error: 'The page redirected to a different site.', finalUrl: now.url };
      const r = await ask(tabId, req, 3);
      return r ?? { ok: false, error: 'The page could not be read (it may be blocking extensions).' };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 120) };
    } finally {
      if (tabId !== undefined) {
        await chrome.tabs.remove(tabId).catch(() => undefined);
        await rememberTab(tabId, false).catch(() => undefined);
      }
    }
  });
}

/** Builds a structure outline of downloaded HTML (the worker has no DOM, so the offscreen document does it). */
export async function outlineOffscreen(html: string): Promise<string> {
  await ensureOffscreen();
  const res = (await chrome.runtime.sendMessage({ target: 'ww-offscreen', op: 'outline', html })) as { outline?: string } | undefined;
  return res?.outline ?? '';
}
