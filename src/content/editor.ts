import { ADD_ATTR, EDIT_ATTR, MOVE_ATTR, SLOTS, STATE_ATTR, addElement, removeAdded, upsertEdit, type EditBase, type EditTarget, type InsertKind, type InsertPosition, type MovePosition, type Slot, type VisualEdit } from '../shared/edits';
import type { EditState, ElementView, FromPage, MoveMode, MoveStep, PartInfo, SelectionInfo, ToPage, TreeNode } from '../shared/editorProtocol';
import type { AiContextKind } from '../shared/types';
import { currentEdits, moveGaveUp, movedHome, setWorkingEdits } from './editLayer';
import { buildTarget, decorationsOf, isEditable, labelOf, leafText, openingTag, originOf, resolveTarget, similarOf, themeRulesFor } from './identity';
import { canHold, findIcon, findOverlay, inRow, isControl, isPointable, layoutOf, svgAsMask, sameBox, stateEffectsOf, stateLookOf, svgPaint, wrapsControl, type IconType } from './parts';
import { childRange } from '../shared/treeRange';
import { alphaOf, elementsAt, forcedElement, hasVisualChild, inVisualTree, invalidateVisual, isVisual, setForced, setView, visualChildren, visualParent, visualStateChanged } from './visual';
import { repeatCount } from './units';
import { pageLookFor } from './lookalike';

/**
 * Edit Mode on the page. Runs only while the side panel holds a `ww-editor` port to this tab; closing the port (Done,
 * the panel closing, another tab) ends it and puts the page back exactly as it was, keeping saved edits.
 *
 * While it runs, clicks on the page select instead of acting (links do not navigate, buttons do not press). Only the
 * selected element is outlined (never on hover): plum for the website's own elements, gold for ones a Whimsy Web
 * design created. The outline, handles and toolbar live in a shadow root, so neither the website's CSS nor a
 * theme can restyle or break them, and they never change the selected element's box.
 */

type Pseudo = '::before' | '::after';
interface Sel {
  el: Element;
  pseudo?: Pseudo;
}

const SITE_COLOR = '#7a5ea8';
const WW_COLOR = '#c9962e';

let port: chrome.runtime.Port | null = null;
let designId = '';
let edits: VisualEdit[] = [];
let sel: Sel | null = null;
/** More selected elements (Ctrl/Shift-click or Select similar); `sel` stays the main one the panel shows. */
let extra: Sel[] = [];
/** "Select similar" is on: the selector every element like the main one matches. */
let group: string | null = null;
const MAX_SELECTED = 300;
let selTarget: ReturnType<typeof buildTarget> | null = null;
let expanded = new Set<string>();
let ui: Overlay | null = null;
let observer: MutationObserver | null = null;
/** Where the selected element last was on screen (page coordinates), for when it hides on its own (hover-only things). */
let lastSeen: { x: number; y: number; w: number; h: number } | null = null;
/** The selected element is hidden or gone right now; the panel has been told. */
let hoverOnly = false;
/** Visual elements (src/content/visual.ts) for the tree and page clicks; false: All elements, the page as it is built. */
let visualMode = true;
/** Which elements are listed and picked (visualMode: a filtered one, Smart or Drawn only). */
let view: ElementView = 'smart';
function useView(v: ElementView): void {
  view = v;
  visualMode = v !== 'all';
  if (v !== 'all') setView(v);
}
/** The last page click: clicking the same spot again picks what the selection sits in. */
let lastClick: { x: number; y: number; hit: Element } | null = null;
/**
 * Layers: everything under the spot last clicked on the page, front to back (only Visual elements in that mode). Tied
 * to that click, so it stays put while the person moves into the toolbar and browses it; null when the selection came
 * from anywhere else.
 */
let layers: Element[] | null = null;
/** How dragging the move handle moves things: within the layout (the element itself is placed elsewhere) or freely. */
let moveMode: MoveMode = 'layout';
/** The element showing its hover/focus look for the panel's Hover/Focus tab (the state attribute is on it). */
/** The elements showing a hover or focus look now: the selection, and the others selected with it. */
let stateEls: Element[] = [];

/** Shows the selection's hover or focus look (normal: none). */
/** One look on the page (Normal clears both); the panel's boxes send both at once (setLooks). */
function showState(state: EditState): void {
  setLooks(state === 'hover', state === 'focus');
}

const nodeIds = new WeakMap<Element, number>();
const byId = new Map<number, WeakRef<Element>>();
let nextNode = 1;
const idOf = (el: Element): string => {
  let n = nodeIds.get(el);
  if (!n) {
    n = nextNode++;
    nodeIds.set(el, n);
    byId.set(n, new WeakRef(el));
  }
  return String(n);
};
const fromId = (id: string): Sel | null => {
  const m = /^(\d+)(::before|::after)?$/.exec(id);
  if (!m) return null;
  const el = byId.get(Number(m[1]))?.deref();
  return el && el.isConnected ? { el, pseudo: m[2] as Pseudo | undefined } : null;
};

const post = (m: FromPage) => {
  try {
    port?.postMessage(m);
  } catch {
    /* the panel went away */
  }
};

export const editorActive = (): boolean => !!port;

// ------------------------------------------------------------------------------------------- start / stop

export function startEditor(p: chrome.runtime.Port): void {
  if (port) stopEditor();
  port = p;
  p.onMessage.addListener(onPanel);
  p.onDisconnect.addListener(() => {
    if (port === p) stopEditor();
  });
}

function begin(id: string, list: VisualEdit[]): void {
  designId = id;
  edits = list;
  void setWorkingEdits(designId, edits);
  if (!ui) {
    ui = new Overlay();
    for (const t of BLOCKED) window.addEventListener(t, guard, { capture: true, passive: false });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    for (const t of LEAVES) window.addEventListener(t, holdHover, true);
    window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
    window.addEventListener('scroll', hideHint, { capture: true, passive: true });
    document.documentElement.classList.add('ww-editing');
    observer = new MutationObserver(onMutations);
    // class / style / hidden changes too: a menu or hover card opened by a class shows (or loses) visual elements
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'] });
  }
  post({ t: 'ready' });
}

export function stopEditor(): void {
  clearFakeHover();
  for (const t of BLOCKED) window.removeEventListener(t, guard, { capture: true } as EventListenerOptions);
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('keyup', onKeyUp, true);
  for (const t of LEAVES) window.removeEventListener(t, holdHover, true);
  window.removeEventListener('pointermove', onPointerMove, true);
  window.removeEventListener('scroll', hideHint, true);
  cancelAnimationFrame(hintRaf);
  hintRaf = 0;
  document.documentElement.classList.remove('ww-editing');
  observer?.disconnect();
  observer = null;
  ui?.destroy();
  ui = null;
  showState('normal');
  sel = null;
  selTarget = null;
  lastSeen = null;
  hoverOnly = false;
  layers = null;
  setForced(null);
  expanded = new Set();
  window.clearTimeout(changeTimer);
  changeTimer = undefined;
  changed = new Set();
  restyled = new Set();
  const p = port;
  port = null;
  void setWorkingEdits(null);
  try {
    p?.disconnect();
  } catch {
    /* already closed */
  }
}

function onPanel(m: ToPage): void {
  switch (m.t) {
    case 'start':
      useView(m.view ?? 'smart');
      begin(m.designId, m.edits);
      return;
    case 'mode':
      useView(m.view);
      lastClick = null;
      layers = null;
      ui?.closeLayers();
      invalidateVisual();
      syncForced(false);
      if (sel && sel.el.isConnected) {
        // the panel rebuilt its tree: open it to the selection again (its path differs between the two views)
        if (!hoverOnly) ui?.show(sel);
        post({ t: 'selected', info: infoFor(sel), path: pathOf(sel) });
      }
      return;
    case 'retarget':
      designId = m.designId;
      void setWorkingEdits(designId, edits);
      return;
    case 'stop':
      stopEditor();
      return;
    case 'select': {
      const s = fromId(m.id);
      if (s) select(s, true, !!m.add);
      return;
    }
    case 'selectSimilar':
      selectSimilar();
      return;
    case 'selectOnly':
      selectOnly();
      return;
    case 'clear':
      clearSelection();
      return;
    case 'selectUnder':
      selectUnder();
      return;
    case 'fakeHover':
      fakeHoverOn = m.on;
      if (m.on) {
        fakeAt = 0;
        tryFakeHover();
      } else clearFakeHover();
      return;
    case 'aiContext':
      post({ t: 'aiContext', ...aiContext(m.want) });
      return;
    case 'looks':
      setLooks(m.hover, m.focus);
      // measured again in that look (a hover overlay's colour as the site shows it on hover)
      if (sel) sendInfo();
      if (m.hover) {
        fakeAt = 0;
        tryFakeHover(); // one that only shows on hover and is away comes back
      }
      return;
    case 'delete':
      deleteSelection();
      return;
    case 'add':
      addNext(m.kind, m.position, m.css, m.text);
      return;
    case 'children':
      post({ t: 'children', id: m.id, ...childrenOf(m.id, m), view });
      return;
    case 'expanded':
      expanded = new Set(m.ids);
      return;
    case 'toggleHidden':
      toggleHidden(m.id);
      return;
    case 'setEdits':
      edits = m.edits;
      ui?.quiet(); // a change just made (a colour picked, a slider let go): seen without the outline for a moment
      void setWorkingEdits(designId, edits).then(() => {
        sendInfo();
        refreshRows(); // the tree's markers (a background just set) show what is on the page now
      });
      return;
    case 'preview':
      ui?.quiet(); // the outline steps back while a change is being made, so the change itself can be seen
      void setWorkingEdits(designId, m.edits).then(() => ui?.place());
      return;
    case 'state':
      showState(m.state);
      return;
    case 'moveMode':
      moveMode = m.mode === 'free' ? 'free' : 'layout';
      sendInfo();
      return;
    case 'moveStep':
      moveStep(m.dir);
      return;
    case 'unmove':
      unmove();
      return;
  }
}

// ------------------------------------------------------------------------------------------- clicks and keys

/** Everything that could make the page act on a click; while editing, the page never sees them. */
const BLOCKED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'submit', 'touchstart', 'touchend', 'dragstart'];

const isOurs = (e: Event) => !!ui && e.composedPath().includes(ui.host);

// ------------------------------------------------------------------------------------------- faking the hover

/**
 * A selection that only shows while pointed at (a hover card, a menu, a button's hover look) is shown as if pointed
 * at: the page's :hover rules also apply to elements marked with HOVER_ATTR (the way a browser's "force :hover"
 * works), and the page is sent the pointer events of entering it, so a script that builds it on hover builds it
 * again. On by default; the panel can turn it off.
 */
const HOVER_ATTR = 'data-ww-hover';
let fakeHoverOn = true;
let fakeAt = 0;
/** The element the hover is faked for (a new selection inside or around it keeps it). */
let fakeFor: Element | null = null;
let hoverSheet: HTMLStyleElement | null = null;

/** The page's :hover rules, written again for [data-ww-hover] (cross-origin sheets cannot be read and are skipped). */
function hoverRulesCss(): string {
  return pageRulesFor(':hover', (sel) => sel.replace(/:hover\b/g, `[${HOVER_ATTR}]`));
}
/** The page's :focus / :focus-visible / :focus-within rules, written again for the marked elements. */
function focusRulesCss(): string {
  return pageRulesFor(':focus', (sel) => sel.replace(/:focus-within\b/g, `[${FOCUS_WITHIN_ATTR}]`).replace(/:focus(?:-visible)?\b/g, `[${FOCUS_ATTR}]`));
}

/** The page's rules whose selector has `has`, with the selector rewritten (cross-origin sheets cannot be read). */
function pageRulesFor(has: string, rewrite: (selector: string) => string): string {
  const out: string[] = [];
  const walk = (rules: CSSRuleList, wrap: string) => {
    for (const r of rules) {
      if (out.length > 4000) return;
      if (r instanceof CSSStyleRule) {
        if (!r.selectorText.includes(has)) continue;
        const rule = `${rewrite(r.selectorText)}{${r.style.cssText}}`;
        out.push(wrap ? `${wrap}{${rule}}` : rule);
      } else if (r instanceof CSSMediaRule) walk(r.cssRules, `@media ${r.conditionText}`);
      else if (r instanceof CSSSupportsRule) walk(r.cssRules, `@supports ${r.conditionText}`);
      else if ('cssRules' in r) walk((r as CSSGroupingRule).cssRules, wrap);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules, '');
    } catch {
      /* another origin's stylesheet */
    }
  }
  return out.join('\n');
}

function clearFakeHover(): void {
  // the page was told the pointer came in (pointAt): it is told the pointer left, so a hover look its own script
  // keeps (YouTube's buttons) goes too, unless the pointer really is on it
  if (fakeFor?.isConnected && !fakeFor.matches(':hover')) {
    const r = fakeFor.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.top + Math.min(r.height / 2, 20), view: window, relatedTarget: null };
    fakeFor.dispatchEvent(new PointerEvent('pointerout', { ...at, bubbles: true }));
    fakeFor.dispatchEvent(new MouseEvent('mouseout', { ...at, bubbles: true }));
    for (let n: Element | null = fakeFor; n && n !== document.documentElement; n = n.parentElement) {
      n.dispatchEvent(new PointerEvent('pointerleave', at));
      n.dispatchEvent(new MouseEvent('mouseleave', at));
    }
  }
  for (const el of document.querySelectorAll(`[${HOVER_ATTR}]`)) el.removeAttribute(HOVER_ATTR);
  hoverSheet?.remove();
  hoverSheet = null;
  fakeFor = null;
}

// the Focus look, faked the same way: the page's focus rules also apply to marked elements, and it hears focus arrive
const FOCUS_ATTR = 'data-ww-focus';
const FOCUS_WITHIN_ATTR = 'data-ww-focus-within';
let fakeFocusOn = false;
let focusSheet: HTMLStyleElement | null = null;
function focusAt(el: Element): void {
  if (!focusSheet) {
    focusSheet = document.createElement('style');
    focusSheet.id = 'ww-fake-focus';
    focusSheet.textContent = focusRulesCss();
    document.documentElement.append(focusSheet);
  }
  el.setAttribute(FOCUS_ATTR, '');
  for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) n.setAttribute(FOCUS_WITHIN_ATTR, '');
  el.dispatchEvent(new FocusEvent('focus'));
  el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
}
function clearFakeFocus(): void {
  for (const el of document.querySelectorAll(`[${FOCUS_ATTR}],[${FOCUS_WITHIN_ATTR}]`)) {
    el.removeAttribute(FOCUS_ATTR);
    el.removeAttribute(FOCUS_WITHIN_ATTR);
  }
  focusSheet?.remove();
  focusSheet = null;
}

/**
 * What the page shows for the selection (the panel's Hover and Focus boxes): its hover and/or focus look, the site's
 * own (faked) and the ones made here (the state attribute), for as long as it is selected.
 */
function setLooks(hover: boolean, focus: boolean): void {
  fakeHoverOn = hover;
  fakeFocusOn = focus;
  for (const e of stateEls) e.removeAttribute(STATE_ATTR);
  stateEls = [];
  const el = sel && !sel.pseudo && sel.el.isConnected ? sel.el : null;
  const states = [hover ? 'hover' : '', focus ? 'focus' : ''].filter(Boolean).join(' ');
  // all like this, or several picked: each shows the look (the site's own effects by marking, as for the first; only
  // the first is sent pointer events, so the page's scripts see one element pointed at, as a person would)
  const others = extra.map((x) => x.el).filter((e) => e.isConnected && e !== sel?.el).slice(0, 200);
  if (sel && sel.el.isConnected && states) {
    // a button's wrapper (YouTube's yt-icon-button) holds its hover layer beside it: marked too, so the layer shows
    // and the same-size elements around it (YouTube's renderer that turns grey on hover): marked too
    const wrappers: Element[] = [];
    for (const e of [sel.el, ...others]) {
      const box = e.getBoundingClientRect();
      for (let p = e.parentElement, i = 0; p && p !== document.body && i < 3 && sameBox(p.getBoundingClientRect(), box); p = p.parentElement, i++) wrappers.push(p);
    }
    for (const e of [sel.el, ...others, ...wrappers]) e.setAttribute(STATE_ATTR, states);
    stateEls = [sel.el, ...others, ...wrappers];
  }
  if (!hover) clearFakeHover();
  if (!focus) clearFakeFocus();
  if (hover && el) {
    // marks left from what was selected before go (the sheet itself stays: it takes a while to make)
    for (const n of document.querySelectorAll(`[${HOVER_ATTR}]`)) n.removeAttribute(HOVER_ATTR);
    pointAt(el);
    for (const o of others) for (let n: Element | null = o; n && n !== document.documentElement && !n.hasAttribute(HOVER_ATTR); n = n.parentElement) n.setAttribute(HOVER_ATTR, '');
  }
  if (focus && el) {
    for (const n of document.querySelectorAll(`[${FOCUS_ATTR}]`)) n.removeAttribute(FOCUS_ATTR);
    focusAt(el);
    for (const o of others) o.setAttribute(FOCUS_ATTR, '');
  }
  ui?.place();
}

