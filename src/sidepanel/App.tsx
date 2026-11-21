import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { GLOBAL_HOST, appliesTo, normalizePath, scopeOf } from '../shared/scope';
import { SITE_URL } from '../shared/site';
import { pickIdeas } from './ideas';
import { cropBox, type SnipRect } from '../shared/snip';
import { CheckIcon, ChatIcon, GearIcon, HistoryIcon, LibraryIcon, PageIcon, EyeIcon, CameraIcon, ImageIcon, PlusIcon, StopIcon, PaperclipIcon, ScissorsIcon, ArrowLeftIcon, PencilIcon } from './Icons';
import { Editor } from './Editor';
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
  getPrefs,
  savePrefs,
  saveModelSettings,
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
  INTENSITY_LEVELS,
  DEFAULT_INTENSITY,
  clampIntensity,
  POLISH_LEVELS,
  DEFAULT_POLISH,
  clampPolish,
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

const GLOBAL_WARNING =
  'Apply this design to ALL websites?\n\n' +
  '• It was written for one site, so parts of it may not fit others.\n' +
  '• It could change sites you did not expect (banking, email, work tools).\n' +
  '• You can switch it off for any single site from the “This site” tab.\n\n' +
  'Apply to all sites?';

const CUSTOM_MODEL = '__custom__';

/** Which chat was last open for each site, so coming back to a site (or reopening the panel) brings its chat back. */
const CHAT_MEMORY_KEY = 'ww.chatByHost';
function loadChatMemory(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(CHAT_MEMORY_KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
function saveChatMemory(m: Record<string, string>): void {
  try {
    localStorage.setItem(CHAT_MEMORY_KEY, JSON.stringify(m));
  } catch {
    /* not remembered */
  }
}

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

      <p className="hint">Token usage, not cost{usage.since ? `, since ${new Date(usage.since).toLocaleDateString()}` : ""}.</p>
      {grand > 0 && (
        <button className="ghost" onClick={onReset}>
          Reset counts
        </button>
      )}
    </div>
  );
}

