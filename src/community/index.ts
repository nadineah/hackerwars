import { getCommunityDesigns, installCommunityDesign, removeDesign } from '../shared/storage';
import type { ContentState, Design } from '../shared/types';
import { createDraft, decide, handleExternal, originsFromMatches, summary, windowClosed, type Deps, type Draft, type Req } from './external';
import type { ExportedDraft } from '../../theme-core/src';

declare const __WW_SITE_URL__: string;
/** Where "Share on the website" opens. Set at build time (WHIMSYWEB_SITE_URL); the same origin must be in externally_connectable. */
export const SITE_URL: string = typeof __WW_SITE_URL__ === 'string' ? __WW_SITE_URL__ : 'http://localhost:3000';

const REQ_KEY = 'wwCommunityReqs';
const DRAFT_KEY = 'wwCommunityDrafts';

export const productionDeps = (enqueue: <T>(job: () => Promise<T>) => Promise<T>): Deps => ({
  allowedOrigins: () => originsFromMatches(chrome.runtime.getManifest().externally_connectable?.matches),
  extensionVersion: () => chrome.runtime.getManifest().version,
  fetch: (...a) => fetch(...a),
  now: () => Date.now(),
  randomId: () => crypto.randomUUID(),
  loadRequests: async () => ((await chrome.storage.session.get(REQ_KEY))[REQ_KEY] as Record<string, Req> | undefined) ?? {},
  saveRequests: (r) => chrome.storage.session.set({ [REQ_KEY]: r }),
  loadDrafts: async () => ((await chrome.storage.session.get(DRAFT_KEY))[DRAFT_KEY] as Record<string, Draft> | undefined) ?? {},
  saveDrafts: (d) => chrome.storage.session.set({ [DRAFT_KEY]: d }),
  openConfirm: async (requestId) => {
    const w = await chrome.windows.create({ url: chrome.runtime.getURL(`confirm.html?r=${encodeURIComponent(requestId)}`), type: 'popup', width: 480, height: 680, focused: true });
    return w?.id;
  },
  closeWindow: (id) => chrome.windows.remove(id),
  communityDesigns: getCommunityDesigns,
  // Storage writes go through the same serialized queue as every other design change.
  install: (design) => enqueue(() => installCommunityDesign(design)),
  remove: (host, id) => enqueue(() => removeDesign(host, id)),
  tabsOn: async (hostname) => {
    const tabs = await chrome.tabs.query({ url: [`https://${hostname}/*`, `http://${hostname}/*`] });
    return tabs.filter((t) => t.id !== undefined && t.url).map((t) => ({ id: t.id!, url: t.url! }));
  },
  appliedIn: async (tabId, designId) => {
    const st = (await chrome.tabs.sendMessage(tabId, { type: 'ww:getState' })) as ContentState | undefined;
    return !!st?.appliedIds.includes(designId);
  },
});

type ConfirmMessage = { type: 'ww:community:get'; requestId: string } | { type: 'ww:community:decide'; requestId: string; approve: boolean };

export function initCommunity(enqueue: <T>(job: () => Promise<T>) => Promise<T>): Deps {
  const deps = productionDeps(enqueue);

  // Messages from WEB PAGES (the allowed website origins listed in externally_connectable).
  chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
    handleExternal(msg, sender, deps)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, code: 'failed', message: 'The extension hit an unexpected problem.' }));
    return true;
  });

  // Messages from the confirmation window (an extension page; never a content script or web page).
  chrome.runtime.onMessage.addListener((msg: ConfirmMessage, sender, sendResponse) => {
    if (!msg || (msg.type !== 'ww:community:get' && msg.type !== 'ww:community:decide')) return;
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
    const run = msg.type === 'ww:community:get' ? summary(String(msg.requestId), deps) : decide(String(msg.requestId), msg.approve === true, deps);
    run.then(sendResponse).catch(() => sendResponse(null));
    return true;
  });

  chrome.windows.onRemoved.addListener((id) => void windowClosed(id, deps).catch(() => undefined));
  return deps;
}

/** For the side panel's "Share on Whimsy Web": prepares the design's CSS and returns the website page to open. */
export async function exportDraftFor(design: Design, deps: Deps): Promise<string> {
  const path = design.scope === 'page' ? design.path ?? '/' : null;
  const draft: ExportedDraft = {
    title: design.name.slice(0, 60),
    hostname: design.host,
    pathScope: design.community ? design.community.pathScope : path && path !== '/' ? { mode: 'prefix', paths: [path] } : { mode: 'all' },
    css: design.css,
  };
  const id = await createDraft(draft, new URL(SITE_URL).origin, deps);
  return `${SITE_URL.replace(/\/+$/, '')}/publish?draft=${encodeURIComponent(id)}`;
}

