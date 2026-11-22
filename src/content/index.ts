import { GLOBAL_HOST, appliesOn, layerOf } from '../shared/scope';
import { getDesignsForHost, normalizePrefs, PREFS_KEY, siteKey } from '../shared/storage';
import type { ContentMessage, ContentState, Design } from '../shared/types';
import { activate, activeIds, appliedInDom, deactivate, hasActive, refresh, activeVersions } from './apply';
import { clearContrast, getContrastStats, runContrast } from './contrast';
import { dedupeBorders, getThemeStats, noteAddedNodes, startTheme, stopTheme } from './theme';
import { extractPageContext } from './extract';
import { begin as previewBegin, end as previewEnd } from './preview';
import { cancelSnip, snip } from './snip';
import { loadArt } from './art';
import { hasEdits, render as renderEdits, setAppliedEdits } from './editLayer';
import { startEditor } from './editor';

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

// ---- readable text: after a design is applied, nudge unreadable text colours (no AI). Needs the preference on.
let contrastOn = true;
let themeOn = true;
let shownDesigns: Design[] = [];
let contrastTimer: number | undefined;
let lastContrast = 0;
const MIN_CONTRAST_GAP_MS = 1500;
/** The page after a design is applied: first the colours the site adds are put on the theme, doubled borders are drawn once, then text readability. */
let polishing = false;
let followUpDone = false;
async function polish(): Promise<void> {
  if (polishing) return;
  polishing = true;
  try {
    const on = !original && hasActive() && shownDesigns.length > 0;
    if (on && themeOn) {
      await startTheme(shownDesigns);
      await dedupeBorders();
    } else stopTheme();
    if (on && contrastOn) {
      await runContrast({ apply: true });
      // fonts, images and late layout can still change what is behind the text: look once more a moment later
      if (!followUpDone) {
        followUpDone = true;
        window.setTimeout(() => void (contrastOn && !original && hasActive() && runContrast({ apply: true })), 1500);
      }
    } else clearContrast();
  } finally {
    polishing = false;
  }
}
/** Pages that change all the time (feeds, players, ads) are re-checked at most this often. */
const CHURN_GAP_MS = 5000;
function scheduleContrast(churn = false): void {
  if (churn && contrastTimer !== undefined) return; // a check is already coming
  window.clearTimeout(contrastTimer);
  const wait = churn ? Math.max(1000, CHURN_GAP_MS - (Date.now() - lastContrast)) : Math.max(300, MIN_CONTRAST_GAP_MS - (Date.now() - lastContrast));
  contrastTimer = window.setTimeout(() => {
    contrastTimer = undefined;
    lastContrast = Date.now();
    void polish();
  }, wait);
}
chrome.storage.local.get(PREFS_KEY).then((r) => {
  const p = normalizePrefs(r[PREFS_KEY]);
  contrastOn = p.contrastFix;
  themeOn = p.themeFix;
  scheduleContrast();
}).catch(() => undefined);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[PREFS_KEY]) {
    const p = normalizePrefs(changes[PREFS_KEY].newValue);
    contrastOn = p.contrastFix;
    themeOn = p.themeFix;
    scheduleContrast();
  }
});

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
  await loadArt(applicable); // generated pictures the designs refer to, read before they are built
  for (const d of applicable) activate(d, layerOf(d));
  // the visual editor's edits sit on top of the designs
  setAppliedEdits(applicable);
  shownDesigns = applicable;
  followUpDone = false;
  scheduleContrast();
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
const ownMutation = (records: MutationRecord[]): boolean =>
  records.every((r) => {
    const t = r.target as Node;
    const el = t.nodeType === Node.ELEMENT_NODE ? (t as Element) : t.parentElement;
    if (el?.closest('#ww-contrast-style, #ww-edits-style, #ww-editor-cursor, ww-editor')) return true;
    return r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every((n) => ['ww-contrast-style', 'ww-edits-style', 'ww-editor-cursor'].includes((n as Element).id) || (n as Element).tagName === 'WW-EDITOR');
  });
const schedule = (records: MutationRecord[] = []) => {
  if (records.length && ownMutation(records)) return;
  if (records.length && themeOn && hasActive()) noteAddedNodes(records);
  checkNavigation();
  if (hasActive()) scheduleContrast(true);
  if (scheduled || (!hasActive() && !hasEdits())) return;
  scheduled = true;
  window.setTimeout(() => {
    scheduled = false;
    refresh();
    // elements the site added or re-rendered get their edits again (an edit never goes to a different element)
    if (hasEdits()) renderEdits();
  }, 250);
};
const observer = new MutationObserver(schedule);
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
  attributeFilter: ['class', 'open', 'hidden', 'aria-expanded', 'aria-hidden'],
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
    case 'ww:previewBegin': {
      const metrics = previewBegin();
      // Let the browser paint the skeleton before the worker captures the screen.
      requestAnimationFrame(() => requestAnimationFrame(() => sendResponse(metrics)));
      return true; // async response
    }
    case 'ww:snip':
      void snip().then(sendResponse);
      return true; // async response
    case 'ww:snipCancel':
      cancelSnip();
      sendResponse(true);
      return;
    case 'ww:previewEnd':
      previewEnd();
      sendResponse(true);
      return;
    case 'ww:getState': {
      const state: ContentState = { host, original, appliedIds: activeIds(), versions: activeVersions(), applied: appliedInDom(), contrast: getContrastStats(), theme: getThemeStats() };
      sendResponse(state);
      return;
    }
  }
});

// Edit Mode: the side panel opens a port to this tab; closing it ends Edit Mode.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ww-editor' || port.sender?.id !== chrome.runtime.id) return;
  startEditor(port);
});
