export type Position = 'beforebegin' | 'afterbegin' | 'beforeend' | 'afterend';

/** The only DOM mutations a design may perform. No arbitrary JS. */
export type DomOp =
  | { op: 'hide'; selector: string }
  | { op: 'setText'; selector: string; text: string }
  | { op: 'addClass'; selector: string; className: string }
  | { op: 'move'; selector: string; target: string; position: Position }
  | {
      op: 'insert';
      target: string;
      position: Position;
      tag: string;
      text?: string;
      className?: string;
      style?: string;
      src?: string;
    };

export type DesignScope = 'site' | 'page' | 'global';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the prompt cache (billed at a discount). */
  cacheReadTokens?: number;
  /** Input tokens written to the prompt cache this request. */
  cacheWriteTokens?: number;
}

/** Set on designs installed from the community website. Their CSS is the creator's, never edited by the model. */
export interface CommunityMeta {
  themeId: string;
  versionId: string;
  version: number;
  slug: string;
  hash: string;
  creator: string;
  /** Which pages of `host` the theme covers. Narrower than the design's whole-site slot. */
  pathScope: import('../../theme-core/src').PathScope;
  /** Designs this install turned off, so Remove can turn them back on. */
  displacedIds: string[];
  /** The website the theme came from (used to fetch updates from the same trusted origin). */
  origin: string;
  installedAt: number;
}

export interface Design {
  /** The generation level, when known. Saved designs keep its rendering rules across visits. */
  intensity?: number;
  id: string;
  /** Hostname the design applies to (e.g. "www.youtube.com"). */
  host: string;
  /**
   * 'site' (default, also for older designs) applies to every page of `host`; 'page' only to `path`;
   * 'global' to every website (stored under host "*"), except the hosts in `excludedHosts`.
   */
  scope?: DesignScope;
  /** All-sites designs only: sites where the user turned this design off. */
  excludedHosts?: string[];
  /** Pathname for page-scoped designs, e.g. "/watch". */
  path?: string;
  name: string;
  prompt: string;
  css: string;
  ops: DomOp[];
  enabled: boolean;
  /** Set when this design was copied from another site/page and has not been adapted by the model yet. */
  copiedFrom?: { host: string; path?: string; name: string };
  /** Present when installed from the community website. */
  community?: CommunityMeta;
  /** A short, human descriptor shown under the name in the library ("Paper textures · Soft colors"). */
  descriptor?: string;
  /** A tiny, blurred preview (data URL) with all text and detail removed before it was stored. */
  thumb?: string;
  /** Library folder (organisation only). */
  folder?: string;
  /** Manual visual-editor edits: a layer above the CSS and ops (see shared/edits.ts). */
  edits?: import('./edits').VisualEdit[];
  /** When the edits last changed (saving edits does not change updatedAt, so the design is not re-applied). */
  editsUpdatedAt?: number;
  createdAt: number;
  updatedAt: number;
  /** The last time it was switched on or used (made, refined, restored); older designs fall back to updatedAt. */
  lastActiveAt?: number;
  usage?: Usage;
}

export type ThemeId = 'light' | 'dark' | 'afterhours';

/** swatch = [background, accent, card] colors shown in the settings picker. */
export const THEME_OPTIONS: { id: ThemeId; label: string; swatch: [string, string, string] }[] = [
  { id: 'light', label: 'Light', swatch: ['#fbf4ee', '#7a5ea8', '#fffaf6'] },
  { id: 'dark', label: 'Dark', swatch: ['#1d2029', '#a58bf0', '#262a35'] },
  { id: 'afterhours', label: 'After Hours', swatch: ['#2b211c', '#f0ae4b', '#362a23'] },
];

/** Saved themes from older versions: the old cream "default" and the old blue "light" both become the new Light. */
export const normalizeTheme = (v: unknown): ThemeId => (v === 'dark' ? 'dark' : v === 'afterhours' ? 'afterhours' : 'light');

export type Provider = 'anthropic' | 'openai';

/** Running token counts, summed over every API response that reported usage. */
export interface UsageTotals {
  /** Input tokens that were NOT served from the prompt cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Number of API responses counted. */
  requests: number;
}

export interface ModelUsage extends UsageTotals {
  provider: Provider;
}

