import { watchActivation } from '../shared/tabguard';
import { GLOBAL_HOST, appliesOn, layerOf, normalizePath, scopeLabel, scopeOf } from '../shared/scope';
import {
  activateDesign,
  addUsage,
  commitDesignAndConversation,
  deleteConversation,
  getAllConversations,
  getConversation,
  getDesignsForHost,
  getSettings,
  migrateLegacy,
  patchDesign,
  putConversation,
  removeDesign,
  resetUsage,
  saveFavicon,
  clearAllThumbs,
  setDesignScope,
  setHostExclusion,
  upsertDesign,
  gcArt,
  loadArtRecords,
} from '../shared/storage';
import type {
  BackgroundMessage,
  CancelMessage,
  CaptureMessage,
  CaptureResponse,
  ChatMessage,
  Conversation,
  Design,
  DesignScope,
  GenerateResponse,
  MutateMessage,
  PageContext,
  Usage,
} from '../shared/types';
import { MAX_ATTACHMENTS, providerOf, supportsImages, clampIntensity, clampPolish } from '../shared/types';
import { runPolish } from './polish';
import { activeIndex, designHistoryNote, historyLabel, revisionsOf, type RevisionEvent } from '../shared/revisions';
import { sanitizeCss, sanitizeOps } from '../shared/validate';
import { exportDraftFor, initCommunity } from '../community';
import { generateDesign, unfulfilledNote, generateDesignWithArt, MAX_CLAUDE_PICTURES, type PaintedPicture } from './anthropic';
import { generateIllustrations, IMAGE_MODEL } from './images';
import { bindArtNames, newArtToken, tokensIn, type ArtRecord } from '../shared/art';
import { capturePreview } from './preview';

// Serializes every write so concurrent saves/deletes/toggles can't clobber each other.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

enqueue(migrateLegacy).catch(() => undefined);
const community = initCommunity(enqueue);

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});

// In-flight generations by requestId, so the Stop button can abort them.
const inflight = new Map<string, AbortController>();

// A non-streaming model reply can take longer than the 30 seconds Chrome allows an extension worker to wait
// for a response before terminating it (which would lose the request, and the tokens spent on it). Calling an
// extension API every 20 seconds resets that timer for as long as a generation is running.
export const KEEPALIVE_MS = 20_000;
let activeGenerations = 0;
let keepalive: ReturnType<typeof setInterval> | null = null;
function generationStarted(): void {
  activeGenerations++;
  if (!keepalive) {
    keepalive = setInterval(() => {
      chrome.runtime.getPlatformInfo().catch(() => undefined);
    }, KEEPALIVE_MS);
  }
}
function generationFinished(): void {
  activeGenerations = Math.max(0, activeGenerations - 1);
  if (activeGenerations === 0 && keepalive) {
    clearInterval(keepalive);
    keepalive = null;
  }
}

/** Fetches a stylesheet for the page's content script (the browser will not show a page the rules of another origin's CSS). */
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|0\.0\.0\.0)/i;
async function fetchSheetText(url: string, pageUrl: string | undefined): Promise<{ ok: boolean; text?: string }> {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false };
    // a page may not use the extension to read private network addresses (unless it IS served from that address)
    let pageHost = '';
    try {
      pageHost = new URL(pageUrl ?? '').hostname;
    } catch {
      /* unknown page */
    }
    if (PRIVATE_HOST.test(u.hostname) && u.hostname !== pageHost) return { ok: false };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(u.href, { credentials: 'omit', signal: ctl.signal, cache: 'force-cache' });
      if (!res.ok) return { ok: false };
      const text = await res.text();
      return text.length > 3_000_000 ? { ok: false } : { ok: true, text };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false };
  }
}

