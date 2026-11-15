import { GLOBAL_HOST, appliesOn, layerOf } from '../shared/scope';
import { getDesignsForHost, siteKey } from '../shared/storage';
import type { ContentMessage, ContentState } from '../shared/types';
import { activate, activeIds, appliedInDom, deactivate, hasActive, refresh } from './apply';
import { handleCollect } from './collect';
import { extractPageContext } from './extract';

/**
 * The content script is a sync engine: whatever is enabled in storage for this
 * host is what is applied. Reapplying a saved design never calls the AI.
 * It reads only `site:<host>`, never settings or other sites.
 */
const host = location.hostname;
const key = siteKey(host);
let original = false; // before/after toggle: show the untouched site
let chain: Promise<void> = Promise.resolve();
let appliedKey = ''; // which designs (and versions) are currently applied

async function sync(): Promise<void> {
  // This site's designs plus the all-sites designs. Stacked bottom to top: all sites, whole site, page.
  // Re-evaluated on every navigation.
  const [siteDesigns, globalDesigns] = await Promise.all([getDesignsForHost(host), getDesignsForHost(GLOBAL_HOST)]);
  const applicable = original
    ? []
    : [...siteDesigns, ...globalDesigns]
        .filter((d) => d.enabled && appliesOn(d, host, location.pathname))
        .sort((a, b) => layerOf(a) - layerOf(b));
  // Designs can edit the same elements (a site design, then a page design on top), so each one's
  // undo snapshot depends on the layers beneath it. Whenever the set changes, unwind EVERYTHING in
  // reverse order and re-apply the wanted designs in order; otherwise turning off a lower layer
  // can resurrect its text after the layers above it are gone.
  const wantKey = applicable.map((d) => `${d.id}@${d.updatedAt}`).join('|');
  if (wantKey !== appliedKey) {
    for (const id of [...activeIds()].reverse()) deactivate(id);
    appliedKey = wantKey;
  }
  for (const d of applicable) activate(d, layerOf(d));
}

function queueSync(): void {
  chain = chain.then(sync).catch(() => undefined);
}

queueSync();

const globalKey = siteKey(GLOBAL_HOST);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[key] || changes[globalKey])) queueSync();
});

// SPAs: re-check on DOM changes. Throttled (not debounced) so a constantly-updating
// feed can't postpone recovery forever.
let scheduled = false;
let lastPath = location.pathname;
const checkNavigation = () => {
  if (location.pathname === lastPath) return;
  lastPath = location.pathname;
  queueSync(); // a page-scoped design may now apply (or stop applying)
};
const schedule = () => {
  checkNavigation();
  if (scheduled || !hasActive()) return;
  scheduled = true;
  window.setTimeout(() => {
    scheduled = false;
    refresh();
  }, 250);
};
const observer = new MutationObserver(schedule);
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
  attributeFilter: ['class'],
});

document.addEventListener('DOMContentLoaded', () => refresh());
// Single-page apps change the URL without a page load.
window.addEventListener('popstate', checkNavigation);
(window as unknown as { navigation?: EventTarget }).navigation?.addEventListener('navigatesuccess', checkNavigation);
// Restored from the back/forward cache: nothing re-runs, so re-sync explicitly.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) queueSync();
});

chrome.runtime.onMessage.addListener((msg: ContentMessage, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  switch (msg.type) {
    case 'ww:extract':
      sendResponse(extractPageContext());
      return;
    case 'ww:setOriginal':
      original = msg.original;
      queueSync();
      sendResponse(true);
      return;
    case 'ww:collect':
      handleCollect(msg).then(sendResponse);
      return true; // async response
    case 'ww:getState': {
      const state: ContentState = { host, original, appliedIds: activeIds(), applied: appliedInDom() };
      sendResponse(state);
      return;
    }
  }
});
