import { EDIT_ATTR, MAX_TARGET_SELECTOR, type EditTarget, type Origin } from '../shared/edits';

/**
 * Finding an element again after a reload, and describing elements for people.
 *
 * A target keeps several selectors, strongest first (a stable id, a distinctive attribute, stable classes under the
 * nearest stable-id ancestor, a structural path), and a fingerprint (tag, a little text, alt/aria/file name). On every
 * load the selectors are tried in order and a match only counts when it is the ONE element that also fits the
 * fingerprint. When nothing fits, the edit is not applied: never to a different element.
 */

/** Ids and classes that look machine-made (hashes, counters, framework prefixes) change between loads. */
const GENERATED = /\d{4,}|[a-f0-9]{8,}|^(?:ember|react|radix|headlessui|mui|css|sc|jsx|svelte|ng-|_ng)|^:|__[a-z0-9]{5,}$|--[a-z0-9]{5,}$/i;
export const isStableToken = (s: string): boolean => s.length >= 2 && s.length <= 40 && /^[A-Za-z_][\w-]*$/.test(s) && !GENERATED.test(s) && !s.startsWith('ww-');

const esc = (s: string) => CSS.escape(s);
const SAFE_ATTR_VALUE = /^[^"\\{};<>\n\r]{1,60}$/;

/** Elements the editor never offers (scripts, styles, its own overlay). */
const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'BASE', 'WW-EDITOR']);
export const isEditable = (el: Element): boolean => !SKIP.has(el.tagName) && !el.closest('ww-editor') && el.getRootNode() === document;

/** An element's own text (its direct text nodes), short. */
export function ownText(el: Element, max = 40): string {
  let t = '';
  for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent ?? '';
  return t.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The text of a plain text element (exactly one text node and no child elements), or null. */
export function leafText(el: Element): Text | null {
  if (el.children.length || !/^(P|SPAN|H[1-6]|A|BUTTON|LABEL|LI|EM|STRONG|SMALL|B|I|BLOCKQUOTE|FIGCAPTION|TD|TH|DT|DD|CAPTION|LEGEND|SUMMARY|DIV|YT-FORMATTED-STRING)$/.test(el.tagName)) return null;
  if ((el as HTMLElement).isContentEditable) return null;
  const texts = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim());
  return texts.length === 1 && el.childNodes.length <= 3 ? (texts[0] as Text) : null;
}

/** What the edit layer changed a text node from (so a fingerprint still compares with the site's own text). */
export const originalText = new WeakMap<Text, string>();

function hintOf(el: Element): string {
  const alt = el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title') || '';
  if (alt.trim()) return alt.trim().slice(0, 120);
  const src = (el as HTMLImageElement).currentSrc || el.getAttribute('src') || '';
  if (src && !src.startsWith('data:')) {
    try {
      return new URL(src, location.href).pathname.split('/').filter(Boolean).pop()?.slice(0, 120) ?? '';
    } catch {
      return '';
    }
  }
  return '';
}

function textFingerprint(el: Element): string {
  const leaf = leafText(el);
  if (leaf && originalText.has(leaf)) return (originalText.get(leaf) ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return ownText(el);
}

function unique(sel: string, el: Element): boolean {
  if (sel.length > MAX_TARGET_SELECTOR) return false;
  try {
    const r = document.querySelectorAll(sel);
    return r.length === 1 && r[0] === el;
  } catch {
    return false;
  }
}

function stableClasses(el: Element, n = 2): string[] {
  return [...el.classList].filter(isStableToken).slice(0, n);
}

/** tag:nth-of-type steps from `stop` (exclusive) down to `el`. */
function nthPath(el: Element, stop: Element): string {
  const parts: string[] = [];
  for (let n: Element | null = el; n && n !== stop && n !== document.documentElement; n = n.parentElement) {
    const tag = n.tagName.toLowerCase();
    const parent = n.parentElement;
    const same = parent ? [...parent.children].filter((c) => c.tagName === n!.tagName) : [n];
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(n) + 1})` : tag);
    if (parts.length > 14) break;
  }
  return parts.join(' > ');
}

/** A short selector that matches only this element (by id, its own custom tag, or a stable class), or null. */
function uniqueSelectorOf(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  if (el.id && isStableToken(el.id) && unique(`#${esc(el.id)}`, el)) return `#${esc(el.id)}`;
  if (tag.includes('-') && unique(tag, el)) return tag;
  for (const c of stableClasses(el, 3)) if (unique(`${tag}.${esc(c)}`, el)) return `${tag}.${esc(c)}`;
  return null;
}