chrome.runtime.onMessage.addListener((msg: BackgroundMessage | MutateMessage | CaptureMessage | CancelMessage | { type: 'ww:fetchSheet'; url: string }, sender, sendResponse) => {
  // The page script (and only it) may ask for a stylesheet to be fetched; everything else is for the side panel.
  if ((msg as { type?: string })?.type === 'ww:fetchSheet' && sender.id === chrome.runtime.id && sender.tab) {
    void fetchSheetText(String((msg as { url?: unknown }).url ?? ''), sender.tab.url).then(sendResponse);
    return true;
  }
  // Only our own extension pages (the side panel) may drive generation or writes.
  // Content scripts run alongside untrusted pages, so they get no write access.
  // (End-to-end test builds only: the panel opened as an ordinary tab of our own extension also counts.)
  const ownPageAsTab = typeof __WW_E2E__ !== 'undefined' && __WW_E2E__ && !!sender.tab && !!sender.url?.startsWith(chrome.runtime.getURL(''));
  if (sender.id !== chrome.runtime.id || (sender.tab && !ownPageAsTab)) return;

  if (msg?.type === 'ww:generate') {
    handleGenerate(msg)
      .then(sendResponse)
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true;
  }
  if (msg?.type === 'ww:cancel') {
    inflight.get(String(msg.requestId))?.abort();
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === 'ww:capture') {
    capture(msg).then(sendResponse);
    return true;
  }
  if (msg?.type === 'ww:mutate') {
    enqueue(() => handleMutate(msg))
      .then((result) => sendResponse({ ok: true, ...(result ?? {}) }))
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true;
  }
});

const newId = () => crypto.randomUUID();

declare const __WW_E2E__: boolean;
// Test-only hook, compiled in solely by `WHIMSYWEB_E2E=1` builds, so end-to-end tests can drive the worker. Not in dist/.
if (typeof __WW_E2E__ !== 'undefined' && __WW_E2E__) (globalThis as unknown as { __ww: unknown }).__ww = { mutate: (m: MutateMessage) => enqueue(() => handleMutate(m)), generate: (m: BackgroundMessage) => handleGenerate(m) };

/**
 * Applies revision `index` of a chat's design: the design becomes exactly that snapshot (CSS and ops; its pictures are
 * kept because every snapshot still refers to them), the chat remembers it as the applied revision, and an activity
 * event is recorded. Design and chat are saved in ONE write, so the version you land on is the one kept.
 */
/** The chat's messages with the revisions after the applied one marked discarded (when the user had gone back). */
function discardForward(c: Conversation): ChatMessage[] {
  const revs = revisionsOf(c);
  const p = activeIndex(c);
  if (p < 0 || p >= revs.length - 1) return c.messages;
  const gone = new Set(revs.slice(p + 1).map((m) => m.id));
  return c.messages.map((m) => (gone.has(m.id) ? { ...m, discarded: true } : m));
}

async function navigateRevision(conversationId: string, index: number): Promise<void> {
  const convo = await getConversation(conversationId);
  if (!convo?.designId) throw new Error('This chat has no design to go back to.');
  const revs = revisionsOf(convo);
  if (!Number.isInteger(index) || index < 0 || index >= revs.length) throw new Error('That version is no longer available.');
  const from = activeIndex(convo);
  let design: Design | undefined;
  for (const h of [convo.host, GLOBAL_HOST]) {
    design = (await getDesignsForHost(h)).find((d) => d.id === convo.designId);
    if (design) break;
  }
  if (!design) throw new Error('This conversation’s design was deleted.');
  const snap = revs[index].snapshot!;
  const now = Date.now();
  const event: RevisionEvent | null = from === index ? null : { id: newId(), kind: index < from ? 'back' : 'forward', from, to: index, createdAt: now };
  const next: Conversation = {
    ...convo,
    revisionIndex: index === revs.length - 1 ? undefined : index,
    events: event ? [...(convo.events ?? []), event].slice(-50) : convo.events,
    updatedAt: now,
  };
  await commitDesignAndConversation({ ...design, css: sanitizeCss(snap.css), ops: sanitizeOps(snap.ops), enabled: true, updatedAt: now }, next, { exclusive: true });
}

