import { useCallback, useEffect, useRef, useState } from 'react';
import { GLOBAL_HOST, appliesTo, normalizePath, scopeOf } from '../shared/scope';
import { SITE_URL } from '../shared/site';
import { pickIdeas } from './ideas';
import { CheckIcon, ChatIcon, GearIcon, HistoryIcon, LibraryIcon, PageIcon, EyeIcon, CameraIcon, ImageIcon, PlusIcon, StopIcon } from './Icons';
import { DesignRow, GroupHead, HistoryView, LibraryView, byName, byText, siteName, type LibCtx } from './Library';
import { applyTheme, cacheTheme, cachedTheme } from './theme';
import {
  getAllConversations,
  getAllDesigns,
  FAVICONS_KEY,
  getDesignsForHost,
  getFavicons,
  getSettings,
  getUsage,
  isConvoKey,
  isSiteKey,
  isUsageKey,
  saveSettings,
  savePreviewsSetting,
  saveTheme,
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
  type Provider,
  type Settings,
  type UsageStats,
  type UsageTotals,
  totalTokens,
} from '../shared/types';

type MutateAction =
  | { action: 'resetUsage' }
  | { action: 'activate'; id: string | null; enabled?: boolean }
  | { action: 'setScope'; id: string; scope: DesignScope; path: string }
  | { action: 'copyDesign'; sourceHost: string; sourceId: string; scope: DesignScope; path: string }
  | { action: 'excludeHost'; id: string; siteHost: string; excluded: boolean }
  | { action: 'delete'; id: string }
  | { action: 'exportDraft'; id: string }
  | { action: 'saveFavicon'; dataUrl: string }
  | { action: 'capturePreview'; id: string }
  | { action: 'clearThumbs' }
  | { action: 'rename'; id: string; name: string }
  | { action: 'deleteConversation'; id: string }
  | { action: 'restore'; conversationId: string; messageId: string };

/** All writes go through the background worker's serialized queue. */
async function mutate(host: string, m: MutateAction): Promise<{ conversationId?: string; preview?: string; reason?: string; cleared?: number }> {
  const msg = { type: 'ww:mutate', host, ...m } as MutateMessage;
  const res = await chrome.runtime.sendMessage(msg);
  if (!res?.ok) throw new Error(res?.error ?? 'Could not save changes.');
  return res;
}

/** Names the provider that will actually receive the image (it depends on the selected model). */
const screenshotWarning = (provider: Provider): string =>
  `This takes a screenshot of the current tab and sends it to ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} with your next message.\n\n` +
  '• Images use more credits than text.\n' +
  '• Anything visible on the page (including personal info) is included.\n\n' +
  'Add the screenshot?';

const GLOBAL_WARNING =
  'Apply this design to ALL websites?\n\n' +
  '• It was written for one site, so parts of it may not fit others.\n' +
  '• It could change sites you did not expect (banking, email, work tools).\n' +
  '• You can switch it off for any single site from the “This site” tab.\n\n' +
  'Apply to all sites?';

const CUSTOM_MODEL = '__custom__';

type View = 'chat' | 'page' | 'library' | 'history';

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
  /** The tab's address (used to explain why browser-owned pages cannot be restyled). */
  url: string;
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
  return { id: tab.id, host, path, url: tab.url ?? '' };
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

/** 1,234 -> "1.2k", 2,500,000 -> "2.50M". The exact figure goes in a tooltip. */
const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

const PROVIDER_LABEL: Record<Provider, string> = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI (GPT)' };

/** A proportional bar. Segments with no tokens are not drawn. */
function Bar({ parts, label }: { parts: { cls: string; value: number; title: string }[]; label: string }) {
  const sum = parts.reduce((a, p) => a + p.value, 0);
  return (
    <div className="bar" role="img" aria-label={label}>
      {sum > 0 &&
        parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <span key={p.cls} className={`bar-seg ${p.cls}`} style={{ width: `${(p.value / sum) * 100}%` }} title={p.title} />
          ))}
    </div>
  );
}