/** The page's :hover rules, ready to apply to marked elements (made once while faking is in use). */
function ensureHoverSheet(): void {
  if (hoverSheet) return;
  hoverSheet = document.createElement('style');
  hoverSheet.id = 'ww-fake-hover';
  hoverSheet.textContent = hoverRulesCss();
  document.documentElement.append(hoverSheet);
}

/**
 * The page as if the pointer were on `el` (the Hover look): its own :hover styles apply to it and everything around
 * it, and it hears the pointer entering, so a hover effect made by a script shows too.
 */
function pointAt(el: Element): void {
  ensureHoverSheet();
  const chain: Element[] = [];
  for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) chain.unshift(n);
  for (const n of chain) n.setAttribute(HOVER_ATTR, '');
  fakeFor = el;
  const r = el.getBoundingClientRect();
  const at = { clientX: r.left + r.width / 2, clientY: r.top + Math.min(r.height / 2, 20), view: window };
  for (const n of chain) {
    n.dispatchEvent(new PointerEvent('pointerenter', at));
    n.dispatchEvent(new MouseEvent('mouseenter', at));
  }
  el.dispatchEvent(new PointerEvent('pointerover', { ...at, bubbles: true }));
  el.dispatchEvent(new MouseEvent('mouseover', { ...at, bubbles: true }));
  el.dispatchEvent(new PointerEvent('pointermove', { ...at, bubbles: true }));
  el.dispatchEvent(new MouseEvent('mousemove', { ...at, bubbles: true }));
}

/** Shows the selection as if pointed at, if it is away (at most once a second while it stays away). */
function tryFakeHover(): void {
  if (!fakeHoverOn || !sel || sel.pseudo || !lastSeen) return;
  const now = Date.now();
  if (now - fakeAt < 1000) return;
  fakeAt = now;
  const x = lastSeen.x + lastSeen.w / 2 - scrollX;
  const y = lastSeen.y + Math.min(lastSeen.h / 2, 40) - scrollY;
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return;
  ensureHoverSheet();
  // the element itself when it is still on the page (hidden by CSS), else what is now where it was
  const start = sel.el.isConnected ? sel.el : document.elementFromPoint(x, y);
  const chain: Element[] = [];
  for (let n: Element | null = start; n && n !== document.documentElement; n = n.parentElement) chain.unshift(n);
  fakeFor = sel.el;
  for (const n of chain) n.setAttribute(HOVER_ATTR, '');
  const at = { clientX: x, clientY: y, view: window };
  for (const n of chain) {
    n.dispatchEvent(new PointerEvent('pointerenter', at));
    n.dispatchEvent(new MouseEvent('mouseenter', at));
  }
  // (nothing but the page where it was: only the pointer's path below can bring it back)
  const target = chain[chain.length - 1];
  if (target) {
    target.dispatchEvent(new PointerEvent('pointerover', { ...at, bubbles: true }));
    target.dispatchEvent(new MouseEvent('mouseover', { ...at, bubbles: true }));
    target.dispatchEvent(new PointerEvent('pointermove', { ...at, bubbles: true }));
    target.dispatchEvent(new MouseEvent('mousemove', { ...at, bubbles: true }));
  }
  // what opened it may be beside it (a menu under its button): the pointer passed over that just before it was picked
  for (const el of hoverTrail) {
    if (!el.isConnected || chain.includes(el)) continue;
    const r = el.getBoundingClientRect();
    const p = { clientX: r.left + r.width / 2, clientY: r.top + Math.min(r.height / 2, 20), view: window };
    el.setAttribute(HOVER_ATTR, '');
    el.dispatchEvent(new PointerEvent('pointerenter', p));
    el.dispatchEvent(new MouseEvent('mouseenter', p));
    el.dispatchEvent(new PointerEvent('pointerover', { ...p, bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseover', { ...p, bubbles: true }));
  }
}

/** What the pointer was over lately (newest last), and what it had passed over when the selection was picked. */
let recentHover: { el: Element; at: number }[] = [];
/** How far back the pointer's path counts (someone may read a hover card a while before picking it). */
const HOVER_TRAIL_MS = 10_000;
let hoverTrail: Element[] = [];
function noteHovered(path: EventTarget[]): void {
  const el = path.find((n): n is Element => n instanceof Element && n.getRootNode() === document && isEditable(n));
  if (!el || recentHover[recentHover.length - 1]?.el === el) return;
  const now = Date.now();
  recentHover = [...recentHover.filter((h) => now - h.at < HOVER_TRAIL_MS && h.el !== el), { el, at: now }].slice(-12);
}

/** The events that tell a page the mouse left something (hover previews, menus and tooltips close on them). */
const LEAVES = ['mouseout', 'mouseleave', 'pointerout', 'pointerleave'];

/**
 * While something is selected, the page is not told when the mouse leaves the window (to the side panel) or moves
 * onto our own toolbar, so a thing shown on hover (a video preview, a dropdown) stays up while it is being edited.
 * Moving to another part of the page still works as usual.
 */
function holdHover(e: Event): void {
  // only while its hover look is meant to stay (Show Hover, or a thing that only shows on hover): otherwise the page
  // hears the pointer leave, and its hover look goes as usual
  if (!sel || !ui || (!fakeHoverOn && !hoverOnly)) return;
  const to = (e as MouseEvent).relatedTarget as Node | null;
  if (to === null || to === ui.host || ui.host.contains(to)) e.stopImmediatePropagation();
}

function guard(e: Event): void {
  if (isOurs(e)) return;
  if (e.type !== 'contextmenu') e.preventDefault(); // the browser's own menu stays available
  e.stopImmediatePropagation();
  if (e.type === 'click' && (e as MouseEvent).button === 0) {
    const me = e as MouseEvent;
    const add = me.ctrlKey || me.metaKey || me.shiftKey;
    const stack = stackAt(me.clientX, me.clientY);
    // Visual elements: the frontmost thing that draws the spot clicked (looking through invisible overlays and
    // wrappers; a card's padding selects the card). All elements: the element itself as before, or the host of a
    // component whose insides are private (a shadow root).
    const hit = visualMode ? stack[0] : e.composedPath().find((n): n is Element => n instanceof Element && n.getRootNode() === document && isEditable(n));
    // a design's decoration drawn there (a ::before / ::after is no element of its own: the click went through it)
    const deco = decorationAt(me.clientX, me.clientY, hit ?? null);
    if (decorationWins(deco, hit)) {
      lastClick = null;
      if (add) return select(deco, false, true);
      ui?.closeLayers();
      layers = null;
      return select(deco, false, false);
    }
    if (!hit) return; // a blank spot (only the page itself): the selection stays as it is
    // a button's hover overlay shows while the pointer is on it, so a click lands on it: the button is meant (its
    // overlay has options there; Layers still lists the overlay itself)
    let el = overlayOwner(hit) ?? hit;
    if (el !== hit && !stack.includes(el)) stack.splice(stack.indexOf(hit) + 1, 0, el);
    if (add) {
      lastClick = null;
      return select({ el }, false, true);
    }
    // the same spot again: what the selection sits in (title, then its card, then the feed), back to the start at the top
    const again = lastClick && lastClick.hit === el && Math.abs(lastClick.x - me.clientX) <= 4 && Math.abs(lastClick.y - me.clientY) <= 4;
    lastClick = { x: me.clientX, y: me.clientY, hit: el };
    if (again && sel && !sel.pseudo && !extra.length && (sel.el === el || sel.el.contains(el))) {
      const up = sitsIn(sel.el);
      if (up) el = up;
      if (!stack.includes(el)) stack.push(el);
    }
    ui?.closeLayers();
    layers = stack.includes(el) ? stack : null;
    select({ el }, false, false, true);
  }
}

/**
 * The editable elements under a point, front to back, for page clicks and Layers: also ones that ignore the mouse
 * (pointer-events: none), never our own toolbar; in Visual elements only visual ones (never the page itself).
 */
function stackAt(x: number, y: number): Element[] {
  invalidateVisual(); // a click is a good moment for fresh answers (hover styles may have changed)
  const out: Element[] = [];
  for (const el of elementsAt(x, y)) {
    if (out.includes(el) || el === document.documentElement || !isEditable(el)) continue;
    if (ui && (el === ui.host || ui.host.contains(el))) continue;
    if (visualMode && !isVisual(el)) continue;
    out.push(el);
  }
  return out;
}

/**
 * Where a design's decoration (its ::before / ::after) is drawn, when it is placed by position (absolute or fixed, as
 * decorations are); null when that cannot be told.
 */
/**
 * Where a decoration that the layout places sits (no left/top of its own): a block one above the element's contents
 * (::before) or below them (::after); an inline one (a symbol, a word) just before the first or after the last line of
 * text, as wide as its content measures. Approximate, enough to pick it with a click.
 */
function flowRect(el: Element, pseudo: Pseudo, cs: CSSStyleDeclaration, w: number, h: number): DOMRect | null {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const hs = getComputedStyle(el);
  const px = (v: string) => parseFloat(v) || 0;
  const inner = { left: r.left + px(hs.borderLeftWidth) + px(hs.paddingLeft), top: r.top + px(hs.borderTopWidth) + px(hs.paddingTop), right: r.right - px(hs.borderRightWidth) - px(hs.paddingRight), bottom: r.bottom - px(hs.borderBottomWidth) - px(hs.paddingBottom) };
  const before = pseudo === '::before';
  if (!/^inline/.test(cs.display) || /flex|grid/.test(hs.display)) {
    // in a flex or grid layout it may sit anywhere (centred, reordered): not guessed, the tree lists it
    if (/flex|grid/.test(hs.display)) return null;
    // a block: its own size, at the start or end of the contents
    if (!(h > 0)) return null;
    const width = w > 0 ? w : inner.right - inner.left;
    const left = inner.left + px(cs.marginLeft);
    const top = before ? inner.top + px(cs.marginTop) : inner.bottom - px(cs.marginBottom) - h;
    return new DOMRect(left, top, width, h);
  }
  // inline: next to the contents' first (or last) line
  const range = document.createRange();
  range.selectNodeContents(el);
  const lines = [...range.getClientRects()].filter((x) => x.width > 0 || x.height > 0);
  const text = /^["'](.*)["']$/s.exec(cs.content)?.[1] ?? '';
  let width = w > 0 ? w : 0;
  if (!width && text) {
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx) {
      ctx.font = cs.font || `${cs.fontSize} ${cs.fontFamily}`;
      width = ctx.measureText(text).width + px(cs.paddingLeft) + px(cs.paddingRight);
    }
  }
  if (!(width > 0)) return null;
  const height = h > 0 ? h : px(cs.lineHeight) || px(cs.fontSize) * 1.2;
  if (!lines.length) return new DOMRect(before ? inner.left : inner.right - width, inner.top, width, height);
  const line = before ? lines[0] : lines[lines.length - 1];
  return new DOMRect(before ? line.left - width - px(cs.marginRight) : line.right + px(cs.marginLeft), line.top, width, Math.max(height, line.height));
}

function decorationRect(el: Element, pseudo: Pseudo): DOMRect | null {
  const cs = getComputedStyle(el, pseudo);
  if (cs.display === 'none' || cs.visibility === 'hidden' || !cs.content || cs.content === 'none') return null;
  const w = parseFloat(cs.width);
  const h = parseFloat(cs.height);
  if (cs.position !== 'fixed' && cs.position !== 'absolute') return flowRect(el, pseudo, cs, w, h);
  if (!(w > 0 && h > 0)) return null;
  // its containing block: the nearest element around it (itself included) that is positioned (absolute), or that
  // has a transform, filter or containment (both); else the window (fixed) or the page's first box (absolute)
  let cb: Element | null = null;
  for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
    const ns = getComputedStyle(n);
    const traps = (ns.transform && ns.transform !== 'none') || (ns.filter && ns.filter !== 'none') || (ns.perspective && ns.perspective !== 'none') || /paint|layout|strict|content/.test(ns.contain || '');
    if (traps || (cs.position === 'absolute' && ns.position !== 'static')) {
      cb = n;
      break;
    }
  }
  let box: { left: number; top: number; right: number; bottom: number };
  if (cb) {
    const r = cb.getBoundingClientRect();
    const hs = getComputedStyle(cb);
    // measured from inside the border
    box = { left: r.left + (parseFloat(hs.borderLeftWidth) || 0), top: r.top + (parseFloat(hs.borderTopWidth) || 0), right: r.right - (parseFloat(hs.borderRightWidth) || 0), bottom: r.bottom - (parseFloat(hs.borderBottomWidth) || 0) };
  } else if (cs.position === 'fixed') box = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  else box = { left: -scrollX, top: -scrollY, right: innerWidth - scrollX, bottom: innerHeight - scrollY };
  const n = (v: string) => (v === 'auto' || v === '' ? null : parseFloat(v));
  const l = n(cs.left);
  const t = n(cs.top);
  const rt = n(cs.right);
  const b = n(cs.bottom);
  const x = l !== null ? box.left + l : rt !== null ? box.right - rt - w : box.left;
  const y = t !== null ? box.top + t : b !== null ? box.bottom - b - h : box.top;
  return new DOMRect(x, y, w, h);
}

/**
 * The design decoration drawn at a point, on the element there or one it is inside (the innermost first), or null.
 * Decorations are not elements, so a click lands on what is under them; this finds them again.
 */
function decorationAt(x: number, y: number, from: Element | null): Sel | null {
  let n = from ?? document.elementFromPoint(x, y);
  // up to the page itself (html): a design may draw on it too
  for (let i = 0; n && i < 30; n = n.parentElement, i++) {
    if (!isEditable(n)) continue;
    for (const p of decorationsOf(n)) {
      const r = decorationRect(n, p);
      if (!r || x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      // a tint or texture over the whole element (or the whole window) would take every click there: the tree has it
      const host = n.getBoundingClientRect();
      const area = Math.max(1, Math.min(host.width * host.height, innerWidth * innerHeight));
      if ((r.width * r.height) / area >= 0.85) continue;
      return { el: n, pseudo: p };
    }
  }
  return null;
}
/** Is the decoration what a click there means? Yes over nothing else, or over the element drawing it (or one around it). */
const decorationWins = (d: Sel | null, hit: Element | undefined): d is Sel => !!d && (!hit || hit === d.el || hit.contains(d.el) || (d.el.contains(hit) && decorationOnTop(d, hit)));
/**
 * Is a decoration painted over this element inside the one drawing it? A placed ::before/::after with no negative
 * z-index paints over the element's ordinary contents; contents placed themselves with a higher z-index paint over it.
 */
function decorationOnTop(d: Sel, hit: Element): boolean {
  const z = getComputedStyle(d.el, d.pseudo).zIndex;
  const dz = z === 'auto' ? 0 : parseInt(z, 10) || 0;
  if (dz < 0) return false;
  for (let n: Element | null = hit; n && n !== d.el; n = n.parentElement) {
    const ns = getComputedStyle(n);
    if (ns.position === 'static') continue;
    const nz = ns.zIndex === 'auto' ? 0 : parseInt(ns.zIndex, 10) || 0;
    // placed too: a higher layer wins; on the same layer, the later one (::after comes after the contents) wins
    if (nz > dz || (nz === dz && d.pseudo === '::before')) return false;
  }
  return true;
}

/** The control an element is the hover overlay of (null: it is not one). */
function overlayOwner(el: Element): Element | null {
  // the control itself (a button), else the outermost box it covers (a hand cursor is inherited by its insides)
  let outermost: Element | null = null;
  let n = el.parentElement;
  for (let i = 0; n && n !== document.body && i < 5; n = n.parentElement, i++) {
    // a wrapper holding the button and, beside it, the layer (YouTube's icon buttons): the button is meant
    if (wrapsControl(n)) for (const c of n.children) if (isControl(c) && findOverlay(c)?.el === el) return c;
    if (!isPointable(n)) continue;
    const o = findOverlay(n);
    if (!o || o.pseudo || o.el !== el) continue;
    if (isControl(n)) return n;
    outermost = n;
  }
  return outermost;
}

// ------------------------------------------------------------------------------------------- hover hint

/**
 * While the pointer moves over the page, what a click there would select gets a dashed outline and its name, always:
 * the frontmost thing under the pointer, or (back on the spot just clicked) what the selection sits in, its card or row.
 */
let hintRaf = 0;
/** Show what a click would select while the pointer moves: a dashed outline (its name label is off: it covered the page). */
const HOVER_HINTS = true;
/** What the pointer was over (its event path is only readable while the event runs) and whether a button was down. */
let hintAt: { path: EventTarget[]; x: number; y: number; pressed: boolean; ours: boolean } | null = null;
function hideHint(): void {
  ui?.hint(null);
}
function onPointerMove(e: PointerEvent): void {
  hintAt = { path: e.composedPath(), x: e.clientX, y: e.clientY, pressed: e.buttons !== 0, ours: isOurs(e) };
  if (!hintAt.ours) noteHovered(hintAt.path);
  if (HOVER_HINTS && !hintRaf) hintRaf = requestAnimationFrame(showHint);
}
function showHint(): void {
  hintRaf = 0;
  const at = hintAt;
  if (!ui || !at) return;
  if (at.pressed || at.ours) return ui.hint(null);
  // the same choice as a click (a page click also looks through layers that ignore the mouse; close enough here)
  const hit = at.path.find((n): n is Element => n instanceof Element && n.getRootNode() === document && n !== document.documentElement && isEditable(n) && (!visualMode || isVisual(n)));
  const deco = decorationAt(at.x, at.y, hit ?? (at.path.find((n): n is Element => n instanceof Element && n.getRootNode() === document) ?? null));
  if (decorationWins(deco, hit)) {
    if (sel && sel.el === deco.el && sel.pseudo === deco.pseudo) return ui.hint(null);
    const r = decorationRect(deco.el, deco.pseudo!);
    return ui.hint(deco.el, '', r ? { rect: r, label: `Decoration · ${deco.pseudo === '::before' ? 'before' : 'after'} ${labelOf(deco.el).label}` } : undefined);
  }
  if (!hit) return ui.hint(null);
  let target = overlayOwner(hit) ?? hit;
  let again = false;
  if (lastClick && lastClick.hit === target && Math.abs(lastClick.x - at.x) <= 4 && Math.abs(lastClick.y - at.y) <= 4 && sel && !sel.pseudo && !extra.length && (sel.el === target || sel.el.contains(target))) {
    const up = sitsIn(sel.el);
    if (up) {
      target = up;
      again = true;
    }
  }
  if (target === sel?.el || target === document.body) return ui.hint(null);
  ui.hint(target, again ? 'Click again: ' : '');
}

/** What an element sits in, as the current view lists it (null: only the page). */
/**
 * Modify with Claude: what is around the selection, for the model (each element with a ref it can change, its size,
 * words and look), and the edit base behind each ref. "similar" (every element like it) and "page" are always there
 * to change; the rest only when asked for.
 */
function aiContext(want: AiContextKind[]): { text: string; refs: Record<string, EditBase> } {
  const refs: Record<string, EditBase> = {};
  const lines: string[] = [];
  if (!sel) return { text: '', refs };
  const el = sel.el;
  const LOOK = ['background-color', 'background-image', 'color', 'font-family', 'font-size', 'font-weight', 'border', 'border-radius', 'padding', 'margin', 'box-shadow', 'display', 'gap', 'opacity'];
  const quiet = /^(none|normal|auto|0px|rgba\(0, 0, 0, 0\)|0px none.*|medium none.*)$/;
  const describeEl = (n: Element, ref: string): string => {
    const cs = getComputedStyle(n);
    const r = n.getBoundingClientRect();
    const look = LOOK.map((p) => [p, cs.getPropertyValue(p)] as const).filter(([, v]) => v && !quiet.test(v)).map(([p, v]) => `${p}: ${v.slice(0, 80)}`).join('; ');
    const words = (n.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return `[${ref}] ${labelOf(n).label} <${n.tagName.toLowerCase()}> ${Math.round(r.width)}x${Math.round(r.height)}${words ? ` "${words}"` : ''}: ${look.slice(0, 500)}`;
  };
  const add = (n: Element) => {
    const b = baseFor({ el: n });
    if (!b.target?.selectors?.length) return; // cannot be found again after a reload: not offered
    const ref = 'e' + idOf(n);
    refs[ref] = b;
    lines.push(describeEl(n, ref));
  };
  const sim = sel.pseudo ? null : similarOf(el);
  if (sim && sim.count > 1) {
    const existing = edits.find((e) => e.target.all === sim.selector && !e.target.pseudo);
    refs.similar = { editId: existing?.id, target: existing?.target ?? { selectors: [], tag: el.tagName.toLowerCase(), all: sim.selector }, label: `${labelOf(el).label} (all like this)`.slice(0, 80), origin: originOf(el) };
  }
  refs.page = baseFor({ el: document.body });
  if (want.includes('parents')) {
    // the page's real surroundings (Smart view skips plain wrappers; for a description they are what "around it" means)
    const around: Element[] = [];
    for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement && around.length < 4; n = n.parentElement) if (isEditable(n)) around.push(n);
    lines.push(around.length ? 'What it sits in, nearest first:' : 'It sits right on the page.');
    for (const n of around) add(n);
  }
  if (want.includes('children')) {
    const kids = (visualMode ? visualChildren(el, isEditable) : [...el.children].filter(isEditable)).slice(0, 12);
    lines.push(kids.length ? 'What is inside it:' : 'Nothing is inside it.');
    for (const k of kids) add(k);
  }
  if (want.includes('siblings')) {
    const p = el.parentElement;
    const sibs = p ? [...p.children].filter((n) => isEditable(n) && n !== el && n.getClientRects().length > 0).slice(0, 8) : [];
    lines.push(sibs.length ? 'Next to it (in the same place):' : 'Nothing is next to it.');
    for (const s of sibs) add(s);
  }
  if (want.includes('similar')) {
    if (refs.similar && sim) {
      lines.push(`There are ${sim.count} elements like it (${sim.selector}). Target "similar" changes all of them at once, also ones that load later. Two of them:`);
      try {
        for (const n of [...document.querySelectorAll(sim.selector)].filter((n) => n !== el).slice(0, 2)) lines.push('  ' + describeEl(n, 'similar'));
      } catch {
        /* not a selector this page takes */
      }
    } else lines.push('Nothing else on the page is like it.');
  }
  if (want.includes('page')) {
    const html = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    const paints = (c: CSSStyleDeclaration) => c.backgroundImage !== 'none' || !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(c.backgroundColor);
    const bg = paints(body) ? body : html;
    const colour = paints(bg) ? bg.backgroundColor : 'white (the browser default; nothing sets one)';
    lines.push(`[page] The page itself: background ${colour}${bg.backgroundImage !== 'none' ? ' with a picture' : ''}; text ${body.color}; font ${body.fontFamily.slice(0, 80)}. Target "page" changes it (its background fills the whole window).`);
  }
  return { text: lines.join('\n').slice(0, 6000), refs };
}

/**
 * Where an element is, for its outline: its own box, or for one without a box of its own (display: contents, a
 * wrapper of zero size, common on YouTube) the area its contents cover. Without this its outline was a speck in the
 * page's corner, as if nothing were selected.
 */
function boxOf(el: Element): DOMRect {
  const r = el.getBoundingClientRect();
  if (r.width >= 1 && r.height >= 1) return r;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  let seen = 0;
  const walk = (n: Element, depth: number) => {
    for (const c of n.children) {
      if (seen > 300) return;
      seen++;
      const cr = c.getBoundingClientRect();
      if (cr.width >= 1 && cr.height >= 1) {
        left = Math.min(left, cr.left);
        top = Math.min(top, cr.top);
        right = Math.max(right, cr.right);
        bottom = Math.max(bottom, cr.bottom);
      } else if (depth < 6) walk(c, depth + 1);
    }
  };
  walk(el, 0);
  return left === Infinity ? r : new DOMRect(left, top, right - left, bottom - top);
}

function sitsIn(el: Element): Element | null {
  const up = (n: Element) => (visualMode ? visualParent(n) : n.parentElement);
  let n = up(el);
  while (n && n !== document.body && !isEditable(n)) n = up(n);
  return n && n !== document.body && n !== document.documentElement ? n : null;
}

/** The Layers list as it is now: candidates the page has removed since the click are skipped. */
function liveLayers(): Element[] {
  if (!layers) return [];
  layers = layers.filter((el) => el.isConnected && isEditable(el));
  return layers;
}

/** A row of the Layers list was picked: select it, keeping the list (and the page's scroll position). */
function pickLayer(el: Element): void {
  if (sel && sel.el === el && !sel.pseudo && !extra.length) return;
  select({ el }, false, false, true);
}

function onKeyUp(e: KeyboardEvent): void {
  if (!isOurs(e) || !ui) return;
  if (ui.layersKeyUp(e)) e.preventDefault();
  if (ui.inLayers(e)) e.stopImmediatePropagation(); // the page's own shortcuts never see keys typed in our list
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && ui?.cancelLayoutDrag()) {
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }
  if (isOurs(e)) {
    if (ui?.layersKey(e)) e.preventDefault();
    if (ui?.inLayers(e)) e.stopImmediatePropagation();
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') {
    if (sel) {
      // Esc clears the whole selection
      e.preventDefault();
      e.stopImmediatePropagation();
      clearSelection();
    }
    return;
  }
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.stopImmediatePropagation();
    post({ t: e.shiftKey ? 'redo' : 'undo' });
    return;
  }
  if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    e.stopImmediatePropagation();
    post({ t: 'redo' });
    return;
  }
  if (sel && !sel.el.isConnected) return;
  if (sel && (e.key === 'Delete' || e.key === 'Backspace') && !mod) {
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    deleteSelection();
    return;
  }
  if (sel && /^Arrow(Up|Down|Left|Right)$/.test(e.key) && e.altKey && !mod) {
    // Alt+arrows: one step in the layout (Alt+Shift+Left/Right: out of its box / into the box before it)
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) moveStep(e.key === 'ArrowLeft' ? 'out' : 'in');
    else moveStep(e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? 'earlier' : 'later');
    return;
  }
  if (sel && /^Arrow(Up|Down|Left|Right)$/.test(e.key) && !mod) {
    const info = infoFor(sel);
    if (!info.caps.move) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    commitEach((one) => {
      const [x, y] = currentTranslate(one);
      return { translate: `${x + dx}px ${y + dy}px` };
    }, 'Nudge');
  }
}

