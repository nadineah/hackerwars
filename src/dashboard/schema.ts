import { isSafeSelector } from '../shared/validate';
import { checkCollectionUrl, cleanText, hashHex, stableStringify } from './util';

/**
 * Versioned schemas for Dashboard mode, plus validators. EVERYTHING that comes from the AI, from an import, or
 * from storage written by an older version goes through these before it is used. There is no code in a
 * configuration: only data the extension's own reviewed code interprets.
 */
export const SCHEMA_VERSION = 1;

export const LIMITS = {
  dashboards: 30,
  widgetsPerDashboard: 24,
  sourcesTotal: 40,
  sourcesPerWidget: 8,
  maxItems: 50,
  titleChars: 80,
  nameChars: 60,
  selectorChars: 200,
  notesChars: 20_000,
  links: 200,
  linkTitleChars: 120,
  pathChars: 120,
  keywordChars: 60,
  waitMsMax: 15_000,
} as const;

// ------------------------------------------------------------------------------------------ connectors (static facts)

export type SourceKind = 'feed' | 'json' | 'html' | 'rendered' | 'page-change';
export type CollectionMethod = 'fetch' | 'rendered';

export interface KindInfo {
  label: string;
  method: CollectionMethod;
  /** Shortest allowed refresh interval, minutes. */
  minIntervalMin: number;
  defaultIntervalMin: number;
  maxIntervalMin: number;
  /** Hard time limit for one collection, ms. */
  timeoutMs: number;
  /** Needs an offscreen document to parse HTML/XML (service workers have no DOM). */
  needsOffscreen: boolean;
  /** May open a managed background tab. */
  backgroundTab: boolean;
  /** Works with the user's existing signed-in browser session. */
  usesBrowserSession: boolean;
  summary: string;
}

export const KINDS: Record<SourceKind, KindInfo> = {
  feed: { label: 'RSS / Atom feed', method: 'fetch', minIntervalMin: 10, defaultIntervalMin: 30, maxIntervalMin: 1440, timeoutMs: 20_000, needsOffscreen: true, backgroundTab: false, usesBrowserSession: false, summary: 'Reads a published feed in the background. No tab is opened and no cookies are sent.' },
  json: { label: 'JSON API', method: 'fetch', minIntervalMin: 10, defaultIntervalMin: 30, maxIntervalMin: 1440, timeoutMs: 20_000, needsOffscreen: false, backgroundTab: false, usesBrowserSession: false, summary: 'Reads a public JSON endpoint in the background. No tab is opened and no cookies are sent.' },
  html: { label: 'Web page (scraped)', method: 'fetch', minIntervalMin: 15, defaultIntervalMin: 30, maxIntervalMin: 1440, timeoutMs: 25_000, needsOffscreen: true, backgroundTab: false, usesBrowserSession: false, summary: 'Downloads the page HTML in the background and reads only the fields you chose. Scripts on the page are never run.' },
  rendered: { label: 'Web page (needs JavaScript or sign-in)', method: 'rendered', minIntervalMin: 30, defaultIntervalMin: 60, maxIntervalMin: 1440, timeoutMs: 45_000, needsOffscreen: false, backgroundTab: true, usesBrowserSession: true, summary: 'Briefly opens the page in an inactive background tab so its JavaScript and your existing sign-in work, reads the chosen fields, then closes that tab.' },
  'page-change': { label: 'Page change watcher', method: 'fetch', minIntervalMin: 15, defaultIntervalMin: 30, maxIntervalMin: 1440, timeoutMs: 25_000, needsOffscreen: true, backgroundTab: false, usesBrowserSession: false, summary: 'Watches one section of a page and tells you when its text changes.' },
};

// ------------------------------------------------------------------------------------------ configs

export type FieldAttr = 'text' | 'href' | 'src' | 'datetime' | 'content' | 'title' | 'alt';
const ATTRS: FieldAttr[] = ['text', 'href', 'src', 'datetime', 'content', 'title', 'alt'];