export interface UsageStats {
  /** When counting started (first recorded response, or the last reset); null if nothing recorded yet. */
  since: number | null;
  anthropic: UsageTotals;
  openai: UsageTotals;
  byModel: Record<string, ModelUsage>;
}

export const emptyTotals = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  requests: 0,
});

/** Everything the provider billed as tokens for these totals: new + cached + cache writes + output. */
export const totalTokens = (t: UsageTotals): number =>
  t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;

export interface Settings {
  /** Anthropic API key (Claude models). */
  apiKey: string;
  /** OpenAI API key (GPT models). */
  openaiKey: string;
  model: string;
  theme: ThemeId;
  /** Save blurred previews of designs (on by default). Previews hold no text or detail. */
  previews: boolean;
}

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

export const MODEL_OPTIONS: { id: string; label: string; vision: boolean; provider: Provider }[] = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1 (most capable)', vision: true, provider: 'anthropic' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', vision: true, provider: 'anthropic' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 (balanced)', vision: true, provider: 'anthropic' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5 (fastest, cheapest)', vision: true, provider: 'anthropic' },
  // OpenAI model ids can differ by account and change over time: use "Custom model id" for any other.
  { id: 'gpt-5.5-pro', label: 'GPT-5.5 Pro (strongest, slower, costs more)', vision: true, provider: 'openai' },
  { id: 'gpt-5.5', label: 'GPT-5.5', vision: true, provider: 'openai' },
  { id: 'gpt-5.4', label: 'GPT-5.4', vision: true, provider: 'openai' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini (fast, cheaper)', vision: true, provider: 'openai' },
];

/** Which provider serves a model id. Anything that is not a Claude id is treated as an OpenAI model. */
export const providerOf = (modelId: string): Provider => (/^claude/i.test(modelId.trim()) ? 'anthropic' : 'openai');

/**
 * Whether the selected model accepts image input. Listed models say so; an unlisted Claude id is
 * treated as text-only, an unlisted OpenAI id as image-capable (current GPT models accept images; if
 * yours does not, the API error is shown).
 */
export const supportsImages = (modelId: string): boolean =>
  MODEL_OPTIONS.find((m) => m.id === modelId)?.vision ?? providerOf(modelId) === 'openai';

export const MAX_ATTACHMENTS = 8;

export interface ImageAttachment {
  mediaType: 'image/jpeg';
  /** 'screenshot' = the user's current page; 'reference' = inspiration they uploaded. */
  label?: 'screenshot' | 'reference' | 'asset';
  /** base64, no data: prefix */
  data: string;
}

export type DesignMap = Record<string, Design>;

// ---- Messages ----------------------------------------------------------

export interface PageContext {
  host: string;
  /** Normalized pathname of the page. */
  path: string;
  url: string;
  title: string;
  context: string;
}

export type ContentMessage =
  | { type: 'ww:extract' }
  | { type: 'ww:setOriginal'; original: boolean }
  | { type: 'ww:getState' }
  | { type: 'ww:contrastReview'; designId: string; version: number; path: string }
  /** Preview screenshots: skeletonise the page (text -> bars, images blurred), then restore it. */
  | { type: 'ww:previewBegin' }
  | { type: 'ww:previewEnd' }
  /** Show the snipping overlay; answers with the dragged rectangle, or null if cancelled. */
  | { type: 'ww:snip' }
  | { type: 'ww:snipCancel' };

export interface ContrastReviewTarget {
  selector: string;
  kind: 'background' | 'opacity';
  source?: string;
}

export interface ContentState {
  host: string;
  original: boolean;
  appliedIds: string[];
  /** The version (updatedAt) of each applied design. */
  versions?: Record<string, number>;
  /** True only if Whimsy Web's CSS/HTML is really present in the page right now. */
  applied: boolean;
  /** Readability check: how many text colours were adjusted on this page. */
  contrast?: { fixed: number; checked: number; unknown: number };
  /** Theme conformance: site-style overrides, live corrections and doubled borders removed on this page. */
  theme?: { rules: number; marked: number; borders: number; unreadable: number };
}

/** Preferences that hold no secrets (the page scripts may read these; they never read the API keys). */
export interface Prefs {
  /** Nudge unreadable text darker or lighter after a design is applied. */
  contrastFix: boolean;
  /** Keep colours the site adds (hover, focus, pop-ups) on the design's theme, and draw doubled borders once. */
  themeFix: boolean;
}