// ------------------------------------------------------------------------------------------- selection

const same = (a: Sel, b: Sel) => a.el === b.el && a.pseudo === b.pseudo;

/**
 * keepLayers: picked on the page or in the Layers list, which keeps the Layers list of that click. Anything else (the
 * tree, Select parent, adding to a multiselection) drops it.
 */
function select(s: Sel, fromPanel: boolean, add = false, keepLayers = false): void {
  ui?.hint(null); // the next pointer move shows what this one sits in
  // a hover faked for another element stops (one inside or around it keeps it, like a card's title)
  if (fakeFor && !(fakeFor.contains(s.el) || s.el.contains(fakeFor))) clearFakeHover();
  // what the pointer passed over just before this was picked (what opened it, if it only shows on hover)
  if (!add) {
    const now = Date.now();
    hoverTrail = recentHover.filter((h) => now - h.at < HOVER_TRAIL_MS && h.el !== s.el && !s.el.contains(h.el)).map((h) => h.el);
  }
  if (!keepLayers || add) {
    layers = null;
    ui?.closeLayers();
  }
  group = null;
  if (!add || !sel) {
    lastSeen = null;
    showsOnHover = false;
    setHoverOnly(false);
    showState('normal'); // the panel opens a new selection on its normal look
  }
  if (add && sel) {
    // Ctrl/Shift-click: add it, or take it out if it is already selected
    if (same(sel, s)) {
      if (!extra.length) return clearSelection();
      sel = extra.shift()!;
    } else if (extra.some((x) => same(x, s))) {
      extra = extra.filter((x) => !same(x, s));
    } else if (extra.length < MAX_SELECTED - 1) {
      extra.push(s);
    }
    selTarget = editOf(sel)?.target ?? buildTarget(sel.el, sel.pseudo);
    if (fromPanel && extra.some((x) => same(x, s))) bringIntoView(s.el);
    ui?.show(sel);
    post({ t: 'selected', info: infoFor(sel), path: pathOf(s) });
    return;
  }
  extra = [];
  sel = s;
  syncForced();
  selTarget = editOf(s)?.target ?? buildTarget(s.el, s.pseudo);
  if (fromPanel) bringIntoView(s.el);
  ui?.show(s);
  post({ t: 'selected', info: infoFor(s), path: pathOf(s) });
}

/**
 * Picked in the panel's tree: scroll the page so the element can be seen, unless it already fully is (or, when
 * taller than the window, its top is). A hidden element (no size) scrolls to the nearest shown element around it.
 */
function bringIntoView(el: Element): void {
  let target: Element | null = el;
  while (target && target !== document.body) {
    const b = target.getBoundingClientRect();
    if (b.width >= 1 || b.height >= 1) break;
    target = target.parentElement;
  }
  if (!target || target === document.body || target === document.documentElement) return;
  const r = target.getBoundingClientRect();
  const tall = r.height > innerHeight - 40;
  const seen = tall ? r.top >= 0 && r.top < innerHeight * 0.4 : r.top >= 0 && r.bottom <= innerHeight;
  const across = r.left >= 0 && r.right <= innerWidth;
  if (seen && across) return;
  const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ block: tall ? "start" : "center", inline: "nearest", behavior: smooth ? "smooth" : "auto" });
}

/** Every element like the main one (same tag and stable classes): one change for all of them. */
function selectSimilar(): void {
  if (!sel || sel.pseudo) return;
  const sim = similarOf(sel.el);
  if (!sim) return;
  let found: Element[] = [];
  try {
    found = [...document.querySelectorAll(sim.selector)].filter((e) => isEditable(e) && e.tagName === sel!.el.tagName);
  } catch {
    return;
  }
  extra = found.filter((e) => e !== sel!.el).slice(0, MAX_SELECTED - 1).map((el) => ({ el }));
  group = sim.selector;
  ui?.show(sel);
  post({ t: 'selected', info: infoFor(sel), path: pathOf(sel) });
}

function selectOnly(): void {
  extra = [];
  group = null;
  sendInfo();
}

/** The main element and every other selected one that is still on the page. */
function allSelected(): Sel[] {
  extra = extra.filter((x) => x.el.isConnected);
  return sel ? [sel, ...extra] : [];
}

function clearSelection(): void {
  clearFakeHover();
  showState('normal');
  extra = [];
  group = null;
  sel = null;
  selTarget = null;
  lastSeen = null;
  hoverOnly = false;
  layers = null;
  syncForced();
  ui?.hide();
  post({ t: 'cleared' });
}

/**
 * Visual elements: the selected element always has a row in the tree, also when it draws nothing itself (a wrapper
 * reached with Select parent) or has hidden itself (a hover preview). Tree levels that gain or lose such a row are
 * refreshed (notify: false when the panel rebuilds the whole tree anyway).
 */
function syncForced(notify = true): void {
  const next = visualMode && sel ? sel.el : null;
  const prev = forcedElement();
  if (prev === next) return;
  const levels = new Set<string>();
  const levelOf = (el: Element | null) => {
    if (!el || !el.isConnected || isVisual(el)) return; // a visual element has its row anyway
    const p = visualParent(el);
    if (p) levels.add(idOf(p));
  };
  levelOf(prev);
  setForced(next);
  levelOf(next);
  if (notify && levels.size) post({ t: 'treeChanged', ids: [...levels] });
}

/**
 * The tree rows of the selected elements (the list each is in) and of what is inside them (a see-through child shows
 * the colour behind it) are asked again, so their background markers follow a change.
 */
function refreshRows(): void {
  const ids = new Set<string>();
  const add = (el: Element | null) => {
    const id = el ? nodeIds.get(el) : undefined;
    if (id && expanded.has(String(id))) ids.add(String(id));
  };
  for (const s of allSelected()) {
    add(visualMode ? visualParent(s.el) : s.el.parentElement);
    add(s.el);
  }
  if (ids.size) post({ t: 'treeChanged', ids: [...ids] });
}

function sendInfo(): void {
  if (!sel) return;
  if (!sel.el.isConnected) return void reattach();
  if (hoverOnly) return; // the overlay shows it again when it comes back
  ui?.show(sel);
  post({ t: 'info', info: infoFor(sel) });
}

/** The selected element was replaced by the site (a re-render): find it again, or let go of it. */
function reattach(): void {
  if (!sel) return;
  const again = selTarget ? resolveTarget(selTarget) : [];
  if (again.length === 1) {
    sel = { el: again[0], pseudo: sel.pseudo };
    syncForced();
    hoverOnly = false; // the panel hears it from 'selected' below
    ui?.show(sel);
    post({ t: 'selected', info: infoFor(sel), path: pathOf(sel) });
  } else if (lastSeen) {
    // shown only on hover (or in a menu that closed): keep it selected; it is found again when it comes back
    setHoverOnly(true);
  } else {
    sel = null;
    layers = null;
    syncForced();
    ui?.hide();
    post({ t: 'gone' });
  }
}

function setHoverOnly(on: boolean): void {
  if (on) showsOnHover = true; // remembered for this selection, also once it is back (the panel's tag stays put)
  if (hoverOnly === on) return;
  hoverOnly = on;
  post({ t: 'hoverOnly', on });
}
/** The selection turned out to show only while pointed at (until another element is picked). */
let showsOnHover = false;

