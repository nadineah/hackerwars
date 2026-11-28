import { ADD_ATTR, EDIT_ATTR, INSERT_TAG, MOVE_ATTR, compileEdits, validateEdits, type VisualEdit } from '../shared/edits';
import { sanitizeCss } from '../shared/validate';
import type { Design } from '../shared/types';
import { loadArtFor, withArt } from './art';
import { leafText, originalText, resolveTarget, stillMatches } from './identity';

/**
 * Renders the visual-editor layer: for every edit of the applied designs, the element is found again (identity.ts),
 * marked with `data-ww-e`, and one stylesheet styles the marks. Plain-text edits change the text node's characters in
 * place (never the element), so the site's own scripts keep working with the same nodes.
 * While Edit Mode is on, the design being edited shows its working copy instead of what is saved.
 */
const STYLE_ID = 'ww-edits-style';

let applied: { id: string; edits: VisualEdit[] }[] = [];
let working: { designId: string; edits: VisualEdit[] } | null = null;
/** Text nodes this layer changed, by edit id. */
const changedText = new Map<string, Text>();
let lastCss = '';

/** The edits of the designs on this page (lowest layer first). */
export function setAppliedEdits(designs: Design[]): void {
  applied = designs.map((d) => ({ id: d.id, edits: validateEdits(d.edits) }));
  render();
}

/** Edit Mode: show this design's working copy (null: back to what is saved). */
export async function setWorkingEdits(designId: string | null, edits: VisualEdit[] = []): Promise<void> {
  // validated here too (ids go into selectors, declarations into the stylesheet), whoever sent them
  working = designId ? { designId, edits: validateEdits(edits) } : null;
  if (working) await loadArtFor(JSON.stringify(edits));
  render();
}

export function currentEdits(): VisualEdit[] {
  const out: VisualEdit[] = [];
  let workingShown = false;
  for (const d of applied) {
    if (working && working.designId === d.id) {
      out.push(...working.edits);
      workingShown = true;
    } else out.push(...d.edits);
  }
  // a design that does not exist yet (the first edit on a page with none) is still previewed
  if (working && !workingShown) out.push(...working.edits);
  return out;
}

/**
 * Where each edit's element(s) were found. Busy pages (feeds, players) change all the time, so an element that is still
 * in the page and still fits is reused instead of searching the whole document again; only edits whose element is
 * missing are looked for again, and at most every couple of seconds.
 */
const found = new Map<string, { key: string; els: Element[]; at: number }>();
const RETRY_MS = 2000;

function elementsFor(e: VisualEdit, now: number): Element[] {
  const key = JSON.stringify(e.target);
  const hit = found.get(e.id);
  // "All like this" is one selector query, cheap enough to run every time, and the site may have added more
  // (a feed loading new cards): those get the edit straight away.
  if (hit && hit.key === key && !e.target.all) {
    // one element is kept while it is still there and still fits
    const stillThere = hit.els.length > 0 && hit.els.every((el) => stillMatches(el, e.target));
    if (stillThere) return hit.els;
    if (now - hit.at < RETRY_MS) {
      // not found (yet): look again when the wait is over, even if the page stays quiet meanwhile
      retryLater(RETRY_MS - (now - hit.at));
      return hit.els.filter((el) => el.isConnected);
    }
  }
  const els = resolveTarget(e.target);
  found.set(e.id, { key, els, at: now });
  if (!els.length) retryLater(RETRY_MS);
  return els;
}

let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** One timer for all edits still waiting for their element (pages that finish drawing after load). */
function retryLater(ms: number): void {
  if (retryTimer !== undefined) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    if (currentEdits().length) render();
  }, Math.max(50, ms) + 20);
}

/** What this layer last wrote into a text node. */
const textState = new WeakMap<Text, { ours: string }>();
/** Text nodes the site took back (it changed them after an edit), with the edit text they were yielded for. */
const yielded = new WeakMap<Text, string>();

/**
 * Elements added by hand: each is created once next to (or inside) its anchor and kept there; one whose edit is gone is
 * removed. Their text is set with textContent (never HTML).
 */
