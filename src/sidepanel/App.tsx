import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { GLOBAL_HOST, appliesOn, appliesTo, isAutoName, normalizePath, scopeOf } from '../shared/scope';
import { SITE_URL } from '../shared/site';
import { pickIdeas } from './ideas';
import { readActiveTab, useActiveTab, type TabInfo } from './useActiveTab';
import { useAttachments, type Attachment } from './useAttachments';
import { chatForTab, chatTarget, themesOn, type Pin } from './chatForTab';
import { Notices, type Notice } from './Notices';
import { CheckIcon, ChatIcon, GearIcon, HistoryIcon, LibraryIcon, PageIcon, EyeIcon, CameraIcon, ImageIcon, PlusIcon, StopIcon, PaperclipIcon, ScissorsIcon, ArrowLeftIcon, PencilIcon, UndoIcon, RedoIcon } from './Icons';
import { Editor } from './Editor';
import { FileMenu } from './FileMenu';
import { activeIndex, revisionsOf, type RevisionEvent } from '../shared/revisions';
import { DesignRow, GroupHead, HistoryView, LibraryView, siteName, type LibCtx } from './Library';
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
  type Conversation,
  type ChatMessage,
  type Design,
  type DesignScope,
  type GenerateResponse,
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
  | { action: 'copyDesign'; sourceHost: string; sourceId: string; scope: DesignScope; path: string; asCopy?: boolean }
  | { action: 'clearChat'; id: string }
  | { action: 'undoClearChat'; id: string }
  | { action: 'excludeHost'; id: string; siteHost: string; excluded: boolean }
  | { action: 'delete'; id: string }
  | { action: 'exportDraft'; id: string }
  | { action: 'saveFavicon'; dataUrl: string }
  | { action: 'capturePreview'; id: string }
  | { action: 'clearThumbs' }
  | { action: 'rename'; id: string; name: string }
  | { action: 'setFolder'; id: string; folder: string }
  | { action: 'deleteConversation'; id: string }
  | { action: 'restore'; conversationId: string; messageId: string }
  | { action: 'navigateRevision'; conversationId: string; index: number }
  | { action: 'newTheme'; scope: 'site' | 'page'; path: string }
  | { action: 'dropIfEmpty'; id: string };

