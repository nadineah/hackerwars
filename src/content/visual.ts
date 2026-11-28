import { EDIT_ATTR } from '../shared/edits';
import { findIcon, findOverlay, isControl, stateEffectsOf } from './parts';
import { UNIT_RANK, unitKind } from './units';

/**
 * Edit Mode's "Visual elements" filter: which elements draw something a person can see and recognise on the page,
 * as opposed to the wrappers and spacers a site uses only for layout. Page clicks, the element tree and the Layers
 * picker all use this one test, so they always agree.
 *
 * Visual: rendered text of its own, images / video / canvas / embedded frames, form controls and buttons, and boxes
 * that paint something themselves (a background colour or image, a drawn border, a shadow, an outline), including an
 * empty box with only a border, or a card that is mostly padding. Not visual: anything without a size, not shown,
 * fully transparent, or that draws nothing itself.
 */

/** The parts of a computed style the test reads (a CSSStyleDeclaration, or a plain object in tests). */
export interface PaintStyle {
  display: string;
  visibility: string;
  opacity: string;
  backgroundColor: string;
  backgroundImage: string;
  borderTopWidth: string;
  borderTopStyle: string;
  borderTopColor: string;
  borderRightWidth: string;
  borderRightStyle: string;
  borderRightColor: string;
  borderBottomWidth: string;
  borderBottomStyle: string;
  borderBottomColor: string;
  borderLeftWidth: string;
  borderLeftStyle: string;
  borderLeftColor: string;
  boxShadow: string;
  outlineStyle: string;
  outlineWidth: string;
  outlineColor: string;
}

/** Elements that are content by what they are, whatever their style. */
const CONTENT_TAGS = /^(IMG|SVG|CANVAS|VIDEO|IFRAME|EMBED|OBJECT|INPUT|TEXTAREA|SELECT|BUTTON|HR|METER|PROGRESS)$/i;

/** The alpha of a computed colour (Chrome serializes as rgb(), rgba(), or a modern "… / a" form). */
export function alphaOf(color: string): number {
  const c = color.trim().toLowerCase();
  if (!c || c === 'transparent') return 0;
  const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(c);
  if (slash) return slash[2] ? Number(slash[1]) / 100 : Number(slash[1]);
  const rgba = /^rgba\(([^)]*)\)$/.exec(c);
  if (rgba) {
    const parts = rgba[1].split(',');
    if (parts.length === 4) return Number(parts[3]);
  }
  return 1;
}

const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const;

/** Does a box with this style paint something itself (background, border, shadow, outline)? */
export function paintsBox(cs: PaintStyle): boolean {
  if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
  if (alphaOf(cs.backgroundColor) > 0.02) return true;
  for (const s of SIDES) {
    const w = parseFloat(cs[`border${s}Width`]) || 0;
    const style = cs[`border${s}Style`];
    if (w > 0 && style !== 'none' && style !== 'hidden' && alphaOf(cs[`border${s}Color`]) > 0.02) return true;
  }
  if (cs.boxShadow && cs.boxShadow !== 'none') return true;
  if (cs.outlineStyle && cs.outlineStyle !== 'none' && (parseFloat(cs.outlineWidth) || 0) > 0 && alphaOf(cs.outlineColor) > 0.02) return true;
  return false;
}

/** Shown at all: has a size, is displayed, not hidden, not (nearly) fully transparent. */
export function isShown(cs: Pick<PaintStyle, 'display' | 'visibility' | 'opacity'>, rect: { width: number; height: number }): boolean {
  if (cs.display === 'none' || cs.display === 'contents') return false;
  if (cs.visibility !== 'visible') return false;
  if ((parseFloat(cs.opacity) || 0) <= 0.05 && cs.opacity !== '') return false;
  return rect.width >= 1 && rect.height >= 1;
}

/** Text of its own (direct text nodes that are not just spaces). */
export function hasOwnText(el: Element): boolean {
  for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE && /\S/.test(n.textContent ?? '')) return true;
  return false;
}

/** A ::before / ::after that draws something: an icon or text, or an empty one with a background or border. */
function pseudoPaints(el: Element, which: '::before' | '::after'): boolean {
  const cs = getComputedStyle(el, which);
  const content = cs.content;
  if (!content || content === 'none' || content === 'normal') return false;
  if (cs.display === 'none' || cs.visibility !== 'visible') return false;
  if (content !== '""' && content !== "''") return true;
  return paintsBox(cs as unknown as PaintStyle);
}

