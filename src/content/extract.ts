import { normalizePath } from '../shared/scope';
import type { PageContext } from '../shared/types';
import { hasActive } from './apply';

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'IFRAME', 'TEMPLATE', 'LINK', 'META',
  'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'CANVAS', 'VIDEO', 'AUDIO', 'PATH',
]);

const MAX_CHARS = 14_000;
const MAX_DEPTH = 9;
const MAX_CHILDREN = 14;

function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\d{6,}/g, '[num]')
    .replace(/[A-Za-z0-9_\-]{28,}/g, '[token]');
}

function ownText(el: Element): string {
  let t = '';
  for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent ?? '';
  t = t.replace(/\s+/g, ' ').trim();
  return t ? redact(t.slice(0, 40)) : '';
}

const CLICKABLE = 'a[href],button,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="switch"],[onclick]';

/** The element's current size, for clickable elements: lets the model keep them at least this big. */
function sizeNote(el: Element): string {
  if (!el.matches(CLICKABLE)) return '';
  const r = el.getBoundingClientRect();
  return r.width >= 1 && r.height >= 1 ? ` ${Math.round(r.width)}x${Math.round(r.height)}` : '';
}

function describe(el: Element): string {
  let s = el.tagName.toLowerCase();
  if (el.id && el.id.length < 40) s += '#' + el.id;
  const classes = Array.from(el.classList)
    .filter((c) => c.length < 32)
    .slice(0, 3);
  if (classes.length) s += '.' + classes.join('.');
  const txt = ownText(el);
  if (txt) s += ` "${txt}"`;
  return s + sizeNote(el);
}

/** A short name for an element in the layout list: tag, id and up to two classes. */
function shortName(el: Element): string {
  let s = el.tagName.toLowerCase();
  if (el.id && el.id.length < 40) return s + '#' + el.id;
  const classes = Array.from(el.classList).filter((c) => c.length < 32).slice(0, 2);
  if (classes.length) s += '.' + classes.join('.');
  return s;
}

