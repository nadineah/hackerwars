import type { CssNode } from 'css-tree';
import generate from 'css-tree/generator';
import parse from 'css-tree/parser';
import { ident as cssIdent } from 'css-tree/utils';
import walk from 'css-tree/walker';
import type { DomOp, Position } from './types';

export const MAX_CSS = 80_000;
export const MAX_OPS = 60;

const POSITIONS: Position[] = ['beforebegin', 'afterbegin', 'beforeend', 'afterend'];

const ALLOWED_TAGS = new Set([
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'section', 'aside', 'header',
  'footer', 'hr', 'img', 'em', 'strong', 'small', 'ul', 'li', 'marquee',
]);

const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i;
const FONT_URL = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//i;
const FONT_IMPORT_URL = /^https:\/\/fonts\.googleapis\.com\//i;

/**
 * URLs a design's CSS may load: embedded images and Google Fonts only. Arbitrary https hosts are
 * NOT allowed: a request to an attacker's server could carry data out (e.g. a rule that fires only
 * when a DOM attribute matches), and a prompt-injected model could be steered into writing one.
 */
export const isAllowedCssUrl = (u: string): boolean => {
  const t = u.trim();
  return DATA_IMAGE.test(t) || FONT_URL.test(t);
};

/** Inserted <img> elements may only use embedded data (no network request). */
export const isAllowedImgSrc = (u: string): boolean => DATA_IMAGE.test(u.trim());

// ---------------------------------------------------------------------------------------------
// CSS sanitizer. Built on a real CSS parser rather than text filters: identifiers can be spelled
// with escapes (`u\72l(`, `image\2d set(`, `@\69mport`, even escaped backslashes), which defeated
// every regex approach. Here names are decoded exactly once, the way a browser does, and anything
// the parser cannot make sense of, or that is not on the allowlist, is deleted.
// ---------------------------------------------------------------------------------------------

/** Functions that can make a network request or run code. Compared after decoding + prefix removal. */
const BLOCKED_FUNCTIONS = new Set(['url', 'image-set', 'cross-fade', 'element', 'paint', 'image', 'src', 'image-rect', 'expression']);
const BLOCKED_PROPERTIES = new Set(['behavior', 'binding']); // IE `behavior`, Firefox `-moz-binding`
const ALLOWED_AT_RULES = new Set(['media', 'supports', 'keyframes', 'font-face', 'layer', 'container', 'property', 'import']);

/** Decodes escapes once (as the CSS spec does), lowercases, and drops a vendor prefix. */
const canon = (raw: string): string =>
  cssIdent
    .decode(raw)
    .toLowerCase()
    .replace(/^-(?:webkit|moz|o|ms)-/, '');

/** Does this declaration (property or value) contain anything not allowed? */
function declarationIsUnsafe(decl: CssNode & { type: 'Declaration' }): boolean {
  if (BLOCKED_PROPERTIES.has(canon(decl.property))) return true;
  let bad = false;
  walk(decl.value, (node: CssNode) => {
    switch (node.type) {
      case 'Raw': // the parser gave up: cannot be validated
        bad = true;
        break;
      case 'Url':
        if (!isAllowedCssUrl(node.value) || node.value.includes('\\')) bad = true;
        break;
      case 'Function': {
        const name = canon(node.name);
        if (BLOCKED_FUNCTIONS.has(name)) bad = true;
        // attr() with a type (e.g. `attr(data-x url)`) can produce URLs; only the plain form is allowed.
        if (name === 'attr' && node.children.size > 1) bad = true;
        break;
      }
    }
  });
  return bad;
}

function atruleIsUnsafe(node: CssNode & { type: 'Atrule' }): boolean {
  const name = canon(node.name);
  if (!ALLOWED_AT_RULES.has(name)) return true;
  if (node.prelude?.type === 'Raw') return true;
  if (name === 'import') {
    // Only a Google Fonts stylesheet may be imported.
    let found = false;
    let bad = false;
    if (node.prelude) {
      walk(node.prelude, (n: CssNode) => {
        if (n.type === 'Url' || n.type === 'String') {
          found = true;
          if (!FONT_IMPORT_URL.test(n.value.trim())) bad = true;
        } else if (n.type === 'Function' && !['url', 'supports', 'layer'].includes(canon(n.name))) {
          bad = true; // layer(name) and supports(...) conditions are fine on a fonts import
        }
      });
    }
    return !found || bad;
  }
  return false;
}

/** Removes every unsafe node from the tree. Returns how many were removed. */
function clean(ast: CssNode): number {
  const doomed: Array<() => void> = [];
  walk(ast, {
    enter(node: CssNode, item: unknown, list: unknown) {
      const drop = () => {
        if (list && item) (list as { remove(i: unknown): void }).remove(item);
      };
      if (node.type === 'Declaration' && declarationIsUnsafe(node)) {
        doomed.push(drop);
        return walk.skip;
      }
      if (node.type === 'Atrule' && atruleIsUnsafe(node)) {
        doomed.push(drop);
        return walk.skip;
      }
      // Unparseable chunks sitting between rules/declarations (a Raw selector inside a Rule is fine).
      if (node.type === 'Raw' && list && item) {
        doomed.push(drop);
        return walk.skip;
      }
    },
  });
  doomed.forEach((fn) => fn());
  return doomed.length;
}

