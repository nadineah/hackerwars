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
  /** Still loading its page (the page script may not be there yet). */
  loading: boolean;
}

/**
 * Can Whimsy Web work on this tab?
 *  ok: the page script answers. never: Chrome's own pages, the Web Store, files: no extension may change them.
 *  reload: a website the page script could not be attached to (reloading the tab fixes it). pending: still checking.
 */
export type Reach = 'ok' | 'never' | 'reload' | 'pending';

/** Websites no extension may script, whatever we do. */
export function neverReachable(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    return u.hostname === 'chromewebstore.google.com' || (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore'));
  } catch {
    return true;
  }
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
  return { id: tab.id, host, path, url: tab.url ?? '', loading: tab.status === 'loading' };
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
  const [reach, setReach] = useState<Reach>('pending');
  const tabIdRef = useRef<number | null>(null);
  const hostRef = useRef<string | null>(null);
  /** Bumped by every lookup / page-state request; an older one finishing late is ignored. */
  const tabSeq = useRef(0);
  const stateSeq = useRef(0);
  /** The reachability check has its own counter: the page-state polls (every 2 s) must not cancel a slow attach. */
  const reachSeq = useRef(0);
  const reachRef = useRef<Reach>('pending');
  const reachable = useRef(onReachable);
  reachable.current = onReachable;
  const host = tab?.host ?? null;
  hostRef.current = host;

  const refreshTab = useCallback(async () => {
    const tseq = ++tabSeq.current;
    const t = await readActiveTab();
    if (tseq !== tabSeq.current) return; // a newer lookup superseded this one
    const changed = tabIdRef.current !== (t?.id ?? null);
    setTab(t);
    tabIdRef.current = t?.id ?? null;
    const seq = ++reachSeq.current;
    ++stateSeq.current; // any page-state answer still on its way is about the page before this lookup
    let next = NONE;
    let r: Reach = !t ? 'pending' : !t.host || neverReachable(t.url) ? 'never' : 'pending';
    // Another tab: forget what the last one reported straight away (never show its "reachable" for this one).
    if (changed || r === 'never') {
      setPage(NONE);
      reachRef.current = r;
      setReach(r);
    }
    if (t?.host && r === 'pending') {
      const ask = async () => fromState(await chrome.tabs.sendMessage(t.id, { type: 'ww:getState' }));
      try {
        next = await ask();
        r = 'ok';
      } catch {
        // No page script: a tab opened before the extension was installed or updated. Attach it (no reload needed).
        if (!t.loading) {
          const res = (await chrome.runtime.sendMessage({ type: 'ww:attach', tabId: t.id }).catch(() => undefined)) as { attached?: boolean } | undefined;
          if (res?.attached) {
            try {
              next = await ask();
              r = 'ok';
            } catch {
              r = 'reload';
            }
          } else r = 'reload';
        }
      }
    }
    if (seq !== reachSeq.current || tabIdRef.current !== (t?.id ?? null)) return; // a newer check, or another tab
    ++stateSeq.current; // this answer is newer than any poll still on its way
    setPage(next);
    reachRef.current = r;
    setReach(r);
    if (r === 'ok') reachable.current();
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
      reachRef.current = 'ok';
      setReach('ok');
      reachable.current();
    } catch {
      if (seq !== stateSeq.current || id !== tabIdRef.current) return;
      setPage((p) => ({ ...p, applied: false }));
      // The page stopped answering (its script was removed, or it went to a page we could not attach to): check
      // again, which attaches it or shows the reload notice. Only from "ok", so a tab already known to need a
      // reload is not re-attached every 2 seconds.
      if (reachRef.current === 'ok') {
        reachRef.current = 'pending';
        void refreshTab();
      }
    }
  }, [tab?.id, host, refreshTab]);

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

  return { tab, host, page, reach, tabIdRef, hostRef, refreshApplied, refreshTab, setShowOriginal };
}