const LANDMARKS = 'header,[role="banner"],nav,[role="navigation"],main,[role="main"],aside,[role="complementary"],footer,[role="contentinfo"],[role="search"],form[role="search"],dialog[open]';
const MAX_LAYOUT_LINES = 28;
/** Text elements are content, not layout boxes, so they are never reported as repeated items. */
const TEXT_TAGS = new Set(['P', 'SPAN', 'A', 'TR', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LABEL', 'EM', 'STRONG', 'B', 'I', 'SMALL', 'BR', 'DEFS', 'IMG', 'PICTURE', 'SOURCE']);
/** Invisible layers (click ripples, fixed overlays) that are boxes on paper but nothing anyone sees. */
const isOverlay = (el: Element) => {
  const cs = getComputedStyle(el);
  return (cs.position === 'absolute' || cs.position === 'fixed') && (cs.pointerEvents === 'none' || Number(cs.opacity) === 0);
};

/**
 * Where the big areas of the page are and how large (sizes and positions only, no content): the landmarks, the
 * largest blocks of the first screen, and repeated items such as cards or rows. Lets the model plan shapes and
 * placements for the real layout.
 */
export function layoutSummary(): string {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const sx = window.scrollX;
  const sy = window.scrollY;
  const pageH = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
  const box = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const visible = (el: Element) => {
    const b = box(el);
    if (b.w < 40 || b.h < 16) return null;
    const cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden' ? null : b;
  };
  const lines: string[] = [];
  const seen = new Set<Element>();
  const add = (el: Element, extra = '') => {
    if (seen.has(el) || lines.length >= MAX_LAYOUT_LINES || !isRelevant(el)) return;
    const b = visible(el);
    if (!b) return;
    seen.add(el);
    lines.push(`${shortName(el)} ${b.w}x${b.h} at ${b.x},${b.y}${extra}`);
  };

  // landmarks, outermost first (a header inside an article is skipped when its article is already listed)
  const marks = Array.from(document.querySelectorAll(LANDMARKS)).filter((el) => !el.parentElement?.closest(LANDMARKS) || el.matches('main,[role="main"]'));
  marks.slice(0, 12).forEach((el) => add(el));

  // the biggest blocks that start on the first screen (hero areas, banners, feeds), largest first
  const big: { el: Element; area: number }[] = [];
  const all = document.body ? document.body.querySelectorAll('*') : [];
  const limit = Math.min(all.length, 4000);
  for (let i = 0; i < limit; i++) {
    const el = all[i];
    if (SKIP_TAGS.has(el.tagName.toUpperCase()) || el.closest('svg,[data-ww],[data-whimsyweb]')) continue;
    const r = el.getBoundingClientRect();
    if (r.top + sy > vh * 1.2 || r.width < vw * 0.4 || r.height < 120 || r.height > pageH * 0.9) continue;
    if (isOverlay(el)) continue;
    big.push({ el, area: r.width * r.height });
  }
  big.sort((a, b) => b.area - a.area);
  let picked = 0;
  for (const { el } of big) {
    if (picked >= 6) break;
    // skip a block that only wraps one already listed at the same size
    const b = box(el);
    const sameBox = (o: Element) => {
      if (!(o.contains(el) || el.contains(o))) return false;
      const ob = box(o);
      return Math.min(ob.w * ob.h, b.w * b.h) / Math.max(ob.w * ob.h, b.w * b.h) > 0.6;
    };
    if ([...seen].some(sameBox)) continue;
    const before = lines.length;
    add(el);
    if (lines.length > before) picked++;
  }

  // repeated items (cards, rows, tiles): siblings with the same tag and classes
  const groups = new Map<string, { first: Element; count: number }>();
  for (let i = 0; i < limit; i++) {
    const el = all[i];
    const parent = el.parentElement;
    if (!parent || SKIP_TAGS.has(el.tagName.toUpperCase()) || TEXT_TAGS.has(el.tagName.toUpperCase()) || el.closest('svg')) continue;
    const key = `${shortName(parent)}>${el.tagName}.${Array.from(el.classList).slice(0, 2).join('.')}`;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { first: el, count: 1 });
  }
  const repeated = [...groups.values()]
    .filter((g) => g.count >= 4)
    .map((g) => ({ ...g, b: visible(g.first) }))
    .filter((g) => g.b && g.b.w >= 80 && g.b.h >= 40 && g.b.w * g.b.h < vw * vh * 0.4 && !isOverlay(g.first))
    .sort((a, b) => b.count * b.b!.w * b.b!.h - a.count * a.b!.w * a.b!.h);
  const chosen: Element[] = [];
  for (const g of repeated) {
    if (lines.length >= MAX_LAYOUT_LINES || chosen.length >= 5) break;
    if (chosen.some((c) => c.contains(g.first) || g.first.contains(c))) continue;
    chosen.push(g.first);
    const label = g.first.tagName.toLowerCase() + Array.from(g.first.classList).filter((c) => c.length < 32).slice(0, 2).map((c) => '.' + c).join('');
    lines.push(`${label} ×${g.count}, each about ${g.b!.w}x${g.b!.h}`);
  }

  return `Layout (CSS pixels; x,y from the top-left of the page): window ${vw}x${vh}, page height ${pageH}\n${lines.join('\n')}`;
}

function isRelevant(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName.toUpperCase())) return false;
  if (el.hasAttribute('data-ww') || el.hasAttribute('data-whimsyweb')) return false; // our own elements
  if (el.getAttribute('aria-hidden') === 'true') return false;
  return true;
}

/**
 * Builds a compact outline of the page (tags, ids, classes, short text) for the
 * model. Never includes form values, attributes like href/src, or scripts.
 */
export function extractPageContext(): PageContext {
  const lines: string[] = [];
  let chars = 0;

  const walk = (el: Element, depth: number) => {
    if (chars > MAX_CHARS || depth > MAX_DEPTH) return;
    const line = '  '.repeat(depth) + describe(el);
    lines.push(line);
    chars += line.length + 1;
    const kids = Array.from(el.children).filter(isRelevant);
    // Prefer visible-ish children; keep order but cap breadth.
    for (const kid of kids.slice(0, MAX_CHILDREN)) walk(kid, depth + 1);
    if (kids.length > MAX_CHILDREN) {
      const more = '  '.repeat(depth + 1) + `… ${kids.length - MAX_CHILDREN} more siblings`;
      lines.push(more);
      chars += more.length + 1;
    }
  };

  if (document.body) walk(document.body, 0);

  // With a design applied, computed colors describe the redesign, not the site. Omit them then
  // (this also keeps the cached page context stable between turns).
  const cs = document.body && !hasActive() ? getComputedStyle(document.body) : null;
  const header = [
    `host: ${location.hostname}`,
    `path: ${normalizePath(location.pathname)}`,
    `title: ${redact(document.title).slice(0, 120)}`,
    cs ? `body: background=${cs.backgroundColor}; color=${cs.color}; font=${cs.fontFamily.slice(0, 80)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    host: location.hostname,
    path: normalizePath(location.pathname),
    url: location.origin + location.pathname,
    title: document.title,
    context: `${header}\n\n${layoutSummary()}\n\nDOM outline:\n${lines.join('\n')}`,
  };
}
