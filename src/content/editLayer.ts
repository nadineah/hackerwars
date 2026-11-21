import { EDIT_ATTR, compileEdits, validateEdits, type VisualEdit } from '../shared/edits';
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
  if (hit && hit.key === key) {
    // "all like this" can gain new matches; one element is kept while it is still there
    const stillThere = hit.els.length > 0 && hit.els.every((el) => (e.target.all ? el.isConnected : stillMatches(el, e.target)));
    if (stillThere && !e.target.all) return hit.els;
    if (now - hit.at < RETRY_MS && (e.target.all ? stillThere : true)) {
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

/** Puts the marks, the stylesheet and the text where they belong now. Cheap when nothing changed. */
export function render(): void {
  const edits = currentEdits();
  const now = Date.now();
  const want = new Map<Element, string[]>();
  const textFor = new Map<string, Element>();
  const live = new Set<string>();
  for (const e of edits) {
    live.add(e.id);
    const els = elementsFor(e, now);
    for (const el of els) {
      const ids = want.get(el) ?? [];
      ids.push(e.id);
      want.set(el, ids);
    }
    if (e.text !== undefined && els.length === 1) textFor.set(e.id, els[0]);
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
