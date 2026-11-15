import type { CollectRequest } from '../shared/types';
import type { ParseRequest, ParseResponse, RenderedResult } from './collect';
import { KINDS, effectiveMethod, type HtmlConfig, type PageChangeConfig, type RenderedConfig, type Source } from './schema';
import { canonicalUrl, sameSiteHost } from './util';

/** Browser-API glue for the collectors: the offscreen parser and the rendered-page (tab) collector. */

// ------------------------------------------------------------------------------------------ offscreen parser
let creating: Promise<void> | null = null;
async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL('offscreen.html');
  const ctxs = await (chrome.runtime as any).getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (ctxs?.length) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({ url: 'offscreen.html', reasons: [chrome.offscreen.Reason.DOM_PARSER], justification: 'Parse downloaded feeds and pages into plain data in an inert document.' })
      .catch((e: Error) => {
        if (!/single offscreen|already exists/i.test(e.message)) throw e;
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}
export async function parseOffscreen(req: ParseRequest): Promise<ParseResponse> {
  await ensureOffscreen();
  const res = (await chrome.runtime.sendMessage({ target: 'ww-offscreen', req })) as ParseResponse | undefined;
  return res ?? { ok: false, error: 'The parser did not answer.' };
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

function requestFor(src: Source): CollectRequest {
  if (src.kind === 'page-change') {
    const c = src.config as PageChangeConfig;
    return { kind: 'page-change', url: src.url, selector: c.selector, waitMs: c.waitMs };
  }
  const c = src.config as RenderedConfig | HtmlConfig;
  return { kind: 'rendered', url: src.url, selector: c.itemSelector, waitFor: (c as RenderedConfig).waitFor, waitMs: (c as RenderedConfig).waitMs ?? 8000, config: c };
}

async function ask(tabId: number, req: CollectRequest, tries: number): Promise<RenderedResult | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = (await chrome.tabs.sendMessage(tabId, { type: 'ww:collect', ...req })) as RenderedResult | undefined;
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
 * Collects from a rendered page. Order of preference:
 *  1. a tab the USER already has open on exactly this page (read only; it is never navigated, reloaded or closed);
 *  2. if the user allowed background tabs for this source: one inactive collector-created tab, bounded wait,
 *     content-script extraction, then closed. Only tabs the collector created are ever closed.
 */
export async function collectRendered(src: Source): Promise<RenderedResult> {
  if (effectiveMethod(src.kind, src.config) !== 'rendered') return { ok: false, error: 'Not a rendered source.' };
  const req = requestFor(src);
  const want = canonicalUrl(src.url);
  const deadline = Date.now() + KINDS.rendered.timeoutMs;

  const existing = (await chrome.tabs.query({})).find((t) => t.id !== undefined && t.status === 'complete' && !t.discarded && t.url && canonicalUrl(t.url) === want);
  if (existing?.id !== undefined) {
    const r = await ask(existing.id, req, 1);
    if (r) return r;
  }
  if (!src.backgroundTabs) return { ok: false, error: 'Open this page in a tab, or allow background tabs for this source so it can update on its own.' };

  return oneTab(async () => {
    let tabId: number | undefined;
    try {
      const tab = await chrome.tabs.create({ url: src.url, active: false });
      tabId = tab.id;
      if (tabId === undefined) return { ok: false, error: 'Could not open a background tab.' };
      await rememberTab(tabId, true);
      if (!(await waitComplete(tabId, Math.max(1000, deadline - Date.now())))) return { ok: false, error: 'The page did not finish loading in time.' };
      const now = await chrome.tabs.get(tabId);
      if (!now.url || !sameSiteHost(new URL(now.url).hostname, new URL(src.url).hostname)) return { ok: false, error: 'The page redirected to a different site.', finalUrl: now.url };
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