function placeAdded(edits: VisualEdit[], now: number): void {
  const want = new Set<string>();
  for (const e of edits) {
    if (!e.insert) continue;
    want.add(e.id);
    const [anchor] = elementsFor(e, now);
    let el = document.querySelector(`[${ADD_ATTR}="${e.id}"]`);
    if (!anchor) {
      el?.remove();
      continue;
    }
    const tag = INSERT_TAG[e.insert.kind];
    const where = e.insert.position === 'before' ? anchor.previousElementSibling === el : e.insert.position === 'after' ? anchor.nextElementSibling === el : el?.parentElement === anchor;
    if (!el || el.tagName.toLowerCase() !== tag || !where) {
      el?.remove();
      el = document.createElement(tag);
      el.setAttribute(ADD_ATTR, e.id);
      anchor.insertAdjacentElement(e.insert.position === 'before' ? 'beforebegin' : e.insert.position === 'after' ? 'afterend' : 'beforeend', el);
    }
    const text = e.text ?? '';
    if (tag !== 'hr' && el.textContent !== text) el.textContent = text;
  }
  document.querySelectorAll(`[${ADD_ATTR}]`).forEach((el) => {
    if (!want.has(el.getAttribute(ADD_ATTR) ?? '')) el.remove();
  });
}

/**
 * Elements moved in the layout. The element itself is moved (never a copy), so the site's scripts, listeners and state
 * keep working with it. Where it came from is remembered for this page session, so taking the move away (undo, reset)
 * puts it back. If the site keeps putting it back itself (it redraws that part), the move is given up for this page
 * view instead of fighting it.
 */
interface Moved {
  el: Element;
  home: { parent: Node; next: Node | null };
  /** When the site undid the move (it was in place and is not any more). */
  undone: number[];
  placed: boolean;
  gaveUp: boolean;
}
const moved = new Map<string, Moved>();
const anchors = new Map<string, { key: string; el: Element }>();
const FIGHT_WINDOW = 10_000;
const MAX_FIGHTS = 4;

function anchorFor(e: VisualEdit): Element | null {
  const t = e.move!.to;
  const key = JSON.stringify(t);
  const hit = anchors.get(e.id);
  if (hit && hit.key === key && stillMatches(hit.el, t)) return hit.el;
  const [el] = resolveTarget(t);
  if (el) anchors.set(e.id, { key, el });
  return el ?? null;
}

const inPlace = (el: Element, anchor: Element, pos: string): boolean =>
  pos === 'before' ? anchor.previousElementSibling === el : pos === 'after' ? anchor.nextElementSibling === el : pos === 'first' ? anchor.firstElementChild === el : anchor.lastElementChild === el;

function placeMoved(edits: VisualEdit[], now: number): void {
  const live = new Set<string>();
  for (const e of edits) {
    if (!e.move) continue;
    live.add(e.id);
    const prev = moved.get(e.id);
    if (prev?.gaveUp) continue;
    let el: Element | null = prev && prev.el.isConnected ? prev.el : null;
    if (!el) {
      const found = elementsFor(e, now);
      el = found.length === 1 ? found[0] : null;
    }
    const anchor = el ? anchorFor(e) : null;
    if (!el || !anchor || anchor === el || el.contains(anchor) || !anchor.isConnected) continue;
    if ((e.move.position === 'before' || e.move.position === 'after') && !anchor.parentElement) continue;
    const rec: Moved = prev && prev.el === el ? prev : { el, home: { parent: el.parentNode!, next: el.nextSibling }, undone: [], placed: false, gaveUp: false };
    moved.set(e.id, rec);
    if (!inPlace(el, anchor, e.move.position)) {
      if (rec.placed) {
        rec.undone = [...rec.undone.filter((t) => now - t < FIGHT_WINDOW), now];
        if (rec.undone.length > MAX_FIGHTS) {
          rec.gaveUp = true;
          console.warn('[Whimsy Web] The site keeps putting a moved element back, so it is left where the site wants it.');
          continue;
        }
      }
      const where = { before: 'beforebegin', after: 'afterend', first: 'afterbegin', last: 'beforeend' } as const;
      anchor.insertAdjacentElement(where[e.move.position], el);
      rec.placed = true;
    }
    if (el.getAttribute(MOVE_ATTR) !== e.id) el.setAttribute(MOVE_ATTR, e.id);
  }
  for (const [id, rec] of moved) {
    if (live.has(id)) continue;
    // the move was taken away: back where it came from (if that is still there)
    moved.delete(id);
    anchors.delete(id);
    const { el, home } = rec;
    if (el.getAttribute(MOVE_ATTR) === id) el.removeAttribute(MOVE_ATTR);
    if (!el.isConnected || !home.parent.isConnected || rec.gaveUp) continue;
    const next = home.next && home.next.parentNode === home.parent ? home.next : null;
    if (el.parentNode !== home.parent || el.nextSibling !== next) home.parent.insertBefore(el, next);
  }
}

