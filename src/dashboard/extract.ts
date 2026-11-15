import type { FieldSpec, HtmlConfig, ItemFields, JsonConfig, PageChangeConfig } from './schema';
import { canonicalUrl, cleanText, parseDate, safeLink } from './util';

/**
 * Pure extraction: given a DOM (or parsed JSON) and a VALIDATED configuration, return plain items. Nothing here
 * runs, evaluates or follows anything found in the page: selectors and dot-paths are data, interpreted by this
 * reviewed code. It works on any Document (an inert one from DOMParser in the offscreen page, or the live page in
 * a content script), so both paths behave the same.
 */

export interface RawItem {
  title: string;
  url?: string;
  summary?: string;
  image?: string;
  publishedAt?: number;
  /** A source-given identity (feed guid, JSON id) used when there is no URL. */
  key?: string;
}

const TITLE_MAX = 200;
const SUMMARY_MAX = 400;

// ------------------------------------------------------------------------------------------ HTML

function pick(el: Element, spec: FieldSpec | undefined): Element | null {
  if (!spec || !spec.selector) return el;
  try {
    return el.querySelector(spec.selector);
  } catch {
    return null; // an invalid selector never throws into the collector
  }
}

function readAttr(node: Element, attr: FieldSpec['attr'] | undefined, baseUrl: string): string | undefined {
  const a = attr ?? 'text';
  switch (a) {
    case 'text':
      return cleanText(node.textContent, a === 'text' ? SUMMARY_MAX * 2 : 200) || undefined;
    case 'href': {
      const el = node.hasAttribute('href') ? node : (node.closest('a[href]') ?? node.querySelector('a[href]'));
      return safeLink(el?.getAttribute('href'), baseUrl);
    }
    case 'src': {
      const el = node.matches('img,source,video,iframe') ? node : node.querySelector('img');
      const raw = el?.getAttribute('src') || el?.getAttribute('data-src') || el?.getAttribute('data-lazy-src') || el?.getAttribute('srcset')?.split(/\s+/)[0];
      return safeLink(raw, baseUrl);
    }
    case 'datetime':
      return node.getAttribute('datetime') ?? node.querySelector('time[datetime]')?.getAttribute('datetime') ?? (cleanText(node.textContent, 80) || undefined);
    case 'content':
      return cleanText(node.getAttribute('content'), SUMMARY_MAX) || undefined;
    case 'title':
    case 'alt':
      return cleanText(node.getAttribute(a), SUMMARY_MAX) || undefined;
  }
}

function field(item: Element, spec: FieldSpec | undefined, baseUrl: string, defaultAttr: FieldSpec['attr']): string | undefined {
  const node = pick(item, spec);
  return node ? readAttr(node, spec?.attr ?? defaultAttr, baseUrl) : undefined;
}

/** Items matching `itemSelector`, with the configured fields read from each. Missing fields are simply absent. */
export function extractItems(doc: Document, cfg: HtmlConfig, baseUrl: string): RawItem[] {
  let nodes: Element[];
  try {
    nodes = Array.from(doc.querySelectorAll(cfg.itemSelector)).slice(0, cfg.maxItems * 3);
  } catch {
    return [];
  }
  return itemsFromNodes(nodes, cfg.fields, baseUrl, cfg.maxItems);
}

function itemsFromNodes(nodes: Element[], f: ItemFields, baseUrl: string, max: number): RawItem[] {
  const out: RawItem[] = [];
  for (const el of nodes) {
    const title = cleanText(field(el, f.title, baseUrl, 'text'), TITLE_MAX);
    if (!title) continue; // an item with no title is not displayable: skip, never invent one
    const url = f.url ? field(el, f.url, baseUrl, 'href') : (field(el, { attr: 'href' }, baseUrl, 'href') as string | undefined);
    const published = f.published ? parseDate(field(el, f.published, baseUrl, 'datetime')) : undefined;
    out.push({
      title,
      url,
      summary: f.summary ? cleanText(field(el, f.summary, baseUrl, 'text'), SUMMARY_MAX) || undefined : undefined,
      image: f.image ? field(el, f.image, baseUrl, 'src') : undefined,
      publishedAt: published,
    });
    if (out.length >= max) break;
  }
  return out;
}

