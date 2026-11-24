import type { CssNode } from 'css-tree';
import generate from 'css-tree/generator';
import parse from 'css-tree/parser';
import walk from 'css-tree/walker';
import { isSafeSelector, sanitizeDeclarations } from './validate';

/**
 * Visual-editor edits: the manual layer that sits above a design's AI-written CSS.
 *
 *   1. the original website
 *   2. the design's CSS and ops (written by the AI)
 *   3. these edits (made by hand in Edit Mode, or by "ask Claude about this element")
 *
 * An edit is a small set of CSS declarations for ONE element (or every element like it), plus optionally new text for
 * a plain text element. Elements are found again on every load by `EditTarget` (several selectors, strongest first,
 * checked against a fingerprint), never by a temporary marker, and an edit whose element cannot be found reliably is
 * simply not applied. Everything here is plain data validated on the way in (storage) and on the way out (the page).
 */

export type Origin = 'site' | 'webloom';

export interface EditTarget {
  /** CSS selectors that find the element again, strongest first. */
  selectors: string[];
  /** Lowercase tag name, to confirm a match. */
  tag: string;
  /** A little of its own text when it was edited, to confirm a match (not needed with a unique id). */
  text?: string;
  /** alt text, aria-label or picture file name, to confirm a match. */
  hint?: string;
  /** A decoration drawn by the design's CSS on this element. */
  pseudo?: '::before' | '::after';
  /** Apply to every element this selector matches ("this and the others like it"). */
  all?: string;
}

export interface VisualEdit {
  /** e + hex, used as the marker on the page (safe inside an attribute selector). */
  id: string;
  target: EditTarget;
  /** Human label for lists ("Image · Logo"). */
  label: string;
  origin: Origin;
  /** property -> value, without !important. */
  css: Record<string, string>;
  /** New text for a plain text element (one text node, no child elements). */
  text?: string;
  /**
   * An element added by hand, placed relative to the target element. The edit's css and text are the NEW element's;
   * the target only says where it goes.
   */
  insert?: { kind: InsertKind; position: InsertPosition };
  updatedAt: number;
}

export type InsertKind = 'text' | 'heading' | 'button' | 'image' | 'divider' | 'box';
export type InsertPosition = 'before' | 'after' | 'inside';
export const INSERT_KINDS: InsertKind[] = ['text', 'heading', 'button', 'image', 'divider', 'box'];
/** The tag each added kind is made of (a "button" is a styled span: a real link or button would do something). */
export const INSERT_TAG: Record<InsertKind, string> = { text: 'p', heading: 'h2', button: 'span', image: 'div', divider: 'hr', box: 'div' };
/** How a new element starts out: readable on any design (currentColor), easy to restyle. */
export const INSERT_DEFAULTS: Record<InsertKind, { text?: string; css: Record<string, string> }> = {
  text: { text: 'New text', css: { margin: '8px 0' } },
  heading: { text: 'New heading', css: { margin: '12px 0' } },
  button: { text: 'Button', css: { display: 'inline-block', padding: '10px 20px', border: '2px solid currentColor', 'border-radius': '999px', 'font-weight': '700', margin: '8px 0' } },
  image: { css: { display: 'block', width: '100%', height: '220px', 'background-size': 'cover', 'background-position': 'center', 'background-repeat': 'no-repeat', 'border-radius': '12px', margin: '12px 0' } },
  divider: { css: { border: 'none', 'border-top': '2px solid currentColor', opacity: '0.35', margin: '16px 0' } },
  box: { text: 'New box', css: { display: 'block', padding: '16px', 'border-radius': '12px', 'background-color': 'rgba(127, 127, 127, 0.14)', margin: '12px 0' } },
};
/** The attribute an added element carries (its edit id). */
export const ADD_ATTR = 'data-ww-add';
const hasText = (k: InsertKind) => k !== 'image' && k !== 'divider';

/**
 * A new element next to (or inside) `anchor`, with its starting look plus `css` (a picture for an image, say).
 * Returns the list with it added, and its id.
 */
export function addElement(edits: VisualEdit[], anchor: EditTarget, kind: InsertKind, position: InsertPosition, css: Record<string, string> = {}): { edits: VisualEdit[]; editId: string } {
  const d = INSERT_DEFAULTS[kind];
  const clean: Record<string, string> = {};
  for (const [p, v] of Object.entries({ ...d.css, ...css })) {
    const c = cleanValue(p, v);
    if (c !== null) clean[p] = c;
  }
  const id = newEditId();
  const label = { text: 'Added text', heading: 'Added heading', button: 'Added button', image: 'Added image', divider: 'Added divider', box: 'Added box' }[kind];
  const target: EditTarget = { selectors: anchor.selectors, tag: anchor.tag, ...(anchor.text ? { text: anchor.text } : {}), ...(anchor.hint ? { hint: anchor.hint } : {}) };
  const e: VisualEdit = { id, target, label, origin: 'site', css: clean, ...(d.text ? { text: d.text } : {}), insert: { kind, position }, updatedAt: Date.now() };
  return { edits: [...edits, e], editId: id };
}