/** Shown and not inside something faded out (the first part of both views' tests). */
function shownHere(el: Element, cs: CSSStyleDeclaration, r: DOMRect): boolean {
  const tag = el.tagName;
  if (tag === 'HTML' || tag === 'BODY') return false; // the page itself: the root of the tree, never a click target
  if (!isShown(cs, r)) return false;
  // opacity is not inherited: a picture inside a faded-out menu reports opacity 1 but cannot be seen
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) if (isDead(p)) return false;
  return true;
}

/** Draws something itself: content by what it is, text of its own, a painted box, or a drawn ::before/::after. */
function drawsItself(el: Element, cs: CSSStyleDeclaration): boolean {
  const tag = el.tagName;
  if (CONTENT_TAGS.test(tag)) return !(tag === 'INPUT' && (el as HTMLInputElement).type === 'hidden');
  if (el.getAttribute('role') === 'img') return true;
  if (hasOwnText(el)) return true;
  if (paintsBox(cs as unknown as PaintStyle)) return true;
  // a site's icon drawn by CSS (icon fonts, badges made of ::before)
  return pseudoPaints(el, '::before') || pseudoPaints(el, '::after');
}

/** The full "Drawn only" test for one element (uncached; use `isVisual`). */
function computeVisual(el: Element): boolean {
  const cs = getComputedStyle(el);
  return shownHere(el, cs, el.getBoundingClientRect()) && drawsItself(el, cs);
}

/** Inline styling inside a run of text (a bold word, a span of a sentence): part of its paragraph, not a piece. */
const INLINE_BITS = /^(B|I|EM|STRONG|SPAN|SMALL|BIG|MARK|U|S|SUB|SUP|ABBR|CODE|TIME|FONT|Q|CITE|DFN|KBD|SAMP|VAR|BDI|BDO|DEL|INS|WBR)$/;
function inlineBit(el: Element, cs: CSSStyleDeclaration): boolean {
  if (cs.display !== 'inline' || !INLINE_BITS.test(el.tagName)) return false;
  const p = el.parentElement;
  if (!p || !hasOwnText(p)) return false;
  if (paintsBox(cs as unknown as PaintStyle)) return false; // a highlighted word or a code chip is something you see
  if (el.querySelector('img,svg,video,canvas,input,button,a[href]')) return false;
  const cls = typeof el.className === 'string' ? el.className : '';
  return !/icon|(^|s)(fa|bi|mdi|material)[-s]/i.test(cls) && !/icon|awesome|material|symbols/i.test(cs.fontFamily);
}

const sameBox = (a: DOMRect, b: DOMRect) => Math.abs(a.left - b.left) <= 2 && Math.abs(a.top - b.top) <= 2 && Math.abs(a.right - b.right) <= 2 && Math.abs(a.bottom - b.bottom) <= 2;
/** Its only child shown with a size (null: none, or several). */
function onlyShownChild(el: Element): Element | null {
  let one: Element | null = null;
  let n = 0;
  for (const c of el.children) {
    if (++n > 60) return null;
    const r = c.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (one) return null;
    one = c;
  }
  return one;
}

/**
 * A container drawing nothing that another element with the same box stands for: one that draws it, or a container
 * that says more (a card over the link filling it), or, saying as much, the outer one. Sites wrap a piece 3-5 times;
 * one of them is listed.
 */
function standsInForIt(el: Element, r: DOMRect, rank: number): boolean {
  let n = el.parentElement;
  for (let i = 0; n && n !== document.body && i < 6; n = n.parentElement, i++) {
    const pr = n.getBoundingClientRect();
    if (!sameBox(pr, r)) break;
    const pcs = getComputedStyle(n);
    if (drawsItself(n, pcs)) return true;
    const k = unitKind(n, pr, pcs);
    if (k && UNIT_RANK[k] >= rank) return true;
  }
  let c = onlyShownChild(el);
  for (let i = 0; c && i < 6; c = onlyShownChild(c), i++) {
    const cr = c.getBoundingClientRect();
    if (!sameBox(cr, r)) break;
    const ccs = getComputedStyle(c);
    if (drawsItself(c, ccs)) return true;
    const k = unitKind(c, cr, ccs);
    if (k && UNIT_RANK[k] > rank) return true;
  }
  return false;
}

/**
 * The full "Smart" test: what draws something (minus inline bits of a sentence), and the containers people see as one
 * piece although they draw nothing (cards, rows, sections), one per box.
 */
