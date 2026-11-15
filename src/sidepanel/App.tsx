import { useCallback, useEffect, useRef, useState } from 'react';
import { GLOBAL_HOST, appliesTo, normalizePath, scopeLabel, scopeOf } from '../shared/scope';
import { applyTheme, cacheTheme, cachedTheme } from './theme';
import {
  getAllConversations,
  getAllDesigns,
  getDesignsForHost,
  getSettings,
  isConvoKey,
  isSiteKey,
  saveSettings,
  siteKey,
} from '../shared/storage';
import {
  DEFAULT_MODEL,
  MAX_ATTACHMENTS,
  MODEL_OPTIONS,
  THEME_OPTIONS,
  providerOf,
  supportsImages,
  type BackgroundMessage,
  type CaptureResponse,
  type ContentState,
  type Conversation,
  type Design,
  type DesignScope,
  type GenerateResponse,
  type ImageAttachment,
  type MutateMessage,
  type Settings,
} from '../shared/types';

type MutateAction =
  | { action: 'activate'; id: string | null; enabled?: boolean }
  | { action: 'setScope'; id: string; scope: DesignScope; path: string }
  | { action: 'copyDesign'; sourceHost: string; sourceId: string; scope: DesignScope; path: string }
  | { action: 'excludeHost'; id: string; siteHost: string; excluded: boolean }
  | { action: 'delete'; id: string }
  | { action: 'rename'; id: string; name: string }
  | { action: 'deleteConversation'; id: string }
  | { action: 'restore'; conversationId: string; messageId: string };

/** All writes go through the background worker's serialized queue. */
async function mutate(host: string, m: MutateAction): Promise<{ conversationId?: string }> {
  const msg = { type: 'ww:mutate', host, ...m } as MutateMessage;
  const res = await chrome.runtime.sendMessage(msg);
  if (!res?.ok) throw new Error(res?.error ?? 'Could not save changes.');
  return res;
}

const IDEAS = [
  'An enchanted forest with elegant serif type and botanical decorations',
  'Dark academia: candlelit library, parchment, gold accents',
  'Y2K cyber-pop with glitter gradients and chunky bubble buttons',
  'A dreamy fairy-tale scrapbook with washi tape and handwritten fonts',
];

const SCREENSHOT_WARNING =
  'This takes a screenshot of the current tab and sends it to Claude with your next message.\n\n' +
  '• Images use more credits than text.\n' +
  '• Anything visible on the page (including personal info) is included.\n\n' +
  'Add the screenshot?';

const GLOBAL_WARNING =
  'Apply this design to ALL websites?\n\n' +
  '• It was written for one site, so parts of it may not fit others.\n' +
  '• It could change sites you did not expect (banking, email, work tools).\n' +
  '• You can switch it off for any single site from the “This page” tab.\n\n' +
  'Apply to all sites?';

const CUSTOM_MODEL = '__custom__';

type View = 'chat' | 'page' | 'all';

interface Attachment extends ImageAttachment {
  id: string;
  /** For screenshots: the tab AND site they were taken on (never sent from a different tab or after navigating elsewhere). */
  tabId?: number;
  host?: string | null;
  label: 'screenshot' | 'reference';
  /** data: URL for the thumbnail preview */
  preview: string;
}

const MAX_EDGE = 1568; // larger images are downscaled by the API anyway; this saves upload size + tokens

/** Downscales to MAX_EDGE and re-encodes as JPEG (transparent areas become white). */
async function toAttachment(file: File): Promise<Attachment> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const preview = canvas.toDataURL('image/jpeg', 0.85);
  return { id: crypto.randomUUID(), mediaType: 'image/jpeg', label: 'reference', data: preview.split(',')[1], preview };
}

interface TabInfo {
  id: number;
  host: string | null;
  /** Normalized pathname of the page. */
  path: string;
}

async function readActiveTab(): Promise<TabInfo | null> {
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
  return { id: tab.id, host, path };
}