/** Selects what is on the page where the hover-only element was (usually what people meant: the card under a preview). */
function selectUnder(): void {
  if (!lastSeen || !sel) return;
  const away = sel.el;
  const seen = lastSeen;
  const point = () => [seen.x + seen.w / 2 - scrollX, seen.y + Math.min(seen.h / 2, 40) - scrollY];
  let [x, y] = point();
  if (y < 0 || y > innerHeight || x < 0 || x > innerWidth) {
    scrollTo({ top: seen.y + seen.h / 2 - innerHeight / 2, left: scrollX, behavior: 'instant' as ScrollBehavior });
    [x, y] = point();
  }
  // the same rules as a click (Visual elements: the frontmost visual thing there), minus the element that went away
  const under = stackAt(x, y).find((el) => el !== away && !away.contains(el) && el !== document.body);
  if (under) select({ el: under }, true);
  else post({ t: 'notice', text: 'Nothing else is under it. Hover it on the page and click what you want instead.' });
}

/** Ids from <body> down to the element (and its decoration), for the panel to open the tree to it. */
function pathOf(s: Sel): string[] {
  // the page's own decorations (on html) are listed with the page's (body) in the tree
  if (s.el === document.documentElement) return document.body ? [idOf(document.body), ...(s.pseudo ? [idOf(s.el) + s.pseudo] : [])] : [];
  const chain: string[] = [];
  // Visual elements: only the levels that tree shows (the wrappers in between are skipped, as in its lists)
  for (let n: Element | null = s.el; n && n !== document.documentElement; n = n.parentElement) {
    if (!visualMode || n === s.el || n === document.body || inVisualTree(n)) chain.unshift(idOf(n));
  }
  if (s.pseudo) chain.push(idOf(s.el) + s.pseudo);
  return chain;
}

/** The edit (of the design being edited) for this element, if any. */
function editOf(s: Sel): VisualEdit | undefined {
  const marks = (s.el.getAttribute(EDIT_ATTR) ?? '').split(' ').filter(Boolean);
  const mine = edits.filter((e) => marks.includes(e.id) && e.target.pseudo === s.pseudo);
  return mine.find((e) => !e.target.all) ?? mine[0];
}

const PROPS = [
  'width', 'height', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'color', 'background-color', 'background-image', 'opacity', 'border-top-width', 'border-top-style', 'border-top-color', 'border-top-left-radius', 'box-shadow',
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-decoration-line', 'text-transform',
  'display', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'gap', 'grid-template-columns', 'overflow', 'position', 'z-index',
  'object-fit', 'object-position', 'aspect-ratio', 'translate', 'scale', 'rotate', 'visibility', 'box-sizing',
  'float', 'vertical-align', 'filter', 'list-style-type', 'accent-color', 'caret-color', 'text-decoration-color', '-webkit-text-fill-color', 'border-image-source',
];

const slotsOf = (e: VisualEdit | undefined): Partial<Record<Slot, Record<string, string>>> => {
  const out: Partial<Record<Slot, Record<string, string>>> = {};
  if (e) for (const k of SLOTS) if (e[k]) out[k] = e[k];
  return out;
};

/**
 * A part (icon, hover overlay) of the selected element, with the edit its changes go to. When the element's changes
 * apply to every element like it (Select similar, or "Apply to all like this"), so do its parts' changes.
 */
/** Does it show words other than its icon (an icon font's ligature, such as "home", is the icon, not words)? */
function wordsBesides(el: Element, icon: Element): boolean {
  if (icon === el || icon.contains(el)) return false;
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(), i = 0; n && i < 400; n = walk.nextNode(), i++) {
    if (!/\S/.test((n as Text).data) || icon.contains(n)) continue;
    const p = n.parentElement;
    if (p && p.getClientRects().length && getComputedStyle(p).visibility !== 'hidden') return true;
  }
  return false;
}

/** A site's SVG icon as a mask picture, worked out once per icon (it is sent with every selection). */
const svgMasks = new WeakMap<Element, string | null>();
function svgMaskOf(el: Element): string | null {
  if (!svgMasks.has(el)) svgMasks.set(el, svgAsMask(el));
  return svgMasks.get(el) ?? null;
}

/**
 * A layer that ignores the pointer (pointer-events: none, as overlays are) is never pointed at itself: its hover look
 * follows the element it sits in that people point at (how many levels up is kept with the edit).
 */
function withHoverOwner(t: EditTarget, el: Element, pseudo?: string): EditTarget {
  if (pseudo || t.hoverUp || getComputedStyle(el).pointerEvents !== 'none') return t;
  let up = 0;
  for (let n = el.parentElement; n && n !== document.body && up < 5; n = n.parentElement) {
    up++;
    if (isPointable(n) || wrapsControl(n)) return { ...t, hoverUp: up };
  }
  return t;
}

function partInfo(role: 'icon' | 'overlay', p: Sel, mainEdit: VisualEdit | undefined, iconType?: IconType): PartInfo {
  const cs = getComputedStyle(p.el, p.pseudo);
  const tag = p.el.tagName.toLowerCase();
  const label = role === 'icon' ? `Icon · ${labelOf(sel!.el).label}`.slice(0, 80) : `Hover overlay · ${labelOf(sel!.el).label}`.slice(0, 80);
  const hostAll = group ?? mainEdit?.target.all ?? null;
  let base: EditBase | null = null;
  if (hostAll) {
    let all: string | null = null;
    if (p.el === sel!.el) all = hostAll;
    else {
      const sim = similarOf(p.el);
      const own = sim && !sim.selector.includes('>') ? sim.selector : null;
      all = own ? `${hostAll} ${own}` : tag === 'svg' ? `${hostAll} svg` : null;
    }
    if (all) {
      const existing = edits.find((e) => e.target.all === all && e.target.pseudo === p.pseudo);
      base = { editId: existing?.id, target: existing?.target ?? { selectors: [], tag, all, ...(p.pseudo ? { pseudo: p.pseudo } : {}) }, label: `${label} (all like this)`.slice(0, 80), origin: originOf(sel!.el) };
    }
  }
  if (!base) {
    const b = baseFor(p);
    base = { ...b, label: b.editId ? b.label : label, origin: originOf(sel!.el) };
  }
  // an overlay inside what it covers, or beside it in the same wrapper (YouTube's icon buttons): its hover look follows
  // the element holding both being pointed at (counted up to the first one that holds the selection)
  if (role === 'overlay' && p.el !== sel!.el) {
    let up = 0;
    for (let n: Element | null = p.el; n && !n.contains(sel!.el) && up <= 5; n = n.parentElement) up++;
    if (up >= 1 && up <= 5) base = { ...base, target: { ...base.target, hoverUp: up } };
  }
  const pe = base.editId ? edits.find((e) => e.id === base!.editId) : undefined;
  const computed: Record<string, string> = {};
  for (const prop of ['color', 'fill', 'stroke', 'width', 'height', 'font-size', 'background-color', 'opacity', 'border-top-left-radius', 'top', 'left', 'filter']) computed[prop] = cs.getPropertyValue(prop);
  return {
    role,
    id: idOf(p.el) + (p.pseudo ?? ''),
    label,
    base,
    editCss: pe?.css ?? {},
    editSlots: slotsOf(pe),
    computed,
    ...(iconType ? { iconType } : {}),
    ...(iconType === 'svg' ? { paint: svgPaint(p.el) } : {}),
    ...(iconType === 'svg' && svgMaskOf(p.el) ? { svgMask: svgMaskOf(p.el)! } : {}),
    // (pointed at by the person, or shown as pointed at by Edit Mode)
    ...(role === 'overlay' && !p.pseudo && stateLookOf(p.el) ? { stateLook: stateLookOf(p.el)! } : {}),
    ...(role === 'overlay' && (sel!.el.matches(':hover') || sel!.el.hasAttribute(HOVER_ATTR)) ? { hovered: true } : {}),
  };
}

/** Where the element is laid out, and whether it can be moved in the layout. */
function moveInfo(s: Sel, edit: VisualEdit | undefined, many: number): SelectionInfo['move'] {
  const page = /^(html|body)$/i.test(s.el.tagName);
  return {
    mode: moveMode,
    canLayout: !page && !s.pseudo && many <= 1 && !group && !(s.el instanceof SVGElement && s.el.ownerSVGElement),
    moved: !!edit?.move,
    parent: layoutOf(s.el.parentElement),
    ...(edit?.move && moveGaveUp(edit.id) ? { gaveUp: true } : {}),
  };
}

function infoFor(s: Sel): SelectionInfo {
  const { el, pseudo } = s;
  const cs = getComputedStyle(el, pseudo);
  const base = pseudo ? { kind: 'decoration' as const, label: `Decoration · ${pseudo === '::before' ? 'before' : 'after'} ${labelOf(el).label}`.slice(0, 60), detail: '' } : labelOf(el);
  const computed: Record<string, string> = {};
  // the page: its background is often painted by <html> (a design's, or the site's) while <body> has none, so the
  // Background options show what is seen, not "none"
  const paintsBg = (c: CSSStyleDeclaration) => c.backgroundImage !== 'none' || !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(c.backgroundColor);
  const pageBg = !pseudo && el === document.body && !paintsBg(cs) ? getComputedStyle(document.documentElement) : null;
  for (const p of PROPS) {
    const v = (pageBg && p.startsWith('background') ? pageBg : cs).getPropertyValue(p);
    computed[p] = p === 'background-image' && v.length > 200 ? v.slice(0, 200) + '…' : v;
  }
  const groupEdit = group ? edits.find((e) => e.target.all === group && !e.target.pseudo) : undefined;
  const edit = group ? groupEdit : editOf(s);
  const many = allSelected();
  const leaf = pseudo || many.length > 1 ? null : leafText(el);
  const r = el.getBoundingClientRect();
  const tag = el.tagName.toLowerCase();
  const page = tag === 'html' || tag === 'body';
  const parents: string[] = [];
  for (let p = el.parentElement, i = 0; p && p !== document.body && i < 3; p = p.parentElement, i++) {
    const pr = p.getBoundingClientRect();
    parents.push(`${labelOf(p).label} ${Math.round(pr.width)}x${Math.round(pr.height)}`);
  }
  const childCount = el.children.length;
  // the breadcrumb: everything it sits in, as the tree lists it, up to the page (a deep page is capped, far beyond
  // what a person would follow, so a broken page cannot make it endless)
  const crumbs: { id: string; label: string }[] = [];
  if (!page && many.length <= 1) for (let n = sitsIn(el), i = 0; n && i < 40; n = sitsIn(n), i++) crumbs.unshift({ id: idOf(n), label: labelOf(n).label });
  const repeated = !pseudo && !page && r.width >= 24 && r.height >= 16 ? repeatCount(el) : 0;
  // its words' width (a heading's box is often far wider than its text: a text gradient should span the words)
  let textWidth = 0;
  if (!pseudo && !page && many.length <= 1 && /\S/.test(el.textContent ?? '')) {
    const rg = document.createRange();
    rg.selectNodeContents(el);
    textWidth = Math.round(rg.getBoundingClientRect().width);
  }
  // its looks besides normal, and its parts
  const states: SelectionInfo['states'] = [];
  // also anything the site's own rules change when pointed at, pressed or focused (a hover background, an overlay layer)
  const effects = !page && !pseudo ? stateEffectsOf(el) : { hover: false, focus: false };
  if (!page && (pseudo || isPointable(el) || effects.hover || ['button', 'link', 'image', 'field'].includes(base.kind))) states.push('hover');
  if (!page && !pseudo && (isControl(el) || effects.focus || (!!el.querySelector('input:not([type=hidden]),textarea,select') && r.height <= 160))) states.push('focus');
  const parts: SelectionInfo['parts'] = {};
  let words: boolean | undefined;
  if (!pseudo && !page && (many.length <= 1 || group)) {
    const icon = findIcon(el);
    if (icon) parts.icon = partInfo('icon', { el: icon.el }, edit, icon.type);
    if (icon) words = wordsBesides(el, icon.el);
    const overlay = icon && icon.el === el ? null : findOverlay(el);
    if (overlay) parts.overlay = { ...partInfo('overlay', overlay, edit), ...(overlay.around ? { around: true } : {}) };
  }
  computed['placeholder-color'] = /^(INPUT|TEXTAREA)$/.test(el.tagName) ? getComputedStyle(el, '::placeholder').color : '';
  const html = pseudo
    ? `${openingTag(el)}\n  ${pseudo} (a decoration drawn by the design's CSS)\n</${tag}>`
    : `${openingTag(el)}${leaf ? leaf.data.trim().slice(0, 120) : childCount ? `\n  … ${childCount} element${childCount === 1 ? '' : 's'} inside …\n` : ''}</${tag}>`;
  return {
    id: idOf(el) + (pseudo ?? ''),
    kind: base.kind,
    label: base.label,
    tag,
    origin: pseudo ? 'webloom' : originOf(el),
    ...(pseudo ? { pseudo } : {}),
    target: withHoverOwner(edit?.target ?? buildTarget(el, pseudo), el, pseudo),
    ...(edit ? { editId: edit.id, editCss: edit.css, editText: edit.text, editAll: edit.target.all } : { editCss: {} }),
    editSlots: slotsOf(edit),
    states,
    parts,
    ...(words !== undefined ? { words } : {}),
    move: moveInfo(s, edit, many.length),
    computed,
    box: { w: Math.round(r.width), h: Math.round(r.height) },
    html,
    themeRules: themeRulesFor(el, pseudo),
    text: leaf ? leaf.data : null,
    caps: {
      resize: !page && !pseudo && cs.display !== 'inline' && cs.display !== 'contents',
      move: !page,
      text: !!leaf,
      image: !pseudo && tag === 'img',
      hide: !page,
      // one element at a time; on the page itself only inside it
      add: !pseudo && many.length <= 1,
    },
    ...(el.hasAttribute(ADD_ATTR) ? { added: true } : {}),
    similar: pseudo ? null : similarOf(el),
    parents,
    crumbs,
    ...(repeated >= 2 ? { repeated } : {}),
    ...(textWidth > 0 && textWidth < r.width * 0.85 ? { textWidth } : {}),
    ...(showsOnHover ? { showsOnHover: true } : {}),
    ...(many.length > 1 ? { multi: { count: many.length, ...(group ? { group } : {}), ids: many.map((x) => idOf(x.el) + (x.pseudo ?? '')), bases: bases() } } : {}),
  };
}

// ------------------------------------------------------------------------------------------- changes from the page

/** What a change is written to: one group edit (Select similar), or each selected element's own edit. */
function bases(): EditBase[] {
  if (!sel) return [];
  if (group) {
    const existing = edits.find((e) => e.target.all === group && !e.target.pseudo);
    return [{ editId: existing?.id, target: existing?.target ?? { selectors: [], tag: sel.el.tagName.toLowerCase(), all: group }, label: `${labelOf(sel.el).label} (all like this)`.slice(0, 80), origin: originOf(sel.el) }];
  }
  return allSelected().map(baseFor);
}

/** The same change for every selected element, or (each) one worked out per element, e.g. a nudge from where it is. */
function applyEach(fn: (s: Sel) => Record<string, string | null>): VisualEdit[] | null {
  if (!sel) return null;
  if (group) return upsertEdit(edits, bases()[0], fn(sel)).edits;
  const all = allSelected();
  if (!all.every((x) => canKeep(x, true))) return null;
  let next = edits;
  for (const one of all) next = upsertEdit(next, baseFor(one), fn(one)).edits;
  return next;
}

/** Applies a change to the selection locally (no history entry): used while dragging or sliding. */
/** The toolbar's sliders and colour fields: the outline steps back while they change it (the toolbar itself stays). */
function previewPatch(patch: Record<string, string | null>): void {
  ui?.quiet(true);
  previewEach(() => patch);
}
function previewEach(fn: (s: Sel) => Record<string, string | null>): void {
  const next = applyEach(fn);
  if (next) void setWorkingEdits(designId, next).then(() => ui?.place());
}

/** Applies a change to the selection and hands it to the panel as one undo step. */
function commitPatch(patch: Record<string, string | null>, label: string): void {
  commitEach(() => patch, label);
}
function commitEach(fn: (s: Sel) => Record<string, string | null>, label: string): void {
  if (!sel) return;
  if (!group && !allSelected().every((x) => canKeep(x, x !== sel))) {
    if (sel && canKeep(sel)) post({ t: 'notice', text: 'Some of the selected elements cannot be found again reliably after a reload, so the change was not made. Try Select similar instead.' });
    return;
  }
  const next = applyEach(fn);
  if (next) commit(next, allSelected().length > 1 ? `${label} (${allSelected().length})` : label);
}

/** An element that cannot be found again after a reload cannot keep an edit: say so instead of losing it silently. */
function canKeep(s: Sel, quiet = false): boolean {
  const t = baseFor(s).target;
  if (t.selectors.length || t.all) return true;
  if (!quiet) post({ t: 'notice', text: 'This element cannot be found again reliably after a reload, so it cannot keep an edit. Try the element around it.' });
  return false;
}