/** True if the tree still contains anything the cleaner would remove (used to re-check our output). */
function hasViolation(ast: CssNode): boolean {
  let bad = false;
  walk(ast, (node: CssNode, item: unknown, list: unknown) => {
    if (node.type === 'Declaration' && declarationIsUnsafe(node)) bad = true;
    if (node.type === 'Atrule' && atruleIsUnsafe(node)) bad = true;
    if (node.type === 'Raw' && list && item) bad = true;
  });
  return bad;
}

function sanitize(input: string, context: 'stylesheet' | 'declarationList'): string {
  let css = String(input ?? '').slice(0, MAX_CSS).replace(/\0/g, '');
  // Keep model output from breaking out of the <style> element it is injected into.
  css = css.replace(/<\/?\s*style[^>]*>/gi, '').replace(/<!--|-->/g, '');
  try {
    const opts = { context, parseCustomProperty: true, positions: false, onParseError: () => undefined } as const;
    const ast = parse(css, opts);
    clean(ast);
    const out = generate(ast);
    // Belt and braces: our own output must parse back to a tree with nothing left to remove.
    if (hasViolation(parse(out, opts))) return '';
    return out;
  } catch {
    return '';
  }
}

/** Sanitizes a stylesheet (what models generate). Runs at generation time and again before applying. */
export function sanitizeCss(input: string): string {
  return sanitize(input, 'stylesheet');
}

/** Sanitizes an inline style attribute value (`color:red;background:...`). */
export function sanitizeDeclarations(input: string): string {
  return sanitize(input, 'declarationList');
}

/**
 * A selector comes from an untrusted model and is later pasted into a <style> element, so it must be a
 * real selector list and nothing else. A text blacklist is not enough: `@import url(x) /*` contains none
 * of the characters that look dangerous, yet the unterminated comment swallows the rest of the stylesheet
 * and leaves a valid block-less @import. So: no structure characters or comment markers, AND it must parse
 * as a selector list with no unparseable (Raw) parts.
 */
export function isSafeSelector(sel: unknown): sel is string {
  if (typeof sel !== 'string' || sel.length === 0 || sel.length > 240) return false;
  if (/[{};<]|\/\*|\*\//.test(sel)) return false;
  let bad = false;
  try {
    const ast = parse(sel, { context: 'selectorList', parseCustomProperty: false, positions: false, onParseError: () => (bad = true) });
    if (bad || ast.type !== 'SelectorList') return false;
    walk(ast, (n: CssNode) => {
      if (n.type === 'Raw') bad = true;
    });
  } catch {
    return false;
  }
  return !bad;
}

const str = (v: unknown, max: number): string => String(v ?? '').slice(0, max);

/** Validates and normalizes untrusted ops. Invalid ops are dropped. */
export function sanitizeOps(raw: unknown): DomOp[] {
  if (!Array.isArray(raw)) return [];
  const out: DomOp[] = [];
  for (const item of raw.slice(0, MAX_OPS)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    switch (o.op) {
      case 'hide':
        if (isSafeSelector(o.selector)) out.push({ op: 'hide', selector: o.selector });
        break;
      case 'setText':
        if (isSafeSelector(o.selector))
          out.push({ op: 'setText', selector: o.selector, text: str(o.text, 500) });
        break;
      case 'addClass': {
        const cls = str(o.className, 80);
        if (isSafeSelector(o.selector) && /^[\w\- ]+$/.test(cls))
          out.push({ op: 'addClass', selector: o.selector, className: cls });
        break;
      }
      case 'move':
        if (
          isSafeSelector(o.selector) &&
          isSafeSelector(o.target) &&
          POSITIONS.includes(o.position as Position)
        )
          out.push({ op: 'move', selector: o.selector, target: o.target, position: o.position as Position });
        break;
      case 'insert': {
        const tag = str(o.tag, 20).toLowerCase();
        if (!isSafeSelector(o.target) || !POSITIONS.includes(o.position as Position)) break;
        if (!ALLOWED_TAGS.has(tag)) break;
        const cls = o.className === undefined ? undefined : str(o.className, 120);
        if (cls !== undefined && !/^[\w\- ]*$/.test(cls)) break;
        let src: string | undefined;
        if (tag === 'img') {
          if (typeof o.src !== 'string' || !isAllowedImgSrc(o.src)) break;
          src = o.src.slice(0, 20_000);
        }
        out.push({
          op: 'insert',
          target: o.target,
          position: o.position as Position,
          tag,
          text: o.text === undefined ? undefined : str(o.text, 500),
          className: cls,
          style: o.style === undefined ? undefined : sanitizeDeclarations(str(o.style, 1000)),
          src,
        });
        break;
      }
    }
  }
  return out;
}
