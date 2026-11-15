import type { CssNode } from 'css-tree';
import generate from 'css-tree/generator';
import parse from 'css-tree/parser';
import { ident as cssIdent } from 'css-tree/utils';
import walk from 'css-tree/walker';
import { LIMITS } from './format';

/**
 * Community-theme CSS validation (MVP policy: CSS only, nothing external).
 *
 * Unlike the extension's runtime sanitizer, which quietly strips what it dislikes, this REJECTS: a
 * creator must see exactly what is wrong. It runs on the website at publish time and again inside the
 * extension before a theme is installed. It parses with css-tree (never regexes alone) and compares
 * identifiers after decoding escapes exactly once, the way a browser does.
 *
 * Validation reduces risk; it cannot make arbitrary styles harmless (a theme can still hide or reorder
 * things). That is why installs name the target site and can be undone.
 */

export interface CssIssue {
  code: string;
  message: string;
  line?: number;
}

export interface CssReport {
  ok: boolean;
  errors: CssIssue[];
  warnings: CssIssue[];
  /** Normalized CSS (re-serialized from the parse tree). Empty when not ok. */
  css: string;
  stats: { bytes: number; rules: number; declarations: number; maxDepth: number; dataUriChars: number };
}

/** Functions that fetch resources or run code. Compared after decoding escapes and dropping vendor prefixes. */
const BLOCKED_FUNCTIONS = new Set(['url', 'image-set', 'cross-fade', 'element', 'paint', 'image', 'src', 'image-rect', 'expression']);
const BLOCKED_PROPERTIES = new Set(['behavior', 'binding']); // IE behavior, -moz-binding
const ALLOWED_AT_RULES = new Set(['media', 'supports', 'keyframes', 'font-face', 'layer', 'container', 'property']);
const DATA_URI = /^data:(image\/(png|jpe?g|gif|webp|svg\+xml)|font\/(woff2?|ttf|otf)|application\/font-woff2?)[;,]/i;

const canon = (raw: string): string =>
  cssIdent
    .decode(raw)
    .toLowerCase()
    .replace(/^-(?:webkit|moz|o|ms)-/, '');

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