/** Removes an added element, and anything that was added inside or next to it (they would have nowhere to go). */
export function removeAdded(edits: VisualEdit[], id: string): VisualEdit[] {
  const gone = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of edits) {
      if (gone.has(e.id)) continue;
      if (e.target.selectors.some((s) => [...gone].some((g) => s.includes(`[${ADD_ATTR}="${g}"]`)))) {
        gone.add(e.id);
        grew = true;
      }
    }
  }
  return edits.filter((e) => !gone.has(e.id));
}

export const MAX_EDITS = 400;
export const MAX_TARGET_SELECTOR = 600;
const MAX_PROPS = 40;
const EDIT_ID = /^e[a-f0-9]{6,16}$/;
const PROP = /^(?:--[a-z0-9-]{1,40}|-?[a-z][a-z-]{0,40})$/;

export const newEditId = (): string => 'e' + Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, '0')).join('');

const plain = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ').slice(0, max) : '';

/**
 * Parses `prop: value; prop: value` into pairs, one per declaration, with readable problems for the ones that fail
 * (used by Code mode to explain what is wrong, and to read the model's answer).
 */
export function parseDeclarations(text: string): { css: Record<string, string>; errors: string[] } {
  const css: Record<string, string> = {};
  const errors: string[] = [];
  const src = String(text ?? '').slice(0, 8000);
  if (/[{}]/.test(src)) errors.push('Write only declarations like “color: red;”, without selectors or braces.');
  let ast: CssNode;
  try {
    ast = parse(src.replace(/[{}]/g, ' '), { context: 'declarationList', parseValue: true, onParseError: (e: { message?: string }) => errors.push(`Could not read part of it (${String(e?.message ?? 'syntax error').slice(0, 60)}).`) });
  } catch {
    return { css, errors: ['That is not valid CSS.'] };
  }
  walk(ast, {
    visit: 'Declaration',
    enter(node: CssNode) {
      const d = node as CssNode & { type: 'Declaration'; property: string; value: CssNode };
      const prop = d.property.trim().toLowerCase();
      const value = generate(d.value).trim();
      if (!PROP.test(prop)) return void errors.push(`“${prop.slice(0, 40)}” is not a property name.`);
      if (!value) return void errors.push(`“${prop}” has no value.`);
      const clean = cleanValue(prop, value);
      if (clean === null) return void errors.push(`“${prop}: ${value.slice(0, 60)}” is not allowed (only embedded images and Google Fonts can be loaded).`);
      css[prop] = clean;
    },
  });
  return { css, errors };
}

/** One declaration through the sanitizer; returns its normalized value, or null if it was removed. */
export function cleanValue(prop: string, value: string): string | null {
  if (!PROP.test(prop) || value.length > 400) return null;
  const v = value.replace(/!\s*important\s*$/i, '').trim();
  if (!v || /[;{}]/.test(v)) return null;
  const out = sanitizeDeclarations(`${prop}:${v}`);
  const m = /^\s*([^:]+):([\s\S]*)$/.exec(out);
  if (!m || m[1].trim().toLowerCase() !== prop) return null;
  const clean = m[2].replace(/!important\s*$/i, '').replace(/;\s*$/, '').trim();
  return clean || null;
}

function cleanTarget(raw: unknown): EditTarget | null {
  const t = raw as Partial<EditTarget> | null;
  if (!t || typeof t !== 'object') return null;
  // visual-editor paths on deep pages can be longer than a model's selectors
  const selectors = (Array.isArray(t.selectors) ? t.selectors : []).filter((s): s is string => isSafeSelector(s, MAX_TARGET_SELECTOR)).slice(0, 5);
  const tag = plain(t.tag, 40).toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) return null;
  const all = t.all !== undefined && isSafeSelector(t.all) ? t.all : undefined;
  if (!selectors.length && !all) return null;
  const pseudo = t.pseudo === '::before' || t.pseudo === '::after' ? t.pseudo : undefined;
  const text = plain(t.text, 80).trim() || undefined;
  const hint = plain(t.hint, 120).trim() || undefined;
  return { selectors, tag, ...(text ? { text } : {}), ...(hint ? { hint } : {}), ...(pseudo ? { pseudo } : {}), ...(all ? { all } : {}) };
}