/**
 * A button or link that changes when pointed at or focused, though it draws nothing until then: one with a hover
 * overlay (YouTube's notification bell), or one holding only an icon. It keeps its own row, so its hover and focus
 * looks can be found and edited (its icon is listed inside it). Big ones (a link around a whole card) are left out.
 */
function hoverControl(el: Element, r: DOMRect): boolean {
  if (r.width > 480 || r.height > 240 || !isControl(el)) return false;
  if (findOverlay(el)) return true;
  const icon = findIcon(el);
  if (!icon || icon.el === el) return false;
  const words = (el.textContent ?? '').replace(icon.el.textContent ?? '', '').trim();
  return !words;
}

/**
 * Invisible now only because the site shows it when pointed at, pressed or focused (an overlay layer at opacity 0, a
 * hover-only badge): it has its size and sits in nothing hidden, so it is listed, to find and edit that effect.
 */
function hiddenUntilState(el: Element, cs: CSSStyleDeclaration, r: DOMRect): boolean {
  if (el.tagName === 'HTML' || el.tagName === 'BODY' || cs.display === 'none' || cs.display === 'contents') return false;
  if (r.width < 1 || r.height < 1) return false;
  const faded = (parseFloat(cs.opacity) || 0) <= 0.05 || cs.visibility !== 'visible';
  if (!faded) return false;
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) if (isDead(p)) return false;
  const fx = stateEffectsOf(el);
  return fx.hover || fx.focus;
}

function computeSmart(el: Element): boolean {
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  if (!shownHere(el, cs, r)) return hiddenUntilState(el, cs, r);
  if (inlineBit(el, cs)) return false;
  if (drawsItself(el, cs)) return true;
  if (hoverControl(el, r)) return true;
  // the site changes it when pointed at, pressed or focused (a hover background, an overlay layer): its own row, so
  // the effect can be found and edited, though it draws nothing at rest
  const fx = stateEffectsOf(el);
  if (fx.hover || fx.focus) return true;
  const k = unitKind(el, r, cs);
  return !!k && !standsInForIt(el, r, UNIT_RANK[k]);
}

/** Which elements the filtered tree shows: Smart (the default) or Drawn only. */
export type FilterView = 'smart' | 'visual';
let view: FilterView = 'smart';
export function setView(v: FilterView): void {
  if (view === v) return;
  view = v;
  invalidateVisual();
}
const computeView = (el: Element) => (view === 'smart' ? computeSmart(el) : computeVisual(el));

/**
 * Its subtree cannot contain anything visible (not displayed, or fully transparent): the filter does not look inside.
 * visibility:hidden is not one of them, since a child can make itself visible again.
 */
function deadSubtree(el: Element): boolean {
  const cs = getComputedStyle(el);
  return cs.display === 'none' || (parseFloat(cs.opacity) || 0) <= 0.05 && cs.opacity !== '';
}

// ---- cache: one answer per element for a short while (a burst of tree requests and a click share it); the page
// changing its elements, or the forced element changing, starts over.
let epoch = 1;
let epochAt = 0;
const EPOCH_MS = 600;
const visualCache = new WeakMap<Element, { e: number; v: boolean }>();
const deadCache = new WeakMap<Element, { e: number; v: boolean }>();
const kidsCache = new WeakMap<Element, { e: number; v: Element[] }>();
/** The last answers given for each element (outliving the cache), to tell when one really changed. */
const lastSeen = new WeakMap<Element, { v?: boolean; d?: boolean }>();
const remember = (el: Element, k: 'v' | 'd', value: boolean) => {
  const s = lastSeen.get(el);
  if (s) s[k] = value;
  else lastSeen.set(el, { [k]: value });
};

/**
 * Did this element start or stop counting as visual (or start or stop hiding everything inside it) since the tree last
 * asked? A style or class change that does not do either (a progress bar moving, a hover colour) is not worth a tree
 * refresh. Elements the tree never looked at report no change.
 */
export function visualStateChanged(el: Element): boolean {
  const before = lastSeen.get(el);
  if (!before) return false;
  const v = computeView(el);
  const d = deadSubtree(el);
  const changed = (before.v !== undefined && before.v !== v) || (before.d !== undefined && before.d !== d);
  lastSeen.set(el, { v, d });
  return changed;
}

/** The page changed (elements added or removed, or a theme applied): forget every answer. */
export function invalidateVisual(): void {
  epoch++;
  epochAt = Date.now();
}
function currentEpoch(): number {
  const now = Date.now();
  if (now - epochAt > EPOCH_MS) {
    epoch++;
    epochAt = now;
  }
  return epoch;
}