async function handleMutate(msg: MutateMessage): Promise<{ conversationId?: string; preview?: string; reason?: string; cleared?: number } | void> {
  if (typeof msg.host !== 'string' || !msg.host) throw new Error('Missing host');
  switch (msg.action) {
    case 'activate':
      return activateDesign(msg.host, msg.id, msg.enabled ?? true);
    case 'setScope': {
      if (msg.scope !== 'site' && msg.scope !== 'page' && msg.scope !== 'global') throw new Error('Invalid scope.');
      const path = normalizePath(String(msg.path || '/'));
      await setDesignScope(msg.host, msg.id, msg.scope, path);
      // Keep the conversation list's scope badge in sync.
      for (const c of await getAllConversations()) {
        if (c.designId !== msg.id) continue;
        // The design now lives under `msg.host` (unless it went to all sites), so its chat moves with it;
        // otherwise the chat would point at a site the design is no longer stored under.
        await putConversation({
          ...c,
          host: msg.scope === 'global' ? c.host : msg.host,
          scope: msg.scope,
          path: msg.scope === 'page' ? path : undefined,
        });
      }
      return;
    }
    case 'resetUsage':
      return resetUsage();
    case 'excludeHost':
      return setHostExclusion(msg.id, String(msg.siteHost), !!msg.excluded);
    case 'delete':
      await removeDesign(msg.host, msg.id);
      await gcArt().catch(() => undefined);
      return;
    case 'capturePreview': {
      const design = (await getDesignsForHost(msg.host)).find((d) => d.id === msg.id);
      if (!design) return { preview: 'skipped', reason: 'gone' };
      const r = await capturePreview(design);
      if (!r.ok) return { preview: 'skipped', reason: r.reason };
      await patchDesign(msg.host, msg.id, { thumb: r.dataUrl });
      return { preview: 'saved' };
    }
    case 'clearThumbs':
      return { cleared: await clearAllThumbs() };
    case 'saveFavicon':
      return saveFavicon(msg.host, msg.dataUrl);
    case 'exportDraft': {
      const d = (await getDesignsForHost(msg.host)).find((x) => x.id === msg.id);
      if (!d) throw new Error('That design no longer exists.');
      await chrome.tabs.create({ url: await exportDraftFor(d, community) });
      return;
    }
    case 'rename':
      return patchDesign(msg.host, msg.id, { name: String(msg.name).trim().slice(0, 60) || 'Untitled' });
    case 'deleteConversation':
      await deleteConversation(msg.id);
      await gcArt().catch(() => undefined);
      return;
    case 'restore': {
      // "Go to this version" on a reply: the same as moving Back/Forward to it
      const convo = await getConversation(msg.conversationId);
      const index = convo ? revisionsOf(convo).findIndex((m) => m.id === msg.messageId) : -1;
      if (index < 0) throw new Error('That version is no longer available.');
      return navigateRevision(msg.conversationId, index);
    }
    case 'navigateRevision':
      return navigateRevision(String(msg.conversationId), Number(msg.index));
    case 'copyDesign': {
      // Applies a saved design somewhere new WITHOUT calling the model, then opens a conversation
      // so the user can say what to change. msg.host is the target site.
      const src = (await getDesignsForHost(String(msg.sourceHost))).find((d) => d.id === msg.sourceId);
      if (!src) throw new Error('That design no longer exists.');
      const scope: DesignScope = msg.scope === 'page' ? 'page' : msg.scope === 'global' ? 'global' : 'site';
      const path = normalizePath(String(msg.path || '/'));
      const now = Date.now();
      const css = sanitizeCss(src.css);
      const ops = scope === 'global' ? [] : sanitizeOps(src.ops); // all-sites designs are CSS-only
      const design: Design = {
        id: newId(),
        host: scope === 'global' ? GLOBAL_HOST : msg.host,
        scope,
        path: scope === 'page' ? path : undefined,
        name: src.name.slice(0, 60),
        prompt: src.prompt,
        css,
        ops,
        enabled: true,
        copiedFrom: { host: src.host, path: src.path, name: src.name },
        createdAt: now,
        updatedAt: now,
      };
      const where = scope === 'page' ? 'this page' : scope === 'global' ? 'all sites' : 'this whole site';
      const intro =
        scope === 'global'
          ? `I applied “${src.name}” to all sites exactly as it was, with no AI changes. It was made for ${src.host === GLOBAL_HOST ? 'another scope' : src.host}, so some parts may not fit every site. You can switch it off for any site from the “This site” tab. Want to change anything?`
          : src.host === msg.host
          ? `I copied “${src.name}” to ${where} exactly as it was, with no AI changes. Want to change anything?`
          : `I applied “${src.name}” from ${src.host} to ${where} exactly as it was, with no AI changes, so some parts may not fit here. Want to change anything? Tell me what to tweak, or ask me to adapt it to this site.`;
      const convo: Conversation = {
        id: newId(),
        host: msg.host,
        title: `Applied “${src.name}”`.slice(0, 60),
        createdAt: now,
        updatedAt: now,
        designId: design.id,
        scope,
        path: design.path,
        messages: [{ id: newId(), role: 'assistant', text: intro, createdAt: now, snapshot: { css, ops } }],
      };
      await commitDesignAndConversation(design, convo, { exclusive: true });
      return { conversationId: convo.id };
    }
  }
}