/** How to find this element again after a reload. */
export function buildTarget(el: Element, pseudo?: '::before' | '::after'): EditTarget {
  const tag = el.tagName.toLowerCase();
  const sels: string[] = [];
  if (tag === 'body' || tag === 'html') sels.push(tag);
  if (el.id && isStableToken(el.id) && unique(`#${esc(el.id)}`, el)) sels.push(`#${esc(el.id)}`);
  for (const a of ['data-testid', 'data-test', 'data-qa', 'aria-label', 'name', 'alt', 'title', 'for']) {
    const v = el.getAttribute(a);
    if (v && SAFE_ATTR_VALUE.test(v)) {
      const s = `${tag}[${a}="${v}"]`;
      if (unique(s, el)) {
        sels.push(s);
        break;
      }
    }
  }
  const own = tag !== 'body' && tag !== 'html' ? uniqueSelectorOf(el) : null;
  if (own && !sels.includes(own)) sels.push(own);
  // the nearest ancestor that is unique on the page (an id, a custom element of its own kind, a class) keeps paths short
  let anchor: Element | null = el.parentElement;
  let anchorSel = 'body';
  for (; anchor && anchor !== document.body; anchor = anchor.parentElement) {
    const a = uniqueSelectorOf(anchor);
    if (a) {
      anchorSel = a;
      break;
    }
  }
  if (!anchor) anchor = document.body;
  const cls = stableClasses(el);
  if (cls.length && tag !== 'body') {
    const s = `${anchorSel} ${tag}${cls.map((c) => '.' + esc(c)).join('')}`;
    if (unique(s, el)) sels.push(s);
  }
  if (tag !== 'body' && tag !== 'html') {
    const path = `${anchorSel} > ${nthPath(el, anchor ?? document.body)}`;
    if (unique(path, el)) sels.push(path);
  }
  // the fingerprint is kept for every target, so even an id the site later gives to another element is caught
  const text = tag === 'body' || tag === 'html' ? '' : textFingerprint(el);
  const hint = hintOf(el);
  return { selectors: [...new Set(sels)].slice(0, 5), tag, ...(text ? { text } : {}), ...(hint ? { hint } : {}), ...(pseudo ? { pseudo } : {}) };
}

/** A selector for "this and the others like it": same tag and stable classes (or the same parent class), 2-500 matches. */
export function similarOf(el: Element): { selector: string; count: number } | null {
  const tag = el.tagName.toLowerCase();
  if (tag === 'body' || tag === 'html') return null;
  const candidates: string[] = [];
  const cls = stableClasses(el, 2);
  if (cls.length) candidates.push(`${tag}${cls.map((c) => '.' + esc(c)).join('')}`);
  const pcls = el.parentElement ? stableClasses(el.parentElement, 1) : [];
  if (pcls.length) candidates.push(`${el.parentElement!.tagName.toLowerCase()}.${esc(pcls[0])} > ${tag}`);
  if (tag.includes('-')) candidates.push(tag); // a custom element of the site's own (ytd-rich-item-renderer)
  for (const s of candidates) {
    try {
      const n = document.querySelectorAll(s).length;
      if (n >= 2 && n <= 500) return { selector: s, count: n };
    } catch {
      /* next */
    }
  }
  return null;
}

/** A bare id, one tag with one attribute, or the page itself. */
const isStrongSelector = (sel: string): boolean => sel === 'body' || sel === 'html' || /^#[^\s>+~]+$/.test(sel) || /^[a-z][\w-]*\[[^\]]+\]$/.test(sel);

