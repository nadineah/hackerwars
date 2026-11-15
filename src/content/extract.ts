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

function describe(el: Element): string {
  let s = el.tagName.toLowerCase();
  if (el.id && el.id.length < 40) s += '#' + el.id;
  const classes = Array.from(el.classList)
    .filter((c) => c.length < 32)
    .slice(0, 3);
  if (classes.length) s += '.' + classes.join('.');
  const txt = ownText(el);
  if (txt) s += ` "${txt}"`;
  return s;
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
    context: `${header}\n\nDOM outline:\n${lines.join('\n')}`,
  };
}
