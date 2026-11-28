import { GLOBAL_HOST, appliesOn, layerOf, normalizePath } from '../shared/scope';
import { getDesignsForHost, normalizePrefs, PREFS_KEY, siteKey } from '../shared/storage';
import type { ContentMessage, ContentState, Design } from '../shared/types';
import { activate, activeIds, appliedInDom, deactivate, hasActive, refresh, activeVersions, refreshMediaInheritance } from './apply';
import { clearContrast, getContrastReviewTargets, getContrastStats, remeasureContrast, runContrast } from './contrast';
import { dedupeBorders, getThemeStats, noteAddedNodes, pauseThemeRepairs, resumeThemeRepairs, startTheme, stopTheme } from './theme';
import { extractPageContext } from './extract';
import { begin as previewBegin, end as previewEnd } from './preview';
import { cancelSnip, snip } from './snip';
import { loadArt } from './art';
import { hasEdits, render as renderEdits, setAppliedEdits } from './editLayer';
import { startEditor, stopEditor } from './editor';
import { MEDIA_BOUNDARY, recogniseMediaPlayers, setMediaRepairBoundary } from './media';

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
let readabilityKey = '';
let contrastTimer: number | undefined;
let changedTimer: number | undefined;
let changedRunning = false;
let fullPending = false;
let removedNodes = false;
const changedRoots = new Set<Element>();
const MAX_CHANGED_ROOTS = 32;
const MAX_DEFERRED_ROOTS = 128;
let visibilityEpoch = 0;
let deferredRefresh = false;
let deferredMedia = false;
const canWork = (epoch: number): boolean => !document.hidden && epoch === visibilityEpoch;

// ---- one copy per page. After an install or update, the extension attaches a fresh copy of this script to tabs that
// were already open. The old copy can no longer reach the extension, so the new one tells it to stand down, and
// clears what an older copy without this handshake left behind, before applying anything (a theme is never drawn twice).
const TAKEOVER = 'whimsyweb:takeover';
let retired = false;
document.dispatchEvent(new (document.defaultView?.Event ?? Event)(TAKEOVER));
const LEFTOVERS = 'style[data-ww-rank], #ww-media-inheritance, #ww-shared-contrast, #ww-contrast-style, #ww-edits-style, [data-ww]:not([data-ww="editor"])';
document.querySelectorAll(LEFTOVERS).forEach((el) => el.remove());

/** The page after a design is applied: first the colours the site adds are put on the theme, doubled borders are drawn once, then text readability. */
let polishing = false;
async function polish(): Promise<void> {
  if (polishing || document.hidden) return;
  polishing = true;
  fullPending = false;
  changedRoots.clear();
  removedNodes = false;
  try {
    const measuredKey = readabilityKey;
    const epoch = visibilityEpoch;
    const canRun = () => canWork(epoch) && measuredKey === readabilityKey && !fullPending;
    const designs = shownDesigns;
    const on = !original && hasActive() && shownDesigns.length > 0;
    if (on && themeOn) {
      await startTheme(designs);
      if (!canRun()) return;
      await dedupeBorders(canRun);
    } else stopTheme();
    if (!canRun()) return;
    if (on && contrastOn) await runContrast({ apply: true, canRun });
    else clearContrast();
  } finally {
    polishing = false;
    if (fullPending && contrastTimer === undefined) scheduleContrast();
    else scheduleChangedContrast();
  }
}
function scheduleContrast(): void {
  fullPending = true;
  window.clearTimeout(contrastTimer);
  window.clearTimeout(changedTimer);
  contrastTimer = changedTimer = undefined;
  if (document.hidden) return;
  contrastTimer = window.setTimeout(() => {
    const timer = contrastTimer;
    const run = () => {
      if (contrastTimer !== timer) return;
      contrastTimer = undefined;
      void polish();
    };
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1500 });
    else run();
  }, 300);
}