export function validateCommunityCss(input: unknown): CssReport {
  const errors: CssIssue[] = [];
  const warnings: CssIssue[] = [];
  const stats = { bytes: 0, rules: 0, declarations: 0, maxDepth: 0, dataUriChars: 0 };
  const fail = (code: string, message: string, line?: number) => errors.push({ code, message, line });
  const warn = (code: string, message: string, line?: number) => warnings.push({ code, message, line });
  const result = (css = ''): CssReport => ({ ok: errors.length === 0, errors, warnings, css: errors.length ? '' : css, stats });

  if (typeof input !== 'string' || !input.trim()) {
    fail('empty', 'The CSS is empty.');
    return result();
  }
  const src = input;
  stats.bytes = utf8Bytes(src);
  if (stats.bytes > LIMITS.cssBytes) {
    fail('too-large', `The CSS is ${stats.bytes.toLocaleString()} bytes; the limit is ${LIMITS.cssBytes.toLocaleString()}.`);
    return result(); // do not even parse something huge
  }
  if (/\0/.test(src)) fail('nul', 'The CSS contains a NUL character.');
  if (/<\s*\/?\s*(style|script)\b|<!--|-->|<\s*\/?\s*[a-z][^>]*>/i.test(src.replace(/(["'])(?:(?!\1)[^\\]|\\.)*\1/g, ''))) {
    fail('html', 'The CSS contains HTML-like markup (for example "<style>" or "<!--"). Themes are CSS only.');
  }
  if (errors.length) return result();

  let ast: CssNode;
  try {
    ast = parse(src, {
      context: 'stylesheet',
      parseCustomProperty: true,
      positions: true,
      onParseError: (e: { message: string; line?: number }) => fail('parse', `CSS could not be parsed: ${e.message}`, e.line),
    });
  } catch (e) {
    fail('parse', `CSS could not be parsed: ${e instanceof Error ? e.message : String(e)}`);
    return result();
  }

  const line = (n: CssNode): number | undefined => (n as { loc?: { start?: { line?: number } } }).loc?.start?.line;
  let depth = 0;
  const checkUrl = (value: string, n: CssNode) => {
    if (!DATA_URI.test(value.trim())) {
      fail('external-url', 'External resources are not allowed. Use embedded data: images/fonts or plain CSS (gradients, shapes).', line(n));
      return;
    }
    if (value.includes('\\')) fail('escaped-url', 'Embedded data URLs may not contain escape sequences.', line(n));
    if (value.length > LIMITS.dataUriChars) fail('data-uri-large', `An embedded file is ${value.length.toLocaleString()} characters; the limit is ${LIMITS.dataUriChars.toLocaleString()}.`, line(n));
    stats.dataUriChars += value.length;
  };

  walk(ast, {
    enter(node: CssNode) {
      switch (node.type) {
        case 'Block':
          depth++;
          stats.maxDepth = Math.max(stats.maxDepth, depth);
          break;
        case 'Rule':
          stats.rules++;
          break;
        case 'Raw':
          fail('unparseable', 'Part of the CSS could not be understood, so it cannot be checked.', line(node));
          break;
        case 'Atrule': {
          stats.rules++;
          const name = canon(node.name);
          if (name === 'import') fail('import', '@import is not allowed. Themes cannot load other stylesheets.', line(node));
          else if (!ALLOWED_AT_RULES.has(name)) fail('at-rule', `@${cssIdent.decode(node.name)} is not allowed in themes.`, line(node));
          break;
        }
        case 'Declaration': {
          stats.declarations++;
          const prop = canon(node.property);
          if (BLOCKED_PROPERTIES.has(prop)) fail('property', `The "${cssIdent.decode(node.property)}" property is not allowed.`, line(node));
          if (prop === 'pointer-events' && /\bnone\b/i.test(generate(node.value))) {
            warn('pointer-events', 'pointer-events: none can make parts of a page unclickable. Check it does not cover important controls.', line(node));
          }
          break;
        }
        case 'Url':
          checkUrl(node.value, node);
          break;
        case 'Function': {
          const name = canon(node.name);
          if (BLOCKED_FUNCTIONS.has(name)) {
            // A real url() is a Url node (checked above); a Function named url/expression/image-set... is never ok.
            fail('function', `${cssIdent.decode(node.name)}() is not allowed in themes.`, line(node));
          } else if (name === 'attr' && node.children.size > 1) {
            fail('attr-type', 'attr() with a type (which can build URLs) is not allowed.', line(node));
          }
          break;
        }
      }
    },
    leave(node: CssNode) {
      if (node.type === 'Block') depth--;
    },
  });

  if (stats.rules > LIMITS.rules) fail('too-many-rules', `The CSS has ${stats.rules.toLocaleString()} rules; the limit is ${LIMITS.rules.toLocaleString()}.`);
  if (stats.declarations > LIMITS.declarations) fail('too-many-declarations', `The CSS has ${stats.declarations.toLocaleString()} declarations; the limit is ${LIMITS.declarations.toLocaleString()}.`);
  if (stats.maxDepth > LIMITS.nestingDepth) fail('nesting', `Rules are nested ${stats.maxDepth} levels deep; the limit is ${LIMITS.nestingDepth}.`);
  if (stats.dataUriChars > LIMITS.dataUriTotalChars) fail('data-uri-total', `Embedded files total ${stats.dataUriChars.toLocaleString()} characters; the limit is ${LIMITS.dataUriTotalChars.toLocaleString()}.`);

  // Soft warnings: things that commonly make a page unusable.
  walk(ast, (node: CssNode) => {
    if (node.type !== 'Rule' || node.prelude.type !== 'SelectorList') return;
    const sel = generate(node.prelude).trim();
    const broad = /^(html|body|\*|:root)$/i.test(sel) || sel === 'html,body' || sel === 'html, body';
    if (!broad) return;
    walk(node.block, (d: CssNode) => {
      if (d.type !== 'Declaration') return;
      const prop = canon(d.property);
      const val = generate(d.value);
      if ((prop === 'display' && /^none\b/i.test(val)) || (prop === 'visibility' && /^hidden\b/i.test(val))) {
        warn('hides-page', `This hides the whole page (${sel} { ${prop}: ${val} }).`, line(d));
      }
    });
  });

  if (errors.length) return result();
  const css = generate(ast);
  // Belt and braces: our own normalized output must validate cleanly too.
  const again = validateCommunityCssOnce(css);
  if (!again.ok) {
    fail('normalize', 'The CSS changed meaning when normalized; please simplify it.');
    return result();
  }
  return result(css);
}

/** Re-check without recursing into the normalization step. */
function validateCommunityCssOnce(css: string): { ok: boolean } {
  let bad = false;
  try {
    const ast = parse(css, { context: 'stylesheet', parseCustomProperty: true, positions: false, onParseError: () => (bad = true) });
    walk(ast, (node: CssNode, item: unknown, list: unknown) => {
      if (node.type === 'Raw' && list && item) bad = true;
      if (node.type === 'Url' && !DATA_URI.test(node.value.trim())) bad = true;
      if (node.type === 'Function' && BLOCKED_FUNCTIONS.has(canon(node.name))) bad = true;
      if (node.type === 'Atrule' && !ALLOWED_AT_RULES.has(canon(node.name))) bad = true;
    });
  } catch {
    bad = true;
  }
  return { ok: !bad };
}