/** Elements always shown in the Visual tree although they draw nothing (the selection: a wrapper picked by Select parent). */
let forced: Element | null = null;
export function setForced(el: Element | null): boolean {
  if (forced === el) return false;
  forced = el;
  invalidateVisual();
  return true;
}
export const forcedElement = () => forced;

export function isVisual(el: Element): boolean {
  const e = currentEpoch();
  const hit = visualCache.get(el);
  if (hit && hit.e === e) return hit.v;
  const v = computeView(el);
  visualCache.set(el, { e, v });
  remember(el, 'v', v);
  return v;
}

function isDead(el: Element): boolean {
  const e = currentEpoch();
  const hit = deadCache.get(el);
  if (hit && hit.e === e) return hit.v;
  const v = deadSubtree(el);
  deadCache.set(el, { e, v });
  remember(el, 'd', v);
  return v;
}

/**
 * Hidden by a change made here (the tree's eye): it draws nothing, but keeps its row, so it can be shown again (an
 * edited element that is hidden; the site's own hidden ones are not listed).
 */
function hiddenByEdit(el: Element): boolean {
  if (!el.hasAttribute(EDIT_ATTR)) return false;
  const cs = getComputedStyle(el);
  return cs.visibility === 'hidden' || cs.display === 'none';
}

/** Shown as a row in the Visual tree: visual, the forced element, or one hidden here. */
export const inVisualTree = (el: Element): boolean => el === forced || isVisual(el) || hiddenByEdit(el);

/**
 * The children of `el` in the Visual tree: its nearest visual descendants, looking through wrappers that draw nothing.
 * A wrapper holding three buttons gives the three buttons. `keep` filters what may be listed at all (editable).
 */
export function visualChildren(el: Element, keep: (e: Element) => boolean): Element[] {
  const e = currentEpoch();
  const hit = kidsCache.get(el);
  if (hit && hit.e === e) return hit.v;
  const out: Element[] = [];
  const walk = (parent: Element) => {
    for (const c of parent.children) {
      if (!keep(c)) continue;
      if (inVisualTree(c)) out.push(c);
      else if (!isDead(c) || (forced && c.contains(forced))) walk(c);
    }
  };
  walk(el);
  kidsCache.set(el, { e, v: out });
  return out;
}

/** Whether `el` has any child in the Visual tree (stops at the first one; for the tree's expand arrows). */
export function hasVisualChild(el: Element, keep: (e: Element) => boolean, budget = 4000): boolean {
  const hit = kidsCache.get(el);
  if (hit && hit.e === currentEpoch()) return hit.v.length > 0;
  let left = budget;
  const walk = (parent: Element): boolean => {
    for (const c of parent.children) {
      if (--left < 0) return true; // a huge subtree: assume something is in it (opening it shows the truth)
      if (!keep(c)) continue;
      if (inVisualTree(c)) return true;
      if ((!isDead(c) || (forced && c.contains(forced))) && walk(c)) return true;
    }
    return false;
  };
  return walk(el);
}

/** The nearest ancestor shown in the Visual tree (body at the top). */
export function visualParent(el: Element): Element | null {
  for (let n = el.parentElement; n; n = n.parentElement) {
    if (n === document.body) return n;
    if (inVisualTree(n)) return n;
  }
  return null;
}

// ---- what is under a point

let openSheet: CSSStyleSheet | null = null;

/**
 * Every element under a point, front to back, as the browser paints them (also across stacking contexts), including
 * elements that ignore the mouse (`pointer-events: none`, common on badges and overlays): for one synchronous moment
 * everything is made hit-testable, so the browser's own order is used. Nothing repaints and the page sees no event.
 */
export function elementsAt(x: number, y: number): Element[] {
  let added = false;
  try {
    if (!openSheet) {
      openSheet = new CSSStyleSheet();
      // in a cascade layer: a layered !important beats every unlayered !important of the page, however specific
      // (only an inline style="pointer-events: none !important" still wins; our own toolbar relies on that)
      openSheet.replaceSync('@layer ww-hit-test { *, *::before, *::after { pointer-events: auto !important; } }');
    }
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, openSheet];
    added = true;
  } catch {
    /* no constructed sheets: the plain hit test still works, without pointer-events:none elements */
  }
  try {
    return document.elementsFromPoint(x, y);
  } finally {
    if (added) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== openSheet);
  }
}
