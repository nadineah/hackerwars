import { EDIT_ATTR, compileEdits, validateEdits, type VisualEdit } from '../shared/edits';
import { sanitizeCss } from '../shared/validate';
import type { Design } from '../shared/types';
import { loadArtFor, withArt } from './art';
import { leafText, originalText, resolveTarget } from './identity';

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
  working = designId ? { designId, edits } : null;
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

/** Puts the marks, the stylesheet and the text where they belong now. Cheap when nothing changed. */
export function render(): void {
  const edits = currentEdits();
  const want = new Map<Element, string[]>();
  const textFor = new Map<string, Element>();
  for (const e of edits) {
    const els = resolveTarget(e.target);
    for (const el of els) {
      const ids = want.get(el) ?? [];
      ids.push(e.id);
      want.set(el, ids);
    }
    if (e.text !== undefined && els.length === 1) textFor.set(e.id, els[0]);
  }
  document.querySelectorAll(`[${EDIT_ATTR}]`).forEach((el) => {
    if (!want.has(el)) el.removeAttribute(EDIT_ATTR);
  });
  want.forEach((ids, el) => {
    const v = ids.join(' ');
    if (el.getAttribute(EDIT_ATTR) !== v) el.setAttribute(EDIT_ATTR, v);
  });

  // text: change the characters of the one text node; put the site's text back when the edit is gone
  for (const [id, node] of changedText) {
    if (textFor.has(id) && leafText(textFor.get(id)!) === node) continue;
    if (node.isConnected && originalText.has(node)) node.data = originalText.get(node)!;
    changedText.delete(id);
  }
  for (const e of edits) {
    const el = textFor.get(e.id);
    if (!el || e.text === undefined) continue;
    const node = leafText(el);
    if (!node) continue;
    if (!originalText.has(node)) originalText.set(node, node.data);
    if (node.data !== e.text) node.data = e.text;
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
