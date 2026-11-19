import { fixColor, over, parseColor, ratio, targetFor, toHex, type Rgba } from '../shared/contrast';

/**
 * Makes text readable after a design is applied, with no AI. For every piece of visible text it works out the colour that
 * is really behind it, and if the contrast is too low it nudges the text colour the way it already leans (darker text
 * darker, lighter text lighter) until it passes. The fixes are one small stylesheet plus a marker attribute per element, so
 * nothing in the page is rewritten and "clear" puts everything back.
 */

const ATTR = 'data-ww-fix';
const STYLE_ID = 'ww-contrast-style';
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'HEAD', 'TITLE', 'MATH']);
const MAX_ELEMENTS = 6000;
const CHUNK = 350;

export interface ContrastFailure {
  selector: string;
  text: string;
  ratio: number;
  color: string;
  background: string;
  suggested: string;
  reached: boolean;
}
export interface ContrastReport {
  checked: number;
  failing: number;
  fixed: number;
  /** Text it could not judge (image or gradient behind it). */
  unknown: number;
  failures: ContrastFailure[];
}

let current: ContrastReport = { checked: 0, failing: 0, fixed: 0, unknown: 0, failures: [] };
let nextId = 1;
const ids = new WeakMap<Element, number>();
let running = false;
let again = false;
/** Converts colour spaces the parser does not read (oklch, color(), ...) by letting the browser do it. */
let canvasCtx: CanvasRenderingContext2D | null | undefined;
function viaCanvas(css: string): Rgba | null {
  if (canvasCtx === undefined) canvasCtx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!canvasCtx) return null;
  try {
    canvasCtx.clearRect(0, 0, 1, 1);
    canvasCtx.fillStyle = '#000';
    canvasCtx.fillStyle = css;
    canvasCtx.fillRect(0, 0, 1, 1);
    const d = canvasCtx.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
  } catch {
    return null;
  }
}
const colorOf = (css: string): Rgba | null => parseColor(css) ?? viaCanvas(css);

export const getContrastStats = () => ({ fixed: current.fixed, checked: current.checked, unknown: current.unknown });

function selectorOf(el: Element): string {
  const parts: string[] = [];
  let n: Element | null = el;
  for (let i = 0; n && n !== document.body && i < 3; i++, n = n.parentElement) {
    let p = n.tagName.toLowerCase();
    if (n.id && n.id.length < 40 && /^[\w-]+$/.test(n.id)) {
      parts.unshift(`${p}#${n.id}`);
      break;
    }
    const cls = Array.from(n.classList).filter((c) => /^[\w-]{1,30}$/.test(c)).slice(0, 2);
    if (cls.length) p += '.' + cls.join('.');
    parts.unshift(p);
  }
  return parts.join(' > ');
}

/** The colour behind an element, or null when an image or gradient is painted behind it (cannot be judged). */
function backdrop(el: Element, cache: Map<Element, Rgba | null>): Rgba | null {
  const layers: Rgba[] = [];
  const visited: Element[] = [];
  let node: Element | null = el;
  let result: Rgba | null | undefined;
  while (node) {
    if (cache.has(node)) {
      result = cache.get(node);
      break;
    }
    visited.push(node);
    const cs = getComputedStyle(node);
    if (cs.backgroundImage !== 'none' && cs.backgroundImage !== '') {
      result = null;
      break;
    }
    const bg = colorOf(cs.backgroundColor);
    if (bg && bg.a > 0) {
      layers.push(bg);
      if (bg.a >= 0.99) break;
    }
    node = node.parentElement;
  }
  if (result === undefined) {
    // composite from the furthest layer to the nearest, over white (the page's default canvas)
    let base: Rgba = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    result = base;
  } else if (result !== null && layers.length) {
    let base = result;
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    result = base;
  }
  // remember the answer for the element that was asked (ancestors differ only by their own layers, so cache just this one)
  cache.set(el, result ?? null);
  return result ?? null;
}