/** Validates untrusted edits (from storage, the panel or a model). Invalid edits or declarations are dropped. */
export function validateEdits(raw: unknown): VisualEdit[] {
  if (!Array.isArray(raw)) return [];
  const out: VisualEdit[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (out.length >= MAX_EDITS) break;
    const e = r as Partial<VisualEdit> | null;
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !EDIT_ID.test(e.id) || seen.has(e.id)) continue;
    const target = cleanTarget(e.target);
    if (!target) continue;
    const css: Record<string, string> = {};
    for (const [p, v] of Object.entries(e.css && typeof e.css === 'object' ? e.css : {}).slice(0, MAX_PROPS)) {
      const prop = String(p).toLowerCase();
      const clean = typeof v === 'string' ? cleanValue(prop, v) : null;
      if (clean !== null) css[prop] = clean;
    }
    const ins = e.insert && typeof e.insert === 'object' && INSERT_KINDS.includes(e.insert.kind) && ['before', 'after', 'inside'].includes(e.insert.position) && !target.pseudo && !target.all ? { kind: e.insert.kind, position: e.insert.position } : undefined;
    if (e.insert && !ins) continue; // an added element that cannot be placed safely is dropped, never applied to the anchor
    const text = e.text !== undefined && !target.pseudo && !target.all && (!ins || hasText(ins.kind)) ? plain(e.text, 500) : undefined;
    if (!ins && !Object.keys(css).length && text === undefined) continue;
    seen.add(e.id);
    out.push({
      id: e.id,
      target,
      label: plain(e.label, 80) || target.tag,
      origin: e.origin === 'webloom' ? 'webloom' : 'site',
      css,
      ...(text !== undefined ? { text } : {}),
      ...(ins ? { insert: ins } : {}),
      updatedAt: Number.isFinite(e.updatedAt) ? Number(e.updatedAt) : Date.now(),
    });
  }
  return out;
}

/** Google Fonts the editor offers; using one in font-family makes the compiled stylesheet import it. */
export const GOOGLE_FONTS = [
  'Playfair Display', 'Cormorant Garamond', 'Lora', 'Merriweather', 'EB Garamond', 'Cinzel', 'Inter', 'Poppins', 'Montserrat',
  'Nunito', 'Quicksand', 'Space Grotesk', 'DM Sans', 'Fredoka', 'Pacifico', 'Lobster', 'Caveat', 'Dancing Script', 'Press Start 2P', 'Special Elite',
] as const;

/** The attribute that marks elements an edit applies to (space-separated edit ids). */
export const EDIT_ATTR = 'data-ww-e';

/**
 * The stylesheet for a set of edits. Each rule targets the marker attribute three times so it beats the design's own
 * `!important` rules and the colour/readability corrections, which use two.
 */
export function compileEdits(edits: VisualEdit[]): string {
  const fonts = new Set<string>();
  const rules: string[] = [];
  for (const e of edits) {
    const decls = Object.entries(e.css).map(([p, v]) => {
      if (p === 'font-family') for (const f of GOOGLE_FONTS) if (v.includes(f)) fonts.add(f);
      return `${p}:${v} !important`;
    });
    if (!decls.length) continue;
    rules.push(`[${EDIT_ATTR}~="${e.id}"][${EDIT_ATTR}][${EDIT_ATTR}]${e.target.pseudo ?? ''}{${decls.join(';')}}`);
  }
  const imports = [...fonts].map((f) => `@import url("https://fonts.googleapis.com/css2?family=${f.replace(/ /g, '+')}:wght@400;700&display=swap");`);
  return [...imports, ...rules].join('\n');
}

/** The element a change is for: its existing edit (if any) and how to create one. */
export interface EditBase {
  editId?: string;
  target: EditTarget;
  label: string;
  origin: Origin;
}

/**
 * Applies a change to one element's edit and returns the new list. `patch` sets declarations (null removes one);
 * `text` sets (or with null removes) its text; `all` turns "this and the others like it" on (a selector) or off (null).
 * An edit left with nothing in it is removed.
 */
export function upsertEdit(
  edits: VisualEdit[],
  base: EditBase,
  patch: Record<string, string | null>,
  opts: { text?: string | null; all?: string | null } = {},
): { edits: VisualEdit[]; editId: string | undefined } {
  const old = base.editId ? edits.find((e) => e.id === base.editId) : undefined;
  const css: Record<string, string> = { ...(old?.css ?? {}) };
  for (const [p, v] of Object.entries(patch)) {
    const prop = p.toLowerCase();
    if (v === null || v === '') delete css[prop];
    else {
      const clean = cleanValue(prop, v);
      if (clean !== null) css[prop] = clean;
    }
  }
  let text = old?.text;
  if (opts.text === null) text = undefined;
  else if (typeof opts.text === 'string') text = opts.text.slice(0, 500);
  const target: EditTarget = { ...(old?.target ?? base.target) };
  if (opts.all === null) delete target.all;
  else if (typeof opts.all === 'string' && isSafeSelector(opts.all)) target.all = opts.all;
  if (target.all || target.pseudo) text = undefined;
  const others = edits.filter((e) => e.id !== old?.id);
  if (!old?.insert && !Object.keys(css).length && text === undefined) return { edits: others, editId: undefined };
  const id = old?.id ?? newEditId();
  const next: VisualEdit = { id, target, label: old?.label ?? base.label.slice(0, 80), origin: base.origin, css, ...(text !== undefined ? { text } : {}), ...(old?.insert ? { insert: old.insert } : {}), updatedAt: Date.now() };
  return { edits: old ? edits.map((e) => (e.id === id ? next : e)) : [...edits, next], editId: id };
}