export interface FieldSpec {
  /** CSS selector RELATIVE to the item. Empty/omitted = the item element itself. */
  selector?: string;
  attr?: FieldAttr;
}
export interface ItemFields {
  title: FieldSpec;
  url?: FieldSpec;
  summary?: FieldSpec;
  image?: FieldSpec;
  published?: FieldSpec;
}

export interface FeedConfig {
  maxItems: number;
}
export interface JsonConfig {
  /** Dot path to the array of items, e.g. "hits" or "data.children". "" = the response itself is the array. */
  itemsPath: string;
  /** Dot paths relative to one item. */
  fields: { title: string; url?: string; summary?: string; image?: string; published?: string };
  /** Used when the item has no url: "https://example.com/item?id={objectID}" (only {dot.path} placeholders). */
  urlTemplate?: string;
  maxItems: number;
}
export interface HtmlConfig {
  itemSelector: string;
  fields: ItemFields;
  maxItems: number;
}
export interface RenderedConfig extends HtmlConfig {
  /** Wait for this selector to appear before reading (bounded). */
  waitFor?: string;
  waitMs: number;
}
export interface PageChangeConfig {
  selector: string;
  /** How to load the page: static HTML in the background, or in a managed background tab. */
  via: 'fetch' | 'rendered';
  waitMs: number;
}

export type SourceConfig = FeedConfig | JsonConfig | HtmlConfig | RenderedConfig | PageChangeConfig;

export interface Approval {
  approvedAt: number;
  kind: SourceKind;
  method: CollectionMethod;
  /** Exact hostnames the collector may talk to (www/bare variants count as one site). */
  hosts: string[];
  backgroundTabs: boolean;
  intervalMinutes: number;
  /** Always true in this phase: collected data stays in this browser. */
  dataLocalOnly: true;
}

export interface Source {
  schemaVersion: number;
  id: string;
  kind: SourceKind;
  name: string;
  url: string;
  config: SourceConfig;
  intervalMinutes: number;
  /** For `rendered` sources: whether opening a managed background tab is allowed. */
  backgroundTabs: boolean;
  /** Null until the user approves automatic updates. The scheduler never runs an unapproved source. */
  approval: Approval | null;
  createdAt: number;
  updatedAt: number;
}

// ------------------------------------------------------------------------------------------ widgets & dashboards

export type WidgetType = 'updates' | 'list' | 'page-change' | 'links' | 'notes';
export type WidgetWidth = 1 | 2 | 3;

interface WidgetBase {
  id: string;
  title: string;
  w: WidgetWidth;
  /** "Pause updates for this widget": a source nobody wants updated is not scheduled. */
  paused?: boolean;
}
export interface UpdatesWidget extends WidgetBase {
  type: 'updates';
  sourceIds: string[];
  sort: 'published' | 'collected';
  limit: number;
  keyword?: string;
  /** Show when each source was last checked. */
  showChecked: boolean;
}
export interface ListWidget extends WidgetBase {
  type: 'list';
  sourceId: string;
  limit: number;
  showSummary: boolean;
  showImage: boolean;
  showTime: boolean;
}
export interface PageChangeWidget extends WidgetBase {
  type: 'page-change';
  sourceId: string;
}
export interface LinksWidget extends WidgetBase {
  type: 'links';
  links: { id: string; title: string; url: string }[];
}
export interface NotesWidget extends WidgetBase {
  type: 'notes';
  text: string;
}
export type Widget = UpdatesWidget | ListWidget | PageChangeWidget | LinksWidget | NotesWidget;

export type ThemeMode = 'auto' | 'light' | 'dark';
export const ACCENTS = ['ink', 'blue', 'green', 'rose', 'amber', 'violet'] as const;
export type Accent = (typeof ACCENTS)[number];

export interface DashboardTheme {
  mode: ThemeMode;
  accent: Accent;
  /** Grayscale rendering. */
  mono: boolean;
}