/** Animated ellipsis for loading states. */
function Dots() {
  return (
    <span className="dots" aria-hidden="true">
      <span>.</span>
      <span>.</span>
      <span>.</span>
    </span>
  );
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** e.g. "4.2k in (3.1k cached) · 1.8k out" */
function fmtUsage(u: NonNullable<Design['usage']>): string {
  const read = u.cacheReadTokens ?? 0;
  const total = u.inputTokens + read + (u.cacheWriteTokens ?? 0);
  return `${k(total)} in${read ? ` (${k(read)} cached)` : ''} · ${k(u.outputTokens)} out`;
}

const fmt = (t: number) =>
  new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function App() {
  const [tab, setTab] = useState<TabInfo | null>(null);
  const [designs, setDesigns] = useState<Design[]>([]);
  /** Saved designs across every site (for the All tab). */
  const [allDesigns, setAllDesigns] = useState<Design[]>([]);
  const [convos, setConvos] = useState<Conversation[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [view, setView] = useState<View>('chat');
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  /** Live check: is WhimsyWeb's CSS/HTML actually in the page right now? */
  const [applied, setApplied] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>({ apiKey: '', openaiKey: '', model: DEFAULT_MODEL, theme: cachedTheme() });
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [shotConfirmed, setShotConfirmed] = useState(false);
  const [newScope, setNewScope] = useState<DesignScope>('site');
  const [globalConfirmed, setGlobalConfirmed] = useState(false);
  const threadEnd = useRef<HTMLDivElement>(null);
  const activeRequest = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** Bumped by every page-state request; a slow reply for an old tab/request is ignored. */
  const stateSeq = useRef(0);
  const tabSeq = useRef(0);
  const designsSeq = useRef(0);
  /** The tab/host the panel is showing right now; async work checks it before touching state. */
  const tabIdRef = useRef<number | null>(null);
  const hostRef = useRef<string | null>(null);
  const shotBusy = useRef(false);

  const host = tab?.host ?? null;
  hostRef.current = host;
  const current = convos.find((c) => c.id === currentId) ?? null;
  const hostConvos = convos.filter((c) => c.host === host);
  // All-sites designs apply everywhere, so they show up in every site's "This page" list.
  const globalDesigns = allDesigns.filter((d) => d.host === GLOBAL_HOST);
  const pageDesigns = [...designs, ...globalDesigns];
  // Tabs with nothing in them are disabled and show no count.
  const pageCount = hostConvos.length + pageDesigns.length;
  const allCount = convos.length + allDesigns.length;
  const visionOk = supportsImages(settings.model);
  const currentDesign = current?.designId ? allDesigns.find((d) => d.id === current.designId) : undefined;
  const scopeValue: DesignScope = currentDesign ? scopeOf(currentDesign) : newScope;
  // A page-scoped design can only be edited from its own page (the model needs to see that page).
  const wrongPage =
    !!currentDesign &&
    scopeOf(currentDesign) === 'page' &&
    !!tab &&
    normalizePath(currentDesign.path ?? '/') !== tab.path;
  // A chat about an ALL-SITES design can be continued from any site; others only from their own.
  const canSend = !!tab && !!host && (!current || current.host === host || current.scope === 'global') && !wrongPage;

  // The page a page-scoped design lives on (not necessarily the tab you're looking at now).
  const scopePath = normalizePath(
    currentDesign && scopeOf(currentDesign) === 'page' ? (currentDesign.path ?? '/') : (tab?.path ?? '/'),
  );

  const chooseScope = (s: DesignScope) => {
    if (!tab || !host) return;
    if (currentDesign) {
      if (s !== scopeOf(currentDesign) || (s === 'page' && wrongPage)) {
        // Moving an existing design to all sites changes live pages right away: always confirm.
        if (s === 'global' && !window.confirm(GLOBAL_WARNING)) return;
        run(host, { action: 'setScope', id: currentDesign.id, scope: s, path: tab.path });
      }
    } else {
      // For a new chat nothing changes until you send, so one warning per session is enough.
      if (s === 'global' && !globalConfirmed) {
        if (!window.confirm(GLOBAL_WARNING)) return;
        setGlobalConfirmed(true);
      }
      setNewScope(s);
    }
  };

  // ---- data loading ------------------------------------------------------

  const refreshTab = useCallback(async () => {
    const tseq = ++tabSeq.current;
    const t = await readActiveTab();
    if (tseq !== tabSeq.current) return; // a newer lookup superseded this one
    setTab(t);
    tabIdRef.current = t?.id ?? null;
    const seq = ++stateSeq.current;
    let original = false;
    let isApplied = false;
    if (t?.host) {
      try {
        const st: ContentState = await chrome.tabs.sendMessage(t.id, { type: 'ww:getState' });
        original = st.original;
        isApplied = st.applied;
      } catch {
        /* content script not attached (page needs a reload) */
      }
    }
    if (seq !== stateSeq.current || tabIdRef.current !== (t?.id ?? null)) return; // superseded or tab changed
    setShowOriginal(original);
    setApplied(isApplied);
  }, []);

  const refreshDesigns = useCallback(async (h: string | null) => {
    const seq = ++designsSeq.current;
    const list = h ? await getDesignsForHost(h) : [];
    if (seq !== designsSeq.current) return; // an older read finishing late must not overwrite a newer one
    setDesigns(list);
  }, []);

  const refreshConvos = useCallback(async () => {
    setConvos(await getAllConversations());
  }, []);

  const refreshAllDesigns = useCallback(async () => {
    setAllDesigns(await getAllDesigns());
  }, []);

  useEffect(() => {
    refreshTab();
    refreshConvos();
    refreshAllDesigns();
    getSettings().then((s) => {
      setSettings(s);
      cacheTheme(s.theme);
      if (!s.apiKey && !s.openaiKey) setSettingsOpen(true); // first run: no key for either provider yet
    });
    const onActivated = () => refreshTab();
    const onUpdated = (_id: number, info: chrome.tabs.TabChangeInfo) => {
      if (info.url || info.status === 'complete') refreshTab();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [refreshTab, refreshConvos, refreshAllDesigns]);

  useEffect(() => {
    refreshDesigns(host);
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (host && changes[siteKey(host)]) refreshDesigns(host);
      if (Object.keys(changes).some(isConvoKey)) refreshConvos();
      if (Object.keys(changes).some(isSiteKey)) refreshAllDesigns();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [host, refreshDesigns, refreshConvos, refreshAllDesigns]);

  // Keep the before/after button honest: ask the page what is really applied, whenever anything
  // that could change it happens, and every couple of seconds in case the page changes it itself.
  const refreshApplied = useCallback(async () => {
    const id = tab?.id ?? null;
    // A delayed callback created for an earlier tab must not touch the current tab's state.
    if (id !== tabIdRef.current) return;
    const seq = ++stateSeq.current;
    if (!tab?.id || !host) {
      setApplied(false);
      return;
    }
    try {
      const st: ContentState = await chrome.tabs.sendMessage(tab.id, { type: 'ww:getState' });
      if (seq !== stateSeq.current || id !== tabIdRef.current) return; // the tab changed meanwhile
      setApplied(st.applied);
      setShowOriginal(st.original);
    } catch {
      if (seq === stateSeq.current) setApplied(false);
    }
  }, [tab?.id, host]);

  useEffect(() => {
    refreshApplied();
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

  // Theme previews live while you pick it in Settings; Cancel/Back reloads the saved one.
  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  // A screenshot belongs to the tab and site it was taken on: drop it when you switch tabs OR the tab
  // navigates to a different site.
  useEffect(() => {
    const stale = (x: Attachment) => x.label === 'screenshot' && (x.tabId !== tab?.id || x.host !== (tab?.host ?? null));
    setAttachments((a) => (a.some(stale) ? a.filter((x) => !stale(x)) : a));
  }, [tab?.id, tab?.host]);

  // Never sit on a tab that has become empty (and therefore disabled).
  useEffect(() => {
    if ((view === 'page' && pageCount === 0) || (view === 'all' && allCount === 0)) setView('chat');
  }, [view, pageCount, allCount]);

  // Switching to a different site starts a fresh chat for it.
  useEffect(() => {
    setCurrentId((id) => (id && convos.find((c) => c.id === id)?.host !== host ? null : id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [current?.messages.length, pending, view]);

  // ---- actions -----------------------------------------------------------

  const run = async (h: string, m: MutateAction) => {
    try {
      await mutate(h, m);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const addFiles = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    if (!visionOk) {
      setError('The selected model can’t read images. Pick an image-capable model in Settings.');
      return;
    }
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setError(`You can attach up to ${MAX_ATTACHMENTS} images per message.`);
      return;
    }
    try {
      const added = await Promise.all(imgs.slice(0, room).map(toAttachment));
      // Re-check the limit against the latest list: two batches may have been decoding at once.
      setAttachments((a) => [...a, ...added].slice(0, MAX_ATTACHMENTS));
      setError(imgs.length > room ? `Only ${MAX_ATTACHMENTS} images fit in one message.` : null);
    } catch {
      setError('Could not read that image.');
    }
  };

  const addScreenshot = async () => {
    if (!tab || !canSend || busy) return;
    if (!visionOk) {
      setError('The selected model can’t read images. Pick an image-capable model in Settings.');
      return;
    }
    if (attachments.length >= MAX_ATTACHMENTS) {
      setError(`You can attach up to ${MAX_ATTACHMENTS} images per message.`);
      return;
    }
    if (attachments.some((a) => a.label === 'screenshot') || shotBusy.current) return;
    if (!shotConfirmed) {
      if (!window.confirm(SCREENSHOT_WARNING)) return;
      setShotConfirmed(true);
    }
    shotBusy.current = true; // a second click while capturing must not add a second screenshot
    const shotTab = tab.id;
    const shotHost = host;
    try {
      setError(null);
      const res: CaptureResponse = await chrome.runtime.sendMessage({ type: 'ww:capture', tabId: tab.id });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Full-resolution captures can be several MB on large/retina displays: shrink like any other image.
      const blob = await (await fetch(`data:image/jpeg;base64,${res.data}`)).blob();
      const shot = await toAttachment(blob as File);
      // Decoding takes a moment: if you switched tabs meanwhile, this screenshot is of the wrong page.
      if (tabIdRef.current !== shotTab || hostRef.current !== shotHost) return;
      setAttachments((a) =>
        a.length >= MAX_ATTACHMENTS || a.some((x) => x.label === 'screenshot')
          ? a
          : [...a, { ...shot, label: 'screenshot', tabId: shotTab, host: shotHost }],
      );
    } catch {
      setError('Could not process the screenshot.');
    } finally {
      shotBusy.current = false;
    }
  };

  const stop = () => {
    const id = activeRequest.current;
    if (id) chrome.runtime.sendMessage({ type: 'ww:cancel', requestId: id }).catch(() => undefined);
  };

  const send = async () => {
    if (!tab || !canSend || busy) return;
    const text = input.trim();
    if (!text && !attachments.length) return;

    // Never send a screenshot taken on a different tab or site (it could show another site's private
    // content). Re-read the LIVE tab: panel state can lag a navigation by a moment.
    if (attachments.some((a) => a.label === 'screenshot')) {
      const live = await readActiveTab();
      const mismatch = attachments.some(
        (a) => a.label === 'screenshot' && (a.tabId !== live?.id || a.host !== (live?.host ?? null)),
      );
      if (mismatch) {
        setAttachments((a) => a.filter((x) => x.label !== 'screenshot'));
        setError('That screenshot was taken on a different tab or site, so I removed it. Add a new one for this page.');
        return;
      }
    }

    setBusy(true);
    setError(null);
    const requestId = crypto.randomUUID();
    activeRequest.current = requestId;
    const startTab = tab.id;
    const startHost = host;
    const sentInput = input;
    const sentImages = attachments;
    const label = text || (sentImages.some((a) => a.label === 'screenshot') ? '📸 Screenshot' : '📎 Image');
    setPending(sentImages.length && text ? `${text}\n📎 ${sentImages.length} image${sentImages.length > 1 ? 's' : ''}` : label);
    try {
      const msg: BackgroundMessage = {
        type: 'ww:generate',
        tabId: tab.id,
        prompt: text,
        conversationId: currentId ?? undefined,
        scope: newScope,
        requestId,
        images: sentImages.map(({ mediaType, data, label }) => ({ mediaType, data, label })),
      };
      const res: GenerateResponse = await chrome.runtime.sendMessage(msg);
      if (!res.ok) {
        // A stopped request keeps your text and attachments in the box so you can edit and resend.
        if (!res.cancelled) setError(res.error);
      } else {
        // You may have moved to another tab while Claude worked: clear only what THIS message used,
        // and only select its chat if you are still where it belongs.
        const sentIds = new Set(sentImages.map((a) => a.id));
        setInput((cur) => (cur === sentInput ? '' : cur));
        setAttachments((a) => a.filter((x) => !sentIds.has(x.id)));
        await chrome.tabs.sendMessage(startTab, { type: 'ww:setOriginal', original: false }).catch(() => undefined);
        if (tabIdRef.current === startTab && hostRef.current === startHost) {
          setCurrentId(res.conversation.id);
          setShowOriginal(false);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      activeRequest.current = null;
      setPending(null);
      setBusy(false);
    }
  };

  const toggleOriginal = async () => {
    if (!tab) return;
    const next = !showOriginal;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'ww:setOriginal', original: next });
      setShowOriginal(next);
      window.setTimeout(refreshApplied, 250);
    } catch {
      setError('Reload this tab so WhimsyWeb can attach to it.');
    }
  };

  const openConvo = (c: Conversation) => {
    setCurrentId(c.id);
    setView('chat');
    setError(null);
  };

  const newChat = () => {
    setCurrentId(null);
    setView('chat');
    setError(null);
  };

  const removeConvo = async (c: Conversation) => {
    if (!window.confirm(`Delete the conversation "${c.title}"? Its design stays in your saved designs.`)) return;
    if (currentId === c.id) setCurrentId(null);
    await run(c.host, { action: 'deleteConversation', id: c.id });
  };

  const rename = async (d: Design) => {
    const name = window.prompt('Name this design', d.name);
    if (name?.trim()) await run(d.host, { action: 'rename', id: d.id, name: name.trim() });
  };

  const removeDesign = async (d: Design) => {
    if (window.confirm(`Delete "${d.name}"?`)) await run(d.host, { action: 'delete', id: d.id });
  };

  // ---- views -------------------------------------------------------------

  // Why this chat can't be edited from here, and where to go to edit it.
  const blocked = (() => {
    if (!current || canSend) return null;
    const path = current.scope === 'page' ? normalizePath(current.path ?? '/') : '/';
    const label = current.scope === 'page' ? `${current.host}${path}` : current.host;
    let text: string;
    if (!host) text = `You’re not on a website right now. This chat is about ${label}.`;
    else if (current.host !== host) text = `This chat is about ${current.host}, but you’re on ${host}, so edits are turned off.`;
    else text = `This chat’s design is for the page ${path}, and you’re on ${tab?.path ?? '/'}. Open that page to make edits, or use “Apply to” above to move the design here.`;
    return { text, label, host: current.host, path, exact: current.scope === 'page' };
  })();

  /** Switch to a tab already on that site/page, or open it. */
  /** `exact`: a page-scoped design needs that exact page (even "/"); a site-wide one accepts any page. */
  const openTarget = async (targetHost: string, path: string, exact: boolean) => {
    try {
      const tabs = await chrome.tabs.query({ url: `*://${targetHost}/*` });
      const match = tabs.find((t) => {
        if (!exact) return true;
        try {
          return normalizePath(new URL(t.url ?? '').pathname) === path;
        } catch {
          return false;
        }
      });
      if (match?.id) {
        await chrome.tabs.update(match.id, { active: true });
        if (match.windowId) await chrome.windows.update(match.windowId, { focused: true });
      } else {
        await chrome.tabs.create({ url: `https://${targetHost}${path}` });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const blockedNote = blocked && (
    <div className="blocked-note" role="status">
      <span>{blocked.text}</span>
      <button className="link-btn" onClick={() => openTarget(blocked.host, blocked.path, blocked.exact)} title={`Go to ${blocked.label}`}>
        ↗ <span className="link-text">{blocked.label}</span>
      </button>
    </div>
  );

  const lastBotId = [...(current?.messages ?? [])].reverse().find((m) => m.role === 'assistant')?.id;

  const chatView = (
    <>
      <div className="thread">
        {!current && !pending && (
          <div className="intro">
            <p>
              {host ? (
                <>
                  What should <strong>{host}</strong> feel like?
                </>
              ) : (
                'Open a website (http/https) and I’ll help you reimagine it.'
              )}
            </p>
            {host && (
              <div className="ideas">
                {IDEAS.map((i) => (
                  <button key={i} className="chip" onClick={() => setInput(i)}>
                    {i}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {current?.messages.map((m) => (
          <div key={m.id} className={`bubble ${m.role}`}>
            <div>{m.text}</div>
            {m.screenshot || m.imageCount ? (
              <div className="attach-note">
                {m.screenshot ? '📸 screenshot' : ''}
                {m.screenshot && m.imageCount ? ' · ' : ''}
                {m.imageCount ? `📎 ${m.imageCount} image${m.imageCount > 1 ? 's' : ''}` : ''}
              </div>
            ) : null}
            <div className="bubble-foot">
              <span>{fmt(m.createdAt)}</span>
              {m.usage && <span title="Input tokens (cached portion) and output tokens">{fmtUsage(m.usage)}</span>}
              {m.role === 'assistant' && m.snapshot && m.id !== lastBotId && currentDesign && current.host === host && (
                <button
                  className="link"
                  onClick={() => run(current.host, { action: 'restore', conversationId: current.id, messageId: m.id })}
                >
                  Restore this version
                </button>
              )}
            </div>
          </div>
        ))}

        {pending && <div className="bubble user">{pending}</div>}
        {busy && (
          <div className="bubble assistant thinking">
            Weaving magic
            <Dots />
          </div>
        )}
        <div ref={threadEnd} />
      </div>

      {error && <p className="error">{error}</p>}

      {host && (
        <div
          className={dragOver ? 'composer drag' : 'composer'}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            addFiles(Array.from(e.dataTransfer.files));
          }}
        >
          <div className="scope" role="group" aria-label="Apply to">
            <span className="hint">Apply to</span>
            <button className={scopeValue === 'page' ? 'seg active' : 'seg'} disabled={busy || !host} onClick={() => chooseScope('page')}>
              This page
            </button>
            <button className={scopeValue === 'site' ? 'seg active' : 'seg'} disabled={busy || !host} onClick={() => chooseScope('site')}>
              Whole site
            </button>
            <button
              className={scopeValue === 'global' ? 'seg active' : 'seg'}
              disabled={busy || !host}
              onClick={() => chooseScope('global')}
              title="Try this design on every website"
            >
              All sites
            </button>
            <span className="hint scope-note" title={scopeValue === 'page' ? `${host}${scopePath}` : undefined}>
              {scopeValue === 'page'
                ? `only ${host}${scopePath === '/' ? '/ (home page)' : scopePath}`
                : scopeValue === 'global'
                  ? 'every website (turn it off per site in “This page”)'
                  : `every page on ${host}`}
            </span>
          </div>
          <div className="toolbar">
            <button
              className="ghost"
              disabled={!applied && !showOriginal}
              onClick={toggleOriginal}
              title={
                applied || showOriginal
                  ? 'Toggle between the original site and your design'
                  : 'Nothing from WhimsyWeb is applied on this page right now'
              }
            >
              {showOriginal ? '◐ Show mine' : '◑ Show original'}
            </button>
            <button
              className="ghost"
              disabled={!canSend || busy || !visionOk || attachments.length >= MAX_ATTACHMENTS || attachments.some((a) => a.label === 'screenshot')}
              onClick={addScreenshot}
              title={
                visionOk
                  ? 'Capture this tab and send it with your next message (uses more credits)'
                  : 'The selected model can’t read images. Pick another model in Settings.'
              }
            >
              📸 Add screenshot
            </button>
            <button
              className="ghost"
              disabled={!canSend || busy || !visionOk || attachments.length >= MAX_ATTACHMENTS}
              onClick={() => fileInput.current?.click()}
              title={
                visionOk
                  ? 'Attach inspiration images (or paste / drag them in)'
                  : 'The selected model can’t read images. Pick another model in Settings.'
              }
            >
              🖼 Attach image
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              hidden
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
          </div>
          {attachments.length > 0 && (
            <div className="thumbs">
              {attachments.map((a) => (
                <div key={a.id} className={a.label === 'screenshot' ? 'thumb shot' : 'thumb'} title={a.label === 'screenshot' ? 'Screenshot of this tab' : 'Reference image'}>
                  <img src={a.preview} alt="attachment" />
                  <button aria-label="Remove image" onClick={() => setAttachments((x) => x.filter((y) => y.id !== a.id))}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          {attachments.some((a) => a.label === 'screenshot') && (
            <p className="hint">The screenshot is sent with your next message only. Add a note about what to look at.</p>
          )}
          <textarea
            rows={3}
            value={input}
            disabled={!canSend}
            placeholder={
              current
                ? 'Ask for a change… e.g. “warmer colors, bigger headings”'
                : visionOk
                  ? 'Describe how this site should look and feel… (you can attach an image for inspiration)'
                  : 'Describe how this site should look and feel…'
            }
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.some((f) => f.type.startsWith('image/'))) {
                e.preventDefault();
                addFiles(files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && busy) {
                e.preventDefault();
                stop();
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {busy ? (
            <button className="primary stop" onClick={stop} title="Stop this request (Esc)">
              ■ Stop
            </button>
          ) : (
            <button className="primary" disabled={!canSend || (!input.trim() && !attachments.length)} onClick={send}>
              {current ? 'Send ✦' : 'Transform ✦'}
            </button>
          )}
          <button className="new-chat" onClick={newChat} disabled={busy || !current}>
            ＋ New chat
          </button>
          {blockedNote}
        </div>
      )}
      {!host && blockedNote}
    </>
  );

  const convoRow = (c: Conversation, showHost: boolean) => (
    <li key={c.id} className={c.id === currentId ? 'on' : ''}>
      <button className="row-main" onClick={() => openConvo(c)}>
        <strong>{c.title}</strong>
        <span className="hint">
          {showHost ? `${c.host} · ` : ''}
          {c.scope === 'page' ? `Page ${c.path ?? ''}` : c.scope === 'global' ? 'All sites' : 'Whole site'} ·{' '}
          {Math.ceil(c.messages.length / 2)} {c.messages.length <= 2 ? 'message' : 'messages'} · {fmt(c.updatedAt)}
        </span>
      </button>
      <button className="ghost" title="Delete conversation" onClick={() => removeConvo(c)}>
        🗑
      </button>
    </li>
  );

  // ---- saved designs -------------------------------------------------------

  /** Applies a saved design somewhere new with NO AI call, then opens a chat about it. */
  const copyTo = async (d: Design, scope: DesignScope) => {
    if (!tab || !host || busy) return;
    setError(null);
    try {
      const res = await mutate(host, {
        action: 'copyDesign',
        sourceHost: d.host,
        sourceId: d.id,
        scope,
        path: tab.path,
      });
      // You may have switched sites while this ran: the copy still happened, but only open its chat
      // if you are still looking at the site it belongs to.
      if (res.conversationId && hostRef.current === host && tabIdRef.current === tab.id) {
        await refreshConvos();
        if (hostRef.current !== host || tabIdRef.current !== tab.id) return; // switched while reloading the list
        setCurrentId(res.conversationId);
        setView('chat');
        await chrome.tabs.sendMessage(tab.id, { type: 'ww:setOriginal', original: false }).catch(() => undefined);
        window.setTimeout(refreshApplied, 400);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const copyHere = (d: Design) => copyTo(d, scopeOf(d));

  /** "Try on all sites": copies the design into the all-sites slot (CSS only), after a warning. */
  const tryEverywhere = (d: Design) => {
    if (window.confirm(GLOBAL_WARNING)) copyTo(d, 'global');
  };

  /** Turns off everything affecting this site, including all-sites designs (for this site only). */
  const turnAllOffHere = async () => {
    if (!host) return;
    await run(host, { action: 'activate', id: null });
    for (const d of globalDesigns) {
      if (d.enabled && !(d.excludedHosts ?? []).includes(host)) {
        await run(GLOBAL_HOST, { action: 'excludeHost', id: d.id, siteHost: host, excluded: true });
      }
    }
  };

  const designRow = (d: Design, showHost: boolean) => {
    const isGlobal = scopeOf(d) === 'global';
    const sameSite = !!host && (isGlobal || d.host === host);
    const excludedHere = isGlobal && !!host && (d.excludedHosts ?? []).includes(host);
    const fits = sameSite && !!tab && !excludedHere && appliesTo(d, tab.path);
    const on = fits && d.enabled;
    return (
      <li key={d.id} className={on ? 'on' : ''}>
        <div className="meta">
          <strong>{d.name}</strong>
          <span className="hint" title={d.prompt}>
            {showHost && !isGlobal ? `${d.host} · ` : ''}
            {scopeLabel(d)}
            {excludedHere ? ' · off on this site' : ''} · {d.prompt.slice(0, 50)}
          </span>
        </div>
        <div className="actions">
          {fits ? (
            <button onClick={() => run(d.host, { action: 'activate', id: d.id, enabled: !d.enabled })}>
              {d.enabled ? 'On' : 'Apply'}
            </button>
          ) : host && !isGlobal ? (
            <button
              disabled={busy}
              onClick={() => copyHere(d)}
              title={
                sameSite
                  ? 'Copy this design to the page you are on, unchanged (no AI)'
                  : 'Copy this design onto this site, unchanged (no AI). A chat opens so you can adjust it.'
              }
            >
              {sameSite ? 'Use on this page' : 'Try here'}
            </button>
          ) : null}
          {isGlobal && host ? (
            <button
              className={excludedHere ? '' : 'ghost'}
              title={excludedHere ? 'Use this design on this site again' : 'Turn this design off on this site only'}
              onClick={() => run(GLOBAL_HOST, { action: 'excludeHost', id: d.id, siteHost: host, excluded: !excludedHere })}
            >
              {excludedHere ? 'Use here' : 'Skip here'}
            </button>
          ) : null}
          {!isGlobal && host ? (
            <button className="ghost" title="Try this design on all sites" disabled={busy} onClick={() => tryEverywhere(d)}>
              🌐
            </button>
          ) : null}
          <button className="ghost" title="Rename" onClick={() => rename(d)}>
            Aa
          </button>
          <button className="ghost" title="Delete" onClick={() => removeDesign(d)}>
            🗑
          </button>
        </div>
      </li>
    );
  };

  const pageView = (
    <>
      <section className="card">
        <h2>Conversations on {host ?? 'this page'}</h2>
        {!host ? (
          <p className="hint">Open a website to see its conversations.</p>
        ) : hostConvos.length === 0 ? (
          <p className="hint">No conversations for this site yet.</p>
        ) : (
          <ul className="list">{hostConvos.map((c) => convoRow(c, false))}</ul>
        )}
      </section>

      {host && (
        <section className="card">
          <h2>Saved designs</h2>
          {pageDesigns.length === 0 ? (
            <p className="hint">Your creations will live here and re-apply automatically.</p>
          ) : (
            <ul className="list">{pageDesigns.map((d) => designRow(d, false))}</ul>
          )}
          {pageDesigns.some((d) => d.enabled && !(d.excludedHosts ?? []).includes(host)) && (
            <button className="ghost block" onClick={turnAllOffHere}>
              Something broke? Turn everything off on this site
            </button>
          )}
        </section>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );

  // The all-sites group comes first.
  const designHosts = [...new Set(allDesigns.map((d) => d.host))].sort(
    (a, b) => Number(b === GLOBAL_HOST) - Number(a === GLOBAL_HOST),
  );
  const convoHosts = [...new Set(convos.map((c) => c.host))];
  const allView = (
    <>
      {allDesigns.length > 0 && (
        <section className="card">
          <h2>Saved designs</h2>
          {designHosts.map((h) => (
            <div key={h}>
              <h3 className="host-h">{h === GLOBAL_HOST ? 'All sites' : h}</h3>
              <ul className="list">{allDesigns.filter((d) => d.host === h).map((d) => designRow(d, false))}</ul>
            </div>
          ))}
        </section>
      )}
      {convos.length > 0 && (
        <section className="card">
          <h2>Conversations</h2>
          {convoHosts.map((h) => (
            <div key={h}>
              <h3 className="host-h">{h}</h3>
              <ul className="list">{convos.filter((c) => c.host === h).map((c) => convoRow(c, false))}</ul>
            </div>
          ))}
        </section>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );

  const closeSettings = async () => {
    setSettings(await getSettings()); // discard unsaved edits
    setSettingsOpen(false);
  };

  const settingsScreen = (
    <section className="card settings">
      <div className="theme-field">
        <span className="field-label">Theme</span>
        <div className="theme-tiles" role="radiogroup" aria-label="Theme">
          {THEME_OPTIONS.map((t) => (
            <button
              key={t.id}
              role="radio"
              aria-checked={settings.theme === t.id}
              className={settings.theme === t.id ? 'theme-tile active' : 'theme-tile'}
              onClick={() => setSettings({ ...settings, theme: t.id })}
            >
              <span className="swatch" aria-hidden="true">
                {t.swatch.map((c) => (
                  <i key={c} style={{ background: c }} />
                ))}
              </span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        <p className="hint">Changes the look of this panel only, not the websites you redesign.</p>
      </div>
      <label>
        Anthropic API key <span className="hint">(Claude models)</span>
        <input
          type="password"
          value={settings.apiKey}
          placeholder="sk-ant-…"
          onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
        />
      </label>
      <label>
        OpenAI API key <span className="hint">(GPT models)</span>
        <input
          type="password"
          value={settings.openaiKey}
          placeholder="sk-…"
          onChange={(e) => setSettings({ ...settings, openaiKey: e.target.value })}
        />
      </label>
      <label>
        Model
        <select
          value={MODEL_OPTIONS.some((m) => m.id === settings.model) ? settings.model : CUSTOM_MODEL}
          onChange={(e) => setSettings({ ...settings, model: e.target.value === CUSTOM_MODEL ? '' : e.target.value })}
        >
          <optgroup label="Claude (Anthropic)">
            {MODEL_OPTIONS.filter((m) => m.provider === 'anthropic').map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="GPT (OpenAI)">
            {MODEL_OPTIONS.filter((m) => m.provider === 'openai').map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </optgroup>
          <option value={CUSTOM_MODEL}>Custom model id…</option>
        </select>
      </label>
      {!MODEL_OPTIONS.some((m) => m.id === settings.model) && (
        <label>
          Custom model id
          <input
            value={settings.model}
            placeholder="e.g. a GPT model id from your OpenAI account"
            onChange={(e) => setSettings({ ...settings, model: e.target.value })}
          />
          <span className="hint">Ids starting with “claude” use your Anthropic key; anything else uses your OpenAI key.</span>
        </label>
      )}
      {(providerOf(settings.model) === 'openai' ? !settings.openaiKey : !settings.apiKey) && (
        <p className="warn">
          The selected model needs {providerOf(settings.model) === 'openai' ? 'an OpenAI' : 'an Anthropic'} API key. Paste it
          above, or pick a model from the other provider.
        </p>
      )}
      <p className="hint">
        {supportsImages(settings.model)
          ? 'This model can read images, so you can attach inspiration images and screenshots of the page.'
          : 'This model is text-only, so image attachments are turned off.'}
      </p>
      <p className="hint">
        Page outlines, and any screenshots or images you attach, are sent to the provider of the selected model
        (Anthropic for Claude, OpenAI for GPT).
      </p>
      <p className="hint">
        Keys are stored locally in this browser. Development use only; a production release should call a backend proxy instead
        of shipping a key.
      </p>
      <div className="row">
        <button className="primary" onClick={async () => {
          await saveSettings({ ...settings, model: settings.model.trim() || DEFAULT_MODEL });
          cacheTheme(settings.theme);
          setSettingsOpen(false);
        }}>
          Save
        </button>
        <button onClick={closeSettings}>Cancel</button>
      </div>
    </section>
  );

  return (
    <div className="app">
      {/* Pinned to the top so navigation is always reachable while the chat scrolls. */}
      <div className="topbar">
        <header>
          {settingsOpen ? (
            <>
              <button className="ghost back" onClick={closeSettings} aria-label="Back">
                ←
              </button>
              <h1>Settings</h1>
              <span className="icon-spacer" />
            </>
          ) : (
            <>
              <h1>
                <span className="spark">✦</span> WhimsyWeb
              </h1>
              <button className="icon-btn" onClick={() => setSettingsOpen(true)} aria-label="Settings" title="Settings">
                ⚙
              </button>
            </>
          )}
        </header>

        {!settingsOpen && (
          <nav className="tabs">
            {(
              [
                ['chat', 'Chat', true],
                ['page', `This page${pageCount ? ` (${pageCount})` : ''}`, pageCount > 0],
                ['all', `All${allCount ? ` (${allCount})` : ''}`, allCount > 0],
              ] as [View, string, boolean][]
            ).map(([v, label, enabled]) => (
              <button
                key={v}
                className={view === v ? 'tab active' : 'tab'}
                disabled={!enabled}
                title={enabled ? undefined : 'Nothing saved here yet'}
                onClick={() => setView(v)}
              >
                {label}
              </button>
            ))}
          </nav>
        )}
      </div>

      {settingsOpen ? settingsScreen : view === 'chat' ? chatView : view === 'page' ? pageView : allView}
    </div>
  );
}
