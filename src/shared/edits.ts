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
  /**
   * A hover overlay inside the element it covers (1 to 5 levels up): its hover look shows when that element is pointed
   * at (an overlay ignores the pointer, so it is never pointed at itself).
   */
  hoverUp?: number;
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
  /** While the pointer is over it, or over the link/button it is part of. */
  hover?: Record<string, string>;
  /** While it (or the control it is in) has keyboard focus, or a field in it is being typed in. */
  focus?: Record<string, string>;
  /** The shapes inside an SVG icon (fill/stroke are only set on shapes that paint them). */
  shapes?: Record<string, string>;
  /** A field's placeholder text. */
  placeholder?: Record<string, string>;
  /** A list's bullets or numbers (its own, and its items'). */
  marker?: Record<string, string>;
  /**
   * Moved in the layout: the element itself (the same node, so the site's scripts keep working with it) is placed
   * before/after another element, or first/last inside one. Its target finds it where it was before the move.
   */
  move?: { to: EditTarget; position: MovePosition };
  updatedAt: number;
}

export type MovePosition = 'before' | 'after' | 'first' | 'last';
export const MOVE_POSITIONS: MovePosition[] = ['before', 'after', 'first', 'last'];
/** The extra style sets of an edit, besides its own css. */
export type Slot = 'hover' | 'focus' | 'shapes' | 'placeholder' | 'marker';
export const SLOTS: Slot[] = ['hover', 'focus', 'shapes', 'placeholder', 'marker'];
/** The attribute Edit Mode sets on the selected element to show its hover or focus look while the pointer is in the panel. */
export const STATE_ATTR = 'data-ww-state';
/** The attribute a moved element carries (its edit id), so it is found again where it now is. */
export const MOVE_ATTR = 'data-ww-moved';
/** Things people point at or tab to: a hover or focus look on something inside one shows when the whole control is pointed at. */
export const CONTROL_SELECTOR = 'a[href],button,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="checkbox"],[role="switch"],summary,label,[tabindex]:not([tabindex="-1"])';