function isVisible(el: Element, cs: CSSStyleDeclaration): boolean {
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || Number(cs.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width >= 2 && r.height >= 2;
}

function textParents(root: Node, limit: number): Element[] {
  const out = new Set<Element>();
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      if (!p || SKIP_TAGS.has(p.tagName) || !n.textContent || !n.textContent.trim()) return NodeFilter.FILTER_REJECT;
      if (p.closest('[data-ww-preview],[data-ww-snip],[aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = tw.nextNode(); n && out.size < limit; n = tw.nextNode()) out.add(n.parentElement as Element);
  return [...out];
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Checks the whole page. With `apply` it also corrects every failing text colour (and removes corrections that are no
 * longer needed). Without it, it only reports (the Prompt Lab uses that).
 */
export async function runContrast(opts: { apply: boolean; maxFailures?: number }): Promise<ContrastReport> {
  if (running) {
    again = true;
    return current;
  }
  running = true;
  try {
    const cache = new Map<Element, Rgba | null>();
    const report: ContrastReport = { checked: 0, failing: 0, fixed: 0, unknown: 0, failures: [] };
    const rules: string[] = [];
    const live = new Set<number>();
    const parents = textParents(document.body ?? document.documentElement, MAX_ELEMENTS);
    for (let i = 0; i < parents.length; i += CHUNK) {
      for (const el of parents.slice(i, i + CHUNK)) {
        const cs = getComputedStyle(el);
        if (!isVisible(el, cs)) continue;
        // text painted with a gradient or clipped to a background cannot be judged
        if (cs.webkitBackgroundClip === 'text' || (cs as unknown as { backgroundClip: string }).backgroundClip === 'text') continue;
        if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue;
        const fill = cs.getPropertyValue('-webkit-text-fill-color');
        const rawColor = fill && fill !== cs.color ? fill : cs.color;
        const fg = colorOf(rawColor);
        if (!fg || fg.a === 0) continue;
        const bg = backdrop(el, cache);
        report.checked++;
        if (!bg) {
          report.unknown++;
          continue;
        }
        const px = parseFloat(cs.fontSize) || 16;
        const weight = Number(cs.fontWeight) || 400;
        const target = targetFor(px, weight);
        const solid = fg.a < 1 ? over(fg, bg) : fg;
        const r0 = ratio(solid, bg);
        if (r0 >= target) continue;
        const fix = fixColor(fg, bg, target);
        if (!fix) continue;
        report.failing++;
        if (report.failures.length < (opts.maxFailures ?? 60)) {
          report.failures.push({ selector: selectorOf(el), text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40), ratio: Math.round(r0 * 100) / 100, color: toHex(solid), background: toHex(bg), suggested: toHex(fix.color), reached: fix.reached });
        }
        if (opts.apply) {
          const id = ids.get(el) ?? nextId++;
          ids.set(el, id);
          el.setAttribute(ATTR, String(id));
          live.add(id);
          rules.push(`[${ATTR}="${id}"]{color:${toHex(fix.color)}!important;-webkit-text-fill-color:${toHex(fix.color)}!important}`);
          report.fixed++;
        }
      }
      if (i + CHUNK < parents.length) await tick();
    }
    if (opts.apply) {
      let st = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
      if (!st) {
        st = document.createElement('style');
        st.id = STYLE_ID;
        st.setAttribute('data-ww-contrast', '');
        document.documentElement.append(st);
      }
      st.textContent = rules.join('\n');
      // markers whose element no longer needs a correction
      document.querySelectorAll(`[${ATTR}]`).forEach((el) => {
        if (!live.has(Number(el.getAttribute(ATTR)))) el.removeAttribute(ATTR);
      });
      current = report;
    } else {
      current = { ...current };
    }
    return report;
  } finally {
    running = false;
    if (again) {
      again = false;
      void runContrast(opts);
    }
  }
}

/** Removes every correction (the page is exactly as the design left it). */
export function clearContrast(): void {
  document.getElementById(STYLE_ID)?.remove();
  document.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR));
  current = { checked: 0, failing: 0, fixed: 0, unknown: 0, failures: [] };
}