/** Delete: elements added by hand are removed; the site's own (and a design's) are taken out of the layout. */
function deleteSelection(): void {
  if (!sel) return;
  const all = group ? [sel] : allSelected();
  const page = (x: Sel) => /^(html|body)$/i.test(x.el.tagName);
  if (all.some(page)) return;
  let next = edits;
  const keep: Sel[] = [];
  for (const one of all) {
    const id = one.pseudo ? null : one.el.getAttribute(ADD_ATTR);
    if (id && next.some((e) => e.id === id)) next = removeAdded(next, id);
    else keep.push(one);
  }
  if (keep.length) {
    if (!group && !keep.every((x) => canKeep(x, x !== sel))) return;
    if (group) next = upsertEdit(next, bases()[0], { display: 'none' }).edits;
    else for (const one of keep) next = upsertEdit(next, baseFor(one), { display: 'none' }).edits;
  }
  const n = all.length;
  clearSelection();
  commit(next, n > 1 ? `Delete (${n})` : 'Delete');
}

/** Adds a new element before, after or inside the selected one, then selects it. */
function addNext(kind: InsertKind, position: InsertPosition, css?: Record<string, string>, text?: string): void {
  if (!sel || sel.pseudo || /^(html|body)$/i.test(sel.el.tagName) && position !== 'inside') return;
  if (!canKeep(sel)) return;
  const anchor = baseFor(sel).target;
  // it starts out in the page's look (a button like the buttons near it, theme included); given styles go on top
  const near = position === 'inside' ? sel.el : (sel.el.parentElement ?? sel.el);
  const look = { ...pageLookFor(kind, near), ...(css ?? {}) };
  const { edits: next, editId } = addElement(edits, anchor, kind, position, look, text);
  edits = next;
  void setWorkingEdits(designId, next).then(() => {
    post({ t: 'commit', edits: next, label: `Add ${kind}` });
    const el = document.querySelector(`[${ADD_ATTR}="${editId}"]`);
    if (el) select({ el }, true, false);
    else sendInfo();
  });
}

// ------------------------------------------------------------------------------------------- moving in the layout

/** Containers whose children must be of certain kinds (a table row holds cells): only those can be dropped in. */
function fitsIn(container: Element | null, el: Element): boolean {
  if (!container) return false;
  const c = container.tagName;
  const t = el.tagName;
  if (/^(TABLE|THEAD|TBODY|TFOOT)$/.test(c)) return /^(TR|THEAD|TBODY|TFOOT|CAPTION|COLGROUP)$/.test(t);
  if (c === 'TR') return /^(TD|TH)$/.test(t);
  if (/^(TD|TH|TR)$/.test(t)) return /^(TR|TBODY|THEAD|TFOOT|TABLE)$/.test(c);
  if (/^(SELECT|DATALIST|OPTGROUP)$/.test(c)) return false;
  return c !== 'HTML' && canHold(container);
}

export interface Drop {
  anchor: Element;
  position: MovePosition;
  /** It can be kept there (the spot can be found again after a reload, and the element fits in it). */
  ok: boolean;
  /** It is already there. */
  same: boolean;
  why?: string;
}

const containerOf = (anchor: Element, position: MovePosition) => (position === 'first' || position === 'last' ? anchor : anchor.parentElement);

function isAt(el: Element, anchor: Element, position: MovePosition): boolean {
  const sib = (n: Element | null, dir: 'previousElementSibling' | 'nextElementSibling') => n?.[dir] ?? null;
  if (position === 'before') return sib(anchor, 'previousElementSibling') === el;
  if (position === 'after') return sib(anchor, 'nextElementSibling') === el;
  if (position === 'first') return anchor.firstElementChild === el;
  return anchor.lastElementChild === el;
}

function describeDrop(el: Element, anchor: Element, position: MovePosition): Drop {
  const base = { anchor, position, same: isAt(el, anchor, position) };
  if (anchor === el || el.contains(anchor)) return { ...base, ok: false, why: 'Not inside itself' };
  if (!fitsIn(containerOf(anchor, position), el)) return { ...base, ok: false, why: 'It does not fit there' };
  let findable = keepCache.get(anchor);
  if (findable === undefined) {
    findable = anchor.hasAttribute(ADD_ATTR) || withHome(() => buildTarget(anchor)).selectors.length > 0;
    keepCache.set(anchor, findable);
  }
  if (!findable) return { ...base, ok: false, why: 'That spot cannot be found again after a reload' };
  return { ...base, ok: true };
}
/** Whether a drop spot can be found again, per drag (working it out moves nothing, but queries the page). */
const keepCache = new Map<Element, boolean>();
export const resetDropCache = (): void => keepCache.clear();