type Slots = Partial<Record<Slot, Record<string, string>>>;
const hasContent = (e: { css: Record<string, string>; text?: string; insert?: unknown; move?: unknown } & Slots): boolean =>
  !!e.insert || !!e.move || e.text !== undefined || Object.keys(e.css).length > 0 || SLOTS.some((k) => Object.keys(e[k] ?? {}).length > 0);

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
export function addElement(edits: VisualEdit[], anchor: EditTarget, kind: InsertKind, position: InsertPosition, css: Record<string, string> = {}, text?: string): { edits: VisualEdit[]; editId: string } {
  const d = INSERT_DEFAULTS[kind];
  const clean: Record<string, string> = {};
  for (const [p, v] of Object.entries({ ...d.css, ...css })) {
    const c = cleanValue(p, v);
    if (c !== null) clean[p] = c;
  }
  const id = newEditId();
  const label = { text: 'Added text', heading: 'Added heading', button: 'Added button', image: 'Added image', divider: 'Added divider', box: 'Added box' }[kind];
  const target: EditTarget = { selectors: anchor.selectors, tag: anchor.tag, ...(anchor.text ? { text: anchor.text } : {}), ...(anchor.hint ? { hint: anchor.hint } : {}) };
  // its words: given ones (trimmed, at most 500 characters), else the kind's placeholder; kinds without words have none
  const words = hasText(kind) ? (typeof text === 'string' && text.trim() ? text.trim().slice(0, 500) : d.text) : undefined;
  const e: VisualEdit = { id, target, label, origin: 'site', css: clean, ...(words ? { text: words } : {}), insert: { kind, position }, updatedAt: Date.now() };
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

/** Properties that may hold an embedded SVG picture, and how long one may be. */
const EMBED_PROP = /^(-webkit-)?mask-image$|^background-image$|^content$|^list-style-image$/;
export const MAX_EMBEDDED_SVG = 6000;

/** One declaration through the sanitizer; returns its normalized value, or null if it was removed. */
export function cleanValue(prop: string, value: string): string | null {
  // an icon's shape embedded as an SVG (a picked icon, a site's own icon made into a gradient's mask) is longer than
  // other values: those were dropped, so many icons could not be picked
  const max = EMBED_PROP.test(prop) && /^url\(\s*["']?data:image\/svg\+xml,/i.test(value.trim()) ? MAX_EMBEDDED_SVG : 400;
  if (!PROP.test(prop) || value.length > max) return null;
  const v = value.replace(/!\s*important\s*$/i, '').trim();
  if (!v || /[;{}]/.test(v)) return null;
  const out = sanitizeDeclarations(`${prop}:${v}`);
  const m = /^\s*([^:]+):([\s\S]*)$/.exec(out);
  if (!m || m[1].trim().toLowerCase() !== prop) return null;
  const clean = m[2].replace(/!important\s*$/i, '').replace(/;\s*$/, '').trim();
  return clean || null;
}

function cleanCss(raw: unknown): Record<string, string> {
  const css: Record<string, string> = {};
  for (const [p, v] of Object.entries(raw && typeof raw === 'object' ? raw : {}).slice(0, MAX_PROPS)) {
    const prop = String(p).toLowerCase();
    const clean = typeof v === 'string' ? cleanValue(prop, v) : null;
    if (clean !== null) css[prop] = clean;
  }
  return css;
}

function cleanTarget(raw: unknown): EditTarget | null {
  const t = raw as Partial<EditTarget> | null;
  if (!t || typeof t !== 'object') return null;
  // visual-editor paths on deep pages can be longer than a model's selectors
  const selectors = (Array.isArray(t.selectors) ? t.selectors : []).filter((s): s is string => isSafeSelector(s, MAX_TARGET_SELECTOR)).slice(0, 5);
  const tag = plain(t.tag, 40).toLowerCase();
  const all = t.all !== undefined && isSafeSelector(t.all) ? t.all : undefined;
  // "*": any tag, only for a group on a rule's selector (a shared style may style several kinds of element)
  if (!/^[a-z][a-z0-9-]*$/.test(tag) && !(tag === '*' && all)) return null;
  if (!selectors.length && !all) return null;
  const pseudo = t.pseudo === '::before' || t.pseudo === '::after' ? t.pseudo : undefined;
  const text = plain(t.text, 80).trim() || undefined;
  const hint = plain(t.hint, 120).trim() || undefined;
  const hoverUp = Number.isInteger(t.hoverUp) && t.hoverUp! >= 1 && t.hoverUp! <= 5 ? t.hoverUp : undefined;
  return { selectors, tag, ...(text ? { text } : {}), ...(hint ? { hint } : {}), ...(pseudo ? { pseudo } : {}), ...(all ? { all } : {}), ...(hoverUp ? { hoverUp } : {}) };
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
    const css = cleanCss(e.css);
    const slots: Slots = {};
    for (const k of SLOTS) {
      const c = cleanCss(e[k]);
      if (Object.keys(c).length) slots[k] = c;
    }
    const ins = e.insert && typeof e.insert === 'object' && INSERT_KINDS.includes(e.insert.kind) && ['before', 'after', 'inside'].includes(e.insert.position) && !target.pseudo && !target.all ? { kind: e.insert.kind, position: e.insert.position } : undefined;
    if (e.insert && !ins) continue; // an added element that cannot be placed safely is dropped, never applied to the anchor
    const text = e.text !== undefined && !target.pseudo && !target.all && (!ins || hasText(ins.kind)) ? plain(e.text, 500) : undefined;
    const mv = e.move && typeof e.move === 'object' ? e.move : undefined;
    const to = mv ? cleanTarget(mv.to) : null;
    const move = mv && to && !to.all && !to.pseudo && to.selectors.length > 0 && MOVE_POSITIONS.includes(mv.position) && !ins && !target.all && !target.pseudo ? { to, position: mv.position } : undefined;
    if (!hasContent({ css, text, insert: ins, move, ...slots })) continue;
    seen.add(e.id);
    out.push({
      id: e.id,
      target,
      label: plain(e.label, 80) || target.tag,
      origin: e.origin === 'webloom' ? 'webloom' : 'site',
      css,
      ...(text !== undefined ? { text } : {}),
      ...(ins ? { insert: ins } : {}),
      ...slots,
      ...(move ? { move } : {}),
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
  const rule = (selectors: string[], css: Record<string, string> | undefined) => {
    const decls = Object.entries(css ?? {}).map(([p, v]) => {
      if (p === 'font-family') for (const f of GOOGLE_FONTS) if (v.includes(f)) fonts.add(f);
      return `${p}:${v} !important`;
    });
    if (decls.length) rules.push(`${selectors.join(',')}{${decls.join(';')}}`);
  };
  const ctl = `:is(${CONTROL_SELECTOR})`;
  const st = (s: string) => `[${STATE_ATTR}~="${s}"]`;
  for (const e of edits) {
    // a group's edit (all like this, a shared style) is one attribute weaker than one element's own: that one wins
    const m = e.target.all ? `[${EDIT_ATTR}~="${e.id}"][${EDIT_ATTR}]` : `[${EDIT_ATTR}~="${e.id}"][${EDIT_ATTR}][${EDIT_ATTR}]`;
    const p = e.target.pseudo ?? '';
    const pageBg = e.target.tag === 'body' && !p && !e.target.all ? pageBackground(e.css) : null;
    if (pageBg) {
      // the page's background: drawn by <html>, which fills the whole window (the body may be shorter, and a design
      // often paints <html>); the body is see-through so nothing is drawn twice (a see-through colour, darker)
      rule([`html:has(> ${m})`], pageBg.html);
      rule([`${m}${p}`], pageBg.body);
    } else rule([`${m}${p}`], e.css);
    // its own hover, or the control it sits in being pointed at (a control's own look is not set off by an outer one);
    // the state attribute shows it while Edit Mode previews that look
    const owner = e.target.hoverUp ? [`:hover > ${'* > '.repeat(e.target.hoverUp - 1)}${m}${p}`] : [];
    rule([`${m}:hover${p}`, `${ctl}:hover ${m}:not(${ctl})${p}`, ...owner, `${m}${st('hover')}${p}`, `${st('hover')} ${m}${p}`], e.hover);
    rule([`${m}:focus-visible${p}`, `${m}:is(input,textarea,select):focus${p}`, `${m}:has(:is(input,textarea,select):focus)${p}`, `${ctl}:focus-visible ${m}:not(${ctl})${p}`, `${m}${st('focus')}${p}`, `${st('focus')} ${m}${p}`], e.focus);
    if (e.shapes) {
      const shapes = `${m} :is(path,circle,rect,ellipse,line,polyline,polygon,use,text)`;
      const { fill, stroke, ...rest } = e.shapes;
      rule([shapes], rest);
      if (fill) rule([`${shapes}:not([fill="none"])`], { fill });
      if (stroke) rule([`${shapes}:not([stroke="none"])`], { stroke });
    }
    rule([`${m}::placeholder`], e.placeholder);
    rule([`${m}::marker`, `${m} > li::marker`], e.marker);
  }
  const imports = [...fonts].map((f) => `@import url("https://fonts.googleapis.com/css2?family=${f.replace(/ /g, '+')}:wght@400;700&display=swap");`);
  return [...imports, ...rules].join('\n');
}

/** A page (body) edit's background, moved to <html>; the rest stays on the body, with its own background cleared. */
function pageBackground(css: Record<string, string>): { html: Record<string, string>; body: Record<string, string> } | null {
  const bg = Object.entries(css).filter(([k]) => k.startsWith('background'));
  if (!bg.length) return null;
  const body = Object.fromEntries(Object.entries(css).filter(([k]) => !k.startsWith('background')));
  return { html: Object.fromEntries(bg), body: { ...body, 'background-color': 'transparent', 'background-image': 'none' } };
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
  opts: { text?: string | null; all?: string | null; slot?: Slot; move?: VisualEdit['move'] | null } = {},
): { edits: VisualEdit[]; editId: string | undefined } {
  const old = base.editId ? edits.find((e) => e.id === base.editId) : undefined;
  const slots: Slots = {};
  for (const k of SLOTS) if (old?.[k]) slots[k] = { ...old[k] };
  // the patch goes to the edit's own css, or to one of its style sets (hover, the icon's shapes, ...)
  const css: Record<string, string> = opts.slot ? { ...(slots[opts.slot] ?? {}) } : { ...(old?.css ?? {}) };
  for (const [p, v] of Object.entries(patch)) {
    const prop = p.toLowerCase();
    if (v === null || v === '') delete css[prop];
    else {
      const clean = cleanValue(prop, v);
      if (clean !== null) css[prop] = clean;
    }
  }
  if (opts.slot) {
    if (Object.keys(css).length) slots[opts.slot] = css;
    else delete slots[opts.slot];
  }
  const ownCss = opts.slot ? { ...(old?.css ?? {}) } : css;
  let move = old?.move;
  if (opts.move === null) move = undefined;
  else if (opts.move) move = opts.move;
  let text = old?.text;
  if (opts.text === null) text = undefined;
  else if (typeof opts.text === 'string') text = opts.text.slice(0, 500);
  const target: EditTarget = { ...(old?.target ?? base.target) };
  // an overlay edit made before its owner was recorded learns it
  if (old && base.target.hoverUp && !target.hoverUp) target.hoverUp = base.target.hoverUp;
  if (opts.all === null) delete target.all;
  else if (typeof opts.all === 'string' && isSafeSelector(opts.all)) target.all = opts.all;
  if (target.all || target.pseudo) {
    text = undefined;
    move = undefined;
  }
  const others = edits.filter((e) => e.id !== old?.id);
  if (!hasContent({ css: ownCss, text, insert: old?.insert, move, ...slots })) return { edits: others, editId: undefined };
  const id = old?.id ?? newEditId();
  const next: VisualEdit = { id, target, label: old?.label ?? base.label.slice(0, 80), origin: base.origin, css: ownCss, ...(text !== undefined ? { text } : {}), ...(old?.insert ? { insert: old.insert } : {}), ...slots, ...(move ? { move } : {}), updatedAt: Date.now() };
  return { edits: old ? edits.map((e) => (e.id === id ? next : e)) : [...edits, next], editId: id };
}