/** All writes go through the background worker's serialized queue. */
async function mutate(host: string, m: MutateAction): Promise<{ conversationId?: string; preview?: string; reason?: string; cleared?: number; designId?: string; name?: string }> {
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

/** A message being worked on in the background. Several can run at once (one per chat), each tied to the tab it came from. */
interface Job {
  requestId: string;
  tabId: number;
  host: string;
  path: string;
  scope: DesignScope;
  /** The chat it continues; null while a new chat's first design is being made. */
  convoId: string | null;
  /** The draft slot it was sent from (to give the text back if it fails). */
  key: string;
  text: string;
  shot: number;
  images: number;
  stage: string;
  /** The screenshot review is waiting for its tab to be on screen. */
  needsTab: boolean;
  newSession: boolean;
  illustrations: boolean;
}

/** At most this many messages are worked on at once. */
const MAX_JOBS = 3;

/**
 * This site's cards: the designs on here right now first, then the rest by when they were last switched on or used
 * (most recent first). Designs saved before this was recorded fall back to when they were last changed.
 */
const byLastActive = (host: string) => (a: Design, b: Design) => {
  const onHere = (d: Design) => (d.enabled && !(d.excludedHosts ?? []).includes(host) ? 1 : 0);
  const when = (d: Design) => d.lastActiveAt ?? d.updatedAt ?? d.createdAt ?? 0;
  return onHere(b) - onHere(a) || when(b) - when(a) || a.name.localeCompare(b.name);
};

/** Messages and Back/Forward events in time order. */
function timeline(c: Conversation): ({ m: ChatMessage } | RevisionEvent)[] {
  const items: ({ m: ChatMessage; at: number } | (RevisionEvent & { at: number }))[] = [
    ...c.messages.map((m) => ({ m, at: m.createdAt })),
    ...(c.events ?? []).map((e) => ({ ...e, at: e.createdAt })),
  ];
  return items.sort((a, b) => a.at - b.at);
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

/** A few levels as buttons side by side, one selected (Polish): its description shows beside the label. */
function LevelChoice({ label, levels, value, onChange, disabled }: { label: string; levels: readonly { level: number; name: string; hint: string }[]; value: number; onChange: (level: number) => void; disabled?: boolean }) {
  const cur = levels[value - 1] ?? levels[0];
  return (
    <div className={disabled ? 'intensity disabled' : 'intensity'}>
      <div className="intensity-head">
        <span className="intensity-label">{label}</span>
        <span className="intensity-hint">{cur.hint}</span>
      </div>
      <div className="level-seg" role="radiogroup" aria-label={label}>
        {levels.map((l) => (
          <button key={l.level} type="button" role="radio" aria-checked={l.level === value} className={l.level === value ? 'on' : ''} disabled={disabled} title={l.hint} onClick={() => onChange(l.level)}>
            {l.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A bar with a dot per level (Intensity). Drag the knob or click a dot; the arrow keys work too. */
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
  const { tab, host, page, reach, tabIdRef, hostRef, refreshApplied, setShowOriginal } = useActiveTab(() => setError((e) => (e && e.startsWith('Reload this tab') ? null : e)));
  const { applied, showOriginal, contrastFixed, themeAdjusted } = page;
  const [designs, setDesigns] = useState<Design[]>([]);
  /** Saved designs across every site (for the All tab). */
  const [allDesigns, setAllDesigns] = useState<Design[]>([]);
  const [convos, setConvos] = useState<Conversation[]>([]);
  /** Chats chosen on purpose per tab (docs/spec-chat-follows-tab.md). Otherwise the tab's themes decide. */
  const [pins, setPins] = useState<Record<number, Pin>>({});
  const [jobs, setJobs] = useState<Job[]>([]);
  const jobsRef = useRef<Job[]>(jobs);
  /** The chats as they are now (for timers that run later). */
  const convosRef = useRef(convos);
  convosRef.current = convos;
  jobsRef.current = jobs;
  const [notices, setNotices] = useState<Notice[]>([]);
  const [view, setView] = useState<View>('chat');
  const [favicons, setFavicons] = useState<Record<string, string>>({});
  const [libQuery, setLibQuery] = useState('');
  const [histQuery, setHistQuery] = useState('');
  const faviconTried = useRef(new Set<string>());
  const [input, setInput] = useState('');
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
  // What each job is doing right now (Polish reviews take a while), shown in its waiting bubble. A review waiting for
  // its tab says so with `needsTab`; that becomes a "needs you" notice when you are somewhere else.
  useEffect(() => {
    const onMsg = (m: { type?: string; requestId?: string; text?: string; needsTab?: boolean }) => {
      if (m?.type !== 'ww:progress' || !m.requestId || typeof m.text !== 'string') return;
      const text = m.text.slice(0, 60);
      const needsTab = m.needsTab === true;
      setJobs((js) => js.map((j) => (j.requestId === m.requestId ? { ...j, stage: text, needsTab } : j)));
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);
  const [navBusy, setNavBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Edit Mode: the visual editor replaces the tabs until Done (or the panel closes).
  const [editMode, setEditMode] = useState(false);
  /** Where Edit Mode pins its header and selection bar (inside the top bar, so they stay while the panel scrolls). */
  const [edPin, setEdPin] = useState<HTMLDivElement | null>(null);
  /** What is saved right now, to tell whether the keys/model have unsaved edits. */
  const [savedModels, setSavedModels] = useState<Pick<Settings, 'apiKey' | 'openaiKey' | 'model'> | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [settings, setSettings] = useState<Settings>({ apiKey: '', openaiKey: '', model: DEFAULT_MODEL, theme: cachedTheme(), previews: true });
  const [dragOver, setDragOver] = useState(false);
  const [newScope, setNewScope] = useState<DesignScope>('site');
  // "Start fresh": ignore whatever design is on the page or in this chat and build a new one from the original site.
  const [startFresh, setStartFresh] = useState(false);
  const [contrastFix, setContrastFix] = useState(true);
  const [themeFix, setThemeFix] = useState(true);
  useEffect(() => {
    void getPrefs().then((p) => {
      setContrastFix(p.contrastFix);
      setThemeFix(p.themeFix);
    });
  }, []);
  const chatByHost = useRef<Record<string, string>>(loadChatMemory());
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const threadEnd = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!error) return;
    // after the chat's own scrolling (it follows the message box), so the message is what you see
    const t = window.setTimeout(() => errorRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 120);
    return () => window.clearTimeout(t);
  }, [error]);
  const fileInput = useRef<HTMLInputElement>(null);
  const designsSeq = useRef(0);

  // Example prompts (a hand-written pool, no AI). They stay put while you switch tabs and pages, and only change when a new chat is started.
  const [ideas, setIdeas] = useState<string[]>(() => pickIdeas(3));
  useEffect(() => {
    setError(null);
  }, [tab?.id, tab?.path]);
  // ---- which chat this tab shows (docs/spec-chat-follows-tab.md): a chat opened on purpose here, else the most
  // specific theme on the page, else a fresh chat.
  const tabChat = chatForTab({ tab, pin: tab ? pins[tab.id] ?? null : null, convos, designs: allDesigns, memory: chatByHost.current });
  const currentId = tabChat.kind === 'convo' ? tabChat.id : null;
  const continueId = tabChat.kind === 'fresh' ? tabChat.continueId : null;
  /** Shows a chat (or, with null, a fresh chat) on a tab until that tab moves to another page. */
  const pinTab = useCallback((tabId: number, convoId: string | null, at?: { host: string | null; path: string; loading?: boolean }) => {
    setPins((p) => ({ ...p, [tabId]: { convoId, host: at && !at.loading ? at.host : null, path: at && !at.loading ? at.path : null } }));
  }, []);
  // A pin made while its tab was loading is confirmed once the tab shows its page; a tab that moved on drops its pin.
  useEffect(() => {
    if (!tab) return;
    setPins((p) => {
      const pin = p[tab.id];
      if (!pin) return p;
      if (pin.host === null) {
        if (tab.loading || !tab.host) return p;
        return { ...p, [tab.id]: { ...pin, host: tab.host, path: tab.path } };
      }
      if (pin.host === tab.host && pin.path === tab.path) return p;
      const next = { ...p };
      delete next[tab.id];
      return next;
    });
  }, [tab]);
  const current = convos.find((c) => c.id === currentId) ?? null;
  /** The job behind what this tab shows: its chat's, or the new chat being made from this tab. */
  const viewJob = jobs.find((j) => (current ? j.convoId === current.id : tabChat.kind === 'fresh' && tabChat.why === 'pinned' && !!tab && j.convoId === null && j.tabId === tab.id));
  const busy = !!viewJob;
  const pending = viewJob ? { text: viewJob.text, shot: viewJob.shot, images: viewJob.images } : null;
  const stage = viewJob?.stage ?? '';
  const workingConvos = new Set(jobs.map((j) => j.convoId).filter((id): id is string => !!id));

  // Drafts (text and images) are kept per chat, so switching tabs never loses what you were writing.
  const viewKey = current ? `c:${current.id}` : `t:${tab?.id ?? 0}`;
  const drafts = useRef<Record<string, { input: string; attachments: Attachment[] }>>({});
  const prevViewKey = useRef(viewKey);
  /** Set right before a view change that should START a design from the original site (New chat). */
  const freshNext = useRef(false);
  /** Set right before a view change that should take the draft along (New theme for this site instead). */
  const carryDraft = useRef(false);
  const [globalAsk, setGlobalAsk] = useState(false);
  /** Sending to an All Sites chat was confirmed once since the panel opened. */
  const [globalOk, setGlobalOk] = useState(false);

  const hostConvos = convos.filter((c) => c.host === host);
  // All-sites designs apply everywhere, so they show up in every site's "This site" list.
  const globalDesigns = allDesigns.filter((d) => d.host === GLOBAL_HOST);
  const pageDesigns = [...designs, ...globalDesigns];
  const themeHere = !!tab && !!host && allDesigns.some((d) => d.enabled && (d.host === host || (scopeOf(d) === 'global' && !(d.excludedHosts ?? []).includes(host))) && appliesTo(d, tab.path));
  const freshAvailable = !!current || themeHere;
  const fresh = startFresh && freshAvailable;
  const visionOk = supportsImages(settings.model);
  const currentDesign = current?.designId ? allDesigns.find((d) => d.id === current.designId) : undefined;
  // ---- the File: the one design this page is working on, the same in the chat and in Edit Mode: the open chat's
  // design, else the most specific design switched on here, else (so it can be turned back on) one switched off here
  const [offFile, setOffFile] = useState<Record<string, string>>({});
  const onHere = (d: Design) => !!host && !!tab && d.enabled && (scopeOf(d) !== 'global' || !(d.excludedHosts ?? []).includes(host)) && appliesTo(d, tab.path);
  const autoFile = currentDesign ?? (tab && host ? themesOn(allDesigns, host, tab.path)[0] : undefined);
  const file = autoFile ?? (host ? allDesigns.find((d) => d.id === offFile[host]) : undefined) ?? null;
  const fileOn = !!file && onHere(file);
  /** A new design nothing has happened to yet: its chat shows the suggestions to start from, not its opening note. */
  const blankNew = !!current && !!currentDesign && !current.messages.some((m) => m.role === 'user') && isAutoName(currentDesign.name) && !currentDesign.css.trim() && !currentDesign.ops?.length && !currentDesign.edits?.length;
  /** Changed by hand in Edit Mode, nothing asked in its chat yet: the chat invites you to carry on with AI. */
  const handStarted = !!current && !!currentDesign && !blankNew && !current.messages.some((m) => m.role === 'user') && !!currentDesign.edits?.length;
  const leftFile = useRef<{ id: string; host: string; timer: number } | null>(null);
  useEffect(() => {
    const prev = leftFile.current;
    if (prev && prev.id === file?.id) {
      window.clearTimeout(prev.timer);
      leftFile.current = null;
    }
    return () => {
      if (!file) return;
      const id = file.id;
      const h = file.host;
      if (leftFile.current) window.clearTimeout(leftFile.current.timer);
      leftFile.current = {
        id,
        host: h,
        timer: window.setTimeout(() => {
          leftFile.current = null;
          // a design whose first request is still being made is not empty, whatever is saved yet
          const working = jobsRef.current.some((j) => j.convoId && convosRef.current.some((c) => c.id === j.convoId && c.designId === id));
          if (working) return;
          void mutate(h, { action: 'dropIfEmpty', id }).catch(() => undefined);
        }, 4000),
      };
    };
  }, [file?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  /** The design Edit Mode saved on last (the chat opens it when Edit Mode closes). */
  const editorDesign = useRef<string | null>(null);
  /** A chat for the File's design, shown on this tab. */
  const showChatOf = (designId: string | null) => {
    if (!tab || !designId) return;
    const c = convos.filter((x) => x.designId === designId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (c) pinTab(tab.id, c.id, tab);
    else {
      // no chat of its own yet: let go of the chat that was open, so the File follows the design that is on
      const id = tab.id;
      setPins((p) => {
        const n = { ...p };
        delete n[id];
        return n;
      });
    }
  };
  const newFile = async () => {
    if (!host || !tab) return;
    try {
      const res = await mutate(host, { action: 'newTheme', scope: 'site', path: tab.path });
      if (res.conversationId) pinTab(tab.id, res.conversationId, tab);
      flash(`Started “${res.name ?? 'My edits'}”`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  /** Library → Make a copy: "Name 2" where the original is, switched on instead of it, with its own chat. */
  const duplicate = async (d: Design) => {
    const global = scopeOf(d) === 'global';
    const where = global ? host : d.host;
    if (!where) return;
    try {
      const res = await mutate(where, { action: 'copyDesign', sourceHost: d.host, sourceId: d.id, scope: scopeOf(d), path: d.path ?? '/', asCopy: true });
      // the chat follows when the copy shows on the tab you are on
      if (res.conversationId && tab && (global || d.host === host) && appliesTo(d, tab.path)) pinTab(tab.id, res.conversationId, tab);
      flash(`Made “${res.name ?? 'a copy'}”`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  /** File → Open recent: this site's designs used lately (that can show on this page), newest first. */
  const recentFiles =
    !host || !tab
      ? []
      : allDesigns
          .filter((d) => d.id !== file?.id && d.host === host && !d.community && appliesTo(d, tab.path))
          .sort((a, b) => (b.lastActiveAt ?? b.updatedAt ?? 0) - (a.lastActiveAt ?? a.updatedAt ?? 0))
          .slice(0, 4);
  /** Opens a recent design: switched on here (the one that was on is switched off), its chat shown. */
  const openRecent = async (d: Design) => {
    await run(d.host, { action: 'activate', id: d.id, enabled: true });
    showChatOf(d.id);
    setView('chat');
  };
  /** Clear chat (File menu, or a design in the Library): the design stays; its chat starts over. */
  const clearChatOf = async (d: Design) => {
    if (!window.confirm(`Clear the chat of “${d.name}”? The design stays exactly as it is, but you can no longer go back to its earlier versions.`)) return;
    try {
      const res = await mutate(d.host, { action: 'clearChat', id: d.id });
      // the chat on this tab shows it again if it was this design's
      if (res.conversationId && tab && file?.id === d.id) pinTab(tab.id, res.conversationId, tab);
      setClearedChats((m) => ({ ...m, [d.id]: d.host }));
      flash('Chat cleared');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  /** Designs whose chat was cleared this session (design id -> where it is stored): Undo is offered for them. */
  const [clearedChats, setClearedChats] = useState<Record<string, string>>({});
  /** Undo is offered until something new is asked in the cleared chat. */
  const canUndoClear = (d: Design) => !!clearedChats[d.id] && !convos.some((c) => c.designId === d.id && c.messages.some((m) => m.role === 'user'));
  const undoClearChat = async (d: Design) => {
    try {
      const res = await mutate(d.host, { action: 'undoClearChat', id: d.id });
      if (res.conversationId && tab && file?.id === d.id) pinTab(tab.id, res.conversationId, tab);
      flash('Chat brought back');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setClearedChats((m) => {
      const n = { ...m };
      delete n[d.id];
      return n;
    });
  };
  const toggleFile = async () => {
    if (!file || !host) return;
    if (fileOn) setOffFile((m) => ({ ...m, [host]: file.id }));
    if (scopeOf(file) === 'global') await run(GLOBAL_HOST, { action: 'excludeHost', id: file.id, siteHost: host, excluded: fileOn });
    else await run(file.host, { action: 'activate', id: file.id, enabled: !fileOn });
  };
  /** A new design session: no chat yet (or Start fresh). Only then are Intensity and Polish offered. */
  // a chat with nothing asked in it yet (a new design from the File menu or Edit Mode) still starts its session
  const newSession = !current || fresh || (!current.session && !current.messages.some((m) => m.role === 'user'));
  // ---- linear design history of this chat (Back / Forward)
  const revisions = current ? revisionsOf(current) : [];
  const activeRev = current ? activeIndex(current) : -1;
  const revIds = new Map(revisions.map((m, i) => [m.id, i]));
  // Once a chat exists, where it applies is fixed by where it was SENT: it comes from the chat itself, not from the tab you are on now.
  // (a new design nothing has happened to yet can still be moved: this page, the whole site or all sites)
  const chatLocked = !!current && !fresh && !blankNew;
  const chatScope: DesignScope = current ? ((blankNew && currentDesign ? scopeOf(currentDesign) : current.scope ?? (currentDesign ? scopeOf(currentDesign) : 'site')) as DesignScope) : newScope;
  // while a new chat's first design is being made, the note stays on where it was sent from
  const sentFrom = viewJob && !current ? { host: viewJob.host, scope: viewJob.scope, path: viewJob.path } : null;
  const scopeValue: DesignScope = chatLocked || blankNew ? chatScope : sentFrom ? sentFrom.scope : newScope;
  // A page-scoped design can only be edited from its own page (the model needs to see that page).
  const wrongPage =
    !fresh &&
    !!currentDesign &&
    scopeOf(currentDesign) === 'page' &&
    !!tab &&
    normalizePath(currentDesign.path ?? '/') !== tab.path;
  // A chat about an ALL-SITES design can be continued from any site; others only from their own.
  // A saved design that is switched on for this page counts as applied straight away, without waiting for the page to report back.
  // A tab the page script cannot reach (until reloaded) or may never reach (Chrome's own pages) cannot be sent from.
  const unreachable = reach === 'reload' || reach === 'never';
  const canType = !!tab && !!host && !unreachable && (!current || current.host === host || current.scope === 'global') && !wrongPage;
  // Still checking whether the page script answers (a tab just switched to, or still loading): a draft can be typed,
  // but nothing is sent until the page is known to be reachable, so a request never starts on a tab that then needs a reload.
  const checking = !!host && reach === 'pending';
  const canSend = canType && !checking;
  const { attachments, setAttachments, addFiles, addScreenshot, snipping } = useAttachments({ tab, tabIdRef, hostRef, visionOk, canSend, setError });

  // Switching chats (another tab, another chat opened): put the old draft away and bring this chat's back.
  useLayoutEffect(() => {
    const prev = prevViewKey.current;
    if (prev === viewKey) return;
    prevViewKey.current = viewKey;
    if (carryDraft.current) {
      carryDraft.current = false;
      drafts.current[prev] = { input: '', attachments: [] };
      drafts.current[viewKey] = { input, attachments };
    } else {
      drafts.current[prev] = { input, attachments };
    }
    const d = drafts.current[viewKey];
    setInput(d?.input ?? '');
    setAttachments(d?.attachments ?? []);
    // opening a chat continues it; only New chat starts from the original site
    setStartFresh(freshNext.current);
    freshNext.current = false;
    setGlobalAsk(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey]);

  // The page a page-scoped design lives on (not necessarily the tab you're looking at now).
  const scopePath = normalizePath(
    chatLocked && chatScope === 'page' ? (current?.path ?? currentDesign?.path ?? '/') : (tab?.path ?? '/'),
  );

  // Once a chat has a design, the note describes WHERE THAT DESIGN LIVES, and stays the same however you move around.
  const noteHost = chatLocked && chatScope !== 'global' && current ? current.host : sentFrom ? sentFrom.host : host ?? '';

  const chooseScope = (s: DesignScope) => {
    if (!tab || !host) return;
    if (currentDesign && !fresh) {
      if (s !== scopeOf(currentDesign) || (s === 'page' && wrongPage)) {
        // Moving an existing design to all sites changes live pages right away: always confirm.
        if (s === 'global' && !window.confirm(GLOBAL_WARNING)) return;
        run(host, { action: 'setScope', id: currentDesign.id, scope: s, path: tab.path });
      }
    } else {
      // For a new chat nothing changes until you send; the warning comes when you send (once per panel session).
      setNewScope(s);
    }
  };

  // ---- data loading ------------------------------------------------------

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
    refreshConvos();
    refreshAllDesigns();
    getSettings().then((s) => {
      setSettings(s);
      setSavedModels({ apiKey: s.apiKey, openaiKey: s.openaiKey, model: s.model });
      cacheTheme(s.theme);
      if (!s.apiKey && !s.openaiKey) setSettingsOpen(true); // first run: no key for either provider yet
    });
  }, [refreshConvos, refreshAllDesigns]);

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

  // ---- notices: what happened in jobs on OTHER tabs (the tab on screen shows its own chat already)
  const addNotice = useCallback((n: Notice) => setNotices((list) => [...list.filter((x) => x.id !== n.id), n]), []);
  const dropNotice = useCallback((id: string) => setNotices((list) => list.filter((x) => x.id !== id)), []);
  // A review waiting for its tab: "needs you" while you are elsewhere; gone once it carries on.
  useEffect(() => {
    setNotices((list) => {
      let next = list;
      for (const j of jobs) {
        const id = `needs:${j.requestId}`;
        const has = next.some((n) => n.id === id);
        const want = j.needsTab && j.tabId !== tab?.id;
        if (want && !has) {
          next = [...next, { id, kind: 'needs', host: j.host, path: j.path, tabId: j.tabId, requestId: j.requestId, title: `Come back to ${siteName(j.host)} to finish the review`, detail: 'The screenshot review checks the new design on its own tab. Go to the tab and it carries on, or skip the review to keep the design as it is.' }];
        } else if (!want && has) next = next.filter((n) => n.id !== id);
      }
      return next.filter((n) => n.kind !== 'needs' || jobs.some((j) => `needs:${j.requestId}` === n.id));
    });
  }, [jobs, tab?.id]);
  // Arriving on a tab settles its "done" notices.
  useEffect(() => {
    if (tab) setNotices((list) => (list.some((n) => n.kind === 'done' && n.tabId === tab.id) ? list.filter((n) => !(n.kind === 'done' && n.tabId === tab.id)) : list));
  }, [tab?.id]);

  /** Brings up a tab (and its window). If it was closed, its page is opened again. Returns the tab id. */
  const goToTab = async (tabId: number, fallback: { host: string; path: string; exact: boolean }): Promise<number | null> => {
    const t = await chrome.tabs.get(tabId).catch(() => undefined);
    if (t?.id !== undefined) {
      await chrome.tabs.update(t.id, { active: true }).catch(() => undefined);
      await chrome.windows.update(t.windowId, { focused: true }).catch(() => undefined);
      return t.id;
    }
    return openTarget(fallback.host, fallback.path, fallback.exact);
  };

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

  const stop = () => {
    const id = viewJob?.requestId;
    if (id) chrome.runtime.sendMessage({ type: 'ww:cancel', requestId: id }).catch(() => undefined);
  };

  /** Turns the open chat's theme back on here: its current version, and an All Sites theme stops being skipped on this site. */
  const turnThemeOn = async (d: Design) => {
    if (!host) return;
    try {
      if (scopeOf(d) === 'global' && (d.excludedHosts ?? []).includes(host)) await mutate(GLOBAL_HOST, { action: 'excludeHost', id: d.id, siteHost: host, excluded: false });
      if (!d.enabled) await mutate(d.host, { action: 'activate', id: d.id, enabled: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (tab) await chrome.tabs.sendMessage(tab.id, { type: 'ww:setOriginal', original: false }).catch(() => undefined);
    setShowOriginal(false);
    window.setTimeout(refreshApplied, 300);
  };

  /**
   * Turns the open chat's theme off here (it really stops applying, nothing is hidden): a page or site theme is switched
   * off, an All Sites theme is skipped on this site. The chat stays on screen (pinned) and shows "This theme is off".
   */
  const turnThemeOff = async (d: Design) => {
    if (!host || !tab) return;
    if (current) pinTab(tab.id, current.id, tab);
    try {
      if (scopeOf(d) === 'global') await mutate(GLOBAL_HOST, { action: 'excludeHost', id: d.id, siteHost: host, excluded: true });
      else await mutate(d.host, { action: 'activate', id: d.id, enabled: false });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    await chrome.tabs.sendMessage(tab.id, { type: 'ww:setOriginal', original: false }).catch(() => undefined);
    setShowOriginal(false);
    window.setTimeout(refreshApplied, 300);
  };

  // A fast double click could start two requests (two API charges, and Stop could only cancel one) before the job
  // shows up in state. This lock closes that window synchronously. It is per chat (or per tab for a fresh chat):
  // one chat runs one job at a time anyway, and other chats must stay free to send (up to MAX_JOBS at once).
  const sendLocks = useRef(new Set<string>());
  /** `confirmedGlobal`: the All Sites warning was just answered with "Send to all sites". */
  const send = async (confirmedGlobal = false) => {
    const key = viewKey;
    if (sendLocks.current.has(key) || navBusy) return;
    sendLocks.current.add(key);
    try {
      await sendOnce(confirmedGlobal);
    } finally {
      sendLocks.current.delete(key);
    }
  };

  const sendOnce = async (confirmedGlobal: boolean) => {
    if (!tab || !canSend || busy) return;
    const text = input.trim();
    if (!text && !attachments.length) return;
    if (jobsRef.current.length >= MAX_JOBS) {
      setError(`${MAX_JOBS} designs are already being made. Send this when one of them is done.`);
      return;
    }
    // Sending to every website: asked once per panel session, inline (Enter never confirms it).
    if (scopeValue === 'global' && !globalOk && !confirmedGlobal) {
      setGlobalAsk(true);
      return;
    }
    if (confirmedGlobal) setGlobalOk(true);
    setGlobalAsk(false);

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

    setError(null);
    if (jobsRef.current.length >= MAX_JOBS) {
      setError(`${MAX_JOBS} designs are already being made. Send this when one of them is done.`);
      return;
    }
    const requestId = crypto.randomUUID();
    const startTab: TabInfo = tab;
    const continuing = fresh ? null : current?.id ?? null;
    const job: Job = {
      requestId,
      tabId: tab.id,
      host: host ?? '',
      path: tab.path,
      scope: newScope,
      convoId: continuing,
      key: continuing ? `c:${continuing}` : `t:${tab.id}`,
      text,
      shot: attachments.filter((a) => a.label === 'screenshot').length,
      images: attachments.filter((a) => a.label !== 'screenshot').length,
      stage: '',
      needsTab: false,
      newSession,
      illustrations,
    };
    jobsRef.current = [...jobsRef.current, job];
    setJobs((js) => [...js, job]);
    // This tab now shows the chat being worked on (a new chat: its waiting bubble) until the tab moves on.
    pinTab(tab.id, continuing, tab);
    delete drafts.current[job.key]; // an older draft of this chat must not come back while it is being worked on
    const sentInput = input;
    const sentImages = attachments;
    // Clear the box as soon as the message is on its way (the waiting bubble shows what was sent). If the request
    // fails or is stopped, the text and images come back, unless you have already started typing something new.
    const sentIds = new Set(sentImages.map((a) => a.id));
    setInput('');
    setAttachments((a) => a.filter((x) => !sentIds.has(x.id)));
    // A theme that was off here comes back on with this message (an All Sites theme stops being skipped here).
    if (continuing && currentDesign && host && scopeOf(currentDesign) === 'global' && (currentDesign.excludedHosts ?? []).includes(host)) {
      await mutate(GLOBAL_HOST, { action: 'excludeHost', id: currentDesign.id, siteHost: host, excluded: false }).catch(() => undefined);
    }
    let restore = true;
    let failure: string | null = null;
    try {
      const msg: BackgroundMessage = {
        type: 'ww:generate',
        tabId: tab.id,
        prompt: text,
        conversationId: continuing ?? undefined,
        scope: newScope,
        fresh: fresh || undefined,
        requestId,
        // the session settings go with the first design only; later messages are refinements
        ...(newSession ? { intensity, polish } : {}),
        images: sentImages.map(({ mediaType, data, label }) => ({ mediaType, data, label })),
      };
      const res: GenerateResponse = await chrome.runtime.sendMessage(msg);
      if (!res.ok) {
        if (!res.cancelled) failure = res.error;
      } else {
        restore = false;
        if (res.conversation.scope !== 'global') {
          chatByHost.current[res.conversation.host] = res.conversation.id;
          saveChatMemory(chatByHost.current);
        }
        // The tab it came from now shows this chat (unless another chat was opened there meanwhile).
        setPins((p) => {
          const pin = p[startTab.id];
          if (pin && pin.convoId !== continuing) return p;
          return { ...p, [startTab.id]: { convoId: res.conversation.id, host: pin ? pin.host : startTab.host, path: pin ? pin.path : startTab.path } };
        });
        await chrome.tabs.sendMessage(startTab.id, { type: 'ww:setOriginal', original: false }).catch(() => undefined);
        // Give the page a moment to show the new design, then make its blurred preview (only if you are still on that tab).
        window.setTimeout(() => {
          if (tabIdRef.current === startTab.id) void refreshPreview(res.design, true);
        }, 1400);
        if (tabIdRef.current === startTab.id) setShowOriginal(false);
        else {
          const reply = [...res.conversation.messages].reverse().find((m) => m.role === 'assistant')?.text ?? '';
          addNotice({ id: `done:${requestId}`, kind: 'done', host: job.host, path: job.path, tabId: startTab.id, convoId: res.conversation.id, title: `Done on ${siteName(job.host)}`, detail: reply });
        }
      }
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    } finally {
      jobsRef.current = jobsRef.current.filter((j) => j.requestId !== requestId);
      setJobs((js) => js.filter((j) => j.requestId !== requestId));
      if (failure) {
        // Said where you are looking at it, or as a notice if you have moved on.
        if (tabIdRef.current === startTab.id && prevViewKey.current === job.key) setError(failure);
        else addNotice({ id: `problem:${requestId}`, kind: 'problem', host: job.host, path: job.path, tabId: startTab.id, convoId: continuing, title: `Couldn’t finish on ${siteName(job.host)}`, detail: failure });
      }
      if (restore) {
        if (prevViewKey.current === job.key) {
          setInput((cur) => (cur === '' ? sentInput : cur));
          setAttachments((a) => {
            const back = sentImages.filter((x) => !a.some((y) => y.id === x.id));
            return [...back, ...a].slice(0, MAX_ATTACHMENTS);
          });
        } else {
          const d = drafts.current[job.key];
          if (!d?.input) drafts.current[job.key] = { input: sentInput, attachments: [...sentImages, ...(d?.attachments ?? [])].slice(0, MAX_ATTACHMENTS) };
        }
      }
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

  /** Shows a chat on the tab on screen (the "Also on this page" chips, "Continue your last chat"). */
  const showHere = (convoId: string) => {
    if (!tab) return;
    pinTab(tab.id, convoId, tab);
    setStartFresh(false);
    setView('chat');
    setError(null);
  };

  /**
   * Opening a chat from History or the Library brings up its tab: a tab already on its page (This page) or site
   * (Whole site), or the page in a new tab. An All Sites chat stays on this tab when it is a website. Its theme is NOT
   * switched on; the chat says so if it is off.
   */
  const openConvo = async (c: Conversation) => {
    setStartFresh(false);
    setView('chat');
    setError(null);
    const target = chatTarget(c, c.designId ? allDesigns.find((d) => d.id === c.designId) : undefined);
    const live = await readActiveTab();
    const isGlobal = (c.scope ?? 'site') === 'global';
    const here = !!live?.host && (isGlobal || (live.host === target.host && (!target.exact || live.path === target.path)));
    if (here && live) {
      pinTab(live.id, c.id, live);
      return;
    }
    if (!target.host) {
      setError('Open a website to see this chat beside its theme.');
      return;
    }
    const id = await openTarget(target.host, target.path, target.exact);
    if (id === null) return;
    const t = await chrome.tabs.get(id).catch(() => undefined);
    let info: TabInfo | null = null;
    try {
      const u = new URL(t?.url ?? '');
      info = { id, host: u.hostname, path: normalizePath(u.pathname), url: t?.url ?? '', loading: t?.status === 'loading' };
    } catch {
      /* still loading: confirmed when it shows its page */
    }
    pinTab(id, c.id, info && info.host === target.host ? info : undefined);
  };

  /** New design: the same as File → New design (an empty design with its own chat), shown in the chat. */
  const newChat = () => {
    setIdeas((prev) => pickIdeas(3, prev));
    setStartFresh(false); // the new design starts from the site itself already
    setView('chat');
    setError(null);
    void newFile();
  };

  const removeConvo = async (c: Conversation) => {
    if (!window.confirm(`Delete the conversation "${c.title}"? Its design stays in your saved designs.`)) return;
    await run(c.host, { action: 'deleteConversation', id: c.id });
  };

  const rename = async (d: Design) => {
    const name = window.prompt('Name this design', d.name)?.trim();
    if (name && name !== d.name) await run(d.host, { action: 'rename', id: d.id, name });
  };

  /** Moves designs into a folder (asked by name; the first existing folder is suggested) or, with '', out of one. */
  const moveToFolder = async (list: Design[], folder?: string) => {
    let name = folder;
    if (name === undefined) {
      const known = [...new Set(allDesigns.map((x) => x.folder).filter(Boolean))] as string[];
      name = window.prompt(known.length ? `Folder name (existing: ${known.join(', ')})` : 'Folder name', list[0]?.folder || known[0] || 'Test')?.trim();
      if (!name) return;
    }
    for (const d of list) await run(d.host, { action: 'setFolder', id: d.id, folder: name });
  };

  const removeDesign = async (d: Design) => {
    if (window.confirm(`Delete "${d.name}"?`)) await run(d.host, { action: 'delete', id: d.id });
  };

  // ---- views -------------------------------------------------------------

  // Why this chat can't be edited from here, and where to go to edit it.
  const blocked = (() => {
    if (!current || canType || unreachable) return null;
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
  const openTarget = async (targetHost: string, path: string, exact: boolean): Promise<number | null> => {
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
        return match.id;
      }
      const created = await chrome.tabs.create({ url: `https://${targetHost}${path}` });
      return created.id ?? null;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
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

  /** Back/Forward/"go to this version": the background applies and saves it; the chat list refreshes from storage. */
  const onThisSite = !!current && (current.host === host || current.scope === 'global');
  /** The chat's design is switched on here (it may have been turned off, or another design took its place). */
  const designOnHere = !!currentDesign && !!host && !!tab && currentDesign.enabled && appliesOn(currentDesign, host, tab.path);
  /** The open chat's theme is not on this page (switched off, skipped here, or replaced); sending turns it back on. */
  const themeOff = !!current && !!currentDesign && canSend && !busy && !fresh && !designOnHere;
  const canNavigate = !!current && !!currentDesign && onThisSite && !busy && !navBusy;
  const canGoBack = canNavigate && activeRev > 0;
  const canGoForward = canNavigate && activeRev >= 0 && activeRev < revisions.length - 1;
  const goToRevision = async (index: number) => {
    if (!current || navBusy) return;
    setNavBusy(true);
    try {
      await mutate(current.host, { action: 'navigateRevision', conversationId: current.id, index });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setNavBusy(false);
    }
  };

  // Other themes on this page with a chat of their own (the less specific ones the rule did not pick).
  const convoOf = (designId: string) => convos.filter((c) => c.designId === designId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const alsoHere = tab && host
    ? themesOn(allDesigns, host, tab.path)
        .map((d) => ({ d, c: convoOf(d.id) }))
        .filter((x): x is { d: Design; c: Conversation } => !!x.c && x.c.id !== currentId)
    : [];
  const levelName = (d: Design) => (scopeOf(d) === 'global' ? 'All sites' : scopeOf(d) === 'page' ? 'This page' : 'Whole site');

  const reachBar =
    reach === 'reload' && tab ? (
      <div className="reach-bar" role="status">
        <span className="reach-icon" aria-hidden="true">⟳</span>
        <span className="reach-text"><strong>Whimsy Web can’t reach this tab yet.</strong> Reload it to start.</span>
        <button className="reach-btn" onClick={() => void chrome.tabs.reload(tab.id)}>Reload tab</button>
      </div>
    ) : reach === 'never' && host ? (
      <div className="reach-bar" role="status">
        <span className="reach-text"><strong>Whimsy Web can’t change Chrome’s own pages.</strong> Open a regular website to start.</span>
      </div>
    ) : null;

  const chatView = (
    <>
      {reachBar}
      {alsoHere.length > 0 && (
        <div className="also-here" role="group" aria-label="Other themes on this page">
          <span className="also-label">Also on this page:</span>
          {alsoHere.map(({ d, c }) => (
            <button key={c.id} className="also-chip" onClick={() => showHere(c.id)} title={`Open the chat for “${d.name}”`}>
              {workingConvos.has(c.id) && <span className="mini-spin" aria-label="working" />}
              <span className="also-level">{levelName(d)}</span>
              <span className="also-name">{d.name}</span>
            </button>
          ))}
        </div>
      )}
      {/* at the top of the chat, above the suggestions, so it is seen without scrolling */}
      {error && (
        <p className="error chat-error" role="alert" ref={errorRef}>
          {error}
        </p>
      )}
      <div className="thread" ref={threadRef}>
        {(!current || blankNew || handStarted) && !pending && (
          <div className="intro">
            <p>
              {handStarted && currentDesign ? (
                <>
                  Continue <strong>{currentDesign.name}</strong> here with AI
                  <br />
                  <span className="hint">Your changes from Edit Mode are kept. Tell me what else to change.</span>
                </>
              ) : host ? (
                <>
                  What should <strong>{host}</strong> feel like?
                </>
              ) : (
                <>
                  Open a website (http/https) and I’ll help you reimagine it.
                  {/* Chrome hides the address of its own pages from extensions, so this shows for any page that is not a normal website. */}
                  <br />
                  <span className="hint">(Google does not allow extensions to make changes to this page)</span>
                </>
              )}
            </p>
            {continueId && !current && (
              <button className="continue-link" onClick={() => showHere(continueId)}>
                Continue your last chat for this site →
              </button>
            )}
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

        {current && !blankNew && !handStarted && timeline(current).map((item) =>
          'kind' in item ? (
            <div key={item.id} className="activity" role="note">
              {item.kind === 'back' ? '↶' : '↷'} {item.kind === 'back' ? 'Went back' : 'Went forward'} to version {item.to + 1}
            </div>
          ) : (
          (({ m }) => (
          <div key={m.id} className={`bubble ${m.role}${m.discarded || (revIds.has(m.id) && revIds.get(m.id)! > activeRev) ? ' undone' : ''}`}>
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
              {revIds.has(m.id) && <span className="ver-tag">{revIds.get(m.id) === activeRev ? `Version ${revIds.get(m.id)! + 1} · ${designOnHere ? 'on the page' : 'not applied'}` : revIds.get(m.id)! > activeRev ? `Version ${revIds.get(m.id)! + 1} · undone` : `Version ${revIds.get(m.id)! + 1}`}</span>}
              {m.discarded && <span className="ver-tag">Discarded</span>}
              {revIds.has(m.id) && (revIds.get(m.id) !== activeRev || !designOnHere) && currentDesign && !busy && (current.host === host || current.scope === 'global') && (
                <button className="link" onClick={() => void goToRevision(revIds.get(m.id)!)}>
                  {revIds.get(m.id) === activeRev ? 'Apply this version' : 'Go to this version'}
                </button>
              )}
            </div>
          </div>
          ))(item)
          ),
        )}

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
            {stage || (viewJob?.newSession && viewJob.illustrations ? 'Weaving magic and painting images' : 'Weaving magic')}
            <Dots />
          </div>
        )}
        <div ref={threadEnd} />
      </div>



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
          </div>
          {/* Where this chat's theme lives, said plainly and big enough to notice. */}
          <p className="scope-place" title={scopeValue === 'page' ? `${noteHost}${scopePath}` : undefined}>
            {scopeValue === 'page' ? (
              <>Only <strong>{noteHost}{scopePath === '/' ? '/ (home page)' : scopePath}</strong></>
            ) : scopeValue === 'global' ? (
              <strong>Every website</strong>
            ) : (
              <>Every page on <strong>{noteHost}</strong></>
            )}
          </p>
          {freshAvailable && (
            <label className="art-check" title="Off: your message changes the current design. On: ignore the current design and anything applied on this page, and build a brand new design from the original site.">
              <input type="checkbox" checked={fresh} disabled={busy} onChange={(e) => setStartFresh(e.target.checked)} />
              <span>Start fresh <span className="muted-inline">(write over the current design)</span></span>
            </label>
          )}
          {newSession && (
            <>
              <LevelBar label="Intensity" levels={INTENSITY_LEVELS} value={intensity} onChange={chooseIntensity} disabled={busy} />
              <LevelChoice label="Polish" levels={POLISH_LEVELS} value={polish} onChange={choosePolish} disabled={busy} />
              {polish >= 2 && <p className="level-note">Uses screenshots: stay on this page until it’s done.</p>}
            </>
          )}
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
          <div className="toolbar">
            {showOriginal ? (
              // left over from the old "Show original" (the page is still hiding its themes): let it be undone
              <button className="ghost" onClick={toggleOriginal} title="Whimsy Web is hidden on this page. Show it again.">
                <EyeIcon size={19} />
                Show themes
              </button>
            ) : (
              <button
                className="ghost"
                disabled={!currentDesign || busy || !host || (!designOnHere && !(current?.host === host || current?.scope === 'global'))}
                onClick={() => currentDesign && void (designOnHere ? turnThemeOff(currentDesign) : turnThemeOn(currentDesign))}
                title={
                  !currentDesign
                    ? 'This chat has no theme yet'
                    : designOnHere
                      ? scopeOf(currentDesign) === 'global'
                        ? `Turn this theme off on ${host} (it stays on for other sites)`
                        : scopeOf(currentDesign) === 'page'
                          ? 'Turn this theme off on this page'
                          : `Turn this theme off on ${host}`
                      : 'Turn this theme on here'
                }
              >
                <EyeIcon size={19} />
                {designOnHere || !currentDesign ? 'Turn off' : 'Turn on'}
              </button>
            )}
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
            <button
              className="ghost icon-only"
              disabled={!canGoBack}
              onClick={() => void goToRevision(activeRev - 1)}
              aria-label="Back to the previous version"
              title={canGoBack ? `Back to version ${activeRev} of ${revisions.length}` : 'No earlier version to go back to'}
            >
              <UndoIcon size={19} />
            </button>
            <button
              className="ghost icon-only"
              disabled={!canGoForward}
              onClick={() => void goToRevision(activeRev + 1)}
              aria-label="Forward to the next version"
              title={canGoForward ? `Forward to version ${activeRev + 2} of ${revisions.length}` : 'No later version to go forward to'}
            >
              <RedoIcon size={19} />
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
          {themeOff && currentDesign && !globalAsk && (
            <div className="calm-note" role="status">
              <span>This theme is off on this page. Sending a message turns it back on.</span>
              <button className="calm-btn" onClick={() => void turnThemeOn(currentDesign)}>Turn it on</button>
            </div>
          )}
          {globalAsk && (
            <div className="global-ask" role="alertdialog" aria-label="Change every website?">
              <p>This changes your theme on <strong>every website</strong>.</p>
              <div className="global-ask-actions">
                <button className="primary" onClick={() => void send(true)}>Send to all sites</button>
                <button
                  className="ghost"
                  onClick={() => {
                    setGlobalAsk(false);
                    setNewScope('site');
                    if (tab && current) {
                      carryDraft.current = true; // the message goes along to the new chat
                      freshNext.current = true;
                      pinTab(tab.id, null, tab);
                    }
                    setStartFresh(true);
                  }}
                >
                  New theme for this site instead
                </button>
              </div>
            </div>
          )}
          <textarea
            rows={3}
            value={input}
            disabled={!canType}
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
              if (e.key === 'Escape' && globalAsk) {
                e.preventDefault();
                setGlobalAsk(false);
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
            <button className="primary" disabled={!canSend || navBusy || globalAsk || (!input.trim() && !attachments.length)} onClick={() => void send()} title={checking ? 'Connecting to this page…' : undefined}>
              {current && !fresh ? 'Send ✦' : 'Transform ✦'}
            </button>
          )}
          <button className="new-chat" onClick={newChat} disabled={busy || !host || unreachable} title="An empty design for this site with its own chat. The one that is on now stays in the Library.">
            <PlusIcon size={18} />
            New design
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
        pinTab(tab.id, res.conversationId, tab);
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
    working: workingConvos,
    fallbackSrc: chrome.runtime.getURL(`fallback-${settings.theme}.webp`), // one per panel theme: light, dark, afterhours
    act: {
      activate: (d, enabled) =>
        void run(d.host, { action: 'activate', id: d.id, enabled }).then(() => {
          // switched on here from the Library: the File (and the chat) move to it
          if (enabled && tab && host && (d.host === host || scopeOf(d) === 'global') && appliesTo(d, tab.path)) showChatOf(d.id);
          if (enabled && !d.thumb) window.setTimeout(() => void refreshPreview(d, true), 1100);
        }),
      refreshPreview: (d) => void refreshPreview(d),
      excludeHere: (d, excluded) => void (host && run(GLOBAL_HOST, { action: 'excludeHost', id: d.id, siteHost: host, excluded })),
      copyHere: (d) => void copyHere(d),
      duplicate: (d) => void duplicate(d),
      clearChat: (d) => void clearChatOf(d),
      undoClearChat: (d) => void undoClearChat(d),
      canUndoClear,
      tryEverywhere,
      undoAllSites: (d) => void undoAllSites(d),
      share: (d) => void run(d.host, { action: 'exportDraft', id: d.id }),
      rename: (d) => void rename(d),
      moveToFolder: (list, folder) => void moveToFolder(list, folder),
      remove: (d) => void removeDesign(d),
      openChat: (c) => void openConvo(c),
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
              {[...pageDesigns].sort(byLastActive(host)).map((d) => (
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
      <HistoryView convos={convos} designsById={designsById} favicons={favicons} currentId={currentId} working={workingConvos} query={histQuery} setQuery={setHistQuery} onOpen={(c) => void openConvo(c)} onRemove={(c) => void removeConvo(c)} onNew={newChat} />
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
                {host && (
                  <FileMenu
                    file={file}
                    on={fileOn}
                    disabled={reach === 'never'}
                    onNew={newChat}
                    onRename={(name) => file && void run(file.host, { action: 'rename', id: file.id, name })}
                    onToggle={() => void toggleFile()}
                    onClearChat={() => file && void clearChatOf(file)}
                    recent={recentFiles}
                    onOpenRecent={(d) => void openRecent(d)}
                    onUndoClearChat={file && canUndoClear(file) ? () => void undoClearChat(file) : undefined}
                    onCopy={() => file && void duplicate(file)}
                    onOpen={() => {
                      setEditMode(false);
                      setView('library');
                    }}
                  />
                )}
                <button
                  className={editMode ? 'icon-btn edit-toggle active' : 'icon-btn edit-toggle'}
                  onClick={() => (editMode ? setEditMode(false) : !tab?.host ? flash('Open a website to edit it') : reach === 'reload' ? flash('Reload this tab first') : reach === 'never' ? flash('This page can’t be changed') : reach === 'pending' ? flash('Still connecting to this page…') : setEditMode(true))}
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
        {editMode && !settingsOpen && <div className="ed-pin-slot" ref={setEdPin} />}
        {/* notices hang just below the pinned top bar, in its corner */}
        <Notices
          notices={notices}
          favicons={favicons}
          onDismiss={dropNotice}
          onGo={(n) => {
            dropNotice(n.id);
            void goToTab(n.tabId, { host: n.host, path: n.path, exact: true }).then((id) => {
              // the chat goes with it: the tab shows the chat this notice is about
              if (id !== null && n.convoId) pinTab(id, n.convoId, id === n.tabId ? { host: n.host, path: n.path } : undefined);
              setView('chat');
            });
          }}
          onSkip={(n) => {
            dropNotice(n.id);
            if (n.requestId) void chrome.runtime.sendMessage({ type: 'ww:skipReview', requestId: n.requestId }).catch(() => undefined);
          }}
        />
        </div>

      {toast && (
        <div className="toast" role="status" aria-live="polite">
          <CheckIcon size={16} /> {toast}
        </div>
      )}
      {settingsOpen ? settingsScreen : editMode && tab?.host ? (
        <Editor key={`${tab.id}|${tab.host}|${tab.path}`} tabId={tab.id} host={tab.host} path={tab.path} flash={flash} pinTo={edPin} fileId={file && fileOn && scopeOf(file) !== 'global' ? file.id : undefined} allSitesFile={file && fileOn && scopeOf(file) === 'global' ? file.name : undefined} onTarget={(id) => {
          editorDesign.current = id;
        }} onExit={(why) => {
          setEditMode(false);
          showChatOf(editorDesign.current);
          if (why) flash(why);
        }} />
      ) : view === 'chat' ? chatView : view === 'page' ? pageView : view === 'library' ? libraryView : historyView}
    </div>
  );
}