/** Text compared without numbers, case or punctuation, so counters ("3 new" -> "4 new") do not break a match. */
const words = (s: string) => s.toLowerCase().replace(/[\d\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 20);

/**
 * Does this element fit the fingerprint? The tag must match, and a known alt/aria/file name or text must still be
 * the same. A strong selector (a unique id or attribute) tolerates text that is gone (an emptied label), a weak one
 * does not: a structural path that now lands on a different, empty element is not the same element.
 */
function fits(el: Element, t: EditTarget, strong: boolean): boolean {
  if (el.tagName.toLowerCase() !== t.tag || !isEditable(el)) return false;
  const hint = hintOf(el);
  if (t.hint && (hint ? hint !== t.hint : !strong)) return false;
  if (t.text && words(t.text)) {
    const now = words(textFingerprint(el));
    if (!now) return strong;
    if (!now.startsWith(words(t.text).slice(0, 12)) && !words(t.text).startsWith(now.slice(0, 12))) return false;
  }
  return true;
}

/** Is an element found earlier still the one this target means (the site may reuse a node for other content)? */
export function stillMatches(el: Element, t: EditTarget): boolean {
  return el.isConnected && fits(el, t, t.selectors.length > 0 && isStrongSelector(t.selectors[0]));
}

/** The element(s) an edit applies to now; empty when it cannot be found reliably. */
export function resolveTarget(t: EditTarget): Element[] {
  if (t.all) {
    try {
      return [...document.querySelectorAll(t.all)].filter((e) => e.tagName.toLowerCase() === t.tag && isEditable(e)).slice(0, 500);
    } catch {
      return [];
    }
  }
  for (const sel of t.selectors) {
    let found: Element[];
    try {
      found = [...document.querySelectorAll(sel)];
    } catch {
      continue;
    }
    const strong = isStrongSelector(sel);
    const ok = found.filter((e) => fits(e, t, strong));
    if (ok.length === 1) return ok;
  }
  return [];
}

// ------------------------------------------------------------------------------------------- descriptions

export type { Kind } from '../shared/editorProtocol';
import type { Kind } from '../shared/editorProtocol';

const LANDMARK: Record<string, string> = { HEADER: 'Header', NAV: 'Navigation', FOOTER: 'Footer', MAIN: 'Main content', ASIDE: 'Sidebar', SECTION: 'Section', ARTICLE: 'Article', FORM: 'Form', DIALOG: 'Dialog' };

/** Where an element comes from: inserted by a Whimsy Web design, or the website's own (even if restyled). */
export function originOf(el: Element): Origin {
  const ww = el.closest('[data-ww]');
  return ww && ww.getAttribute('data-ww') !== 'editor' ? 'webloom' : 'site';
}

export function kindOf(el: Element): Kind {
  const t = el.tagName;
  if (t === 'BODY' || t === 'HTML') return 'page';
  if (originOf(el) === 'webloom') return 'decoration';
  if (/^(IMG|PICTURE|SVG|CANVAS)$/.test(t) || el.getAttribute('role') === 'img') return 'image';
  if (/^(VIDEO|AUDIO|IFRAME)$/.test(t)) return 'video';
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(t)) return (el as HTMLInputElement).type === 'submit' || (el as HTMLInputElement).type === 'button' ? 'button' : 'field';
  if (t === 'BUTTON' || el.getAttribute('role') === 'button') return 'button';
  if (t === 'A' && el.hasAttribute('href')) return 'link';
  if (/^H[1-6]$/.test(t)) return 'heading';
  if (/^(UL|OL|DL)$/.test(t)) return 'list';
  if (LANDMARK[t]) return 'section';
  if (!el.children.length && ownText(el)) return 'text';
  if (/^(P|BLOCKQUOTE|LABEL|FIGCAPTION)$/.test(t)) return 'text';
  return 'box';
}

const KIND_NAME: Record<Kind, string> = { image: 'Image', video: 'Video', link: 'Link', button: 'Button', field: 'Field', heading: 'Heading', text: 'Text', list: 'List', section: 'Section', decoration: 'Decoration', box: 'Box', page: 'Page' };

/** A custom element's name as words: ytd-rich-item-renderer -> "Rich item". */
const humanTag = (tag: string) => {
  const words = tag.toLowerCase().split('-');
  if (words.length > 1 && words[0].length <= 4) words.shift(); // the site's prefix (ytd, yt, mat, ...)
  if (words[words.length - 1] === 'renderer') words.pop();
  const s = words.join(' ');
  return s ? s[0].toUpperCase() + s.slice(1) : tag;
};