/** Where a dragged element would land if dropped at this point (null: nowhere sensible). */
export function dropAt(x: number, y: number, dragged: Element): Drop | null {
  const outer = (el: Element) => (el instanceof SVGElement && el.ownerSVGElement ? (() => { let s = el.ownerSVGElement!; while (s.ownerSVGElement) s = s.ownerSVGElement; return s; })() : el);
  const stack: Element[] = [];
  for (const raw of elementsAt(x, y)) {
    const el = outer(raw);
    if (stack.includes(el) || el === document.documentElement || !isEditable(el)) continue;
    if (ui && (el === ui.host || ui.host.contains(el))) continue;
    if (el === dragged || dragged.contains(el)) continue;
    stack.push(el);
  }
  // the frontmost element that counts in this view (Visual elements: things that draw, and boxes holding them)
  const t = stack.find((el) => el === document.body || !visualMode || isVisual(el) || inVisualTree(el));
  if (!t) return null;
  const r = t.getBoundingClientRect();
  const dr = dragged.getBoundingClientRect();
  // over a box's own empty area (between or around its children): next to the child nearest the pointer, or into it
  const roomy = canHold(t) && (t === document.body || (r.width > Math.min(dr.width, 400) * 1.15 && r.height > Math.min(dr.height, 200) * 1.15 && r.height > 32));
  const ex = Math.min(20, r.width * 0.2);
  const ey = Math.min(14, r.height * 0.2);
  const inner = roomy && (t === document.body || (x > r.left + ex && x < r.right - ex && y > r.top + ey && y < r.bottom - ey));
  if (inner) {
    const kids = [...t.children].filter((c) => c !== dragged && isEditable(c) && !(ui && c === ui.host) && c.getClientRects().length > 0);
    if (!kids.length) return describeDrop(dragged, t, 'last');
    let best = kids[0];
    let bestD = Infinity;
    for (const k of kids) {
      const kr = k.getBoundingClientRect();
      const dx = Math.max(kr.left - x, 0, x - kr.right);
      const dy = Math.max(kr.top - y, 0, y - kr.bottom);
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    const kr = best.getBoundingClientRect();
    const before = inRow(best) ? x < kr.left + kr.width / 2 : y < kr.top + kr.height / 2;
    return describeDrop(dragged, best, before ? 'before' : 'after');
  }
  if (t === document.body) return null;
  const before = inRow(t) ? x < r.left + r.width / 2 : y < r.top + r.height / 2;
  return describeDrop(dragged, t, before ? 'before' : 'after');
}

/**
 * Runs fn with the selected element back where it was before it was moved (where it is on a fresh load), so selectors
 * built in fn describe the page as the next visit will find it. Synchronous: nothing is painted in between.
 */
function withHome<T>(fn: () => T): T {
  const el = sel?.el;
  const id = el?.getAttribute(MOVE_ATTR);
  const home = id ? movedHome(id) : null;
  if (!el || !home || !home.parent.isConnected) return fn();
  const now = { parent: el.parentNode!, next: el.nextSibling };
  const next = home.next && home.next.parentNode === home.parent ? home.next : null;
  home.parent.insertBefore(el, next);
  try {
    return fn();
  } finally {
    if (now.parent.isConnected) now.parent.insertBefore(el, now.next && now.next.parentNode === now.parent ? now.next : null);
  }
}

/** Moves the selected element in the layout (the element itself), as one undo step. */
function moveTo(anchor: Element, position: MovePosition, label = 'Move'): void {
  if (!sel || sel.pseudo || allSelected().length > 1 || group) return;
  const el = sel.el;
  keepCache.clear();
  const drop = describeDrop(el, anchor, position);
  if (!drop.ok) return void post({ t: 'notice', text: drop.why === 'That spot cannot be found again after a reload' ? 'That spot cannot be found again after a reload, so the move could not be kept. Try placing it next to something else.' : `It cannot go there: ${drop.why?.toLowerCase()}.` });
  if (drop.same) return;
  const addedId = el.getAttribute(ADD_ATTR);
  const added = addedId ? edits.find((e) => e.id === addedId && e.insert) : undefined;
  if (added) {
    // an element added by hand is placed by its own anchor: that changes instead
    let a = anchor;
    let pos: InsertPosition;
    if (position === 'first') {
      const first = [...anchor.children].find((c) => c !== el);
      if (first) {
        a = first;
        pos = 'before';
      } else pos = 'inside';
    } else pos = position === 'last' ? 'inside' : position;
    const t = buildTarget(a);
    if (!t.selectors.length) return void post({ t: 'notice', text: 'That spot cannot be found again after a reload, so the move could not be kept.' });
    const target: EditTarget = { selectors: t.selectors, tag: t.tag, ...(t.text ? { text: t.text } : {}), ...(t.hint ? { hint: t.hint } : {}) };
    commit(edits.map((e) => (e.id === added.id ? { ...e, target, insert: { kind: added.insert!.kind, position: pos }, updatedAt: Date.now() } : e)), label);
    return;
  }
  if (!canKeep(sel)) return;
  const to = withHome(() => buildTarget(anchor));
  const t: EditTarget = { selectors: to.selectors, tag: to.tag, ...(to.text ? { text: to.text } : {}), ...(to.hint ? { hint: to.hint } : {}) };
  const base = baseFor(sel);
  const offset: Record<string, string | null> = editOf(sel)?.css.translate ? { translate: null } : {}; // a place in the layout replaces a free offset
  commit(upsertEdit(edits, base, offset, { move: { to: t, position } }).edits, label);
}

/** The element's neighbours that are on the page (not hidden, not ours). */
function shownSibling(el: Element, dir: 'previousElementSibling' | 'nextElementSibling'): Element | null {
  for (let n = el[dir]; n; n = n[dir]) if (isEditable(n) && !(ui && n === ui.host) && n.getClientRects().length > 0) return n;
  return null;
}

function moveStep(dir: MoveStep): void {
  if (!sel || sel.pseudo) return;
  const el = sel.el;
  const say = (text: string) => post({ t: 'notice', text });
  if (allSelected().length > 1 || group) return say('Select one element to move it in the layout.');
  if (dir === 'earlier' || dir === 'later') {
    const n = shownSibling(el, dir === 'earlier' ? 'previousElementSibling' : 'nextElementSibling');
    if (!n) return say(dir === 'earlier' ? 'It is already first in its box. Use “Out of this box” to move it further.' : 'It is already last in its box. Use “Out of this box” to move it further.');
    return moveTo(n, dir === 'earlier' ? 'before' : 'after', dir === 'earlier' ? 'Move earlier' : 'Move later');
  }
  if (dir === 'out') {
    const p = el.parentElement;
    if (!p || p === document.body || p === document.documentElement) return say('It is not inside a box it can move out of.');
    return moveTo(p, 'after', 'Move out of its box');
  }
  const prev = shownSibling(el, 'previousElementSibling');
  if (!prev || !canHold(prev)) return say('There is no box just before it to move it into.');
  moveTo(prev, 'last', 'Move into the box before');
}

/** Puts a moved element back where it was. */
function unmove(): void {
  if (!sel) return;
  const e = editOf(sel);
  if (!e?.move) return;
  commit(upsertEdit(edits, baseFor(sel), {}, { move: null }).edits, 'Put back');
}

/** Does a change made here hide it? */
function hiddenByUs(s: Sel): boolean {
  const c = editOf(s)?.css;
  return c?.visibility === 'hidden' || c?.display === 'none';
}

/** The tree's eye: hides it (its space stays; a design's decoration goes entirely), or shows it again. */
function toggleHidden(id: string): void {
  const s = fromId(id);
  if (!s || !canKeep(s)) return;
  const own = hiddenByUs(s);
  const patch: Record<string, string | null> = own ? { visibility: null, display: null } : s.pseudo || originOf(s.el) === 'webloom' ? { display: 'none' } : { visibility: 'hidden' };
  const label = `${own ? 'Show' : 'Hide'} ${s.pseudo ? 'decoration' : labelOf(s.el).label}`.slice(0, 80);
  const next = upsertEdit(edits, baseFor(s), patch).edits;
  edits = next;
  void setWorkingEdits(designId, next).then(() => {
    post({ t: 'commit', edits: next, label });
    sendInfo();
    // its row (in the list it is in) shows the eye closed or open
    const p = s.pseudo ? s.el : visualMode ? visualParent(s.el) : s.el.parentElement;
    if (p) post({ t: 'treeChanged', ids: [idOf(p)] });
    refreshRows();
  });
}

function commit(next: VisualEdit[], label: string): void {
  edits = next;
  // send THIS change's list (a later change may replace `edits` before pictures finish loading)
  void setWorkingEdits(designId, next).then(() => {
    post({ t: 'commit', edits: next, label });
    sendInfo();
  });
}

function baseFor(s: Sel) {
  const e = editOf(s);
  return { editId: e?.id, target: e?.target ?? (sel && same(s, sel) ? selTarget : null) ?? buildTarget(s.el, s.pseudo), label: s.pseudo ? 'Decoration' : labelOf(s.el).label, origin: s.pseudo ? ('webloom' as const) : originOf(s.el) };
}

function currentTranslate(s: Sel): [number, number] {
  const v = getComputedStyle(s.el, s.pseudo).translate;
  if (!v || v === 'none') return [0, 0];
  const [x, y] = v.split(/\s+/).map((n) => parseFloat(n) || 0);
  return [x ?? 0, y ?? 0];
}

// ------------------------------------------------------------------------------------------- the tree


function nodeFor(el: Element): TreeNode {
  const { kind, label, detail } = labelOf(el);
  const cs = getComputedStyle(el);
  const kids = (visualMode ? hasVisualChild(el, isEditable) : [...el.children].some(isEditable)) || decorationsOf(el).length > 0 || (el === document.body && decorationsOf(document.documentElement).length > 0);
  // hidden: by its own style, or not shown at all right now (inside something hidden, like a hover preview that closed)
  const hidden = cs.display === 'none' || cs.visibility === 'hidden' || (visualMode && el !== document.body && el.getClientRects().length === 0);
  return {
    id: idOf(el),
    kind,
    label,
    detail,
    origin: originOf(el),
    hasChildren: kids,
    ...(hidden ? { hidden: true } : {}),
    ...(hidden && hiddenByUs({ el }) ? { hiddenByYou: true } : {}),
    ...(el.hasAttribute(EDIT_ATTR) ? { edited: true } : {}),
    ...(visualMode && !hidden && el !== document.body && !isVisual(el) ? { layout: true } : {}),
    ...withText(bgOf(el, cs), kind, cs),
  };
}

/** Text (a paragraph, a heading, a link): the swatch shows its text colour, on its background colour if it has one. */
function withText(b: Pick<TreeNode, 'bg'>, kind: TreeNode['kind'], cs: CSSStyleDeclaration): Pick<TreeNode, 'bg'> {
  if (kind !== 'text' && kind !== 'heading' && kind !== 'link') return b;
  // the "A" in the text colour, on its own background colour (none: on the "none" checkerboard)
  const on = b.bg?.color && !b.bg.color.includes('gradient') ? b.bg.color : undefined;
  return { bg: { ...(on ? { color: on } : {}), text: cs.color } };
}

/** What an element's background is, for the tree's swatch: a video, a picture, a gradient or a colour (none: clear). */
function bgOf(el: Element, cs: CSSStyleDeclaration): Pick<TreeNode, 'bg'> {
  if (el.tagName === 'VIDEO' || (el.tagName === 'IFRAME' && /youtube|vimeo|player|video/i.test(el.getAttribute('src') ?? ''))) return { bg: { video: true } };
  const img = cs.backgroundImage;
  if (img && img !== 'none') {
    if (/url\(/i.test(img)) return { bg: { image: true } };
    // a gradient, as itself (only the gradient: nothing else of the page's value is passed on)
    const g = /^(?:repeating-)?(?:linear|radial|conic)-gradient\([^;{}]*\)$/.exec(img.trim())?.[0];
    if (g && g.length <= 400) return { bg: { color: g } };
  }
  // any colour of its own is shown as that colour (the panel shows how strong it is)
  if (alphaOf(cs.backgroundColor) > 0) return { bg: { color: cs.backgroundColor } };
  // none of its own: a card that shows a picture or a video (its thumbnail) says so; anything else is see-through
  if (!/^(IMG|PICTURE|SVG|CANVAS|INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.children.length) {
    const media = el.querySelector('video, iframe[src*="youtube" i], iframe[src*="vimeo" i], img, picture, canvas');
    const m = media?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    // only when the picture is a good part of it (a card), not for a whole section that happens to hold pictures
    if (media && m && m.width >= 16 && m.width * m.height * 4 >= r.width * r.height) return { bg: { inner: /^(VIDEO|IFRAME)$/.test(media.tagName) ? 'video' : 'image' } };
  }
  return { bg: { transparent: true } };
}


function childrenOf(id: string, want: { start?: number; end?: number; reveal?: string } = {}): { nodes: TreeNode[]; start: number; end: number; total: number } {
  if (id === 'root') return { nodes: document.body ? [nodeFor(document.body)] : [], start: 0, end: 1, total: 1 };
  const s = fromId(id);
  if (!s || s.pseudo) return { nodes: [], start: 0, end: 0, total: 0 };
  // Visual elements: the nearest visual descendants (wrappers in between skipped); All elements: the real children
  const kids = visualMode ? visualChildren(s.el, isEditable) : [...s.el.children].filter(isEditable);
  const shown = want.reveal ? fromId(want.reveal) : null;
  const { start, end } = childRange(kids.length, want, shown && !shown.pseudo ? kids.indexOf(shown.el) : -1);
  const nodes: TreeNode[] = [];
  // The element's own decorations (::before / ::after) are always listed, whichever part of a long child list is
  // loaded: one picked on the page must have a row to show and scroll to, even inside a window far down the list.
  // the page's (html) decorations are listed with the page's (body): html has no row of its own
  const owners = s.el === document.body ? [document.documentElement, s.el] : [s.el];
  for (const o of owners) {
    for (const p of decorationsOf(o)) {
      const where = o === document.documentElement ? ' (page)' : '';
      nodes.push({ id: idOf(o) + p, kind: 'decoration', label: `Decoration · ${p === '::before' ? 'before' : 'after'}${where}`, detail: p, origin: 'webloom', hasChildren: false, ...(getComputedStyle(o, p).display === 'none' ? { hidden: true, ...(hiddenByUs({ el: o, pseudo: p }) ? { hiddenByYou: true } : {}) } : {}), ...(edits.some((e) => e.target.pseudo === p && (o.getAttribute(EDIT_ATTR) ?? '').includes(e.id)) ? { edited: true } : {}) });
    }
  }
  for (const k of kids.slice(start, end)) nodes.push(nodeFor(k));
  return { nodes, start, end, total: kids.length };
}

/** Elements whose children changed since the last tree refresh (looked at in the timer, not in the observer). */
let changed = new Set<Element>();
/** Visual elements: elements whose class or style changed (only a change in what they show refreshes the tree). */
let restyled = new Set<Element>();
let selGone = false;
/** A design's CSS (or what it inserts) changed: the whole tree and the selection's values are asked again. */
let designChanged = false;
const isDesignStyle = (n: Node) => n instanceof Element && n.tagName === 'STYLE' && n.hasAttribute('data-whimsyweb');
let changeTimer: number | undefined;
function onMutations(records: MutationRecord[]): void {
  for (const r of records) {
    const t = r.target as Element;
    if (!(t instanceof Element) || t.tagName === 'WW-EDITOR' || (t as HTMLElement).id === 'ww-edits-style') continue;
    if (isDesignStyle(t) || [...r.addedNodes, ...r.removedNodes].some(isDesignStyle)) designChanged = true;
    if (r.type === 'childList') changed.add(t);
    else if (visualMode) restyled.add(t);
  }
  if (sel && !sel.el.isConnected) selGone = true;
  if ((!changed.size && !restyled.size && !selGone && !designChanged) || changeTimer !== undefined) return;
  changeTimer = window.setTimeout(() => {
    changeTimer = undefined;
    const targets = [...changed];
    const styled = [...restyled];
    const gone = selGone;
    const redesigned = designChanged;
    changed = new Set();
    restyled = new Set();
    selGone = false;
    designChanged = false;
    if (targets.length || styled.length || redesigned) invalidateVisual(); // what is visible, and where, may have changed
    const ids = new Set<string>();
    // the list a row of this element is in (Visual elements: the nearest element the tree shows, wrappers skipped)
    const levelOf = (from: Element | null) => {
      let n = from;
      if (visualMode) while (n && n !== document.body && n.isConnected && !inVisualTree(n)) n = n.parentElement;
      const id = n ? nodeIds.get(n) : undefined;
      if (id && expanded.has(String(id))) ids.add(String(id));
    };
    // First which elements really changed what they show (before the walks below ask again and record the new answers):
    // a style change that shows or hides nothing (a progress bar moving) refreshes nothing.
    const flipped = visualMode ? [...new Set([...targets, ...styled])].filter((t) => t.isConnected && visualStateChanged(t)) : [];
    for (const t of targets) levelOf(t); // its own list (or, for a wrapper, the list its children show in)
    for (const t of flipped) {
      levelOf(t.parentElement); // its row appears in, or leaves, the list above it
      levelOf(t); // and what shows inside it changed
    }
    // a new design (a chat's change, another one switched on): every open list, and the selection's values
    if (redesigned) for (const id of expanded) ids.add(id);
    if (ids.size) post({ t: 'treeChanged', ids: [...ids] });
    if (gone) reattach();
    else if (redesigned && sel) sendInfo();
  }, 400);
}

// ------------------------------------------------------------------------------------------- the overlay

const ICONS: Record<string, string> = {
  parent: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  hide: '<path d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.1A9.8 9.8 0 0112 5c5 0 9 5 9 7a11 11 0 01-2.4 3.3M6.6 6.6C4.5 8 3 10.2 3 12c0 2 4 7 9 7a9.6 9.6 0 004.2-1"/>',
  reset: '<path d="M3 12a9 9 0 109-9 9.7 9.7 0 00-6.7 2.8L3 8M3 3v5h5"/>',
  more: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  bold: '<path d="M7 5h6a3.5 3.5 0 010 7H7zM7 12h7a3.5 3.5 0 010 7H7z"/>',
  align: '<path d="M4 6h16M7 12h10M4 18h16"/>',
  smaller: '<path d="M4 18l4-10 4 10M5.5 14h5M15 12h6"/>',
  bigger: '<path d="M4 18l4-10 4 10M5.5 14h5M15 12h6M18 9v6"/>',
  fit: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 15l3-3 2 2 3-4 2 3"/>',
  corners: '<path d="M4 10V8a4 4 0 014-4h2M14 4h2a4 4 0 014 4v2M20 14v2a4 4 0 01-4 4h-2M10 20H8a4 4 0 01-4-4v-2"/>',
  opacity: '<path d="M12 3s6 6.5 6 11a6 6 0 01-12 0c0-4.5 6-11 6-11z"/>',
  front: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 012-2h10"/>',
  back: '<rect x="4" y="4" width="12" height="12" rx="2"/><path d="M20 8v10a2 2 0 01-2 2H8"/>',
  padMinus: '<path d="M4 4l5 5M9 5v4H5M20 4l-5 5M15 5v4h4M4 20l5-5M5 15h4v4M20 20l-5-5M19 15h-4v4"/>',
  padPlus: '<path d="M9 9 4 4M4 8V4h4M15 9l5-5M16 4h4v4M9 15l-5 5M4 16v4h4M15 15l5 5M20 16v4h-4"/>',
  similar: '<circle cx="6" cy="12" r="2.5"/><circle cx="12" cy="12" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M3 18h18"/>',
  single: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  flow: '<rect x="4" y="4" width="16" height="5" rx="1.5"/><rect x="4" y="15" width="16" height="5" rx="1.5"/><path d="M2 12h20" stroke-dasharray="2 2.5"/>',
  free: '<rect x="4" y="4" width="10" height="10" rx="1.5" stroke-dasharray="2.5 2"/><rect x="10" y="10" width="10" height="10" rx="1.5"/>',
};
const svg = (name: string) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ''}</svg>`;

const STYLE = `
:host { all: initial; }
.box, .chip, .h, .bar, .hint { transition: opacity .18s ease; }
:host(.quiet) .box { opacity: .14; }
:host(.quiet) .chip, :host(.quiet) .h, :host(.quiet) .hint { opacity: 0; }
:host(.quiet:not(.keep-bar)) .bar { opacity: 0; pointer-events: none; }
.box { position: fixed; pointer-events: none; box-sizing: border-box; border: 2px solid var(--c); border-radius: 3px; box-shadow: 0 0 0 1px rgba(255,255,255,.85), 0 0 0 4px color-mix(in srgb, var(--c) 22%, transparent); display: none; }
.box.hidden-el { border-style: dashed; }
/* a selection only shown on hover, now away: nothing is drawn where it was (it covered the page; off for now) */
/* a selection that is away (shown only on hover): its dashed outline stays where it was; its label is off */
.box.away { border-style: dashed; box-shadow: 0 0 0 1px rgba(255,255,255,.7); opacity: .85; }
.chip.away { display: none !important; }
.box.more { border-style: dashed; box-shadow: 0 0 0 1px rgba(255,255,255,.7); }
.bar .count { padding: 0 6px; font: 600 12px/1 'Figtree', system-ui, sans-serif; color: #7a5ea8; white-space: nowrap; }
.chip { position: fixed; pointer-events: none; display: none; align-items: center; gap: 5px; max-width: 260px; padding: 3px 8px; border-radius: 999px; background: var(--c); color: #fff; font: 600 11.5px/1.3 'Figtree', system-ui, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 2px 6px rgba(40,30,60,.25); }
.h { position: fixed; width: 10px; height: 10px; margin: -5px 0 0 -5px; box-sizing: border-box; border: 2px solid var(--c); background: #fffdfb; border-radius: 3px; pointer-events: auto; display: none; touch-action: none; }
.h[data-h=n], .h[data-h=s] { cursor: ns-resize; } .h[data-h=e], .h[data-h=w] { cursor: ew-resize; }
.h[data-h=nw], .h[data-h=se] { cursor: nwse-resize; } .h[data-h=ne], .h[data-h=sw] { cursor: nesw-resize; }
.bar { position: fixed; display: none; align-items: center; gap: 2px; padding: 4px; border-radius: 12px; background: #fffaf6; border: 1px solid #e7ddd3; box-shadow: 0 6px 22px rgba(60,40,80,.18); pointer-events: auto; font: 500 13px/1 'Figtree', system-ui, sans-serif; color: #2b2631; }
.bar button { all: unset; display: inline-flex; align-items: center; justify-content: center; min-width: 30px; height: 30px; padding: 0 4px; box-sizing: border-box; border-radius: 8px; cursor: pointer; color: #2b2631; font: 700 12px/1 'Figtree', system-ui, sans-serif; }
.bar button:hover { background: #f0eaf8; color: #7a5ea8; }
.bar button:focus-visible { outline: 2px solid #cdbfe6; }
.bar button[disabled] { opacity: .35; cursor: default; background: none; }
.bar button.grip { cursor: grab; } .bar button.grip:active { cursor: grabbing; }
.bar .sep { width: 1px; height: 20px; background: #e7ddd3; margin: 0 3px; }
.bar input[type=color] { all: unset; width: 26px; height: 26px; border-radius: 7px; cursor: pointer; box-sizing: border-box; border: 1px solid #e7ddd3; margin: 0 2px; }
.bar input[type=color]::-webkit-color-swatch-wrapper { padding: 2px; } .bar input[type=color]::-webkit-color-swatch { border: none; border-radius: 5px; }
.pop { display: none; align-items: center; gap: 6px; padding: 0 6px; }
.pop.open { display: inline-flex; }
.pop input[type=range] { width: 90px; accent-color: #7a5ea8; }
.who { padding: 0 6px 0 4px; font-size: 11px; color: #6c6475; white-space: nowrap; }
.bar button.layers-btn { gap: 5px; padding: 0 8px; color: #7a5ea8; white-space: nowrap; }
.bar button.layers-btn[aria-expanded=true] { background: #ece4f7; }
.layers { position: fixed; display: none; flex-direction: column; width: 280px; max-width: calc(100vw - 12px); max-height: min(340px, calc(100vh - 12px)); box-sizing: border-box; padding: 6px; border-radius: 12px; background: #fffaf6; border: 1px solid #e7ddd3; box-shadow: 0 10px 30px rgba(60,40,80,.22); pointer-events: auto; font: 500 13px/1.3 'Figtree', system-ui, sans-serif; color: #2b2631; }
.layers.open { display: flex; }
.layers .head { padding: 4px 6px 6px; font-size: 11px; font-weight: 700; color: #6c6475; letter-spacing: .02em; }
.layers .rows { overflow-y: auto; display: flex; flex-direction: column; gap: 1px; min-height: 0; }
.layers button.row { all: unset; display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; cursor: pointer; box-sizing: border-box; }
.layers button.row:hover { background: #f4eefa; }
.layers button.row:focus-visible { outline: 2px solid #b9a6dd; outline-offset: -2px; background: #f4eefa; }
.layers button.row[aria-selected=true] { background: #ece4f7; color: #5b4386; font-weight: 700; }
.layers .n { flex: none; width: 16px; font-size: 11px; color: #9a90a3; text-align: right; }
.layers button.row[aria-selected=true] .n { color: #7a5ea8; }
.layers .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.layers .detail { flex: none; max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 500; color: #9a90a3; }
.layers .foot { padding: 7px 6px 2px; margin-top: 4px; border-top: 1px solid #efe6dc; font-size: 11px; color: #6c6475; }
.layers kbd { font: 600 10.5px/1 'Figtree', system-ui, sans-serif; padding: 2px 5px; border: 1px solid #e0d6cc; border-bottom-width: 2px; border-radius: 4px; background: #fff; color: #2b2631; }
.ghost { position: fixed; pointer-events: none; box-sizing: border-box; border: 2px solid var(--c); border-radius: 6px; background: color-mix(in srgb, var(--c) 14%, transparent); box-shadow: 0 8px 24px rgba(40,30,60,.25); display: none; opacity: .85; }
.drop { position: fixed; pointer-events: none; display: none; background: #2f9e6e; border-radius: 3px; box-shadow: 0 0 0 2px rgba(255,255,255,.9); }
.drop.bad { background: #c2410c; }
.drop::before, .drop::after { content: ''; position: absolute; width: 8px; height: 8px; border-radius: 50%; background: inherit; box-shadow: 0 0 0 2px rgba(255,255,255,.9); }
.drop.h::before { left: -4px; top: -2.5px; } .drop.h::after { right: -4px; top: -2.5px; }
.drop.v::before { top: -4px; left: -2.5px; } .drop.v::after { bottom: -4px; left: -2.5px; }
.dropbox { position: fixed; pointer-events: none; display: none; box-sizing: border-box; border: 2px dashed #2f9e6e; border-radius: 6px; background: rgba(47,158,110,.07); }
.dropchip { position: fixed; pointer-events: none; display: none; max-width: 300px; padding: 4px 9px; border-radius: 999px; background: #2f9e6e; color: #fff; font: 600 11.5px/1.3 'Figtree', system-ui, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 2px 8px rgba(40,30,60,.25); }
.dropchip.bad { background: #c2410c; }
.bar button.mode { gap: 4px; padding: 0 7px; font-weight: 600; color: #6c6475; }
.hint { position: fixed; pointer-events: none; display: none; box-sizing: border-box; border: 2px dashed rgba(122,94,168,.9); border-radius: 4px; box-shadow: 0 0 0 1px rgba(255,255,255,.7); }
.hint span { position: absolute; left: -1.5px; bottom: 100%; margin-bottom: 2px; max-width: 220px; padding: 1px 6px; border-radius: 6px; background: rgba(255,250,246,.92); color: #7a5ea8; font: 600 10.5px/1.5 'Figtree', system-ui, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hint.below span { bottom: auto; top: 100%; margin: 2px 0 0; }
.hint.again span { left: auto; right: -1.5px; } /* the selection's own name sits top left */
.peek { position: fixed; pointer-events: none; box-sizing: border-box; border: 2px dashed #2b2631; border-radius: 3px; background: rgba(122,94,168,.10); box-shadow: 0 0 0 1px rgba(255,255,255,.85); display: none; }
`;

class Overlay {
  host: HTMLElement;
  private root: ShadowRoot;
  private box: HTMLElement;
  private chip: HTMLElement;
  private handles: HTMLElement[] = [];
  private bar: HTMLElement;
  private raf = 0;
  /** Bumped by every show() and hide(); a loop from an older one stops. */
  private loopGen = 0;
  private drag: { kind: 'move' | 'resize'; h?: string; x: number; y: number; w: number; hgt: number; tx: number; ty: number; ratio: number; pad: [number, number] } | null = null;
  private dragFn: ((one: Sel) => Record<string, string | null>) | null = null;
  /** Where each selected element was offset when the drag started. */
  private starts = new Map<Element, [number, number]>();
  private shown: Sel | null = null;
  /** Dashed outlines for the other selected elements (reused, only drawn when on screen). */
  private others: HTMLElement[] = [];
  /** The Layers list (opened from the toolbar's "Layers · 1 of 4"), and the outline previewing a hovered or focused row. */
  private layersEl: HTMLElement;
  private layersOpen = false;
  private peek: HTMLElement;
  private peekEl: Element | null = null;
  /** Shift went down in the list and nothing else happened since: its release selects the next layer. */
  private shiftAlone = false;
  /** Moving in the layout: a see-through copy of the outline follows the pointer, a line shows where it would land. */
  private ghost!: HTMLElement;
  private dropLine!: HTMLElement;
  private dropBox!: HTMLElement;
  private dropChip!: HTMLElement;
  private layoutDrag: { drop: Drop | null; started: boolean; cancelled: boolean } | null = null;
  private hintEl!: HTMLElement;
  private hintFor: Element | null = null;
  private hintPrefix = '';

  constructor() {
    this.host = document.createElement('ww-editor');
    this.host.setAttribute('data-ww', 'editor');
    this.host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;';
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    this.box = document.createElement('div');
    this.box.className = 'box';
    this.chip = document.createElement('div');
    this.chip.className = 'chip';
    this.bar = document.createElement('div');
    this.bar.className = 'bar';
    this.bar.setAttribute('role', 'toolbar');
    this.peek = document.createElement('div');
    this.peek.className = 'peek';
    this.layersEl = document.createElement('div');
    this.layersEl.className = 'layers';
    this.layersEl.setAttribute('role', 'dialog');
    this.layersEl.setAttribute('aria-label', 'Layers under the spot you clicked');
    this.layersEl.addEventListener('pointerdown', () => (this.shiftAlone = false));
    for (const [k, cls] of [['ghost', 'ghost'], ['dropLine', 'drop'], ['dropBox', 'dropbox'], ['dropChip', 'dropchip']] as const) {
      const d = document.createElement('div');
      d.className = cls;
      this[k] = d;
    }
    this.hintEl = document.createElement('div');
    this.hintEl.className = 'hint';
    this.hintEl.append(document.createElement('span'));
    this.root.append(style, this.hintEl, this.peek, this.box, this.chip, this.bar, this.layersEl, this.dropBox, this.ghost, this.dropLine, this.dropChip);
    for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const d = document.createElement('div');
      d.className = 'h';
      d.dataset.h = h;
      d.addEventListener('pointerdown', (e) => this.startDrag(e, 'resize', h));
      this.root.append(d);
      this.handles.push(d);
    }
    (document.body ?? document.documentElement).append(this.host);
    const style2 = document.createElement('style');
    style2.id = 'ww-editor-cursor';
    // the weakest rule on the page (a cascade layer): where the site sets its own cursor (a hand on links, buttons,
    // clickable cards) it shows and can be read as it is; everywhere else, the crosshair. Overriding every cursor meant
    // switching this off to read the site's, which re-styled the whole page twice each time (slow on big pages)
    style2.textContent = '@layer ww-editing-cursor { html.ww-editing, html.ww-editing * { cursor: crosshair; } }';
    document.documentElement.append(style2);
  }

  /**
   * A change is being made: the outline, its name and the handles fade almost away, so the change itself can be seen
   * (a thin border, a shadow, a colour at the edge); they come back a moment after the last change. keepBar: the change
   * comes from the toolbar's own slider or colour field, which stays.
   */
  private quietTimer = 0;
  quiet(keepBar = false): void {
    this.host.classList.add('quiet');
    this.host.classList.toggle('keep-bar', keepBar);
    window.clearTimeout(this.quietTimer);
    this.quietTimer = window.setTimeout(() => this.host.classList.remove('quiet', 'keep-bar'), 900);
  }

  /** The dashed outline on what a click would select (null: none). */
  hint(el: Element | null, prefix = '', at?: { rect: DOMRect; label: string }): void {
    if (!el) {
      this.hintFor = null;
      this.hintEl.style.display = 'none';
      return;
    }
    const r = at?.rect ?? el.getBoundingClientRect();
    Object.assign(this.hintEl.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    this.hintEl.classList.toggle('below', r.top < 22);
    this.hintEl.classList.toggle('again', !!prefix || r.left + 230 > innerWidth); // right-aligned: by the selection's name, or near the edge
    // only the dashed outline: the name label covered what people wanted to see
    (this.hintEl.firstElementChild as HTMLElement).style.display = 'none';
    const label = at?.label ?? labelOf(el).label;
    if (this.hintFor !== el || this.hintPrefix !== prefix + label) {
      this.hintFor = el;
      this.hintPrefix = prefix + label;
      this.hintEl.firstElementChild!.textContent = `${prefix}${label}`;
    }
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.loopGen++;
    this.host.remove();
    document.getElementById('ww-editor-cursor')?.remove();
  }

  show(s: Sel): void {
    this.away = false;
    this.box.classList.remove('away');
    this.chip.classList.remove('away');
    const info = infoFor(s);
    const color = info.origin === 'webloom' ? WW_COLOR : SITE_COLOR;
    this.host.style.setProperty('--c', color);
    this.box.style.setProperty('--c', color);
    for (const el of [this.chip, ...this.handles]) el.style.setProperty('--c', color);
    this.chip.textContent = `${info.origin === 'webloom' ? '✦ ' : ''}${info.multi ? `${info.multi.count} selected · ` : ''}${info.label}`;
    this.chip.title = info.origin === 'webloom' ? 'Created by Whimsy Web' : 'Part of the website';
    this.box.classList.toggle('hidden-el', info.computed.visibility === 'hidden' || info.computed.display === 'none' || info.box.w === 0);
    for (const h of this.handles) h.style.display = info.caps.resize ? 'block' : 'none';
    this.buildBar(s, info);
    this.shown = s;
    this.box.style.display = 'block';
    this.chip.style.display = 'inline-flex';
    this.bar.style.display = 'flex';
    // the Layers list stays open while its rows are picked (each pick rebuilds the toolbar): mark the new selection
    if (this.layersOpen) {
      if (liveLayers().length > 1 && this.currentLayer() >= 0) this.renderLayers();
      else this.closeLayers();
    }
    cancelAnimationFrame(this.raf);
    // One loop at a time: place() can call show() again (a hover-only element came back), which starts a new loop;
    // the old one sees the newer generation and stops instead of scheduling another frame.
    const gen = ++this.loopGen;
    const loop = () => {
      this.place();
      if (gen === this.loopGen) this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  /**
   * A selected element that was on screen and is now hidden or gone (shown only on hover): a dashed outline stays
   * where it was, without the toolbar. Returns whether it is away. When it shows again, everything comes back.
   */
  private away = false;
  private placeAway(s: Sel): boolean {
    const r = s.el.isConnected ? boxOf(s.el) : null;
    const cs = r ? getComputedStyle(s.el, s.pseudo) : null;
    // there (it has its box), even if see-through right now: a layer that shows on hover, picked in the tree, is
    // outlined where it is; only one that went away (removed, not displayed, no size) is drawn where it was
    const visible = !!r && !!cs && r.width >= 1 && r.height >= 1 && cs.display !== 'none';
    if (visible) {
      lastSeen = { x: r!.left + scrollX, y: r!.top + scrollY, w: r!.width, h: r!.height };
      if (this.away) {
        setHoverOnly(false);
        sendInfo(); // the toolbar and handles come back, and the panel gets fresh details
        return true;
      }
      return false;
    }
    if (!lastSeen) return false; // never seen (picked in the tree while hidden): drawn as before
    tryFakeHover(); // shown as if pointed at (when that is on): it may come straight back
    if (!this.away) {
      this.away = true;
      setHoverOnly(true);
      this.box.classList.add('away');
      this.chip.classList.add('away');
      this.chip.textContent = 'Only shown on hover. Hover it again to see it.';
      this.bar.style.display = 'none';
      for (const h of this.handles) h.style.display = 'none';
    }
    const left = lastSeen.x - scrollX;
    const top = lastSeen.y - scrollY;
    Object.assign(this.box.style, { left: `${left - 2}px`, top: `${top - 2}px`, width: `${Math.max(4, lastSeen.w + 4)}px`, height: `${Math.max(4, lastSeen.h + 4)}px` });
    this.chip.style.left = `${Math.min(Math.max(4, left), document.documentElement.clientWidth - this.chip.offsetWidth - 4)}px`;
    this.chip.style.top = `${top - 24 >= 4 ? top - 24 : Math.max(4, top + 4)}px`;
    return true;
  }

  /** The dashed outlines of the other selected elements (or of a hovered style); ones off screen are not drawn. */
  drawOthers(rest: { el: Element }[]): void {
    let used = 0;
    for (const one of rest) {
      const rr = one.el.getBoundingClientRect();
      if (rr.bottom < -40 || rr.top > innerHeight + 40 || rr.right < 0 || rr.left > innerWidth) continue; // off screen: not drawn
      let b = this.others[used];
      if (!b) {
        b = document.createElement('div');
        b.className = 'box more';
        this.root.append(b);
        this.others.push(b);
      }
      b.style.setProperty('--c', this.box.style.getPropertyValue('--c'));
      Object.assign(b.style, { display: 'block', left: `${rr.left - 2}px`, top: `${rr.top - 2}px`, width: `${Math.max(4, rr.width + 4)}px`, height: `${Math.max(4, rr.height + 4)}px` });
      used++;
    }
    for (let i = used; i < this.others.length; i++) this.others[i].style.display = 'none';
  }

  hide(): void {
    this.closeLayers();
    cancelAnimationFrame(this.raf);
    this.loopGen++;
    this.shown = null;
    this.away = false;
    this.box.classList.remove('away');
    this.chip.classList.remove('away');
    for (const el of [this.box, this.chip, this.bar, ...this.handles, ...this.others]) el.style.display = 'none';
  }

  /** Keeps everything on the element as it scrolls, resizes or moves, and the toolbar inside the window. */
  place(): void {
    const s = this.shown;
    if (!s) {
      this.drawOthers([]);
      return;
    }
    this.placePeek();
    if (this.placeAway(s) || !s.el.isConnected) return;
    const r = boxOf(s.el);
    Object.assign(this.box.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${Math.max(4, r.width + 4)}px`, height: `${Math.max(4, r.height + 4)}px` });
    const pos: Record<string, [number, number]> = { nw: [r.left, r.top], n: [r.left + r.width / 2, r.top], ne: [r.right, r.top], e: [r.right, r.top + r.height / 2], se: [r.right, r.bottom], s: [r.left + r.width / 2, r.bottom], sw: [r.left, r.bottom], w: [r.left, r.top + r.height / 2] };
    for (const h of this.handles) {
      const [x, y] = pos[h.dataset.h!];
      h.style.left = `${x}px`;
      h.style.top = `${y}px`;
    }
    // the other selected elements (dashed outlines)
    this.drawOthers(extra.filter((x) => x.el.isConnected));
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const cw = this.chip.offsetWidth;
    const chipTop = r.top - 24 >= 4 ? r.top - 24 : Math.min(vh - 22, r.bottom + 4);
    this.chip.style.left = `${Math.min(Math.max(4, r.left), vw - cw - 4)}px`;
    this.chip.style.top = `${Math.max(4, chipTop)}px`;
    const bw = this.bar.offsetWidth;
    const bh = this.bar.offsetHeight;
    let top = r.bottom + 10;
    if (top + bh > vh - 6) top = r.top - bh - 30 >= 6 ? r.top - bh - 30 : Math.min(vh - bh - 6, Math.max(6, r.top + 6));
    this.bar.style.left = `${Math.min(Math.max(6, r.left), Math.max(6, vw - bw - 6))}px`;
    this.bar.style.top = `${Math.max(6, top)}px`;
  }

  private buildBar(s: Sel, info: SelectionInfo): void {
    this.bar.textContent = '';
    const add = (icon: string, title: string, onClick: () => void, opts: { disabled?: boolean; text?: string; grip?: boolean } = {}) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = opts.text ?? svg(icon);
      if (opts.disabled) b.disabled = true;
      if (opts.grip) {
        b.className = 'grip';
        b.addEventListener('pointerdown', (e) => this.startDrag(e, 'move'));
      } else b.addEventListener('click', onClick);
      this.bar.append(b);
      return b;
    };
    const sep = () => this.bar.append(Object.assign(document.createElement('span'), { className: 'sep' }));
    const color = (title: string, prop: string, current: string) => {
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.title = title;
      inp.setAttribute('aria-label', title);
      inp.value = toHex(current);
      inp.addEventListener('input', () => previewPatch({ [prop]: inp.value }));
      inp.addEventListener('change', () => commitPatch({ [prop]: inp.value }, title));
      this.bar.append(inp);
    };
    const slider = (icon: string, title: string, prop: string, value: number, min: number, max: number, toCss: (v: number) => string) => {
      const toggle = add(icon, title, () => pop.classList.toggle('open'));
      void toggle;
      const pop = document.createElement('span');
      pop.className = 'pop';
      const r = document.createElement('input');
      r.type = 'range';
      r.min = String(min);
      r.max = String(max);
      r.value = String(value);
      r.setAttribute('aria-label', title);
      r.addEventListener('input', () => previewPatch({ [prop]: toCss(Number(r.value)) }));
      r.addEventListener('change', () => commitPatch({ [prop]: toCss(Number(r.value)) }, title));
      pop.append(r);
      this.bar.append(pop);
    };
    const c = info.computed;
    const parent = s.el.parentElement;
    add('parent', 'Select the element around it', () => parent && isEditable(parent) && parent !== document.documentElement && select({ el: parent }, false), { disabled: !!s.pseudo || !parent || parent === document.documentElement });
    // what else is under the spot that was clicked (a badge over a picture over a card)
    const stack = liveLayers();
    const at = stack.indexOf(s.el);
    if (!info.multi && !s.pseudo && stack.length > 1 && at >= 0) {
      const b = add('layers', 'Layers: everything under the spot you clicked', () => this.toggleLayers(), { text: `${svg('layers')}<span>Layers · ${at + 1} of ${stack.length}</span>` });
      b.classList.add('layers-btn');
      b.setAttribute('aria-haspopup', 'dialog');
      b.setAttribute('aria-expanded', String(this.layersOpen));
    }
    const layout = moveMode === 'layout' && info.move.canLayout;
    add('move', layout ? 'Drag to move it in the layout: drop it between other things (Alt+arrows move it a step)' : info.origin === 'webloom' ? 'Drag to move' : 'Drag to nudge (moves how it looks, not the page layout)', () => undefined, { grip: true, disabled: !info.caps.move });
    if (info.caps.move && info.move.canLayout) {
      const m = add(layout ? 'flow' : 'free', layout ? 'Moving in the layout. Click to move freely instead (a visual offset)' : 'Moving freely. Click to move in the layout instead', () => {
        moveMode = layout ? 'free' : 'layout';
        sendInfo();
      });
      m.classList.add('mode');
      m.setAttribute('aria-pressed', String(layout));
    }
    if (info.multi) {
      add('single', 'Only this one', () => selectOnly());
      const n = document.createElement('span');
      n.className = 'count';
      n.textContent = info.multi.group ? `All ${info.multi.count} like this` : `${info.multi.count} selected`;
      this.bar.append(n);
    } else {
      add('similar', info.similar ? `Select all ${info.similar.count} like this` : 'No similar elements', () => selectSimilar(), { disabled: !info.similar });
    }
    sep();
    const k = info.kind;
    if (k === 'text' || k === 'heading' || k === 'link' || k === 'button') {
      const fs = parseFloat(c['font-size']) || 16;
      add('smaller', 'Smaller text', () => commitPatch({ 'font-size': `${Math.max(8, Math.round(fs * 0.9))}px` }, 'Smaller text'));
      add('bigger', 'Bigger text', () => commitPatch({ 'font-size': `${Math.round(fs * 1.1)}px` }, 'Bigger text'));
      add('bold', 'Bold', () => commitPatch({ 'font-weight': Number(c['font-weight']) >= 600 ? '400' : '700' }, 'Bold'));
      const order = ['left', 'center', 'right'];
      add('align', `Align (now ${c['text-align']})`, () => commitPatch({ 'text-align': order[(order.indexOf(c['text-align'] === 'start' ? 'left' : c['text-align']) + 1) % 3] }, 'Alignment'));
      color('Text colour', 'color', c.color);
    } else if (k === 'image' || k === 'video') {
      const fits = ['cover', 'contain', 'fill'];
      if (info.caps.image) add('fit', `Fit (now ${c['object-fit']})`, () => commitPatch({ 'object-fit': fits[(fits.indexOf(c['object-fit']) + 1) % 3] }, 'Fit'));
      cornerButton(add, c);
      slider('opacity', 'Opacity', 'opacity', Math.round((parseFloat(c.opacity) || 1) * 100), 5, 100, (v) => String(v / 100));
    } else if (k === 'decoration') {
      slider('opacity', 'Opacity', 'opacity', Math.round((parseFloat(c.opacity) || 1) * 100), 5, 100, (v) => String(v / 100));
      const z = parseInt(c['z-index']) || 0;
      const needPos: Record<string, string> = c.position === 'static' ? { position: 'relative' } : {};
      add('front', 'Bring forward', () => commitPatch({ 'z-index': String(z + 1), ...needPos }, 'Bring forward'));
      add('back', 'Send backward', () => commitPatch({ 'z-index': String(z - 1), ...needPos }, 'Send backward'));
    } else {
      color('Background colour', 'background-color', c['background-color']);
      const pad = parseFloat(c['padding-top']) || 0;
      add('padMinus', 'Less padding', () => commitPatch({ padding: `${Math.max(0, pad - 8)}px` }, 'Less padding'), { disabled: k === 'page' });
      add('padPlus', 'More padding', () => commitPatch({ padding: `${pad + 8}px` }, 'More padding'), { disabled: k === 'page' });
      if (k !== 'page') cornerButton(add, c);
    }
    sep();
    const hiddenNow = info.editCss.visibility === 'hidden' || info.editCss.display === 'none';
    add('hide', hiddenNow ? 'Show it again' : 'Hide', () => {
      if (hiddenNow) commitPatch({ visibility: null, display: null }, 'Show');
      else commitPatch(info.origin === 'webloom' ? { display: 'none' } : { visibility: 'hidden' }, 'Hide');
    }, { disabled: !info.caps.hide });
    add('trash', 'Delete', () => deleteSelection(), { disabled: !info.caps.hide });
    const resetIds = new Set((info.multi ? info.multi.bases : [{ editId: info.editId }]).map((b) => b.editId).filter(Boolean));
    add('reset', info.multi ? 'Reset the selected elements' : 'Reset this element', () => {
      if (resetIds.size) commit(edits.filter((x) => !resetIds.has(x.id)), info.multi ? 'Reset selection' : 'Reset element');
    }, { disabled: !resetIds.size });
    add('more', 'More options in the side panel', () => post({ t: 'openOptions' }));
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = info.origin === 'webloom' ? 'Whimsy Web' : 'Website';
    this.bar.append(who);
  }

  // ---- Layers: the elements under the clicked spot, front to back

  private layersButton(): HTMLButtonElement | null {
    return this.bar.querySelector<HTMLButtonElement>('button.layers-btn');
  }
  private rows(): HTMLButtonElement[] {
    return [...this.layersEl.querySelectorAll<HTMLButtonElement>('button.row')];
  }
  private focusedRow(): number {
    return this.rows().indexOf(this.root.activeElement as HTMLButtonElement);
  }
  private focusRow(i: number): void {
    const r = this.rows();
    if (r.length) r[((i % r.length) + r.length) % r.length].focus();
  }
  /** Where the selection is in the list (-1: not in it). */
  currentLayer(): number {
    return sel && !sel.pseudo ? liveLayers().indexOf(sel.el) : -1;
  }
  /** The event happened in the Layers list (keys typed there are ours alone). */
  inLayers(e: Event): boolean {
    return this.layersOpen && e.composedPath().includes(this.layersEl);
  }

  toggleLayers(): void {
    if (this.layersOpen) this.closeLayers(true);
    else this.openLayers();
  }

  private openLayers(): void {
    if (liveLayers().length < 2) return;
    this.layersOpen = true;
    this.renderLayers();
    this.layersEl.classList.add('open');
    // under the toolbar, or above it when there is no room; it then stays where it opened (picking a row moves the
    // toolbar to that element, the list must not run away from the pointer)
    const b = this.bar.getBoundingClientRect();
    const w = this.layersEl.offsetWidth;
    const h = this.layersEl.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let top = b.bottom + 6;
    if (top + h > vh - 6) top = b.top - h - 6 >= 6 ? b.top - h - 6 : Math.max(6, vh - h - 6);
    this.layersEl.style.left = `${Math.min(Math.max(6, b.left), Math.max(6, vw - w - 6))}px`;
    this.layersEl.style.top = `${top}px`;
    this.layersButton()?.setAttribute('aria-expanded', 'true');
    this.focusRow(Math.max(0, this.currentLayer()));
  }

  closeLayers(focusButton = false): void {
    if (!this.layersOpen) return;
    this.layersOpen = false;
    this.shiftAlone = false;
    this.layersEl.classList.remove('open');
    this.layersEl.textContent = '';
    this.setPeek(null);
    const btn = this.layersButton();
    btn?.setAttribute('aria-expanded', 'false');
    if (focusButton) btn?.focus();
  }

  private renderLayers(): void {
    const list = liveLayers();
    const cur = this.currentLayer();
    const focused = this.focusedRow();
    const scroll = this.layersEl.querySelector('.rows')?.scrollTop ?? 0;
    this.layersEl.textContent = '';
    const head = document.createElement('div');
    head.className = 'head';
    head.textContent = `Layers here · front to back`;
    const rows = document.createElement('div');
    rows.className = 'rows';
    rows.setAttribute('role', 'listbox');
    rows.setAttribute('aria-label', 'Layers, front to back');
    list.forEach((el, i) => {
      const { label, detail } = labelOf(el);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'row';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(i === cur));
      b.tabIndex = i === Math.max(0, cur) ? 0 : -1;
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = i === cur ? '✓' : String(i + 1);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = el.getAttribute(ADD_ATTR) || originOf(el) === 'webloom' ? `✦ ${label}` : label;
      const d = document.createElement('span');
      d.className = 'detail';
      d.textContent = detail;
      b.append(n, name, d);
      b.title = i === cur ? `${label} (selected)` : `Select ${label}`;
      b.addEventListener('mouseenter', () => this.setPeek(el));
      b.addEventListener('mouseleave', () => {
        const f = this.focusedRow();
        this.setPeek(f >= 0 ? liveLayers()[f] ?? null : null);
      });
      b.addEventListener('focus', () => this.setPeek(el));
      b.addEventListener('click', () => this.pickRow(i));
      rows.append(b);
    });
    const foot = document.createElement('div');
    foot.className = 'foot';
    foot.innerHTML = 'Tap <kbd>Shift</kbd> to cycle · <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Esc</kbd> close';
    this.layersEl.append(head, rows, foot);
    rows.scrollTop = scroll;
    if (focused >= 0) this.focusRow(Math.min(focused, list.length - 1));
  }

  /** Selects the layer in row i; the list stays open, the focus stays on that row. */
  private pickRow(i: number): void {
    const el = liveLayers()[i];
    if (!el) return this.renderLayers();
    pickLayer(el); // show() marks it in the list
    if (this.layersOpen) this.focusRow(i);
    this.setPeek(null);
  }

  /** Outlines a row's element while it is hovered or focused (not the selected one: that is outlined already). */
  private setPeek(el: Element | null): void {
    this.peekEl = el && !(sel && sel.el === el) ? el : null;
    this.placePeek();
  }
  private placePeek(): void {
    const el = this.peekEl;
    if (!el || !el.isConnected || !this.layersOpen) {
      this.peek.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(this.peek.style, { display: 'block', left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${Math.max(4, r.width + 4)}px`, height: `${Math.max(4, r.height + 4)}px` });
  }

  /** Keys pressed in our UI while the list is open. Returns true when handled (the browser's default is then skipped). */
  layersKey(e: KeyboardEvent): boolean {
    if (!this.layersOpen) return false;
    if (e.key === 'Escape') {
      this.closeLayers(true);
      return true;
    }
    if (!this.inLayers(e)) return false;
    if (e.key === 'Shift') {
      if (!e.repeat) this.shiftAlone = true;
      return false;
    }
    this.shiftAlone = false; // Shift with another key (Shift+Tab, Shift+arrow) is not a tap
    const i = this.focusedRow();
    switch (e.key) {
      case 'ArrowDown':
        this.focusRow(i + 1);
        return true;
      case 'ArrowUp':
        this.focusRow(i < 0 ? -1 : i - 1);
        return true;
      case 'Home':
        this.focusRow(0);
        return true;
      case 'End':
        this.focusRow(-1);
        return true;
      case 'Enter':
      case ' ':
        if (i >= 0) this.pickRow(i);
        return true;
    }
    return false;
  }

  /** Shift released in the list without anything else in between: select the next layer (after the last: the first). */
  layersKeyUp(e: KeyboardEvent): boolean {
    if (e.key !== 'Shift' || !this.inLayers(e)) return false;
    const tap = this.shiftAlone;
    this.shiftAlone = false;
    if (!tap) return false;
    const n = liveLayers().length;
    if (n > 1) this.pickRow((this.currentLayer() + 1) % n);
    return true;
  }

  /** Esc while dragging in the layout: nothing moves. Returns whether a drag was cancelled. */
  cancelLayoutDrag(): boolean {
    if (!this.layoutDrag) return false;
    this.layoutDrag.cancelled = true;
    this.showDrop(null);
    return true;
  }

  /** Dragging the move handle in layout mode: the element is dropped between other elements, as part of the layout. */
  private startLayoutDrag(e: PointerEvent, s: Sel): void {
    const target = e.target as HTMLElement;
    const r = s.el.getBoundingClientRect();
    const offX = Math.min(e.clientX - r.left, 260);
    const offY = Math.min(e.clientY - r.top, 160);
    const x0 = e.clientX;
    const y0 = e.clientY;
    resetDropCache();
    this.layoutDrag = { drop: null, started: false, cancelled: false };
    const move = (ev: PointerEvent) => {
      const d = this.layoutDrag;
      if (!d || d.cancelled) return;
      if (!d.started && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      d.started = true;
      Object.assign(this.ghost.style, { display: 'block', left: `${ev.clientX - offX}px`, top: `${ev.clientY - offY}px`, width: `${Math.min(r.width, 320)}px`, height: `${Math.min(r.height, 200)}px` });
      d.drop = dropAt(ev.clientX, ev.clientY, s.el);
      this.showDrop(d.drop);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      const d = this.layoutDrag;
      this.layoutDrag = null;
      this.showDrop(null);
      if (d && !d.cancelled && d.started && d.drop && d.drop.ok && !d.drop.same) moveTo(d.drop.anchor, d.drop.position);
      else if (d && !d.cancelled && d.started && d.drop && !d.drop.ok) post({ t: 'notice', text: `It was not moved: ${d.drop.why?.toLowerCase() ?? 'that spot does not work'}.` });
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  /** The landing line (or the box it would go into) and a label saying where. */
  private showDrop(d: Drop | null): void {
    if (!d) {
      for (const el of [this.ghost, this.dropLine, this.dropBox, this.dropChip]) el.style.display = 'none';
      return;
    }
    const r = d.anchor.getBoundingClientRect();
    const name = labelOf(d.anchor).label;
    const inside = d.position === 'first' || d.position === 'last';
    let lx = 0;
    let ly = 0;
    if (inside) {
      Object.assign(this.dropBox.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      const y = d.position === 'first' ? r.top + 6 : r.bottom - 9;
      this.dropLine.className = 'drop h';
      Object.assign(this.dropLine.style, { display: 'block', left: `${r.left + 8}px`, top: `${y}px`, width: `${Math.max(12, r.width - 16)}px`, height: '3px' });
      lx = r.left + 8;
      ly = y;
    } else {
      this.dropBox.style.display = 'none';
      const row = inRow(d.anchor);
      if (row) {
        const x = d.position === 'before' ? r.left - 3 : r.right;
        this.dropLine.className = 'drop v';
        Object.assign(this.dropLine.style, { display: 'block', left: `${x}px`, top: `${r.top}px`, width: '3px', height: `${Math.max(12, r.height)}px` });
        lx = x + 6;
        ly = r.top;
      } else {
        const y = d.position === 'before' ? r.top - 3 : r.bottom;
        this.dropLine.className = 'drop h';
        Object.assign(this.dropLine.style, { display: 'block', left: `${r.left}px`, top: `${y}px`, width: `${Math.max(12, r.width)}px`, height: '3px' });
        lx = r.left;
        ly = y;
      }
    }
    this.dropLine.classList.toggle('bad', !d.ok);
    this.dropChip.classList.toggle('bad', !d.ok);
    const where = { before: 'Before', after: 'After', first: 'Inside, at the start of', last: 'Inside, at the end of' }[d.position];
    this.dropChip.textContent = !d.ok ? `Can’t go here: ${d.why?.toLowerCase()}` : d.same ? 'Already here' : `${where} ${name}`;
    this.dropChip.style.display = 'block';
    const vw = document.documentElement.clientWidth;
    this.dropChip.style.left = `${Math.min(Math.max(4, lx), vw - this.dropChip.offsetWidth - 4)}px`;
    this.dropChip.style.top = `${ly - 28 >= 4 ? ly - 28 : ly + 8}px`;
  }

  private startDrag(e: PointerEvent, kind: 'move' | 'resize', h?: string): void {
    const s = this.shown;
    if (!s || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (kind === 'move' && moveMode === 'layout' && moveInfo(s, editOf(s), allSelected().length).canLayout) return this.startLayoutDrag(e, s);
    const r = s.el.getBoundingClientRect();
    const cs = getComputedStyle(s.el, s.pseudo);
    const [tx, ty] = currentTranslate(s);
    // content-box elements: width/height exclude padding and border
    const padX = cs.boxSizing === 'border-box' ? 0 : (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
    const padY = cs.boxSizing === 'border-box' ? 0 : (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    this.drag = { kind, h, x: e.clientX, y: e.clientY, w: r.width, hgt: r.height, tx, ty, ratio: r.width / Math.max(1, r.height), pad: [padX, padY] };
    this.dragFn = null;
    this.starts = new Map(allSelected().map((one) => [one.el, currentTranslate(one)]));
    const target = e.target as HTMLElement;
    const move = (ev: PointerEvent) => this.onDrag(ev);
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      const fn = this.dragFn;
      const d = this.drag;
      this.drag = null;
      this.dragFn = null;
      if (fn) commitEach(fn, d?.kind === 'move' ? 'Move' : 'Resize');
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  private onDrag(e: PointerEvent): void {
    const d = this.drag;
    const s = this.shown;
    if (!d || !s) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    const startOf = (one: Sel) => this.starts.get(one.el) ?? [d.tx, d.ty];
    if (d.kind === 'move') {
      this.dragFn = (one) => {
        const [x, y] = startOf(one);
        return { translate: `${Math.round(x + dx)}px ${Math.round(y + dy)}px` };
      };
    } else {
      const h = d.h ?? 'se';
      let w = d.w;
      let hh = d.hgt;
      let tx = d.tx;
      let ty = d.ty;
      if (h.includes('e')) w = d.w + dx;
      if (h.includes('w')) {
        w = d.w - dx;
        tx = d.tx + dx;
      }
      if (h.includes('s')) hh = d.hgt + dy;
      if (h.includes('n')) {
        hh = d.hgt - dy;
        ty = d.ty + dy;
      }
      // pictures keep their proportions when a corner is dragged
      if (h.length === 2 && infoKindIsImage(s)) hh = w / d.ratio;
      w = Math.max(8, w);
      hh = Math.max(8, hh);
      const patch: Record<string, string> = {};
      if (h.includes('e') || h.includes('w')) patch.width = `${Math.round(w - d.pad[0])}px`;
      if (h.includes('n') || h.includes('s') || (h.length === 2 && infoKindIsImage(s))) patch.height = `${Math.round(hh - d.pad[1])}px`;
      if (patch.width || patch.height) patch['max-width'] = 'none';
      const shiftX = tx - d.tx;
      const shiftY = ty - d.ty;
      // the same size for all; a drag from the left or top edge shifts each one from where it is
      this.dragFn = (one) => {
        if (!shiftX && !shiftY) return patch;
        const [x, y] = startOf(one);
        return { ...patch, translate: `${Math.round(x + shiftX)}px ${Math.round(y + shiftY)}px` };
      };
    }
    previewEach(this.dragFn);
  }
}

const infoKindIsImage = (s: Sel) => !s.pseudo && /^(IMG|VIDEO|PICTURE|SVG|CANVAS)$/i.test(s.el.tagName);

function cornerButton(add: (icon: string, title: string, onClick: () => void) => HTMLButtonElement, c: Record<string, string>): void {
  const steps = ['0px', '12px', '24px', '50%'];
  const now = c['border-top-left-radius'];
  const i = steps.indexOf(now);
  add('corners', 'Rounder corners', () => commitPatch({ 'border-radius': steps[(i + 1) % steps.length] }, 'Corners'));
}

/** rgb()/rgba() -> #rrggbb for colour inputs (transparent shows as white). */
function toHex(css: string): string {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(css);
  if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return '#ffffff';
  return '#' + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('');
}

/** For the edit layer to know which marks belong to Edit Mode's design (tests). */
export const editorState = () => ({ designId, edits, selected: sel ? idOf(sel.el) + (sel.pseudo ?? '') : null, current: currentEdits().length });
