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
  setDesignScope,
  setHostExclusion,
  upsertDesign,
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
import { MAX_ATTACHMENTS, providerOf, supportsImages } from '../shared/types';
import { sanitizeCss, sanitizeOps } from '../shared/validate';
import { generateDesign } from './anthropic';

// Serializes every write so concurrent saves/deletes/toggles can't clobber each other.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

enqueue(migrateLegacy).catch(() => undefined);

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});

// In-flight generations by requestId, so the Stop button can abort them.
const inflight = new Map<string, AbortController>();

chrome.runtime.onMessage.addListener((msg: BackgroundMessage | MutateMessage | CaptureMessage | CancelMessage, sender, sendResponse) => {
  // Only our own extension pages (the side panel) may drive generation or writes.
  // Content scripts run alongside untrusted pages, so they get no write access.
  if (sender.id !== chrome.runtime.id || sender.tab) return;

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

async function handleMutate(msg: MutateMessage): Promise<{ conversationId?: string } | void> {
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
        if (c.designId === msg.id) await putConversation({ ...c, scope: msg.scope, path: msg.scope === 'page' ? path : undefined });
      }
      return;
    }
    case 'resetUsage':
      return resetUsage();
    case 'excludeHost':
      return setHostExclusion(msg.id, String(msg.siteHost), !!msg.excluded);
    case 'delete':
      return removeDesign(msg.host, msg.id);
    case 'rename':
      return patchDesign(msg.host, msg.id, { name: String(msg.name).trim().slice(0, 60) || 'Untitled' });
    case 'deleteConversation':
      return deleteConversation(msg.id);
    case 'restore': {
      const convo = await getConversation(msg.conversationId);
      const snap = convo?.messages.find((m) => m.id === msg.messageId)?.snapshot;
      if (!convo?.designId || !snap) throw new Error('That version is no longer available.');
      let bucket: string | undefined;
      for (const h of [convo.host, GLOBAL_HOST]) {
        if ((await getDesignsForHost(h)).some((d) => d.id === convo.designId)) {
          bucket = h;
          break;
        }
      }
      if (!bucket) throw new Error('This conversation’s design was deleted.');
      await patchDesign(bucket, convo.designId, {
        css: sanitizeCss(snap.css),
        ops: sanitizeOps(snap.ops),
      });
      await activateDesign(bucket, convo.designId);
      return;
    }
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
          ? `I applied “${src.name}” to all sites exactly as it was, with no AI changes. It was made for ${src.host === GLOBAL_HOST ? 'another scope' : src.host}, so some parts may not fit every site. You can switch it off for any site from the “This page” tab. Want to change anything?`
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
    const before = await chrome.tabs.get(msg.tabId);
    if (!before.active) return { ok: false, error: 'Switch back to that tab to take a screenshot of it.' };
    const dataUrl = await chrome.tabs.captureVisibleTab(before.windowId, { format: 'jpeg', quality: 70 });
    const after = await chrome.tabs.get(msg.tabId);
    if (!after.active || after.url !== before.url || after.windowId !== before.windowId) {
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
  try {
    return await generateTurn(msg, controller.signal);
  } catch (e) {
    if (controller.signal.aborted || (e instanceof Error && e.name === 'AbortError')) {
      return { ok: false, error: 'Stopped.', cancelled: true };
    }
    throw e;
  } finally {
    if (requestId) inflight.delete(requestId);
  }
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

  let page: PageContext;
  try {
    page = await chrome.tabs.sendMessage(msg.tabId, { type: 'ww:extract' });
  } catch {
    return { ok: false, error: 'Could not read this page. Reload the tab and try again.' };
  }

  const existing = msg.conversationId ? await getConversation(msg.conversationId) : undefined;
  if (msg.conversationId && !existing) return { ok: false, error: 'That conversation no longer exists.' };
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
  const applied = designs
    .filter((d) => d.enabled && d.id !== base?.id && appliesOn(d, page.host, page.path))
    .sort((a, b) => layerOf(a) - layerOf(b))
    .map((d) => ({ label: `${scopeLabel(d)}: “${d.name}”`, css: d.css, ops: d.ops }));

  const baseNote = base?.copiedFrom
    ? `The current design was copied from ${base.copiedFrom.host === GLOBAL_HOST ? 'the all-sites theme' : base.copiedFrom.host}${base.copiedFrom.path ?? ''} and applied here exactly as it was, without adapting it to this page. Selectors written for the other ${base.copiedFrom.host === page.host ? 'page' : 'site'} may not match anything here: adapt them to this page's structure while keeping the look.`
    : undefined;

  const hasScreenshot = images.some((i) => i.label === 'screenshot');
  const refCount = images.length - (hasScreenshot ? 1 : 0);

  const history = (existing?.messages ?? []).map((m) => ({
    role: m.role,
    text: [
      m.text,
      m.screenshot ? '[attached a screenshot of the page; not resent]' : '',
      m.imageCount ? `[attached ${m.imageCount} reference image(s); not resent]` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  }));

  // Reuse the first turn's outline for the same page so the cached prefix doesn't change each turn.
  const stored = existing?.pageContext;
  const contextText = stored && stored.path === page.path ? stored.text : page.context;

  // Count tokens per provider/model the moment a response reports them (even if the reply is unusable).
  const usageWrites: Promise<unknown>[] = [];
  const onUsage = (u: Usage) => {
    usageWrites.push(enqueue(() => addUsage(provider, settings.model, u)).catch(() => undefined));
  };

  let out: Awaited<ReturnType<typeof generateDesign>>;
  try {
    out = await generateDesign({
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
    images,
    signal,
    onUsage,
  });
  } finally {
    await Promise.all(usageWrites); // counted even when the reply was unusable or the request errored
  }

  const css = sanitizeCss(out.css);
  const ops = scope === 'global' ? [] : sanitizeOps(out.ops); // all-sites designs are CSS-only
  if (!css.trim() && !ops.length) return { ok: false, error: 'The model returned an empty design. Try rephrasing.' };

  return enqueue(async () => {
    const now = Date.now();
    // The model call took a while: re-read the latest saved state instead of trusting what we read
    // before it, or a scope change / rename / deletion made meanwhile would be overwritten.
    const latestBase = base ? (await getDesignsForHost(base.host)).find((d) => d.id === base.id) : undefined;
    const latestExisting = existing ? await getConversation(existing.id) : undefined;

    // Optimistic concurrency: if the design's content or the conversation changed while Claude was
    // working (another panel, a restore, a second request), this result is stale and saving it would
    // overwrite newer work.
    const STALE = 'This chat changed while Claude was working (another panel or an undo), so the result was not saved. Send your request again.';
    if (base && latestBase && (latestBase.css !== base.css || JSON.stringify(latestBase.ops) !== JSON.stringify(base.ops))) {
      return { ok: false as const, error: STALE };
    }
    if (existing && latestExisting && latestExisting.messages.length !== existing.messages.length) {
      return { ok: false as const, error: STALE };
    }

    // Something the user was editing was deleted while Claude was working: don't resurrect it.
    if (base && !latestBase) {
      return { ok: false as const, error: 'That design was deleted while Claude was working, so nothing was saved.' };
    }
    if (existing && !latestExisting) {
      return { ok: false as const, error: 'That conversation was deleted while Claude was working, so nothing was saved.' };
    }

    const design: Design = latestBase
      ? { ...latestBase, css, ops, enabled: true, copiedFrom: undefined, updatedAt: now, usage: out.usage }
      : {
          id: newId(),
          host: scope === 'global' ? GLOBAL_HOST : page.host,
          scope,
          path: scope === 'page' ? page.path : undefined,
          name: out.name,
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
      text: prompt || (hasScreenshot ? '📸 Screenshot' : '📎 Image'),
      createdAt: now,
      screenshot: hasScreenshot || undefined,
      imageCount: refCount || undefined,
    };
    const botMsg: ChatMessage = {
      id: newId(),
      role: 'assistant',
      text: out.reply,
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
          pageContext: latestExisting.pageContext ?? { path: page.path, text: contextText },
          updatedAt: now,
          messages: [...latestExisting.messages, userMsg, botMsg],
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
          pageContext: { path: page.path, text: contextText },
          messages: [userMsg, botMsg],
        };

    // ONE write for design + conversation; the Stop check runs after the last read, right before it.
    const committed = await commitDesignAndConversation(design, convo, {
      exclusive: true,
      shouldAbort: () => signal.aborted,
    });
    if (!committed) return { ok: false as const, error: 'Stopped.', cancelled: true };
    return { ok: true as const, conversation: convo, design: { ...design, updatedAt: now } };
  });
}