function scheduleChangedContrast(): void {
  if (!contrastOn || original || !hasActive() || document.hidden || fullPending || polishing || changedRunning || changedTimer !== undefined) return;
  if (!changedRoots.size && !removedNodes) return;
  changedTimer = window.setTimeout(() => {
    changedTimer = undefined;
    if (document.hidden || fullPending) return;
    if (!contrastOn || original || !hasActive()) {
      changedRoots.clear();
      removedNodes = false;
      return;
    }
    const batch = [...changedRoots].slice(0, MAX_CHANGED_ROOTS);
    for (const root of batch) changedRoots.delete(root);
    const roots = batch.filter((root) => !batch.some((other) => root !== other && other.contains(root)));
    const removed = removedNodes;
    removedNodes = false;
    changedRunning = true;
    const epoch = visibilityEpoch;
    void runContrast({ apply: true, roots, removed, canRun: () => canWork(epoch) && !fullPending }).finally(() => {
      changedRunning = false;
      if (epoch !== visibilityEpoch && !fullPending && contrastOn && !original && hasActive()) {
        for (const root of roots) rememberChangedRoot(root);
        removedNodes ||= removed;
      }
      scheduleChangedContrast();
    });
  }, 350);
}
chrome.storage.local.get(PREFS_KEY).then((r) => {
  const p = normalizePrefs(r[PREFS_KEY]);
  const changed = contrastOn !== p.contrastFix || themeOn !== p.themeFix;
  contrastOn = p.contrastFix;
  themeOn = p.themeFix;
  if (changed && hasActive()) scheduleContrast();
}).catch(() => undefined);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[PREFS_KEY]) {
    const p = normalizePrefs(changes[PREFS_KEY].newValue);
    contrastOn = p.contrastFix;
    themeOn = p.themeFix;
    if (original || !hasActive()) return;
    if (!contrastOn) clearContrast();
    else remeasureContrast();
    if (!themeOn) stopTheme();
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
  const wantKey = applicable.map((d) => `${d.id}@${d.updatedAt}:${d.intensity ?? ''}`).join('|');
  const nextReadabilityKey = applicable.map((d) => `${d.id}@${d.updatedAt}:${d.intensity ?? ''}#${d.editsUpdatedAt ?? 0}`).join('|');
  const changed = nextReadabilityKey !== readabilityKey;
  // A scan for the previous design must not write after this swap. Keep its marks until the new scan is ready.
  if (changed) remeasureContrast();
  const layersChanged = wantKey !== appliedKey;
  if (layersChanged) {
    for (const id of [...activeIds()].reverse()) deactivate(id);
    appliedKey = wantKey;
  }
  await loadArt(applicable); // generated pictures the designs refer to, read before they are built
  if (layersChanged && applicable.length) recogniseMediaPlayers();
  for (const d of applicable) activate(d, layerOf(d));
  setMediaRepairBoundary(applicable.length ? MEDIA_BOUNDARY : '');
  if (layersChanged) {
    if (document.hidden && applicable.length) deferredMedia = true;
    else {
      deferredMedia = false;
      refreshMediaInheritance();
    }
  }
  // the visual editor's edits sit on top of the designs
  setAppliedEdits(applicable);
  shownDesigns = applicable;
  if (changed) {
    readabilityKey = nextReadabilityKey;
    if (applicable.length) scheduleContrast();
    else {
      stopTheme();
      clearContrast();
      changedRoots.clear();
      removedNodes = false;
      fullPending = false;
      window.clearTimeout(contrastTimer);
      window.clearTimeout(changedTimer);
      contrastTimer = changedTimer = undefined;
    }
  }
}