// ------------------------------------------------------------------------------------------ page watcher

/** The visible text of the watched region, normalized so cosmetic whitespace changes do not count as changes. */
export function extractWatchText(doc: Document, cfg: Pick<PageChangeConfig, 'selector'>): string | null {
  let el: Element | null;
  try {
    el = doc.querySelector(cfg.selector);
  } catch {
    return null;
  }
  if (!el) return null;
  const text = cleanText(el.textContent, 6000);
  return text || null;
}

// ------------------------------------------------------------------------------------------ feeds (RSS / RDF / Atom)

const kids = (el: Element, name: string): Element[] => Array.from(el.children).filter((c) => c.localName === name);
const kid = (el: Element, name: string): Element | undefined => kids(el, name)[0];
const txt = (el: Element | undefined | null): string => (el?.textContent ?? '').trim();

/** Plain text of an HTML snippet found inside a feed, parsed inertly (no scripts run, no images load). */
function htmlToText(html: string): string {
  if (!html) return '';
  try {
    return cleanText(new DOMParser().parseFromString(html, 'text/html').body.textContent, SUMMARY_MAX);
  } catch {
    return cleanText(html.replace(/<[^>]*>/g, ' '), SUMMARY_MAX);
  }
}
function firstImageInHtml(html: string, baseUrl: string): string | undefined {
  if (!html) return undefined;
  try {
    const img = new DOMParser().parseFromString(html, 'text/html').querySelector('img[src]');
    return safeLink(img?.getAttribute('src'), baseUrl);
  } catch {
    return undefined;
  }
}

export function parseFeed(doc: Document, baseUrl: string, max: number): { items: RawItem[]; title?: string } | { error: string } {
  const root = doc.documentElement;
  if (!root || doc.querySelector('parsererror')) return { error: 'The response is not valid XML.' };
  const name = root.localName.toLowerCase();
  let entries: Element[] = [];
  let feedTitle: string | undefined;
  if (name === 'rss') {
    const channel = kid(root, 'channel');
    entries = channel ? kids(channel, 'item') : [];
    feedTitle = cleanText(txt(channel ? kid(channel, 'title') : undefined), 100) || undefined;
  } else if (name === 'rdf') {
    entries = kids(root, 'item');
    feedTitle = cleanText(txt(kid(kid(root, 'channel') ?? root, 'title')), 100) || undefined;
  } else if (name === 'feed') {
    entries = kids(root, 'entry');
    feedTitle = cleanText(txt(kid(root, 'title')), 100) || undefined;
  } else {
    return { error: 'This is not an RSS or Atom feed.' };
  }
  const items: RawItem[] = [];
  for (const e of entries) {
    const title = cleanText(htmlToText(txt(kid(e, 'title'))) || txt(kid(e, 'title')), TITLE_MAX);
    if (!title) continue;
    // link: RSS <link>text</link>; Atom <link rel="alternate" href="..."/>
    const links = kids(e, 'link');
    const atomLink = links.find((l) => (l.getAttribute('rel') ?? 'alternate') === 'alternate' && l.getAttribute('href')) ?? links.find((l) => l.getAttribute('href'));
    const url = safeLink(atomLink?.getAttribute('href') ?? txt(links[0]) ?? txt(kid(e, 'guid')), baseUrl) ?? safeLink(txt(kid(e, 'guid')), baseUrl);
    const rawSummary = txt(kid(e, 'description')) || txt(kid(e, 'summary')) || txt(kid(e, 'encoded')) || txt(kid(e, 'content'));
    const media = [...kids(e, 'content'), ...kids(e, 'thumbnail'), ...kids(e, 'enclosure')].find((m) => {
      const t = m.getAttribute('type') ?? m.getAttribute('medium') ?? '';
      return (m.getAttribute('url') ?? '') && (!t || t.startsWith('image'));
    });
    items.push({
      title,
      url,
      summary: htmlToText(rawSummary) || undefined,
      image: safeLink(media?.getAttribute('url'), baseUrl) ?? firstImageInHtml(txt(kid(e, 'encoded')) || rawSummary, baseUrl),
      publishedAt: parseDate(txt(kid(e, 'pubDate')) || txt(kid(e, 'published')) || txt(kid(e, 'date')) || txt(kid(e, 'updated'))),
      key: txt(kid(e, 'guid')) || txt(kid(e, 'id')) || undefined,
    });
    if (items.length >= max) break;
  }
  return { items, title: feedTitle };
}