/** The site kept undoing this edit's move, so it was given up for this page view. */
export const moveGaveUp = (id: string): boolean => !!moved.get(id)?.gaveUp;
/** Where an edit's moved element came from in this page view (null: it has not been moved). */
export const movedHome = (id: string): Moved['home'] | null => moved.get(id)?.home ?? null;

/** Puts the marks, the stylesheet and the text where they belong now. Cheap when nothing changed. */
export function render(): void {
  const edits = currentEdits();
  const now = Date.now();
  const want = new Map<Element, string[]>();
  const textFor = new Map<string, Element>();
  const live = new Set<string>();
  placeMoved(edits, now);
  placeAdded(edits, now);
  for (const e of edits) {
    live.add(e.id);
    // an added element is styled itself; its target only says where it goes
    const els = e.insert ? [...document.querySelectorAll(`[${ADD_ATTR}="${e.id}"]`)].slice(0, 1) : elementsFor(e, now);
    for (const el of els) {
      const ids = want.get(el) ?? [];
      ids.push(e.id);
      want.set(el, ids);
    }
    if (e.text !== undefined && els.length === 1 && !e.insert) textFor.set(e.id, els[0]);
  }
  for (const id of found.keys()) if (!live.has(id)) found.delete(id);
  document.querySelectorAll(`[${EDIT_ATTR}]`).forEach((el) => {
    if (!want.has(el)) el.removeAttribute(EDIT_ATTR);
  });
  want.forEach((ids, el) => {
    const v = ids.join(' ');
    if (el.getAttribute(EDIT_ATTR) !== v) el.setAttribute(EDIT_ATTR, v);
  });

  // Text: the characters of the one text node are changed in place. If the SITE changes that text afterwards (a live
  // price, a status), the site wins: the edit stops being forced on that node, and its new text becomes the original.
  const textNodeOf = (id: string, el: Element): Text | null => {
    const prev = changedText.get(id);
    return prev && prev.parentNode === el ? prev : leafText(el); // an emptied node is still the same node
  };
  for (const [id, node] of changedText) {
    const el = textFor.get(id);
    if (el && textNodeOf(id, el) === node) continue;
    // the edit is gone or moved: put the site's text back, unless the site already wrote its own
    const st = textState.get(node);
    if (node.isConnected && st && node.data === st.ours && originalText.has(node)) node.data = originalText.get(node)!;
    changedText.delete(id);
  }
  for (const e of edits) {
    const el = textFor.get(e.id);
    if (!el || e.text === undefined) continue;
    const node = textNodeOf(e.id, el);
    if (!node) continue;
    const st = textState.get(node);
    if (st && node.data !== st.ours && node.data !== e.text) {
      // the site updated it since: keep the site's text and leave this node alone
      originalText.set(node, node.data);
      textState.delete(node);
      changedText.delete(e.id);
      yielded.set(node, e.text);
      continue;
    }
    // yielded to the site for this text; a NEW text typed in the editor applies again
    if (yielded.get(node) === e.text) continue;
    yielded.delete(node);
    if (!originalText.has(node)) originalText.set(node, node.data);
    if (node.data !== e.text) node.data = e.text;
    textState.set(node, { ours: e.text });
    changedText.set(e.id, node);
  }

  const css = edits.length ? withArt(sanitizeCss(compileEdits(edits))) : '';
  let st = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!css) {
    st?.remove();
    lastCss = '';
    return;
  }
  if (!st) {
    st = document.createElement('style');
    st.id = STYLE_ID;
  }
  if (css !== lastCss || st.textContent !== css) {
    st.textContent = css;
    lastCss = css;
  }
  // after every design stylesheet, so equal rules are decided in its favour too
  if (!st.isConnected || st.nextElementSibling) document.documentElement.append(st);
}

export function clearEditLayer(): void {
  applied = [];
  render();
}

export const hasEdits = (): boolean => currentEdits().length > 0;