function queueSync(): void {
  if (retired) return;
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
const ownMutation = (r: MutationRecord): boolean => {
  const t = r.target;
  const el = t.nodeType === Node.ELEMENT_NODE ? (t as Element) : t.parentElement;
  if (el?.closest('style, #ww-editor-cursor, ww-editor')) return true;
  // a design's own <style> taken off the page is not ignored: refresh() has to put it back
  if (r.type === 'childList' && [...r.removedNodes].some((n) => n.nodeType === Node.ELEMENT_NODE && (n as Element).matches('style[data-whimsyweb]'))) return false;
  return r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every((n) => ['STYLE', 'WW-EDITOR'].includes((n as Element).tagName) || (n as Element).id === 'ww-editor-cursor');
};

function rememberChangedRoot(el: Element): void {
  if (fullPending || !el.isConnected || changedRoots.has(el)) return;
  if (document.hidden && changedRoots.size >= MAX_DEFERRED_ROOTS) {
    // An endlessly changing background tab retains a single catch-up request instead of old nodes.
    changedRoots.clear();
    scheduleContrast();
  } else changedRoots.add(el);
}

function queueChangedText(records: MutationRecord[]): void {
  if ((!contrastOn && !(document.hidden && themeOn)) || original || !hasActive() || fullPending) return;
  for (const r of records) {
    if (fullPending) break;
    if (r.type === 'childList') {
      for (const node of r.addedNodes) {
        if (fullPending) break;
        const el = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.nodeType === Node.TEXT_NODE ? node.parentElement : null;
        if (el && !el.matches('style,script,link,meta,ww-editor')) rememberChangedRoot(el);
      }
      removedNodes ||= r.removedNodes.length > 0;
      if ([...r.removedNodes].some((node) => node.nodeType === Node.TEXT_NODE) && r.target.nodeType === Node.ELEMENT_NODE) rememberChangedRoot(r.target as Element);
    } else if (r.type === 'characterData' && r.target.parentElement) {
      rememberChangedRoot(r.target.parentElement);
    } else if (r.attributeName === 'open' || r.attributeName === 'hidden' || r.attributeName === 'aria-hidden') {
      rememberChangedRoot(r.target as Element);
    } else if (document.hidden && (r.attributeName === 'class' || r.attributeName === 'style')) {
      rememberChangedRoot(r.target as Element);
    } else if (r.attributeName === 'aria-expanded') {
      const control = r.target as Element;
      rememberChangedRoot(control);
      for (const id of (control.getAttribute('aria-controls') ?? '').split(/\s+/)) {
        const panel = id && document.getElementById(id);
        if (panel) rememberChangedRoot(panel);
      }
    }
  }
  scheduleChangedContrast();
}

document.addEventListener('input', (event) => {
  const target = event.target;
  if (!contrastOn || original || !hasActive() || !(target instanceof Element) || !target.matches('input, textarea, select')) return;
  rememberChangedRoot(target);
  scheduleChangedContrast();
}, { capture: true, passive: true });

function refreshPage(): void {
  refresh();
  if (hasEdits()) renderEdits();
}

document.addEventListener('visibilitychange', () => {
  visibilityEpoch++;
  if (document.hidden) {
    if (polishing) fullPending = true;
    window.clearTimeout(contrastTimer);
    window.clearTimeout(changedTimer);
    contrastTimer = changedTimer = undefined;
    pauseThemeRepairs();
    return;
  }
  checkNavigation();
  if (deferredMedia) {
    deferredMedia = false;
    refreshMediaInheritance();
  }
  if (deferredRefresh) {
    deferredRefresh = false;
    refreshPage();
  }
  if (themeOn) resumeThemeRepairs(fullPending ? [] : [...changedRoots]);
  if (fullPending) scheduleContrast();
  else scheduleChangedContrast();
  if (!contrastOn) {
    changedRoots.clear();
    removedNodes = false;
  }
});

// A stylesheet can change the colours of existing text anywhere on the page.
document.addEventListener('load', (event) => {
  if (original || !hasActive() || (!themeOn && !contrastOn)) return;
  if (!(event.target instanceof Element) || !event.target.matches('link[rel~="stylesheet"]')) return;
  remeasureContrast();
  scheduleContrast();
}, { capture: true, passive: true });

const schedule = (records: MutationRecord[] = []) => {
  if (retired) return;
  checkNavigation();
  if (!hasActive() && !hasEdits()) return;
  if (document.hidden && fullPending && deferredRefresh && deferredMedia) return;
  const changes = records.filter((record) => !ownMutation(record));
  if (records.length && !changes.length) return;
  if (document.hidden) {
    deferredRefresh = true;
    deferredMedia ||= changes.some((record) => record.addedNodes.length > 0 || record.attributeName === 'controls');
    queueChangedText(changes);
    return;
  }
  if (changes.length && themeOn && hasActive()) noteAddedNodes(changes);
  const added = changes.flatMap((r) => r.attributeName === 'controls'
    ? [r.target as Element]
    : [...r.addedNodes].filter((node): node is Element => node.nodeType === Node.ELEMENT_NODE));
  if (added.length && hasActive()) refreshMediaInheritance(added);
  queueChangedText(changes);
  if (scheduled) return;
  scheduled = true;
  window.setTimeout(() => {
    scheduled = false;
    if (document.hidden) deferredRefresh = true;
    else refreshPage();
  }, 250);
};
const observer = new MutationObserver(schedule);
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
  attributeFilter: ['class', 'style', 'open', 'hidden', 'aria-expanded', 'aria-hidden', 'controls'],
});

// A newer copy of this script arrived (see TAKEOVER above): take everything this copy drew off the page and go quiet.
document.addEventListener(TAKEOVER, () => {
  if (retired) return;
  retired = true;
  observer.disconnect();
  window.clearTimeout(contrastTimer);
  window.clearTimeout(changedTimer);
  try {
    // Edit Mode too: its guards, overlay and observer go, and its port closes so the panel sees Edit Mode end
    stopEditor();
  } catch {
    /* already stopped */
  }
  try {
    for (const id of [...activeIds()].reverse()) deactivate(id);
    setAppliedEdits([]);
    stopTheme();
    clearContrast();
  } catch {
    /* the new copy removes what is left */
  }
});

document.addEventListener('DOMContentLoaded', () => {
  if (retired) return;
  if (document.hidden) deferredRefresh ||= hasActive();
  else refresh();
});
// Single-page apps change the URL without a page load.
window.addEventListener('popstate', checkNavigation);
(window as unknown as { navigation?: EventTarget }).navigation?.addEventListener('navigatesuccess', checkNavigation);
// Restored from the back/forward cache: nothing re-runs, so re-sync explicitly.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) queueSync();
});

chrome.runtime.onMessage.addListener((msg: ContentMessage, sender, sendResponse) => {
  if (retired || sender.id !== chrome.runtime.id) return;
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
    case 'ww:contrastReview':
      sendResponse(!original && !document.hidden && normalizePath(location.pathname) === msg.path && activeVersions()[msg.designId] === msg.version ? getContrastReviewTargets() : []);
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
  // a retired copy never takes Edit Mode: only the newest copy of this script answers
  if (retired || port.name !== 'ww-editor' || port.sender?.id !== chrome.runtime.id) return;
  startEditor(port);
});