export type BackgroundMessage = {
  type: 'ww:generate';
  tabId: number;
  prompt: string;
  /** Continue this conversation (and refine its design). Omit to start a new one. */
  conversationId?: string;
  /** Where a NEW design applies. Ignored when the conversation already has a design. */
  scope?: DesignScope;
  /** Lets the panel cancel this request with a `ww:cancel` message. */
  requestId?: string;
  /** Older panels: let the model also ask for generated illustrations (same as intensity 2). */
  illustrations?: boolean;
  /** How far the redesign goes, 1-5 (see INTENSITY_LEVELS). 2 and up use generated pictures. */
  intensity?: number;
  /** How much the result is reviewed from screenshots and improved, 1-3 (see POLISH_LEVELS). */
  polish?: number;
  /** Ignore the current design, the open chat and anything applied: build a brand new design from the ORIGINAL page. */
  fresh?: boolean;
  /** Images for THIS message only: reference uploads and/or a screenshot. Requires an image-capable model. */
  images?: ImageAttachment[];
};

export type CancelMessage = { type: 'ww:cancel'; requestId: string };

export type CaptureMessage = { type: 'ww:capture'; tabId: number };
export type CaptureResponse = { ok: true; data: string } | { ok: false; error: string };

/** All writes to saved data go through the background worker's serialized queue. */
export type MutateMessage = { type: 'ww:mutate'; host: string } & (
  /** id = null turns every design for the host off. `enabled` defaults to true. */
  | { action: 'activate'; id: string | null; enabled?: boolean }
  | { action: 'setScope'; id: string; scope: DesignScope; path: string }
  /** Clears the token usage counters. */
  | { action: 'resetUsage' }
  /** Turns an all-sites design off (or back on) for one site without disabling it everywhere. */
  | { action: 'excludeHost'; id: string; siteHost: string; excluded: boolean }
  /** Copies a saved design onto `host` (the target) with no AI call, and starts a conversation about it. */
  /** asCopy: a copy kept next to the original on the same site, named "Name 2". */
  | { action: 'copyDesign'; sourceHost: string; sourceId: string; scope: DesignScope; path: string; asCopy?: boolean }
  /** The design's chat starts over (one message, from its current version); the design is not changed. */
  | { action: 'clearChat'; id: string }
  /** Brings a cleared chat back as it was (within a day, while nothing new was asked in it). */
  | { action: 'undoClearChat'; id: string }
  | { action: 'delete'; id: string }
  /** Prepares a design's CSS for the website's publishing flow; the response carries the URL to open. */
  | { action: 'exportDraft'; id: string }
  /** Stores a small PNG favicon (data URL) for `host`, shown in the library next to its designs. */
  | { action: 'saveFavicon'; dataUrl: string }
  /** Makes a blurred, detail-free preview of design `id` from the tab that is open (only if it is on screen and switched on). */
  | { action: 'capturePreview'; id: string }
  /** Deletes every saved preview image. */
  | { action: 'clearThumbs' }
  | { action: 'rename'; id: string; name: string }
  /** Puts design `id` in a Library folder; an empty name takes it out. */
  | { action: 'setFolder'; id: string; folder: string }
  | { action: 'deleteConversation'; id: string }
  | { action: 'restore'; conversationId: string; messageId: string }
  /** Saves the visual-editor edits of design `id`, or creates a design for them (`create`) when none applies here. */
  | { action: 'setEdits'; id?: string; create?: { scope: 'site' | 'page'; path: string }; edits: unknown; expectVersion?: number }
  /** A new, empty theme made by hand (with its own chat); it becomes the one switched on here. */
  | { action: 'newTheme'; scope: 'site' | 'page'; path: string }
  /** A new design left without anything in it (no message, no edit) is removed, with its chat. */
  | { action: 'dropIfEmpty'; id: string }
  /** Stores an image the user chose in the editor (a small data URL); the response carries its token. */
  | { action: 'saveArt'; dataUrl: string; w: number; h: number }
  /** Back/Forward: applies revision `index` (0-based) of the chat's design and saves it as the design. */
  | { action: 'navigateRevision'; conversationId: string; index: number }
);