export interface Dashboard {
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  paused: boolean;
  columns: 1 | 2 | 3;
  theme: DashboardTheme;
  widgets: Widget[];
}

export const DEFAULT_THEME: DashboardTheme = { mode: 'auto', accent: 'ink', mono: false };

// ------------------------------------------------------------------------------------------ validation plumbing

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };
class Errs {
  list: string[] = [];
  add(path: string, msg: string) {
    this.list.push(`${path}: ${msg}`);
  }
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const int = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN;
  return Number.isNaN(n) ? dflt : Math.min(max, Math.max(min, n));
};
const strictInt = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;

const PATH_RE = /^[A-Za-z0-9_$-]+(\[\d{1,3}\])?(\.[A-Za-z0-9_$-]+(\[\d{1,3}\])?){0,7}$/;
/** A dot path with optional [n] indexes. No brackets with expressions, no wildcards, no function calls. */
const BLOCKED_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
export const isSafePath = (p: unknown): p is string =>
  typeof p === 'string' &&
  p.length <= LIMITS.pathChars &&
  PATH_RE.test(p) &&
  !p.split('.').some((seg) => BLOCKED_SEGMENTS.has(seg.replace(/\[\d+\]$/, '')));

function readField(v: unknown, path: string, e: Errs, required: boolean): FieldSpec | undefined {
  if (v === undefined || v === null) {
    if (required) e.add(path, 'is required');
    return undefined;
  }
  if (!isObj(v)) {
    e.add(path, 'must be an object like {"selector": "...", "attr": "text"}');
    return undefined;
  }
  const out: FieldSpec = {};
  if (v.selector !== undefined && v.selector !== '') {
    if (typeof v.selector !== 'string' || v.selector.length > LIMITS.selectorChars || !isSafeSelector(v.selector)) e.add(`${path}.selector`, 'is not a valid, safe CSS selector');
    else out.selector = v.selector;
  }
  if (v.attr !== undefined) {
    if (!ATTRS.includes(v.attr as FieldAttr)) e.add(`${path}.attr`, `must be one of ${ATTRS.join(', ')}`);
    else out.attr = v.attr as FieldAttr;
  }
  return out;
}

function readItemFields(v: unknown, path: string, e: Errs): ItemFields | undefined {
  if (!isObj(v)) {
    e.add(path, 'is required');
    return undefined;
  }
  const title = readField(v.title, `${path}.title`, e, true);
  const out: ItemFields = { title: title ?? {} };
  for (const k of ['url', 'summary', 'image', 'published'] as const) {
    const f = readField(v[k], `${path}.${k}`, e, false);
    if (f) out[k] = f;
  }
  return out;
}

// ------------------------------------------------------------------------------------------ source config

