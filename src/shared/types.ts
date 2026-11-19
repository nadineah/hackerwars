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
  createdAt: number;
  updatedAt: number;
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
  /** Preview screenshots: skeletonise the page (text -> bars, images blurred), then restore it. */
  | { type: 'ww:previewBegin' }
  | { type: 'ww:previewEnd' }
  /** Show the snipping overlay; answers with the dragged rectangle, or null if cancelled. */
  | { type: 'ww:snip' }
  | { type: 'ww:snipCancel' };

export interface ContentState {
  host: string;
  original: boolean;
  appliedIds: string[];
  /** True only if Whimsy Web's CSS/HTML is really present in the page right now. */
  applied: boolean;
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
  /** OpenAI models only: let the model also ask for generated illustrations. */
  illustrations?: boolean;
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
  | { action: 'copyDesign'; sourceHost: string; sourceId: string; scope: DesignScope; path: string }
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
  | { action: 'deleteConversation'; id: string }
  | { action: 'restore'; conversationId: string; messageId: string }
);

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
}
