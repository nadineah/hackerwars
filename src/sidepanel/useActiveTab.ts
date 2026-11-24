import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizePath } from '../shared/scope';
import { siteKey } from '../shared/storage';
import type { ContentState } from '../shared/types';

/**
 * The tab the panel is about, and what that page reports (is a design applied, before/after, how many colours were
 * corrected). Everything here guards against timing: a slow reply for a tab you already left is thrown away, so state
 * from one page never lands on another. Async work elsewhere checks `tabIdRef` / `hostRef` (the tab shown NOW) before
 * touching state.
 */

export interface TabInfo {
  id: number;
  host: string | null;
  /** The tab's address (used to explain why browser-owned pages cannot be restyled). */
  url: string;
  /** Normalized pathname of the page. */
  path: string;
}

export interface PageState {
  /** Whimsy Web's CSS/HTML is actually in the page right now. */
  applied: boolean;
  /** The before/after toggle shows the original site. */
  showOriginal: boolean;
  contrastFixed: number;
  themeAdjusted: number;
}

const NONE: PageState = { applied: false, showOriginal: false, contrastFixed: 0, themeAdjusted: 0 };

export async function readActiveTab(): Promise<TabInfo | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  let host: string | null = null;
  let path = '/';
  try {
    const u = new URL(tab.url ?? '');
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      host = u.hostname;
      path = normalizePath(u.pathname);
    }
  } catch {
    /* not a web page */
  }
  return { id: tab.id, host, path, url: tab.url ?? '' };
}

const fromState = (st: ContentState): PageState => ({
  applied: st.applied,
  showOriginal: st.original,
  contrastFixed: st.contrast?.fixed ?? 0,
  themeAdjusted: (st.theme?.rules ?? 0) + (st.theme?.borders ?? 0),
});

/** `onReachable` runs when the page answered (e.g. to clear a "reload this tab" message). */
export function useActiveTab(onReachable: () => void) {
  const [tab, setTab] = useState<TabInfo | null>(null);
  const [page, setPage] = useState<PageState>(NONE);
  const tabIdRef = useRef<number | null>(null);
  const hostRef = useRef<string | null>(null);
  /** Bumped by every lookup / page-state request; an older one finishing late is ignored. */
  const tabSeq = useRef(0);
  const stateSeq = useRef(0);
  const reachable = useRef(onReachable);
  reachable.current = onReachable;
  const host = tab?.host ?? null;
  hostRef.current = host;

  const refreshTab = useCallback(async () => {
    const tseq = ++tabSeq.current;
    const t = await readActiveTab();
    if (tseq !== tabSeq.current) return; // a newer lookup superseded this one
    setTab(t);
    tabIdRef.current = t?.id ?? null;
    const seq = ++stateSeq.current;
    let next = NONE;
    if (t?.host) {
      try {
        next = fromState(await chrome.tabs.sendMessage(t.id, { type: 'ww:getState' }));
      } catch {
        /* content script not attached (page needs a reload) */
      }
    }
    if (seq !== stateSeq.current || tabIdRef.current !== (t?.id ?? null)) return; // superseded or tab changed
    setPage(next);
  }, []);

  useEffect(() => {
    void refreshTab();
    const onActivated = () => void refreshTab();
    const onUpdated = (_id: number, info: chrome.tabs.TabChangeInfo) => {
      if (info.url || info.status === 'complete') void refreshTab();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [refreshTab]);

  // Keep the before/after button honest: ask the page what is really applied, whenever anything that could change it
  // happens, and every couple of seconds in case the page changes it itself.
  const refreshApplied = useCallback(async () => {
    const id = tab?.id ?? null;
    // A delayed callback created for an earlier tab must not touch the current tab's state.
    if (id !== tabIdRef.current) return;
    const seq = ++stateSeq.current;
    if (!tab?.id || !host) {
      setPage((p) => ({ ...p, applied: false }));
      return;
    }
    try {
      const st: ContentState = await chrome.tabs.sendMessage(tab.id, { type: 'ww:getState' });
      if (seq !== stateSeq.current || id !== tabIdRef.current) return; // the tab changed meanwhile
      setPage(fromState(st));
      reachable.current();
    } catch {
      if (seq === stateSeq.current) setPage((p) => ({ ...p, applied: false }));
    }
  }, [tab?.id, host]);

  useEffect(() => {
    void refreshApplied();
    const timer = window.setInterval(refreshApplied, 2000);
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && host && changes[siteKey(host)]) window.setTimeout(refreshApplied, 300);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      window.clearInterval(timer);
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, [refreshApplied, host]);

  /** The before/after toggle changed here (optimistically, until the page confirms). */
  const setShowOriginal = useCallback((showOriginal: boolean) => setPage((p) => ({ ...p, showOriginal })), []);

  return { tab, host, page, tabIdRef, hostRef, refreshApplied, setShowOriginal };
}