/** A readable name for an element ("Image · logo.png", "Heading · Welcome", "Header", "Rich item"). */
export function labelOf(el: Element): { kind: Kind; label: string; detail: string } {
  const kind = kindOf(el);
  const t = el.tagName;
  let name = KIND_NAME[kind];
  if (kind === 'section') name = LANDMARK[t] ?? name;
  if (kind === 'box' && t.includes('-')) name = humanTag(t);
  if (kind === 'page') name = 'Page';
  let ctx = '';
  if (kind === 'image') ctx = hintOf(el);
  else if (kind === 'field') ctx = el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
  else if (kind !== 'page' && kind !== 'section' && kind !== 'list') ctx = ownText(el, 36) || el.getAttribute('aria-label') || '';
  const detail = el.id && el.id.length < 30 ? `#${el.id}` : stableClasses(el, 1).map((c) => '.' + c).join('') || (t.includes('-') ? '' : t.toLowerCase());
  return { kind, label: ctx ? `${name} · ${ctx.replace(/\s+/g, ' ').slice(0, 40)}` : name, detail: detail.slice(0, 32) };
}

// ------------------------------------------------------------------------------------------- design decorations

let pseudoRules: { base: string; pseudo: '::before' | '::after' }[] = [];
let pseudoKey = '';
/** Pseudo-element decorations (::before/::after) written by the applied designs' CSS. */
function designPseudoRules(): typeof pseudoRules {
  const styles = [...document.querySelectorAll('style[data-whimsyweb]')] as HTMLStyleElement[];
  const key = styles.map((s) => `${s.getAttribute('data-whimsyweb')}:${s.textContent?.length ?? 0}`).join('|');
  if (key === pseudoKey) return pseudoRules;
  pseudoKey = key;
  pseudoRules = [];
  const visit = (rules: CSSRuleList) => {
    for (const r of rules) {
      if (r instanceof CSSStyleRule) {
        for (const part of r.selectorText.split(',')) {
          const m = /^(.*?)(::?(?:before|after))\s*$/i.exec(part.trim());
          if (m && m[1].trim()) pseudoRules.push({ base: m[1].trim(), pseudo: m[2].toLowerCase().includes('before') ? '::before' : '::after' });
        }
      } else if ('cssRules' in r) visit((r as CSSGroupingRule).cssRules);
    }
  };
  for (const s of styles) {
    try {
      if (s.sheet) visit(s.sheet.cssRules);
    } catch {
      /* unreadable */
    }
  }
  return pseudoRules;
}

/** The design's decorations drawn on this element (shown in the tree as their own items). */
export function decorationsOf(el: Element): ('::before' | '::after')[] {
  const out = new Set<'::before' | '::after'>();
  for (const r of designPseudoRules()) {
    if (out.has(r.pseudo)) continue;
    try {
      if (!el.matches(r.base)) continue;
    } catch {
      continue;
    }
    const c = getComputedStyle(el, r.pseudo).content;
    if (c && c !== 'none' && c !== 'normal') out.add(r.pseudo);
  }
  return [...out];
}

/** The applied designs' rules that style this element (read-only, for Code mode and the AI). */
export function themeRulesFor(el: Element, pseudo?: string, max = 2400): string[] {
  const out: string[] = [];
  let size = 0;
  const visit = (rules: CSSRuleList) => {
    for (const r of rules) {
      if (size > max) return;
      if (r instanceof CSSStyleRule) {
        const parts = r.selectorText.split(',').map((p) => p.trim());
        const hit = parts.some((p) => {
          const m = /^(.*?)(::?(?:before|after))\s*$/i.exec(p);
          const base = m ? m[1].trim() : p;
          if ((pseudo && !m) || (!pseudo && m)) return false;
          if (pseudo && m && !m[2].toLowerCase().includes(pseudo.replace(/:/g, ''))) return false;
          try {
            return !!base && el.matches(base);
          } catch {
            return false;
          }
        });
        if (hit) {
          const text = r.cssText.length > 600 ? r.cssText.slice(0, 600) + ' …}' : r.cssText;
          out.push(text);
          size += text.length;
        }
      } else if ('cssRules' in r) visit((r as CSSGroupingRule).cssRules);
    }
  };
  for (const s of document.querySelectorAll('style[data-whimsyweb]') as NodeListOf<HTMLStyleElement>) {
    try {
      if (s.sheet) visit(s.sheet.cssRules);
    } catch {
      /* unreadable */
    }
  }
  return out;
}

/** The element's opening tag with its attributes (long values shortened), for Code mode. */
export function openingTag(el: Element): string {
  const attrs = [...el.attributes]
    .filter((a) => a.name !== EDIT_ATTR && !a.name.startsWith('data-ww-'))
    .map((a) => (a.value ? `${a.name}="${a.value.length > 80 ? a.value.slice(0, 80) + '…' : a.value}"` : a.name));
  return `<${el.tagName.toLowerCase()}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
}