/** "Ask Claude about this element" (side panel only). */
/** mode: restyle the selected element (default), or add a new element next to or inside it. */
/** What "Modify with Claude" can ask to see before answering (gathered from the page by the panel). */
export type AiContextKind = 'parents' | 'children' | 'siblings' | 'similar' | 'page';
export const AI_CONTEXT_KINDS: AiContextKind[] = ['parents', 'children', 'siblings', 'similar', 'page'];
/**
 * One change from Claude: to the selection, to every element like it ("similar"), to the page, or to an element it
 * was shown (a ref like "e12"); in the normal look, or while pointed at or focused.
 */
export type AiChange = { target: string; state: 'normal' | 'hover' | 'focus'; css: Record<string, string> };
export type EditElementMessage = {
  type: 'ww:editElement';
  prompt: string;
  el: unknown;
  mode?: 'edit' | 'add';
  /** More of the page, which Claude asked for (the second call). */
  context?: string;
  /** The targets Claude may change besides "selection". */
  targets?: string[];
  /** The second call: answer now, no more asking. */
  final?: boolean;
};
export type EditElementResponse = { ok: true; need: AiContextKind[]; changes: AiChange[]; reply: string } | { ok: false; error: string };
/** A new element the model designed (kind and place are checked by the background; the page cleans the CSS again). */
export type AddElementResponse = { ok: true; add: { kind: 'text' | 'heading' | 'button' | 'divider' | 'box'; position: 'before' | 'after' | 'inside'; text: string; css: Record<string, string> }; reply: string } | { ok: false; error: string };

export type GenerateResponse =
  | { ok: true; conversation: Conversation; design: Design }
  | { ok: false; error: string; cancelled?: boolean };

// ---- Conversations -------------------------------------------------------

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  /** This turn included a screenshot of the page (the image itself is not stored). */
  screenshot?: boolean;
  /** How many screenshots or snips came with this message (when more than one). */
  screenshotCount?: number;
  /** Number of reference images the user attached (the images themselves are not stored). */
  imageCount?: number;
  /** Assistant turns: the design as it stood after this reply (enables "restore this version"). */
  snapshot?: { css: string; ops: DomOp[] };
  /** A revision that was undone and then replaced by a newer change (kept in the transcript, never applied again). */
  discarded?: boolean;
  usage?: Usage;
}

export interface Conversation {
  id: string;
  host: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** The design this conversation is refining. */
  designId?: string;
  /**
   * The page outline sent with the first turn. Reused on later turns (same path) so the cached
   * prompt prefix stays byte-identical instead of changing with every fresh extraction.
   */
  pageContext?: { host?: string; path: string; text: string };
  /** Mirrors the design's scope for display in lists. */
  scope?: DesignScope;
  path?: string;
  messages: ChatMessage[];
  /** The applied revision (0-based index into revisionsOf); absent = the latest. */
  revisionIndex?: number;
  /** Back/Forward moves, shown as activity lines and told to the model. */
  events?: import('./revisions').RevisionEvent[];
  /** The settings the chat's first design was made with; later turns are refinements and do not reapply them. */
  session?: { intensity: number; polish: number };
}

/** How far a redesign goes. Level 1 is CSS only; 2 and up add pictures painted by OpenAI's image model. */
export const INTENSITY_LEVELS = [
  { level: 1, name: 'Simple', hint: 'New colours, fonts and shapes' },
  { level: 2, name: 'Illustrated', hint: 'Adds illustrated accents' },
  { level: 3, name: 'Enchanted', hint: 'Decorated parts, illustrated backdrops' },
  { level: 4, name: 'Immersive', hint: 'A whole themed setting' },
  { level: 5, name: 'Chaos', hint: 'A bold rework of the page' },
] as const;
export const DEFAULT_INTENSITY = 1;
/** A safe level from anything (old messages, storage): whole numbers 1-5. */
export const clampIntensity = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : DEFAULT_INTENSITY;
};

/** How extensively a result is reviewed and improved after it is applied (independent of Intensity). */
export const POLISH_LEVELS = [
  { level: 1, name: 'Quick', hint: 'One pass' },
  { level: 2, name: 'Polished', hint: 'Checks a screenshot, fixes problems' },
  { level: 3, name: 'Studio', hint: 'Reworks and rechecks, keeps the best' },
] as const;
export const DEFAULT_POLISH = 1;
export const clampPolish = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(3, Math.max(1, n)) : DEFAULT_POLISH;
};