export function validateSourceConfig(kind: SourceKind, raw: unknown): Result<SourceConfig> {
  const e = new Errs();
  if (!isObj(raw)) return { ok: false, errors: ['config: must be an object'] };
  const maxItems = int(raw.maxItems, 1, LIMITS.maxItems, 20);
  let value: SourceConfig | undefined;
  switch (kind) {
    case 'feed':
      value = { maxItems };
      break;
    case 'json': {
      if (raw.itemsPath !== '' && !isSafePath(raw.itemsPath)) e.add('config.itemsPath', 'must be a dot path like "hits" or "data.items" (or empty if the response is the list)');
      const f = isObj(raw.fields) ? raw.fields : {};
      if (!isSafePath(f.title)) e.add('config.fields.title', 'must be a dot path such as "title"');
      const fields: JsonConfig['fields'] = { title: String(f.title ?? '') };
      for (const k of ['url', 'summary', 'image', 'published'] as const) {
        if (f[k] === undefined || f[k] === '') continue;
        if (!isSafePath(f[k])) e.add(`config.fields.${k}`, 'must be a dot path');
        else fields[k] = f[k] as string;
      }
      let urlTemplate: string | undefined;
      if (raw.urlTemplate !== undefined && raw.urlTemplate !== '') {
        const t = raw.urlTemplate;
        if (typeof t !== 'string' || t.length > 300 || !/^https?:\/\//i.test(t) || !/^[^{}]*(\{[A-Za-z0-9_.$-]+\}[^{}]*)*$/.test(t)) e.add('config.urlTemplate', 'must be an http(s) address with optional {path} placeholders');
        else urlTemplate = t;
      }
      value = { itemsPath: typeof raw.itemsPath === 'string' ? raw.itemsPath : '', fields, urlTemplate, maxItems };
      break;
    }
    case 'html':
    case 'rendered': {
      const itemSelector = raw.itemSelector;
      if (typeof itemSelector !== 'string' || !itemSelector.trim() || itemSelector.length > LIMITS.selectorChars || !isSafeSelector(itemSelector)) e.add('config.itemSelector', 'must be a valid, safe CSS selector for ONE item (for example "article.post")');
      const fields = readItemFields(raw.fields, 'config.fields', e);
      const base: HtmlConfig = { itemSelector: String(itemSelector ?? ''), fields: fields ?? { title: {} }, maxItems };
      if (kind === 'rendered') {
        let waitFor: string | undefined;
        if (raw.waitFor !== undefined && raw.waitFor !== '') {
          if (typeof raw.waitFor !== 'string' || !isSafeSelector(raw.waitFor)) e.add('config.waitFor', 'must be a valid, safe CSS selector');
          else waitFor = raw.waitFor;
        }
        value = { ...base, waitFor, waitMs: int(raw.waitMs, 1000, LIMITS.waitMsMax, 8000) } as RenderedConfig;
      } else value = base;
      break;
    }
    case 'page-change': {
      if (typeof raw.selector !== 'string' || !raw.selector.trim() || !isSafeSelector(raw.selector)) e.add('config.selector', 'must be a valid, safe CSS selector for the section to watch');
      const via = raw.via === 'rendered' ? 'rendered' : 'fetch';
      value = { selector: String(raw.selector ?? ''), via, waitMs: int(raw.waitMs, 1000, LIMITS.waitMsMax, 8000) } as PageChangeConfig;
      break;
    }
    default:
      return { ok: false, errors: [`kind: unsupported source type "${String(kind)}"`] };
  }
  return e.list.length ? { ok: false, errors: e.list } : { ok: true, value: value! };
}

/** `rendered` page-change watchers behave like the rendered connector for permissions and timing. */
export function effectiveMethod(kind: SourceKind, config: SourceConfig): CollectionMethod {
  if (kind === 'page-change') return (config as PageChangeConfig).via === 'rendered' ? 'rendered' : 'fetch';
  return KINDS[kind].method;
}
export const effectiveInfo = (kind: SourceKind, config: SourceConfig): KindInfo => {
  const base = KINDS[kind];
  return effectiveMethod(kind, config) === 'rendered' && kind === 'page-change'
    ? { ...base, method: 'rendered', minIntervalMin: KINDS.rendered.minIntervalMin, defaultIntervalMin: KINDS.rendered.defaultIntervalMin, timeoutMs: KINDS.rendered.timeoutMs, needsOffscreen: false, backgroundTab: true, usesBrowserSession: true }
    : base;
};

// ------------------------------------------------------------------------------------------ source

export interface SourceInput {
  kind: unknown;
  name?: unknown;
  url: unknown;
  config: unknown;
  intervalMinutes?: unknown;
  backgroundTabs?: unknown;
}
export interface ValidationOptions {
  allowLocal?: boolean;
  /** Developer/test override that lowers minimum intervals. Never set by the UI. */
  fastIntervals?: boolean;
}

/** The stable id of a source: identical (kind, url, config) requests from different widgets/dashboards share ONE source. */
export function sourceIdFor(kind: SourceKind, url: string, config: SourceConfig): string {
  return `src_${hashHex(stableStringify({ kind, url, config })).slice(0, 20)}`;
}

export function validateSourceInput(raw: SourceInput, opts: ValidationOptions = {}, now = Date.now()): Result<Omit<Source, 'approval'>> {
  const e = new Errs();
  const kind = raw.kind as SourceKind;
  if (!(kind in KINDS)) return { ok: false, errors: [`kind: "${String(raw.kind)}" is not a supported source type. Supported: ${Object.keys(KINDS).join(', ')}.`] };
  const urlCheck = checkCollectionUrl(raw.url, { allowLocal: opts.allowLocal });
  if (!urlCheck.ok) e.add('url', urlCheck.reason!);
  const cfg = validateSourceConfig(kind, raw.config);
  if (!cfg.ok) cfg.errors.forEach((m) => e.list.push(m));
  if (e.list.length) return { ok: false, errors: e.list };
  const config = (cfg as { ok: true; value: SourceConfig }).value;
  const url = urlCheck.url!.toString();
  const info = effectiveInfo(kind, config);
  const min = opts.fastIntervals ? 1 : info.minIntervalMin;
  const requested = strictInt(raw.intervalMinutes, 1, 100_000);
  if (raw.intervalMinutes !== undefined && requested === null) e.add('intervalMinutes', 'must be a whole number of minutes');
  else if (requested !== null && (requested < min || requested > info.maxIntervalMin)) e.add('intervalMinutes', `must be between ${min} and ${info.maxIntervalMin} minutes for this kind of source`);
  if (e.list.length) return { ok: false, errors: e.list };
  const name = cleanText(typeof raw.name === 'string' ? raw.name : '', LIMITS.nameChars) || urlCheck.url!.hostname.replace(/^www\./, '');
  return {
    ok: true,
    value: {
      schemaVersion: SCHEMA_VERSION,
      id: sourceIdFor(kind, url, config),
      kind,
      name,
      url,
      config,
      intervalMinutes: requested ?? info.defaultIntervalMin,
      backgroundTabs: info.backgroundTab ? raw.backgroundTabs === true : false,
      createdAt: now,
      updatedAt: now,
    },
  };
}

/** What a user must approve before a source may run. Used by the approval dialog and compared to detect expansion. */
export function approvalFor(src: Pick<Source, 'kind' | 'url' | 'config' | 'intervalMinutes' | 'backgroundTabs'>, now = Date.now()): Approval {
  const info = effectiveInfo(src.kind, src.config);
  return {
    approvedAt: now,
    kind: src.kind,
    method: info.method,
    hosts: [new URL(src.url).hostname.toLowerCase().replace(/^www\./, '')],
    backgroundTabs: info.backgroundTab ? src.backgroundTabs : false,
    intervalMinutes: src.intervalMinutes,
    dataLocalOnly: true,
  };
}

/**
 * Does an existing approval still cover this source? Expanding to a new host, a different collection method or
 * kind, or enabling background tabs needs a fresh approval. A faster interval is NOT an expansion of access
 * (it is still bounded by the connector minimum), but a materially different data scope is: that is the kind change.
 */
export function approvalCovers(approval: Approval | null, src: Pick<Source, 'kind' | 'url' | 'config' | 'backgroundTabs'>): boolean {
  if (!approval) return false;
  const want = approvalFor({ ...src, intervalMinutes: approval.intervalMinutes });
  return (
    approval.kind === want.kind &&
    approval.method === want.method &&
    want.hosts.every((h) => approval.hosts.includes(h)) &&
    (!want.backgroundTabs || approval.backgroundTabs)
  );
}

// ------------------------------------------------------------------------------------------ widgets

export interface WidgetValidationContext {
  /** Source ids that exist (widgets may only reference real sources). */
  sourceIds: Set<string>;
  newId: (prefix: string) => string;
}

export function validateWidget(raw: unknown, ctx: WidgetValidationContext, path = 'widget'): Result<Widget> {
  const e = new Errs();
  if (!isObj(raw)) return { ok: false, errors: [`${path}: must be an object`] };
  const type = raw.type as WidgetType;
  if (!['updates', 'list', 'page-change', 'links', 'notes'].includes(type)) return { ok: false, errors: [`${path}.type: unsupported widget type "${String(raw.type)}"`] };
  const id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(raw.id) ? raw.id : ctx.newId('w');
  const title = cleanText(typeof raw.title === 'string' ? raw.title : '', LIMITS.titleChars);
  const w = ([1, 2, 3] as const).find((x) => x === raw.w) ?? 1;
  const paused = raw.paused === true ? true : undefined;
  const base = { id, title, w: w as WidgetWidth, ...(paused ? { paused } : {}) };
  const refSource = (v: unknown, p: string): string | null => {
    if (typeof v !== 'string' || !ctx.sourceIds.has(v)) {
      e.add(p, 'must be the id of an existing source');
      return null;
    }
    return v;
  };
  let value: Widget | undefined;
  switch (type) {
    case 'updates': {
      const ids = Array.isArray(raw.sourceIds) ? raw.sourceIds : [];
      if (ids.length === 0) e.add(`${path}.sourceIds`, 'needs at least one source');
      if (ids.length > LIMITS.sourcesPerWidget) e.add(`${path}.sourceIds`, `can combine at most ${LIMITS.sourcesPerWidget} sources`);
      const sourceIds = [...new Set(ids.map((v, i) => refSource(v, `${path}.sourceIds[${i}]`)).filter((x): x is string => !!x))];
      const keyword = typeof raw.keyword === 'string' ? cleanText(raw.keyword, LIMITS.keywordChars) : '';
      value = { ...base, type, title: title || 'Latest updates', sourceIds, sort: raw.sort === 'collected' ? 'collected' : 'published', limit: int(raw.limit, 1, LIMITS.maxItems, 15), ...(keyword ? { keyword } : {}), showChecked: raw.showChecked !== false };
      break;
    }
    case 'list': {
      const sourceId = refSource(raw.sourceId, `${path}.sourceId`);
      value = { ...base, type, title: title || 'List', sourceId: sourceId ?? '', limit: int(raw.limit, 1, LIMITS.maxItems, 10), showSummary: raw.showSummary !== false, showImage: raw.showImage === true, showTime: raw.showTime !== false };
      break;
    }
    case 'page-change': {
      const sourceId = refSource(raw.sourceId, `${path}.sourceId`);
      value = { ...base, type, title: title || 'Page watcher', sourceId: sourceId ?? '' };
      break;
    }
    case 'links': {
      const links: LinksWidget['links'] = [];
      for (const [i, l] of (Array.isArray(raw.links) ? raw.links : []).slice(0, LIMITS.links).entries()) {
        if (!isObj(l)) continue;
        const check = checkCollectionUrl(l.url, { allowLocal: true });
        // Saved links are just links the user clicks: any http(s) URL is fine, but never javascript:/data:/file:.
        if (!check.ok || !check.url) {
          e.add(`${path}.links[${i}].url`, check.reason ?? 'invalid address');
          continue;
        }
        links.push({ id: typeof l.id === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(l.id) ? l.id : ctx.newId('l'), title: cleanText(typeof l.title === 'string' ? l.title : '', LIMITS.linkTitleChars) || check.url.hostname, url: check.url.toString() });
      }
      value = { ...base, type, title: title || 'Saved links', links };
      break;
    }
    case 'notes': {
      const text = typeof raw.text === 'string' ? raw.text.slice(0, LIMITS.notesChars) : '';
      value = { ...base, type, title: title || 'Notes', text };
      break;
    }
  }
  return e.list.length ? { ok: false, errors: e.list } : { ok: true, value: value! };
}

// ------------------------------------------------------------------------------------------ dashboards

export function validateTheme(raw: unknown): DashboardTheme {
  const r = isObj(raw) ? raw : {};
  return {
    mode: r.mode === 'light' || r.mode === 'dark' ? r.mode : 'auto',
    accent: (ACCENTS as readonly string[]).includes(r.accent as string) ? (r.accent as Accent) : 'ink',
    mono: r.mono === true,
  };
}

export function newDashboard(id: string, name = 'Untitled dashboard', now = Date.now()): Dashboard {
  return { schemaVersion: SCHEMA_VERSION, id, name, createdAt: now, updatedAt: now, paused: false, columns: 2, theme: { ...DEFAULT_THEME }, widgets: [] };
}

/**
 * Validates a whole dashboard (for storage reads, imports and undo snapshots). Invalid widgets are dropped and
 * reported; the rest is kept, so one bad widget never makes a dashboard unopenable.
 */
export function validateDashboard(raw: unknown, ctx: WidgetValidationContext): { dashboard: Dashboard | null; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw)) return { dashboard: null, errors: ['dashboard: must be an object'] };
  const id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(raw.id) ? raw.id : null;
  if (!id) return { dashboard: null, errors: ['dashboard.id: invalid'] };
  const widgets: Widget[] = [];
  const seen = new Set<string>();
  for (const [i, w] of (Array.isArray(raw.widgets) ? raw.widgets : []).slice(0, LIMITS.widgetsPerDashboard).entries()) {
    const r = validateWidget(w, ctx, `widgets[${i}]`);
    if (!r.ok) {
      errors.push(...r.errors);
      continue;
    }
    if (seen.has(r.value.id)) r.value.id = ctx.newId('w');
    seen.add(r.value.id);
    widgets.push(r.value);
  }
  return {
    dashboard: {
      schemaVersion: SCHEMA_VERSION,
      id,
      name: cleanText(typeof raw.name === 'string' ? raw.name : '', LIMITS.nameChars) || 'Untitled dashboard',
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
      paused: raw.paused === true,
      columns: raw.columns === 1 || raw.columns === 3 ? raw.columns : 2,
      theme: validateTheme(raw.theme),
      widgets,
    },
    errors,
  };
}