/** Looks for `<link rel="alternate" type="application/rss+xml|atom+xml">` so a site address can become a feed. */
export function discoverFeeds(doc: Document, baseUrl: string): { url: string; title?: string }[] {
  const out: { url: string; title?: string }[] = [];
  for (const l of Array.from(doc.querySelectorAll('link[rel~="alternate"][type]'))) {
    const type = (l.getAttribute('type') ?? '').toLowerCase();
    if (!/(rss|atom)\+xml/.test(type)) continue;
    const url = safeLink(l.getAttribute('href'), baseUrl);
    if (url && !out.some((o) => o.url === url)) out.push({ url, title: cleanText(l.getAttribute('title'), 80) || undefined });
  }
  return out.slice(0, 5);
}

// ------------------------------------------------------------------------------------------ JSON

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Reads a dot path with optional [n] indexes. Own properties only; no prototype access; no evaluation. */
export function getPath(value: unknown, path: string): unknown {
  if (path === '') return value;
  let cur: unknown = value;
  for (const seg of path.split('.')) {
    const m = /^([^[\]]+)(?:\[(\d+)\])?$/.exec(seg);
    if (!m || BLOCKED_KEYS.has(m[1])) return undefined;
    if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, m[1])) return undefined;
    cur = (cur as Record<string, unknown>)[m[1]];
    if (m[2] !== undefined) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(m[2])];
    }
  }
  return cur;
}

const asText = (v: unknown, max: number): string | undefined => {
  if (typeof v === 'string') return cleanText(v, max) || undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
};

/** Epoch seconds/ms numbers and ISO strings are accepted for dates; anything else is simply "no date". */
function jsonDate(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return parseDate(new Date(v < 1e11 ? v * 1000 : v).toISOString());
  return typeof v === 'string' ? parseDate(v) : undefined;
}

export function extractJson(data: unknown, cfg: JsonConfig, baseUrl: string): RawItem[] | { error: string } {
  const list = getPath(data, cfg.itemsPath);
  if (!Array.isArray(list)) return { error: `The response has no list at "${cfg.itemsPath || '(top level)'}".` };
  const out: RawItem[] = [];
  for (const item of list.slice(0, cfg.maxItems * 3)) {
    if (!item || typeof item !== 'object') continue;
    const title = asText(getPath(item, cfg.fields.title), TITLE_MAX);
    if (!title) continue;
    let url = cfg.fields.url ? safeLink(asText(getPath(item, cfg.fields.url), 2000), baseUrl) : undefined;
    if (!url && cfg.urlTemplate) {
      let ok = true;
      const filled = cfg.urlTemplate.replace(/\{([A-Za-z0-9_.$-]+)\}/g, (_m, p: string) => {
        const v = asText(getPath(item, p), 200);
        if (v === undefined) ok = false;
        return encodeURIComponent(v ?? '');
      });
      if (ok) url = safeLink(filled, baseUrl);
    }
    out.push({
      title,
      url,
      summary: cfg.fields.summary ? asText(getPath(item, cfg.fields.summary), SUMMARY_MAX) : undefined,
      image: cfg.fields.image ? safeLink(asText(getPath(item, cfg.fields.image), 2000), baseUrl) : undefined,
      publishedAt: cfg.fields.published ? jsonDate(getPath(item, cfg.fields.published)) : undefined,
    });
    if (out.length >= cfg.maxItems) break;
  }
  return out;
}