/** Screenshot of the tab's visible area as base64 JPEG (no data: prefix). */
async function capture(msg: CaptureMessage): Promise<CaptureResponse> {
  try {
    // captureVisibleTab grabs whichever tab is active in the window, so make sure it is still the
    // requested one before AND after; otherwise we could attach a different (private) page.
    const watch = watchActivation();
    let dataUrl: string;
    let before: chrome.tabs.Tab;
    try {
      before = await chrome.tabs.get(msg.tabId);
      if (!before.active) return { ok: false, error: 'Switch back to that tab to take a screenshot of it.' };
      dataUrl = await chrome.tabs.captureVisibleTab(before.windowId, { format: 'jpeg', quality: 70 });
    } finally {
      watch.stop();
    }
    const after = await chrome.tabs.get(msg.tabId);
    if (watch.changed() || !after.active || after.url !== before.url || after.windowId !== before.windowId) {
      return { ok: false, error: 'The tab changed while capturing. Try again.' };
    }
    return { ok: true, data: dataUrl.replace(/^data:image\/jpeg;base64,/, '') };
  } catch (e) {
    return { ok: false, error: `Could not capture a screenshot of this tab: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function handleGenerate(msg: BackgroundMessage): Promise<GenerateResponse> {
  const controller = new AbortController();
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined;
  if (requestId) inflight.set(requestId, controller);
  generationStarted();
  let succeeded = false;
  try {
    const result = await generateTurn(msg, controller.signal);
    succeeded = result.ok === true;
    return result;
  } catch (e) {
    if (controller.signal.aborted || (e instanceof Error && e.name === 'AbortError')) {
      return { ok: false, error: 'Stopped.', cancelled: true };
    }
    throw e;
  } finally {
    if (requestId) inflight.delete(requestId);
    generationFinished();
    // A fresh start briefly showed the ORIGINAL page so the model could read it. Put the page back: on success the
    // new design shows; if it failed or was stopped, the page returns to how you had it (including your own Show original).
    if (msg.fresh === true && typeof msg.tabId === 'number') {
      const was = originalBefore.get(msg.tabId) === true;
      originalBefore.delete(msg.tabId);
      chrome.tabs.sendMessage(msg.tabId, { type: 'ww:setOriginal', original: succeeded ? false : was }).catch(() => undefined);
    }
  }
}

/** Asks the page's content script for its outline. It can be a moment late right after a load, so try twice. */
async function readPage(tabId: number): Promise<PageContext> {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'ww:extract' });
  } catch {
    await new Promise((r) => setTimeout(r, 400));
    return await chrome.tabs.sendMessage(tabId, { type: 'ww:extract' });
  }
}

/**
 * The page as it looked BEFORE any Whimsy Web design: the designs are switched off for a moment (the same as the
 * Show original button), the outline is read, and the caller puts them back.
 */
/** Whether each tab was already showing the original (Show original) before a fresh start toggled it. */
const originalBefore = new Map<number, boolean>();

async function readOriginalPage(tabId: number): Promise<PageContext> {
  const before = (await chrome.tabs.sendMessage(tabId, { type: 'ww:getState' }).catch(() => undefined)) as { original?: boolean } | undefined;
  originalBefore.set(tabId, before?.original === true);
  await chrome.tabs.sendMessage(tabId, { type: 'ww:setOriginal', original: true }).catch(() => undefined);
  for (let i = 0; i < 12; i++) {
    const st = (await chrome.tabs.sendMessage(tabId, { type: 'ww:getState' }).catch(() => undefined)) as { applied?: boolean } | undefined;
    if (!st || !st.applied) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return readPage(tabId);
}

/** Says what is actually wrong, instead of always telling people to reload. */
async function unreadableMessage(tabId: number, err: unknown): Promise<string> {
  let url = '';
  try {
    url = (await chrome.tabs.get(tabId)).url ?? '';
  } catch {
    return 'That tab is gone. Switch to the page you want to change and try again.';
  }
  if (!/^https?:\/\//i.test(url)) {
    const kind = /^file:/i.test(url) ? 'Local files' : /^(chrome|edge|about|chrome-extension):/i.test(url) || !url ? 'Browser pages' : 'Pages like this one';
    return `${kind} can’t be changed by extensions. Open a regular website (http or https) and try again.`;
  }
  // Chrome's own wording ("Could not establish connection. Receiving end does not exist.") only confuses people, so it goes to the console, not the message.
  if (err) console.warn('Whimsy Web could not read the page:', err);
  return 'Could not read this page. Reload the tab, and if it keeps happening, reload the extension at chrome://extensions and then the tab.';
}

async function generateTurn(msg: BackgroundMessage, signal: AbortSignal): Promise<GenerateResponse> {
  if (typeof msg.tabId !== 'number' || typeof msg.prompt !== 'string') {
    return { ok: false, error: 'Invalid request.' };
  }
  const prompt = msg.prompt.trim().slice(0, 2000);
  const images = (Array.isArray(msg.images) ? msg.images : [])
    .filter((i) => i && i.mediaType === 'image/jpeg' && typeof i.data === 'string' && i.data.length < 7_000_000)
    .map((i) => ({ mediaType: i.mediaType, data: i.data, label: i.label === 'screenshot' ? ('screenshot' as const) : ('reference' as const) }))
    .slice(0, MAX_ATTACHMENTS);
  if (!prompt && !images.length) return { ok: false, error: 'Write a message first.' };

  const settings = await getSettings();
  // The model decides the provider, and each provider has its own key.
  const provider = providerOf(settings.model);
  const apiKey = provider === 'openai' ? settings.openaiKey : settings.apiKey;
  if (!apiKey) {
    return { ok: false, error: `Add your ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key in Settings first (the selected model needs it).` };
  }
  if (images.length && !supportsImages(settings.model)) {
    return { ok: false, error: 'The selected model can’t read images. Pick an image-capable model in Settings.' };
  }

  const fresh = msg.fresh === true;
  let page: PageContext;
  try {
    page = fresh ? await readOriginalPage(msg.tabId) : await readPage(msg.tabId);
  } catch (e) {
    return { ok: false, error: await unreadableMessage(msg.tabId, e) };
  }

  // Fresh: no earlier chat, no current design, nothing applied: only the original site and the request.
  const existing = !fresh && msg.conversationId ? await getConversation(msg.conversationId) : undefined;
  if (!fresh && msg.conversationId && !existing) return { ok: false, error: 'That conversation no longer exists.' };
  // A conversation about an ALL-SITES design can be continued from any site; others only from their own.
  if (existing && existing.scope !== 'global' && existing.host !== page.host) {
    return { ok: false, error: `This conversation is for ${existing.host}. Open that site to continue it.` };
  }

  const [siteDesigns, globalDesigns] = await Promise.all([getDesignsForHost(page.host), getDesignsForHost(GLOBAL_HOST)]);
  const designs = [...siteDesigns, ...globalDesigns];
  const base = existing?.designId ? designs.find((d) => d.id === existing.designId) : undefined;
  if (existing?.designId && !base) {
    return { ok: false, error: 'This conversation’s design was deleted. Start a new chat to make another.' };
  }

  // The design's own scope is authoritative once it exists; `msg.scope` only picks it for a new design.
  const scope: DesignScope = base ? scopeOf(base) : msg.scope === 'global' ? 'global' : msg.scope === 'page' ? 'page' : 'site';
  if (base && scopeOf(base) === 'page' && normalizePath(base.path ?? '/') !== page.path) {
    return {
      ok: false,
      error: `This chat’s design is for the page ${normalizePath(base.path ?? '/')}. Open that page to continue it, or start a new chat.`,
    };
  }

  // Designs already on this page that the model should know about: everything applied here except
  // the one being edited (that one is sent as the current design). For a NEW chat that is all of them.
  const applied = (fresh ? [] : designs)
    .filter((d) => d.enabled && d.id !== base?.id && appliesOn(d, page.host, page.path))
    .sort((a, b) => layerOf(a) - layerOf(b))
    .map((d) => ({ label: `${scopeLabel(d)}: “${d.name}”`, css: d.css, ops: d.ops }));

  const baseNote = base?.copiedFrom
    ? `The current design was copied from ${base.copiedFrom.host === GLOBAL_HOST ? 'the all-sites theme' : base.copiedFrom.host}${base.copiedFrom.path ?? ''} and applied here exactly as it was, without adapting it to this page. Selectors written for the other ${base.copiedFrom.host === page.host ? 'page' : 'site'} may not match anything here: adapt them to this page's structure while keeping the look.`
    : undefined;

  const shotCount = images.filter((i) => i.label === 'screenshot').length;
  const hasScreenshot = shotCount > 0;
  const refCount = images.length - shotCount;

  const history = (existing?.messages ?? []).map((m) => ({
    role: m.role,
    text: [
      existing ? historyLabel(existing, m) : '',
      m.text,
      m.screenshot ? '[attached a screenshot of the page; not resent]' : '',
      m.imageCount ? `[attached ${m.imageCount} reference image(s); not resent]` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  }));

  // Reuse the first turn's outline for the same page so the cached prefix doesn't change each turn.
  const stored = existing?.pageContext;
  // Same SITE and page only: an all-sites chat continued on another site must not send the old site's outline.
  const contextText =
    stored && (stored.host ?? existing?.host) === page.host && stored.path === page.path ? stored.text : page.context;

  // Count tokens per provider/model the moment a response reports them (even if the reply is unusable).
  const usageWrites: Promise<unknown>[] = [];
  const onUsage = (u: Usage) => {
    usageWrites.push(enqueue(() => addUsage(provider, settings.model, u)).catch(() => undefined));
  };

  // Pictures only when the checkbox is on. OpenAI models ask for them in one go; Claude plans them, OpenAI's image
  // model paints them (with the OpenAI key), and Claude then designs around the results.
  // A chat is one design session. The first turn uses the Intensity and Polish the user chose; later turns are
  // refinements the model scopes itself (a tweak, a component, the whole theme or a full redesign), so the session's
  // ambition and review level are not applied again. Pictures stay available when the session used them.
  const imageKey = settings.openaiKey;
  const session = existing
    ? undefined
    : { intensity: msg.intensity !== undefined ? clampIntensity(msg.intensity) : msg.illustrations === true ? 2 : 1, polish: clampPolish(msg.polish) };
  const sessionUsedImages = existing ? (existing.session?.intensity ?? (base && tokensIn(base.css).length ? 2 : 1)) >= 2 : false;
  const intensity = session ? session.intensity : sessionUsedImages && imageKey ? 2 : 1;
  const wantArt = intensity >= 2;
  if (wantArt && !imageKey) {
    return { ok: false, error: 'Generating illustrations uses OpenAI’s image model. Add an OpenAI API key in Settings first, or set Intensity to Simple.' };
  }
  const claudeArt = wantArt && provider === 'anthropic';
  const imageUsage = (u: Usage) => usageWrites.push(enqueue(() => addUsage('openai', IMAGE_MODEL, u)).catch(() => undefined));
  const existingArt = base ? await loadArtRecords(tokensIn(`${base.css}\n${JSON.stringify(base.ops)}`)) : new Map<string, ArtRecord>();
  const artwork = Array.from(existingArt, ([token, r]) => ({ token, w: r.w, h: r.h, prompt: r.prompt }));

  let out: Awaited<ReturnType<typeof generateDesign>>;
  let painted: { made: Map<string, PaintedPicture>; problems: string[] } | undefined;
  const designInput = {
    provider,
    apiKey,
    model: settings.model,
    prompt,
    host: page.host,
    path: page.path,
    scope,
    pageContext: contextText,
    history,
    base,
    applied,
    baseNote,
    designState: existing ? designHistoryNote(existing) : undefined,
    images,
    illustrations: wantArt,
    intensity,
    // no count in the instructions; this is only a safety stop against a runaway reply
    maxIllustrations: MAX_CLAUDE_PICTURES,
    artwork,
    signal,
    onUsage,
  };
  try {
    if (claudeArt) {
      const r = await generateDesignWithArt(designInput, async (specs, artDirection) => {
        try {
          const made = await generateIllustrations(specs, imageKey, signal, { onUsage: imageUsage, styleSpec: artDirection, referenceFirst: true });
          return { made: made.made, problems: made.problems };
        } finally {
          await Promise.all(usageWrites);
        }
      });
      painted = { made: r.made, problems: r.artProblems };
      out = r;
    } else {
      out = await generateDesign(designInput);
    }
  } finally {
    await Promise.all(usageWrites); // counted even when the reply was unusable or the request errored
  }

  let rawCss = out.css;
  let rawOps = out.ops;
  // Anything the model says it could not (fully) do is added to its reply, so it is never hidden.
  const missed = unfulfilledNote(out.checklist);
  let reply = missed && !out.reply.includes(missed.slice(0, 30)) ? `${out.reply}\n\n${missed}`.slice(0, 1200) : out.reply;
  const newArt = new Map<string, ArtRecord>();
  if (!painted && wantArt && out.illustrations.length) {
    // Each image call is counted in Token usage under the image model, like the design calls.
    try {
      painted = await generateIllustrations(out.illustrations, imageKey, signal, { onUsage: imageUsage });
    } finally {
      await Promise.all(usageWrites); // counted even if the request is stopped part-way
    }
  }
  if (painted) {
    const made = painted;
    const names = new Map<string, string>();
    for (const [name, rec] of made.made) {
      const token = newArtToken();
      names.set(name, token);
      newArt.set(token, rec);
    }
    rawCss = bindArtNames(rawCss, names);
    rawOps = rawOps.map((o) => (o.op === 'insert' ? { ...o, src: o.src ? bindArtNames(o.src, names) : o.src, style: o.style ? bindArtNames(o.style, names) : o.style } : o));
    if (made.problems.length) {
      reply = `${reply} (I couldn’t make some of the illustrations: ${made.problems[0]}. The rest of the design still applies.)`.slice(0, 800);
    }
  }

  const css = sanitizeCss(rawCss);
  const ops = scope === 'global' ? [] : sanitizeOps(rawOps); // all-sites designs are CSS-only
  if (!css.trim() && !ops.length) return { ok: false, error: 'The model returned an empty design. Try rephrasing.' };

  const saved = await enqueue(async () => {
    const now = Date.now();
    // The model call took a while: re-read the latest saved state instead of trusting what we read
    // before it, or a scope change / rename / deletion made meanwhile would be overwritten.
    const latestBase = base ? (await getDesignsForHost(base.host)).find((d) => d.id === base.id) : undefined;
    const latestExisting = existing ? await getConversation(existing.id) : undefined;

    // Optimistic concurrency: if the design's content or the conversation changed while Claude was
    // working (another panel, a restore, a second request), this result is stale and saving it would
    // overwrite newer work.
    const STALE = 'This chat changed while Claude was working (another panel or an undo), so the result was not saved. Send your request again.';
    if (base && latestBase && (latestBase.css !== base.css || JSON.stringify(latestBase.ops) !== JSON.stringify(base.ops) || scopeOf(latestBase) !== scopeOf(base) || (latestBase.path ?? '') !== (base.path ?? ''))) {
      return { ok: false as const, error: STALE };
    }
    if (existing && latestExisting && (latestExisting.messages.length !== existing.messages.length || activeIndex(latestExisting) !== activeIndex(existing))) {
      return { ok: false as const, error: STALE };
    }

    // Something the user was editing was deleted while Claude was working: don't resurrect it.
    if (base && !latestBase) {
      return { ok: false as const, error: 'That design was deleted while Claude was working, so nothing was saved.' };
    }
    if (existing && !latestExisting) {
      return { ok: false as const, error: 'That conversation was deleted while Claude was working, so nothing was saved.' };
    }

    const usedTokens = new Set(tokensIn(`${css}\n${JSON.stringify(ops)}`));
    const art = new Map([...newArt].filter(([t]) => usedTokens.has(t)));

    const design: Design = latestBase
      ? { ...latestBase, css, ops, enabled: true, copiedFrom: undefined, updatedAt: now, usage: out.usage, descriptor: out.descriptor || latestBase.descriptor }
      : {
          id: newId(),
          host: scope === 'global' ? GLOBAL_HOST : page.host,
          scope,
          path: scope === 'page' ? page.path : undefined,
          name: out.name,
          descriptor: out.descriptor || undefined,
          prompt: prompt || 'Image inspiration',
          css,
          ops,
          enabled: true,
          createdAt: now,
          updatedAt: now,
          usage: out.usage,
        };

    const userMsg: ChatMessage = {
      id: newId(),
      role: 'user',
      text: prompt || (hasScreenshot ? 'Screenshot' : 'Image'),
      createdAt: now,
      screenshot: hasScreenshot || undefined,
      screenshotCount: shotCount > 1 ? shotCount : undefined,
      imageCount: refCount || undefined,
    };
    const botMsg: ChatMessage = {
      id: newId(),
      role: 'assistant',
      text: reply,
      createdAt: now + 1,
      snapshot: { css, ops },
      usage: out.usage,
    };
    const convo: Conversation = latestExisting
      ? {
          ...latestExisting,
          designId: design.id,
          scope: scopeOf(design),
          path: design.path,
          pageContext: latestExisting.pageContext ?? { host: page.host, path: page.path, text: contextText },
          updatedAt: now,
          messages: [...discardForward(latestExisting), userMsg, botMsg],
          revisionIndex: undefined,
        }
      : {
          id: newId(),
          host: page.host,
          title: (prompt || (hasScreenshot ? 'Screenshot feedback' : 'Image inspiration')).slice(0, 60),
          createdAt: now,
          updatedAt: now,
          designId: design.id,
          scope: scopeOf(design),
          path: design.path,
          pageContext: { host: page.host, path: page.path, text: contextText },
          messages: [userMsg, botMsg],
          session,
        };

    // ONE write for design + conversation; the Stop check runs after the last read, right before it.
    const committed = await commitDesignAndConversation(design, convo, {
      exclusive: true,
      shouldAbort: () => signal.aborted,
      art,
    });
    if (!committed) return { ok: false as const, error: 'Stopped.', cancelled: true };
    // A fresh start means the original site plus only the new design: whatever else was showing here is switched off
    // (kept in the Library; an all-sites design is only skipped on this site).
    if (fresh) {
      for (const d of designs.filter((x) => x.enabled && x.id !== design.id && appliesOn(x, page.host, page.path))) {
        if (scopeOf(d) === 'global') await setHostExclusion(d.id, page.host, true);
        else await patchDesign(d.host, d.id, { enabled: false });
      }
    }
    // A design that was replaced may have left pictures nobody uses any more.
    await gcArt().catch(() => undefined);
    return { ok: true as const, conversation: convo, design: { ...design, updatedAt: now }, botMessageId: botMsg.id };
  });
  if (!saved.ok) return saved;
  const { botMessageId, ...result } = saved;

  // Polish: Claude reviews the applied result from screenshots (2 = targeted fixes, 3 = studio rework + best of).
  const polish = session ? session.polish : 1;
  if (polish < 2 || signal.aborted) return result;
  await runPolish(
    {
      level: polish,
      tabId: msg.tabId,
      signal,
      provider,
      apiKey,
      model: settings.model,
      intensity,
      imageKey,
      request: prompt,
      host: page.host,
      path: page.path,
      scope,
      pageContext: contextText,
      applied,
      designId: result.design.id,
      designHost: result.design.host,
      conversationId: result.conversation.id,
      botMessageId,
      onUsage,
      imageUsage,
      enqueue,
      capture: (tabId) => capture({ type: 'ww:capture', tabId } as CaptureMessage),
      progress: (text) => void chrome.runtime.sendMessage({ type: 'ww:progress', requestId: msg.requestId, text }).catch(() => undefined),
    },
    reply,
  );
  await Promise.all(usageWrites);
  // the chat and design as the review left them
  const convo = await getConversation(result.conversation.id);
  const design = (await getDesignsForHost(result.design.host)).find((d) => d.id === result.design.id);
  return { ok: true, conversation: convo ?? result.conversation, design: design ?? result.design };
}