// ------------------------------------------------------------------------------------------ records & state

/** The one shape every connector produces, so widgets can combine sources. */
export interface DashRecord {
  /** Stable across refreshes: hash of (source, canonical url or title). */
  id: string;
  sourceId: string;
  sourceName: string;
  title: string;
  url?: string;
  summary?: string;
  image?: string;
  /** Source-provided publication time. Never invented: absent when the source gives none. */
  publishedAt?: number;
  /** When WE first saw this record. */
  collectedAt: number;
}

export type SourceStatus =
  | 'idle' // approved, waiting for its next check
  | 'running'
  | 'ok'
  | 'paused'
  | 'needs-approval'
  | 'needs-signin'
  | 'needs-attention' // CAPTCHA/anti-bot, structural change, repeated failures
  | 'error'; // last attempt failed (cached data kept)

export interface SourceState {
  sourceId: string;
  status: SourceStatus;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  /** Last time the collected content actually differed. */
  lastChangeAt?: number;
  nextCheckAt: number;
  lastError?: string;
  /** Machine-readable reason behind lastError (for the UI). */
  errorCode?: string;
  consecutiveFailures: number;
  /** For conditional requests, to avoid re-downloading and re-writing unchanged data. */
  etag?: string;
  lastModified?: string;
  contentHash?: string;
  /** Do not try before this time (backoff or the server's Retry-After). */
  backoffUntil?: number;
  /** Set while a collection is running; recovered if the worker dies mid-run. */
  runningSince?: number;
  runId?: string;
  /** Page-change sources: the watched text, so the widget can show what changed. */
  watchText?: string;
  previousWatchText?: string;
}

export interface JobResult {
  at: number;
  sourceId: string;
  sourceName: string;
  ok: boolean;
  /** "changed" | "unchanged" | "not-modified" | an error code. */
  outcome: string;
  items?: number;
  ms: number;
}