// ------------------------------------------------------------------------------------------ blockers

export type Blocker = 'signin' | 'captcha' | null;

/**
 * Is this page a sign-in wall or an anti-bot challenge? WhimsyWeb never signs in for you and never tries to get past
 * a challenge: it reports the source as needing the user's attention instead.
 */
export function detectBlocker(doc: Document): Blocker {
  const html = doc.documentElement;
  if (!html) return null;
  if (doc.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare"], .g-recaptcha, .h-captcha, #cf-challenge-running, #challenge-form, [data-sitekey]')) return 'captcha';
  const text = (doc.body?.textContent ?? '').slice(0, 4000).toLowerCase();
  if (/(verify (that )?you are (a )?human|are you a robot|unusual traffic from your|attention required|checking your browser before accessing|enable javascript and cookies to continue|captcha)/.test(text)) return 'captcha';
  if (doc.querySelector('input[type="password"]') && !doc.querySelector('article, [role="article"], main article')) return 'signin';
  if (/(sign in to continue|log in to continue|please (sign|log) in|login required)/.test(text) && doc.querySelector('input[type="password"], form[action*="login" i], form[action*="signin" i]')) return 'signin';
  return null;
}

// ------------------------------------------------------------------------------------------ outline (for AI inspection, with consent)

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'IFRAME', 'TEMPLATE', 'LINK', 'META', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'CANVAS', 'VIDEO', 'AUDIO', 'PATH', 'HEAD']);
const redact = (t: string): string => t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]').replace(/\d{6,}/g, '[num]').replace(/[A-Za-z0-9_-]{28,}/g, '[token]');

/**
 * A compact structure outline (tags, ids, classes, short labels) that lets the assistant choose selectors. Only built
 * after the user explicitly allows it for that page; it is the page STRUCTURE, never stored data or cookies.
 */
export function buildOutline(doc: Document, maxChars = 9000): string {
  const lines: string[] = [];
  let chars = 0;
  const walk = (el: Element, depth: number) => {
    if (chars > maxChars || depth > 9) return;
    let s = el.localName;
    if (el.id && el.id.length < 40) s += `#${el.id}`;
    const classes = Array.from(el.classList).filter((c) => c.length < 32).slice(0, 3);
    if (classes.length) s += '.' + classes.join('.');
    const own = redact(cleanText(Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '').join(' '), 40));
    if (own) s += ` "${own}"`;
    if (el.localName === 'a' && el.getAttribute('href')) s += ' [href]';
    if (el.localName === 'time' && el.getAttribute('datetime')) s += ' [datetime]';
    const line = '  '.repeat(depth) + s;
    lines.push(line);
    chars += line.length + 1;
    const children = Array.from(el.children).filter((c) => !SKIP.has(c.tagName.toUpperCase()));
    for (const c of children.slice(0, 12)) walk(c, depth + 1);
    if (children.length > 12) {
      lines.push('  '.repeat(depth + 1) + `… ${children.length - 12} more siblings`);
      chars += 20;
    }
  };
  if (doc.body) walk(doc.body, 0);
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------ misc

/** Stable identity for a record within a source: its canonical URL if it has one, else the source's key, else its title. */
export function identityOf(item: RawItem, baseUrl: string): string {
  const c = item.url ? canonicalUrl(item.url, baseUrl) : null;
  return c ? `u:${c}` : item.key ? `k:${item.key}` : `t:${item.title.toLowerCase()}`;
}