export function UsageSection({
  usage,
  selected,
  onReset,
}: {
  usage: UsageStats | null;
  selected: Provider;
  onReset: () => void;
}) {
  if (!usage) return <p className="hint">Loading usage…</p>;
  const providers: Provider[] = ['anthropic', 'openai'];
  const totals: Record<Provider, UsageTotals> = { anthropic: usage.anthropic, openai: usage.openai };
  const grand = providers.reduce((a, p) => a + totalTokens(totals[p]), 0);
  const models = Object.entries(usage.byModel);

  return (
    <div className="usage">
      <div className="usage-head">
        <span className="field-label">Total so far</span>
        <strong title={`${grand.toLocaleString()} tokens`}>{fmtTokens(grand)} total</strong>
      </div>

      {grand === 0 ? (
        <p className="hint">Nothing used yet. Counts appear here after your first request.</p>
      ) : (
        <Bar
          label={`Share of total tokens: ${providers.map((p) => `${PROVIDER_LABEL[p]} ${fmtTokens(totalTokens(totals[p]))}`).join(', ')}`}
          parts={providers.map((p) => ({
            cls: `series-${p}`,
            value: totalTokens(totals[p]),
            title: `${PROVIDER_LABEL[p]}: ${totalTokens(totals[p]).toLocaleString()} tokens`,
          }))}
        />
      )}

      {providers.map((p) => {
        const t = totals[p];
        const total = totalTokens(t);
        return (
          <div key={p} className={p === selected ? 'usage-card selected' : 'usage-card'}>
            <div className="usage-row">
              <span className="usage-name">
                <i className={`dot series-${p}`} aria-hidden="true" />
                {PROVIDER_LABEL[p]}
                {p === selected && <em className="badge">selected model</em>}
              </span>
              <strong title={`${total.toLocaleString()} tokens`}>{fmtTokens(total)}</strong>
            </div>
            <Bar
              label={`${PROVIDER_LABEL[p]}: ${t.inputTokens} new input, ${t.cacheReadTokens + t.cacheWriteTokens} cached, ${t.outputTokens} output`}
              parts={[
                { cls: 'part-in', value: t.inputTokens, title: `New input: ${t.inputTokens.toLocaleString()}` },
                { cls: 'part-cache', value: t.cacheReadTokens + t.cacheWriteTokens, title: `Cached input: ${(t.cacheReadTokens + t.cacheWriteTokens).toLocaleString()}` },
                { cls: 'part-out', value: t.outputTokens, title: `Output: ${t.outputTokens.toLocaleString()}` },
              ]}
            />
            <div className="usage-legend">
              <span><i className="dot part-in" aria-hidden="true" />Input {fmtTokens(t.inputTokens)}</span>
              <span><i className="dot part-cache" aria-hidden="true" />Cached {fmtTokens(t.cacheReadTokens + t.cacheWriteTokens)}</span>
              <span><i className="dot part-out" aria-hidden="true" />Output {fmtTokens(t.outputTokens)}</span>
              <span>{t.requests} {t.requests === 1 ? 'request' : 'requests'}</span>
            </div>
            {models
              .filter(([, m]) => m.provider === p)
              .map(([id, m]) => (
                <div key={id} className="usage-model">
                  <span>{id}</span>
                  <span title={`${totalTokens(m).toLocaleString()} tokens`}>{fmtTokens(totalTokens(m))}</span>
                </div>
              ))}
          </div>
        );
      })}

      <p className="hint">
        Tokens as reported by each provider{usage.since ? `, since ${new Date(usage.since).toLocaleDateString()}` : ''}. This is
        tokens, not cost (prices vary by model). A request you stop before it finishes is not counted, because the provider
        only reports usage with a completed response.
      </p>
      {grand > 0 && (
        <button className="ghost" onClick={onReset}>
          Reset counts
        </button>
      )}
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<TabInfo | null>(null);
  const [designs, setDesigns] = useState<Design[]>([]);
  /** Saved designs across every site (for the All tab). */
  const [allDesigns, setAllDesigns] = useState<Design[]>([]);
  const [convos, setConvos] = useState<Conversation[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [view, setView] = useState<View>('chat');
  const [favicons, setFavicons] = useState<Record<string, string>>({});
  const [libQuery, setLibQuery] = useState('');
  const [histQuery, setHistQuery] = useState('');
  const faviconTried = useRef(new Set<string>());
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  /** Live check: is Whimsy Web's CSS/HTML actually in the page right now? */
  const [applied, setApplied] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** What is saved right now, to tell whether the keys/model have unsaved edits. */
  const [savedModels, setSavedModels] = useState<Pick<Settings, 'apiKey' | 'openaiKey' | 'model'> | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [settings, setSettings] = useState<Settings>({ apiKey: '', openaiKey: '', model: DEFAULT_MODEL, theme: cachedTheme(), previews: true });
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [shotConfirmed, setShotConfirmed] = useState(false);
  const [newScope, setNewScope] = useState<DesignScope>('site');
  const [globalConfirmed, setGlobalConfirmed] = useState(false);
  const [usage, setUsage] = useState<UsageStats | null>(null);
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
  // A fresh handful of example prompts each time the chat is opened, revisited or the tab changes (from a hand-written pool, no AI).
  const [ideas, setIdeas] = useState<string[]>(() => pickIdeas(4));
  useEffect(() => {
    if (view === 'chat') setIdeas((prev) => pickIdeas(4, prev));
  }, [view, tab?.id, tab?.path, currentId]);
  hostRef.current = host;
  const current = convos.find((c) => c.id === currentId) ?? null;
  const hostConvos = convos.filter((c) => c.host === host);
  // All-sites designs apply everywhere, so they show up in every site's "This site" list.
  const globalDesigns = allDesigns.filter((d) => d.host === GLOBAL_HOST);
  const pageDesigns = [...designs, ...globalDesigns];
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
  // A saved design that is switched on for this page counts as applied straight away, without waiting for the page to report back.
  const themeHere = !!tab && !!host && allDesigns.some((d) => d.enabled && (d.host === host || (scopeOf(d) === 'global' && !(d.excludedHosts ?? []).includes(host))) && appliesTo(d, tab.path));
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
      setSavedModels({ apiKey: s.apiKey, openaiKey: s.openaiKey, model: s.model });
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

  // Token usage: load when Settings opens and keep it live while open (counts change as requests finish).
  useEffect(() => {
    if (!settingsOpen) return;
    let alive = true;
    const load = () => getUsage().then((u) => alive && setUsage(u));
    load();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && Object.keys(changes).some(isUsageKey)) load();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, [settingsOpen]);

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

  // Site icons: load the saved ones, and save the current site's icon once (only for sites that have a design or chat).
  useEffect(() => {
    getFavicons().then(setFavicons);
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[FAVICONS_KEY]) getFavicons().then(setFavicons);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);
  useEffect(() => {
    const id = tab?.id;
    const h = tab?.host;
    if (!id || !h || favicons[h] || faviconTried.current.has(h)) return;
    if (!allDesigns.some((d) => d.host === h) && !convos.some((c) => c.host === h)) return;
    faviconTried.current.add(h);
    (async () => {
      try {
        const url = (await chrome.tabs.get(id)).favIconUrl;
        if (!url || !/^(https?:|data:image\/)/.test(url)) return;
        const blob = await (await fetch(url)).blob();
        if (blob.size > 300_000) return;
        const objectUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.src = objectUrl;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = c.height = 32;
        c.getContext('2d')!.drawImage(img, 0, 0, 32, 32);
        URL.revokeObjectURL(objectUrl);
        await mutate(h, { action: 'saveFavicon', dataUrl: c.toDataURL('image/png') });
      } catch {
        /* no icon available: the library shows a ✦ */
      }
    })();
  }, [tab?.id, tab?.host, favicons, allDesigns, convos]);

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
    if (!tab || !canSend) return;
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
      if (!window.confirm(screenshotWarning(providerOf(settings.model)))) return;
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

  // `busy` only turns true after the live-tab check below, so a fast double click could start two requests
  // (two API charges, and Stop could only cancel one). This lock closes that window synchronously.
  const sendLock = useRef(false);
  const send = async () => {
    if (sendLock.current) return;
    sendLock.current = true;
    try {
      await sendOnce();
    } finally {
      sendLock.current = false;
    }
  };

  const sendOnce = async () => {
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
    // Clear the box as soon as the message is on its way (the pending bubble shows what was sent). If the request
    // fails or is stopped, the text and images come back below, unless you have already started typing something new.
    const sentIds = new Set(sentImages.map((a) => a.id));
    setInput('');
    setAttachments((a) => a.filter((x) => !sentIds.has(x.id)));
    let restore = true;
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
        if (!res.cancelled) setError(res.error);
      } else {
        restore = false;
        // You may have moved to another tab while Claude worked: clear only what THIS message used,
        // and only select its chat if you are still where it belongs.
        await chrome.tabs.sendMessage(startTab, { type: 'ww:setOriginal', original: false }).catch(() => undefined);
        // Give the page a moment to show the new design, then make its blurred preview (only if you are still on that tab).
        window.setTimeout(() => {
          if (tabIdRef.current === startTab) void refreshPreview(res.design, true);
        }, 1400);
        if (tabIdRef.current === startTab && hostRef.current === startHost) {
          setCurrentId(res.conversation.id);
          setShowOriginal(false);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (restore) {
        setInput((cur) => (cur === '' ? sentInput : cur));
        setAttachments((a) => [...sentImages.filter((x) => !a.some((y) => y.id === x.id)), ...a].slice(0, MAX_ATTACHMENTS));
      }
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
      setError('Reload this tab so Whimsy Web can attach to it.');
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
    const name = window.prompt('Name this design', d.name)?.trim();
    if (name && name !== d.name) await run(d.host, { action: 'rename', id: d.id, name });
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
    else text = `This chat’s design is for the page ${path}, and you’re on ${tab?.path ?? '/'}. Open that page to keep editing, or start a new chat here.`;
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
                <>
                  Open a website (http/https) and I’ll help you reimagine it.
                  {/* Chrome hides the address of its own pages from extensions, so this shows for any page that is not a normal website. */}
                  <br />
                  <span className="hint">(Google does not allow extensions to make changes to the new tab page)</span>
                </>
              )}
            </p>
            {host && (
              <div className="ideas">
                {ideas.map((i) => (
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
          <div className="scope" role="group" aria-label="Apply to" title={currentDesign ? 'This chat stays with where it started. Start a new chat to apply a design somewhere else.' : undefined}>
            <span className="hint">Apply to</span>
            <button className={scopeValue === 'page' ? 'seg active' : 'seg'} disabled={busy || !host || !!currentDesign} onClick={() => chooseScope('page')}>
              This page
            </button>
            <button className={scopeValue === 'site' ? 'seg active' : 'seg'} disabled={busy || !host || !!currentDesign} onClick={() => chooseScope('site')}>
              Whole site
            </button>
            <button
              className={scopeValue === 'global' ? 'seg active' : 'seg'}
              disabled={busy || !host || !!currentDesign}
              onClick={() => chooseScope('global')}
              title={currentDesign ? undefined : 'Try this design on every website'}
            >
              All sites
            </button>
            <span className="hint scope-note" title={scopeValue === 'page' ? `${host}${scopePath}` : undefined}>
              {scopeValue === 'page'
                ? `only ${host}${scopePath === '/' ? '/ (home page)' : scopePath}`
                : scopeValue === 'global'
                  ? 'every website (turn it off per site in “This site”)'
                  : `every page on ${host}`}
            </span>
          </div>
          <div className="toolbar">
            <button
              className="ghost"
              disabled={!applied && !themeHere && !showOriginal}
              onClick={toggleOriginal}
              title={
                applied || themeHere || showOriginal
                  ? 'Toggle between the original site and your design'
                  : 'Nothing from Whimsy Web is applied on this page right now'
              }
            >
              <EyeIcon size={19} />
              {showOriginal ? 'Show mine' : 'Show original'}
            </button>
            <button
              className="ghost"
              disabled={!canSend || !visionOk || attachments.length >= MAX_ATTACHMENTS || attachments.some((a) => a.label === 'screenshot')}
              onClick={addScreenshot}
              title={
                visionOk
                  ? 'Capture this tab and send it with your next message (uses more credits)'
                  : 'The selected model can’t read images. Pick another model in Settings.'
              }
            >
              <CameraIcon size={19} />
              Add screenshot
            </button>
            <button
              className="ghost"
              disabled={!canSend || !visionOk || attachments.length >= MAX_ATTACHMENTS}
              onClick={() => fileInput.current?.click()}
              title={
                visionOk
                  ? 'Attach inspiration images (or paste / drag them in)'
                  : 'The selected model can’t read images. Pick another model in Settings.'
              }
            >
              <ImageIcon size={19} />
              Attach image
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
            <p className="hint shot-note">The screenshot is sent with your next message only. Add a note about what to look at.</p>
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
              <StopIcon size={16} />
              Stop
            </button>
          ) : (
            <button className="primary" disabled={!canSend || (!input.trim() && !attachments.length)} onClick={send}>
              {current ? 'Send ✦' : 'Transform ✦'}
            </button>
          )}
          <button className="new-chat" onClick={newChat} disabled={busy || !current}>
            <PlusIcon size={18} />
            New chat
          </button>
          {blockedNote}
        </div>
      )}
      {!host && blockedNote}
    </>
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

  const convoByDesign = new Map(convos.filter((c) => c.designId).map((c) => [c.designId as string, c]));
  const designsById = new Map(allDesigns.map((d) => [d.id, d]));
  const libCtx: LibCtx = {
    host,
    fits: (d) => {
      const isGlobal = scopeOf(d) === 'global';
      const sameSite = !!host && (isGlobal || d.host === host);
      const excludedHere = isGlobal && !!host && (d.excludedHosts ?? []).includes(host);
      return sameSite && !!tab && !excludedHere && appliesTo(d, tab.path);
    },
    busy,
    favicons,
    convoByDesign,
    fallbackSrc: chrome.runtime.getURL(`fallback-${settings.theme}.webp`), // one per panel theme: light, dark, afterhours
    act: {
      activate: (d, enabled) =>
        void run(d.host, { action: 'activate', id: d.id, enabled }).then(() => {
          if (enabled && !d.thumb) window.setTimeout(() => void refreshPreview(d, true), 1100);
        }),
      refreshPreview: (d) => void refreshPreview(d),
      excludeHere: (d, excluded) => void (host && run(GLOBAL_HOST, { action: 'excludeHost', id: d.id, siteHost: host, excluded })),
      copyHere: (d) => void copyHere(d),
      tryEverywhere,
      share: (d) => void run(d.host, { action: 'exportDraft', id: d.id }),
      rename: (d) => void rename(d),
      remove: (d) => void removeDesign(d),
      openChat: openConvo,
      openSite: (h) => { if (/^[a-z0-9.-]+$/i.test(h)) void chrome.tabs.create({ url: `https://${h}/` }); },
      viewTheme: (d) => void (d.community && chrome.tabs.create({ url: `${SITE_URL}/themes/${encodeURIComponent(d.community.slug)}` })),
    },
  };

  const pageView = (
    <div className="lib">
      {!host ? (
        <div className="empty-note">
          <strong>No website open</strong>Open a website to see its designs here.
        </div>
      ) : (
        <section className="group">
          <GroupHead host={host} count={pageDesigns.length} favicons={favicons} />
          {pageDesigns.length === 0 ? (
            <div className="empty-note">
              <strong>Nothing for {siteName(host)} yet</strong>Your creations will live here and re-apply automatically.
            </div>
          ) : (
            <ul className="rows">
              {[...pageDesigns].sort(byName).map((d) => (
                <DesignRow key={d.id} d={d} ctx={libCtx} />
              ))}
            </ul>
          )}
          {pageDesigns.some((d) => d.enabled && !(d.excludedHosts ?? []).includes(host)) && (
            <button className="ghost block" onClick={turnAllOffHere}>
              Something broke? Turn everything off on this site
            </button>
          )}
          {hostConvos.length > 0 && (
            <button
              className="ghost block"
              onClick={() => {
                setHistQuery(siteName(host));
                setView('history');
              }}
            >
              See {hostConvos.length} {hostConvos.length === 1 ? 'chat' : 'chats'} about {siteName(host)} in History
            </button>
          )}
        </section>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );

  const libraryView = (
    <>
      <LibraryView designs={allDesigns} ctx={libCtx} query={libQuery} setQuery={setLibQuery} onExplore={() => void chrome.tabs.create({ url: `${SITE_URL}/explore` })} />
      {error && <p className="error">{error}</p>}
    </>
  );

  const historyView = (
    <>
      <HistoryView convos={convos} designsById={designsById} favicons={favicons} currentId={currentId} query={histQuery} setQuery={setHistQuery} onOpen={openConvo} onRemove={(c) => void removeConvo(c)} onNew={newChat} />
      {error && <p className="error">{error}</p>}
    </>
  );

  const resetUsageCounts = async () => {
    if (!window.confirm('Reset all token counts to zero?')) return;
    await run(GLOBAL_HOST, { action: 'resetUsage' });
  };

  const modelsDirty = !!savedModels && (settings.apiKey !== savedModels.apiKey || settings.openaiKey !== savedModels.openaiKey || settings.model !== savedModels.model);

  const flash = (text: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  };

  /** The theme is its own setting: choosing one saves it straight away. */
  const chooseTheme = async (theme: Settings['theme']) => {
    setSettings((cur) => ({ ...cur, theme }));
    cacheTheme(theme);
    await saveTheme(theme);
  };

  /** The previews switch saves straight away, like the theme. */
  const setPreviews = async (on: boolean) => {
    setSettings((cur) => ({ ...cur, previews: on }));
    await savePreviewsSetting(on);
    flash(on ? 'Previews on' : 'Previews off');
  };
  const clearPreviews = async () => {
    if (!window.confirm('Delete every saved design preview? They are made again when you apply a design.')) return;
    const r = await mutate(GLOBAL_HOST, { action: 'clearThumbs' });
    flash(`Cleared ${r.cleared ?? 0} ${r.cleared === 1 ? 'preview' : 'previews'}`);
  };

  /** Asks the worker for a blurred preview of a design; it only succeeds when the design is on screen and switched on. */
  const refreshPreview = async (d: Design, quiet = false) => {
    if (!settings.previews) return;
    try {
      const r = await mutate(d.host, { action: 'capturePreview', id: d.id });
      if (!quiet) flash(r.preview === 'saved' ? 'Preview updated' : r.reason === 'not-here' || r.reason === 'not-on' ? 'Open the site with the design on to update its preview' : r.reason === 'incognito' ? 'Previews are not made in private windows' : 'Could not update the preview');
    } catch {
      if (!quiet) flash('Could not update the preview');
    }
  };

  /** Saves the API keys and model only, and stays on this page. */
  const saveModels = async () => {
    const model = settings.model.trim() || DEFAULT_MODEL;
    await saveSettings({ ...settings, model });
    setSettings((cur) => ({ ...cur, model }));
    setSavedModels({ apiKey: settings.apiKey, openaiKey: settings.openaiKey, model });
    flash('Saved');
  };

  const discardModels = () => {
    if (savedModels) setSettings((cur) => ({ ...cur, ...savedModels }));
  };

  const closeSettings = async () => {
    if (modelsDirty && !window.confirm('You have unsaved changes to your API keys or model. Leave without saving?')) return;
    const fresh = await getSettings();
    setSettings(fresh);
    setSavedModels({ apiKey: fresh.apiKey, openaiKey: fresh.openaiKey, model: fresh.model });
    setSettingsOpen(false);
  };

  const settingsScreen = (
    <div className="settings-page">
      <section className="set-card" aria-labelledby="set-appearance">
        <div className="set-head">
          <h2 id="set-appearance">Appearance</h2>
          <p className="set-sub">Changes the look of this panel only, not the websites you redesign. Applies as soon as you pick one.</p>
        </div>
        <div className="theme-tiles" role="radiogroup" aria-label="Theme">
          {THEME_OPTIONS.map((t) => (
            <button key={t.id} role="radio" aria-checked={settings.theme === t.id} className={settings.theme === t.id ? 'theme-tile active' : 'theme-tile'} onClick={() => void chooseTheme(t.id)}>
              <span className="swatch" aria-hidden="true">
                {t.swatch.map((c) => (
                  <i key={c} style={{ background: c }} />
                ))}
              </span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="set-card" aria-labelledby="set-models">
        <div className="set-head">
          <h2 id="set-models">AI models</h2>
          <p className="set-sub">Your API keys and which model writes your designs. Press Save to apply changes here.</p>
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
      <div className="set-actions">
        <button className="primary save-btn" onClick={() => void saveModels()} disabled={!modelsDirty}>
          Save
        </button>
        {modelsDirty && (
          <button className="ghost" onClick={discardModels}>
            Discard changes
          </button>
        )}
        {!modelsDirty && <span className="hint set-clean">Nothing to save</span>}
      </div>
      </section>

      <section className="set-card" aria-labelledby="set-previews">
        <div className="set-head">
          <h2 id="set-previews">Design previews</h2>
          <p className="set-sub">The small pictures in your Library. Applies as soon as you change it.</p>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={settings.previews} onChange={(e) => void setPreviews(e.target.checked)} />
          <span>Save a blurred preview of each design</span>
        </label>
        <p className="hint">
          Before a preview is made, text on the page is replaced with plain bars and pictures are blurred. The screenshot is then shrunk to a few dozen pixels, so no text or detail is kept. Only that tiny image is stored in this browser; the full screenshot is never saved or sent anywhere, and nothing is captured in private windows.
        </p>
        <div className="set-actions">
          <button onClick={() => void clearPreviews()}>Clear all previews</button>
        </div>
      </section>

      <section className="set-card" aria-labelledby="set-usage">
        <div className="set-head">
          <h2 id="set-usage">Token usage</h2>
          <p className="set-sub">What your requests have used so far, from the providers' own counts.</p>
        </div>
        <UsageSection usage={usage} selected={providerOf(settings.model)} onReset={resetUsageCounts} />
      </section>
    </div>
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
              <div className="brand-row">
                <img className="brand-logo" src={chrome.runtime.getURL('icons/icon48.png')} alt="" width={42} height={42} />
                <h1 className="brand-name">Whimsy Web</h1>
              </div>
              <span className="header-actions">
                <button className="icon-btn" onClick={() => setSettingsOpen(true)} aria-label="Settings" title="Settings">
                  <GearIcon size={24} />
                </button>
              </span>
            </>
          )}
        </header>

        {!settingsOpen && (
          <nav className="tabs" aria-label="Sections">
            {(
              [
                ['chat', 'Chat', <ChatIcon key="c" size={20} />],
                ['page', 'This site', <PageIcon key="p" size={20} />],
                ['library', 'Library', <LibraryIcon key="l" size={20} />],
                ['history', 'History', <HistoryIcon key="h" size={20} />],
              ] as [View, string, JSX.Element][]
            ).map(([v, label, icon]) => (
              <button key={v} className={view === v ? 'tab active' : 'tab'} aria-current={view === v ? 'page' : undefined} aria-label={label} title={label} onClick={() => setView(v)}>
                {icon}
                <span className="tab-label">{label}</span>
              </button>
            ))}
          </nav>
        )}
      </div>

      {toast && (
        <div className="toast" role="status" aria-live="polite">
          <CheckIcon size={16} /> {toast}
        </div>
      )}
      {settingsOpen ? settingsScreen : view === 'chat' ? chatView : view === 'page' ? pageView : view === 'library' ? libraryView : historyView}
    </div>
  );
}