/** A bar with a dot per level (Intensity, Polish). Drag the knob or click a dot; the arrow keys work too. */
function LevelBar({ label, levels, value, onChange, disabled }: { label: string; levels: readonly { level: number; name: string; hint: string }[]; value: number; onChange: (level: number) => void; disabled?: boolean }) {
  const n = levels.length;
  const cur = levels[value - 1] ?? levels[0];
  return (
    <div className={disabled ? 'intensity disabled' : 'intensity'}>
      <div className="intensity-head">
        <span className="intensity-label">{label}</span>
        <span className="intensity-name">{cur.name}</span>
        <span className="intensity-hint">{cur.hint}</span>
      </div>
      <div className="intensity-track" style={{ '--pct': `${((value - 1) / (n - 1)) * 100}%`, '--step': `${100 / (n - 1)}%` } as CSSProperties}>
        <div className="intensity-rail" aria-hidden="true">
          <div className="intensity-fill" />
          {levels.map((l) => (
            <span key={l.level} className={l.level <= value ? 'intensity-dot on' : 'intensity-dot'} style={{ '--i': l.level - 1 } as CSSProperties} />
          ))}
        </div>
        <input
          type="range"
          min={1}
          max={n}
          step={1}
          value={value}
          disabled={disabled}
          aria-label={label}
          aria-valuetext={`${cur.name}: ${cur.hint}`}
          onChange={(e) => onChange(Math.min(n, Math.max(1, Math.round(Number(e.target.value)))))}
        />
      </div>
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
  const [snipping, setSnipping] = useState(false);
  // Intensity 1-5 (2 and up: pictures by OpenAI's image model). Remembered between sessions; the panel works fine without storage.
  const [intensity, setIntensity] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('ww.intensity');
      if (saved) return clampIntensity(saved);
      return localStorage.getItem('ww.illustrations') === '1' ? 2 : DEFAULT_INTENSITY; // the old checkbox
    } catch {
      return DEFAULT_INTENSITY;
    }
  });
  const chooseIntensity = (level: number) => {
    setIntensity(level);
    try {
      localStorage.setItem('ww.intensity', String(level));
    } catch {
      /* not remembered */
    }
  };
  const illustrations = intensity >= 2;
  // Polish 1-3: how much the result is reviewed from screenshots and improved (independent of Intensity).
  const [polish, setPolish] = useState<number>(() => {
    try {
      return clampPolish(localStorage.getItem('ww.polish') ?? DEFAULT_POLISH);
    } catch {
      return DEFAULT_POLISH;
    }
  });
  const choosePolish = (level: number) => {
    setPolish(level);
    try {
      localStorage.setItem('ww.polish', String(level));
    } catch {
      /* not remembered */
    }
  };
  // What the background is doing right now (Polish reviews take a while), shown in the waiting bubble.
  const [stage, setStage] = useState('');
  useEffect(() => {
    const onMsg = (m: { type?: string; requestId?: string; text?: string }) => {
      if (m?.type === 'ww:progress' && m.requestId && m.requestId === activeRequest.current && typeof m.text === 'string') setStage(m.text.slice(0, 60));
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);
  const [pending, setPending] = useState<{ text: string; shot: number; images: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  /** Live check: is Whimsy Web's CSS/HTML actually in the page right now? */
  const [applied, setApplied] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Edit Mode: the visual editor replaces the tabs until Done (or the panel closes).
  const [editMode, setEditMode] = useState(false);
  /** What is saved right now, to tell whether the keys/model have unsaved edits. */
  const [savedModels, setSavedModels] = useState<Pick<Settings, 'apiKey' | 'openaiKey' | 'model'> | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [settings, setSettings] = useState<Settings>({ apiKey: '', openaiKey: '', model: DEFAULT_MODEL, theme: cachedTheme(), previews: true });
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [newScope, setNewScope] = useState<DesignScope>('site');
  // "Start fresh": ignore whatever design is on the page or in this chat and build a new one from the original site.
  const [startFresh, setStartFresh] = useState(false);
  const [sentFrom, setSentFrom] = useState<{ host: string; scope: DesignScope; path: string } | null>(null);
  const [contrastFix, setContrastFix] = useState(true);
  const [themeFix, setThemeFix] = useState(true);
  const [themeAdjusted, setThemeAdjusted] = useState(0);
  const [contrastFixed, setContrastFixed] = useState(0);
  useEffect(() => {
    void getPrefs().then((p) => {
      setContrastFix(p.contrastFix);
      setThemeFix(p.themeFix);
    });
  }, []);
  const chatByHost = useRef<Record<string, string>>(loadChatMemory());
  const restoredFor = useRef<string | null>(null);
  const [globalConfirmed, setGlobalConfirmed] = useState(false);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const threadEnd = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
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
  // Example prompts (a hand-written pool, no AI). They stay put while you switch tabs and pages, and only change when a new chat is started.
  const [ideas, setIdeas] = useState<string[]>(() => pickIdeas(4));
  hostRef.current = host;
  useEffect(() => {
    setError(null);
  }, [tab?.id, tab?.path]);
  const current = convos.find((c) => c.id === currentId) ?? null;
  const hostConvos = convos.filter((c) => c.host === host);
  // All-sites designs apply everywhere, so they show up in every site's "This site" list.
  const globalDesigns = allDesigns.filter((d) => d.host === GLOBAL_HOST);
  const pageDesigns = [...designs, ...globalDesigns];
  const themeHere = !!tab && !!host && allDesigns.some((d) => d.enabled && (d.host === host || (scopeOf(d) === 'global' && !(d.excludedHosts ?? []).includes(host))) && appliesTo(d, tab.path));
  const freshAvailable = !!current || themeHere;
  const fresh = startFresh && freshAvailable;
  const visionOk = supportsImages(settings.model);
  const currentDesign = current?.designId ? allDesigns.find((d) => d.id === current.designId) : undefined;
  // Once a chat exists, where it applies is fixed by where it was SENT: it comes from the chat itself, not from the tab you are on now.
  const chatLocked = !!current && !fresh;
  const chatScope: DesignScope = current ? ((current.scope ?? (currentDesign ? scopeOf(currentDesign) : 'site')) as DesignScope) : newScope;
  const scopeValue: DesignScope = chatLocked ? chatScope : sentFrom && !current ? sentFrom.scope : newScope;
  // A page-scoped design can only be edited from its own page (the model needs to see that page).
  const wrongPage =
    !fresh &&
    !!currentDesign &&
    scopeOf(currentDesign) === 'page' &&
    !!tab &&
    normalizePath(currentDesign.path ?? '/') !== tab.path;
  // A chat about an ALL-SITES design can be continued from any site; others only from their own.
  // A saved design that is switched on for this page counts as applied straight away, without waiting for the page to report back.
  const canSend = !!tab && !!host && (!current || current.host === host || current.scope === 'global') && !wrongPage;

  // The page a page-scoped design lives on (not necessarily the tab you're looking at now).
  const scopePath = normalizePath(
    chatLocked && chatScope === 'page' ? (current?.path ?? currentDesign?.path ?? '/') : (tab?.path ?? '/'),
  );

  // Once a chat has a design, the note describes WHERE THAT DESIGN LIVES, and stays the same however you move around.
  const noteHost = chatLocked && chatScope !== 'global' && current ? current.host : sentFrom && !current ? sentFrom.host : host ?? '';

  const chooseScope = (s: DesignScope) => {
    if (!tab || !host) return;
    if (currentDesign && !fresh) {
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
    let contrastN = 0;
    let themeN = 0;
    if (t?.host) {
      try {
        const st: ContentState = await chrome.tabs.sendMessage(t.id, { type: 'ww:getState' });
        original = st.original;
        isApplied = st.applied;
        contrastN = st.contrast?.fixed ?? 0;
        themeN = (st.theme?.rules ?? 0) + (st.theme?.borders ?? 0);
      } catch {
        /* content script not attached (page needs a reload) */
      }
    }
    if (seq !== stateSeq.current || tabIdRef.current !== (t?.id ?? null)) return; // superseded or tab changed
    setShowOriginal(original);
    setApplied(isApplied);
    setContrastFixed(contrastN);
    setThemeAdjusted(themeN);
  }, []);

  const refreshDesigns = useCallback(async (h: string | null) => {
    const seq = ++designsSeq.current;
    const list = h ? await getDesignsForHost(h) : [];
    if (seq !== designsSeq.current) return; // an older read finishing late must not overwrite a newer one
    setDesigns(list);
  }, []);

  const convosSeq = useRef(0);
  const refreshConvos = useCallback(async () => {
    const seq = ++convosSeq.current;
    const list = await getAllConversations();
    if (seq === convosSeq.current) setConvos(list); // an older read finishing late is thrown away
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
      setContrastFixed(st.contrast?.fixed ?? 0);
      setThemeAdjusted((st.theme?.rules ?? 0) + (st.theme?.borders ?? 0));
      setShowOriginal(st.original);
      setError((e) => (e && e.startsWith('Reload this tab') ? null : e));
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

  // Remember the open chat for its site.
  useEffect(() => {
    if (!currentId) return;
    const c = convos.find((x) => x.id === currentId);
    const h = c ? (c.scope === 'global' ? host : c.host) : null;
    if (h && chatByHost.current[h] !== currentId) {
      chatByHost.current[h] = currentId;
      saveChatMemory(chatByHost.current);
    }
  }, [currentId, convos, host]);

  // Opening the panel brings back the chat you last had open for this site. After that, switching tabs never changes the
  // chat on screen: it keeps showing its own chat, and the note under the message box says which site it belongs to.
  useEffect(() => {
    if (!host || !convos.length || restoredFor.current !== null) return;
    restoredFor.current = host;
    setCurrentId((id) => {
      if (id) return id;
      const mem = chatByHost.current[host];
      return mem && convos.some((c) => c.id === mem) ? mem : id;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convos, host]);

  // ---- chat scrolling ------------------------------------------------------
  // The chat follows the latest message while you are at the latest message ("pinned"), including when it grows
  // later (a review updates the reply, pictures load). If you scrolled up to read, it leaves you there. Leaving the
  // Chat tab and coming back puts you where you were in that conversation.
  const chatOn = view === 'chat' && !settingsOpen;
  const pinned = useRef(true);
  const chatScroll = useRef<Record<string, { y: number; pinned: boolean }>>({});
  /** Where the page should scroll to show the latest message: the bottom of the page, unless that would push the latest message's top out of view. */
  const latestY = (): number | null => {
    const thread = threadRef.current;
    if (!thread) return null;
    const bubbles = thread.querySelectorAll('.bubble');
    const last = bubbles[bubbles.length - 1] as HTMLElement | undefined;
    const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    if (!last) return maxY;
    const lastTop = last.getBoundingClientRect().top + window.scrollY - 12;
    return Math.max(0, Math.min(maxY, lastTop));
  };
  const toLatest = () => {
    const y = latestY();
    if (y !== null) window.scrollTo({ top: y, behavior: 'auto' });
  };
  // remember where you are in this conversation, and whether you are at the latest message
  useEffect(() => {
    if (!chatOn) return;
    const onScroll = () => {
      if (!threadRef.current) return; // the chat is not on screen (another tab is being drawn)
      const y = latestY();
      pinned.current = y === null || window.scrollY >= y - 60;
      if (currentId) chatScroll.current[currentId] = { y: window.scrollY, pinned: pinned.current };
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatOn, currentId]);
  // back on the Chat tab, or another conversation opened: where you were in it, or its latest message
  useLayoutEffect(() => {
    if (!chatOn) return;
    const saved = currentId ? chatScroll.current[currentId] : undefined;
    if (saved && !saved.pinned) {
      pinned.current = false;
      window.scrollTo({ top: saved.y, behavior: 'auto' });
    } else {
      pinned.current = true;
      toLatest();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatOn, currentId]);
  // you sent something: always show it
  useLayoutEffect(() => {
    if (!chatOn || !pending) return;
    pinned.current = true;
    toLatest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);
  // a new message arrived: follow it if you were at the latest one
  useLayoutEffect(() => {
    if (chatOn && pinned.current) toLatest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.messages.length, current?.updatedAt]);
  // the chat grows after drawing (pictures, a longer reply, the waiting bubble's text): stay with it while pinned
  useEffect(() => {
    const thread = threadRef.current;
    if (!chatOn || !thread || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) toLatest();
    });
    ro.observe(thread);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatOn, currentId]);

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

  const addScreenshot = async (snipRegion = false) => {
    if (!tab || !canSend) return;
    if (!visionOk) {
      setError('The selected model can’t read images. Pick an image-capable model in Settings.');
      return;
    }
    if (attachments.length >= MAX_ATTACHMENTS) {
      setError(`You can attach up to ${MAX_ATTACHMENTS} images per message.`);
      return;
    }
    if (shotBusy.current) return;
    shotBusy.current = true; // a second click while capturing must not add a second screenshot
    const shotTab = tab.id;
    const shotHost = host;
    try {
      setError(null);
      let rect: SnipRect | null = null;
      if (snipRegion) {
        setSnipping(true);
        try {
          rect = await chrome.tabs.sendMessage(shotTab, { type: 'ww:snip' });
        } catch {
          // Say why, when we can tell: private windows and browser pages do not run extension scripts.
          const info = await chrome.tabs.get(shotTab).catch(() => undefined);
          setError(
            info?.incognito
              ? 'Chrome does not run extensions in private windows unless you allow it: chrome://extensions, Whimsy Web, Details, Allow in Incognito. Then reload the page.'
              : info && !/^https?:/i.test(info.url ?? '')
                ? 'Snipping only works on regular websites, not browser pages.'
                : 'Could not reach this page. Reload the tab and try again.',
          );
          return;
        } finally {
          setSnipping(false);
        }
        if (!rect) return; // cancelled
        if (tabIdRef.current !== shotTab || hostRef.current !== shotHost) return;
      }
      const res: CaptureResponse = await chrome.runtime.sendMessage({ type: 'ww:capture', tabId: tab.id });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Full-resolution captures can be several MB on large/retina displays: shrink like any other image.
      let blob = await (await fetch(`data:image/jpeg;base64,${res.data}`)).blob();
      if (rect) {
        const bmp = await createImageBitmap(blob);
        const box = cropBox(rect, bmp.width, bmp.height);
        if (!box) {
          bmp.close();
          setError('That selection was too small. Drag a bigger area.');
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = box.sw;
        canvas.height = box.sh;
        canvas.getContext('2d')!.drawImage(bmp, box.sx, box.sy, box.sw, box.sh, 0, 0, box.sw, box.sh);
        bmp.close();
        blob = await new Promise<Blob>((res2, rej) => canvas.toBlob((b) => (b ? res2(b) : rej(new Error('no blob'))), 'image/jpeg', 0.88));
      }
      const shot = await toAttachment(blob as File);
      // Decoding takes a moment: if you switched tabs meanwhile, this screenshot is of the wrong page.
      if (tabIdRef.current !== shotTab || hostRef.current !== shotHost) return;
      setAttachments((a) =>
        a.length >= MAX_ATTACHMENTS
          ? a
          : [...a, { ...shot, label: 'screenshot', tabId: shotTab, host: shotHost }],
      );
    } catch (e) {
      console.error('[Whimsy Web] screenshot failed', e);
      setError('Could not process the screenshot.');
    } finally {
      shotBusy.current = false;
    }
  };

  // Esc in the panel also cancels a snip in progress (the page only sees Esc once it has focus).
  useEffect(() => {
    if (!snipping || !tab) return;
    const id = tab.id;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void chrome.tabs.sendMessage(id, { type: 'ww:snipCancel' }).catch(() => undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [snipping, tab?.id]);

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
    setStage('');
    const startTab = tab.id;
    setSentFrom({ host: host ?? '', scope: newScope, path: tab.path }); // while the first answer is pending, the note stays on the site it was sent from
    const sentInput = input;
    const sentImages = attachments;
    setPending({ text, shot: sentImages.filter((a) => a.label === 'screenshot').length, images: sentImages.filter((a) => a.label !== 'screenshot').length });
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
        conversationId: fresh ? undefined : currentId ?? undefined,
        scope: newScope,
        fresh: fresh || undefined,
        requestId,
        intensity,
        polish,
        images: sentImages.map(({ mediaType, data, label }) => ({ mediaType, data, label })),
      };
      const res: GenerateResponse = await chrome.runtime.sendMessage(msg);
      if (!res.ok) {
        if (!res.cancelled) setError(res.error);
      } else {
        restore = false;
        setStartFresh(false); // the new design is now the one you are refining
        if (res.conversation.scope !== 'global') {
          chatByHost.current[res.conversation.host] = res.conversation.id;
          saveChatMemory(chatByHost.current);
        }
        // You may have moved to another tab while Claude worked: clear only what THIS message used,
        // and only select its chat if you are still where it belongs.
        await chrome.tabs.sendMessage(startTab, { type: 'ww:setOriginal', original: false }).catch(() => undefined);
        // Give the page a moment to show the new design, then make its blurred preview (only if you are still on that tab).
        window.setTimeout(() => {
          if (tabIdRef.current === startTab) void refreshPreview(res.design, true);
        }, 1400);
        // Still on the same tab: open the new chat even if the address blinked meanwhile (a different site closes it on its own).
        if (tabIdRef.current === startTab) {
          setCurrentId(res.conversation.id);
          setShowOriginal(false);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (restore) {
        setInput((cur) => (cur === '' ? sentInput : cur));
        setAttachments((a) => {
          const back = sentImages.filter((x) => !a.some((y) => y.id === x.id));
          return [...back, ...a].slice(0, MAX_ATTACHMENTS);
        });
      }
      activeRequest.current = null;
      setSentFrom(null);
      setPending(null);
      setBusy(false);
    }
  };

  const toggleOriginal = async () => {
    if (!tab) return;
    const next = !showOriginal;
    setError(null);
    try {
      const send = () => chrome.tabs.sendMessage(tab.id, { type: 'ww:setOriginal', original: next });
      await send().catch(async () => {
        await new Promise((r) => setTimeout(r, 400));
        return send();
      });
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
    setIdeas((prev) => pickIdeas(4, prev));
    if (host && chatByHost.current[host]) {
      delete chatByHost.current[host]; // a chat you deliberately left is not brought back on its own
      saveChatMemory(chatByHost.current);
    }
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
      <div className="thread" ref={threadRef}>
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
                {m.screenshot ? <><CameraIcon size={14} /> {m.screenshotCount && m.screenshotCount > 1 ? `${m.screenshotCount} screenshots` : 'screenshot'}</> : ''}
                {m.screenshot && m.imageCount ? ' · ' : ''}
                {m.imageCount ? <><PaperclipIcon size={14} /> {m.imageCount} image{m.imageCount > 1 ? 's' : ''}</> : ''}
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

        {pending && (
          <div className="bubble user">
            {pending.text && <div>{pending.text}</div>}
            {(pending.shot > 0 || pending.images > 0) && (
              <div className="attach-note">
                {pending.shot > 0 && <><CameraIcon size={14} /> {pending.shot > 1 ? `${pending.shot} screenshots` : 'screenshot'}</>}
                {pending.shot > 0 && pending.images > 0 && ' · '}
                {pending.images > 0 && <><PaperclipIcon size={14} /> {pending.images} image{pending.images > 1 ? 's' : ''}</>}
              </div>
            )}
          </div>
        )}
        {busy && (
          <div className="bubble assistant thinking">
            {stage || (illustrations ? 'Weaving magic and painting images' : 'Weaving magic')}
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
          <div className="scope" role="group" aria-label="Apply to" title={chatLocked ? 'This chat stays with where it started. Start a new chat to apply a design somewhere else.' : undefined}>
            <span className="hint">Apply to</span>
            <button className={scopeValue === 'page' ? 'seg active' : 'seg'} disabled={busy || !host || chatLocked} onClick={() => chooseScope('page')}>
              This page
            </button>
            <button className={scopeValue === 'site' ? 'seg active' : 'seg'} disabled={busy || !host || chatLocked} onClick={() => chooseScope('site')}>
              Whole site
            </button>
            <button
              className={scopeValue === 'global' ? 'seg active' : 'seg'}
              disabled={busy || !host || chatLocked}
              onClick={() => chooseScope('global')}
              title={currentDesign ? undefined : 'Try this design on every website'}
            >
              All sites
            </button>
            <span className="hint scope-note" title={scopeValue === 'page' ? `${noteHost}${scopePath}` : undefined}>
              {scopeValue === 'page'
                ? `only ${noteHost}${scopePath === '/' ? '/ (home page)' : scopePath}`
                : scopeValue === 'global'
                  ? 'every website (turn it off per site in “This site”)'
                  : `every page on ${noteHost}`}
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
              disabled={!canSend || !visionOk || attachments.length >= MAX_ATTACHMENTS}
              onClick={() => void addScreenshot()}
              title={
                visionOk
                  ? 'Capture this tab and send it with your next message (uses more credits)'
                  : 'The selected model can’t read images. Pick another model in Settings.'
              }
            >
              <CameraIcon size={19} />
              Screenshot
            </button>
            <button
              className="ghost"
              disabled={!canSend || !visionOk || snipping || attachments.length >= MAX_ATTACHMENTS}
              onClick={() => void addScreenshot(true)}
              title={
                visionOk
                  ? 'Drag over just the part of the page you want to show (uses more credits)'
                  : 'The selected model can’t read images. Pick another model in Settings.'
              }
            >
              <ScissorsIcon size={19} />
              Snip
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
          {freshAvailable && (
            <label className="art-check" title="Off: your message changes the current design. On: ignore the current design and anything applied on this page, and build a brand new design from the original site.">
              <input type="checkbox" checked={fresh} disabled={busy} onChange={(e) => setStartFresh(e.target.checked)} />
              <span>Start fresh <span className="muted-inline">(ignore the current design)</span></span>
            </label>
          )}
          <LevelBar label="Intensity" levels={INTENSITY_LEVELS} value={intensity} onChange={chooseIntensity} disabled={busy} />
          <LevelBar label="Polish" levels={POLISH_LEVELS} value={polish} onChange={choosePolish} disabled={busy} />
          {polish >= 2 && <p className="level-note">Stay on this tab until it finishes: Claude checks screenshots of the page, and they only work while the tab is on screen.</p>}
          {attachments.length > 0 && (
            <div className="thumbs">
              {attachments.map((a) => (
                <div key={a.id} className={a.label === 'screenshot' ? 'thumb shot' : 'thumb'} title={a.label === 'screenshot' ? 'Screenshot of this tab' : 'Reference image'}>
                  <img src={a.preview} alt="attachment" />
                  {a.label === 'screenshot' && <span className="shot-badge"><CameraIcon size={13} /></span>}
                  <button aria-label="Remove image" onClick={() => setAttachments((x) => x.filter((y) => y.id !== a.id))}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          {snipping && <p className="hint shot-note">Drag over the part of the page you want to show. Press Esc to cancel.</p>}
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
              {current && !fresh ? 'Send ✦' : 'Transform ✦'}
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

  /**
   * Undoes "all sites". A design copied from a site whose original still exists: the all-sites copy is removed and the
   * original keeps working there. Otherwise the design itself moves back to its site (the one it came from, or where its
   * chat started), so nothing is lost.
   */
  const undoAllSites = async (d: Design) => {
    const origin = d.copiedFrom && d.copiedFrom.host !== GLOBAL_HOST ? d.copiedFrom : null;
    const home = origin?.host ?? convos.find((c) => c.designId === d.id)?.host ?? host;
    if (!home || home === GLOBAL_HOST) {
      setError('Open the website this design should stay on, then try again.');
      return;
    }
    const original = origin ? allDesigns.find((x) => x.id !== d.id && x.host === origin.host && x.name === origin.name) : undefined;
    try {
      if (original) {
        if (!window.confirm(`Stop using “${d.name}” on all sites? It stays on ${siteName(home)}.`)) return;
        await run(GLOBAL_HOST, { action: 'delete', id: d.id });
      } else {
        if (!window.confirm(`Stop using “${d.name}” on all sites? It will apply only to ${siteName(home)}.`)) return;
        await run(home, { action: 'setScope', id: d.id, scope: 'site', path: '/' });
      }
      flash(`Now only on ${siteName(home)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
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
      undoAllSites: (d) => void undoAllSites(d),
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
          {(contrastFixed > 0 || themeAdjusted > 0) && (
            <p className="hint">
              {[themeAdjusted > 0 ? `${themeAdjusted} colour or border rule${themeAdjusted === 1 ? '' : 's'} matched to the theme` : '', contrastFixed > 0 ? `${contrastFixed} text colour${contrastFixed === 1 ? '' : 's'} made readable` : ''].filter(Boolean).join(' · ')} on this page.
            </p>
          )}
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
  const setThemePref = async (on: boolean) => {
    setThemeFix(on);
    await savePrefs({ themeFix: on });
    flash(on ? 'Theme matching on' : 'Theme matching off');
  };
  const setContrastPref = async (on: boolean) => {
    setContrastFix(on);
    await savePrefs({ contrastFix: on });
    flash(on ? 'Readability fixes on' : 'Readability fixes off');
  };
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
    await saveModelSettings({ apiKey: settings.apiKey, openaiKey: settings.openaiKey, model });
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
          <p className="set-sub">Pick the model that writes your designs, then add its API key. Press Save to apply changes here.</p>
        </div>
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
      {providerOf(settings.model) === 'openai' ? (
        <label>
          OpenAI API key
          <input type="password" value={settings.openaiKey} placeholder="sk-…" onChange={(e) => setSettings({ ...settings, openaiKey: e.target.value })} />
        </label>
      ) : (
        <>
          <label>
            Anthropic API key
            <input type="password" value={settings.apiKey} placeholder="sk-ant-…" onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })} />
          </label>
          <label>
            OpenAI API key for illustrations
            <input type="password" value={settings.openaiKey} placeholder="sk-… (optional)" onChange={(e) => setSettings({ ...settings, openaiKey: e.target.value })} />
            <span className="hint">Used for generated images, at Intensity 2 and up.</span>
          </label>
        </>
      )}
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

      <section className="set-card" aria-labelledby="set-readability">
        <div className="set-head">
          <h2 id="set-readability">Readability and colours</h2>
          <p className="set-sub">Applies as soon as you change it.</p>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={contrastFix} onChange={(e) => void setContrastPref(e.target.checked)} />
          <span>Fix text that is hard to read</span>
        </label>
        <p className="hint">Text that does not stand out from its background is nudged darker or lighter.</p>
        <label className="check-row">
          <input type="checkbox" checked={themeFix} onChange={(e) => void setThemePref(e.target.checked)} />
          <span>Keep site colours on the theme</span>
        </label>
        <p className="hint">Hover, focus and pop-up colours the site adds are matched to your design, and doubled borders are drawn once.</p>
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
        <p className="hint">Saved previews are stored locally and never sent anywhere.</p>
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
              <button className="icon-btn back" onClick={closeSettings} aria-label="Back" title="Back">
                <ArrowLeftIcon size={22} />
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
                <button
                  className={editMode ? 'icon-btn edit-toggle active' : 'icon-btn edit-toggle'}
                  onClick={() => (editMode ? setEditMode(false) : tab?.host ? setEditMode(true) : flash('Open a website to edit it'))}
                  aria-pressed={editMode}
                  aria-label={editMode ? 'Exit Edit Mode' : 'Edit Mode'}
                  title={editMode ? 'Exit Edit Mode' : 'Edit Mode: select and change elements on the page'}
                >
                  <PencilIcon size={22} />
                </button>
                <button className="icon-btn" onClick={() => (setEditMode(false), setSettingsOpen(true))} aria-label="Settings" title="Settings">
                  <GearIcon size={24} />
                </button>
              </span>
            </>
          )}
        </header>

        {!settingsOpen && !editMode && (
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
      {settingsOpen ? settingsScreen : editMode && tab?.host ? (
        <Editor key={tab.id} tabId={tab.id} host={tab.host} path={tab.path} flash={flash} onExit={(why) => {
          setEditMode(false);
          if (why) flash(why);
        }} />
      ) : view === 'chat' ? chatView : view === 'page' ? pageView : view === 'library' ? libraryView : historyView}
    </div>
  );
}
