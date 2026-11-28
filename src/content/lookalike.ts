import { ADD_ATTR, type InsertKind } from '../shared/edits';
import { alphaOf } from './visual';

/**
 * A new element (Edit Mode's "Add an element") starts out in the look the page has now, theme included: a new button
 * copies a button near where it goes, a heading copies a heading, a box copies a card. What it copies is the element's
 * computed style, so whatever the theme did to it (by class, by tag) comes along. Nothing found: the plain defaults.
 */

/** Where to look for a model of each kind, best first. */
const MODELS: Record<Exclude<InsertKind, 'image'>, string> = {
  text: 'p, [class*="description" i], [class*="text" i]:not(:has(*))',
  heading: 'h2, h3, h1, [role="heading"]',
  button: 'button, [role="button"], a[class*="button" i], a[class*="btn" i], input[type="submit"]',
  divider: 'hr',
  box: 'article, [class*="card" i], section, aside, li, div',
};

/** The properties copied for each kind (only the ones that make the look, never size or position). */
const TYPE = ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-transform', 'color'];
const SURFACE = ['background-color', 'background-image', 'border-top-width', 'border-top-style', 'border-top-color', 'border-top-left-radius', 'box-shadow'];
const COPY: Record<Exclude<InsertKind, 'image'>, string[]> = {
  text: TYPE,
  heading: TYPE,
  button: [...TYPE, ...SURFACE, 'padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  divider: ['border-top-width', 'border-top-style', 'border-top-color', 'opacity'],
  box: [...SURFACE, 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'color'],
};

const shown = (el: Element) => {
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  const cs = getComputedStyle(el);
  return cs.visibility === 'visible' && cs.display !== 'none' && (parseFloat(cs.opacity) || 0) > 0.3;
};
const paintsSurface = (cs: CSSStyleDeclaration) => alphaOf(cs.backgroundColor) > 0.05 || cs.backgroundImage !== 'none' || (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none') || cs.boxShadow !== 'none';

/** Is `el` a good model for that kind (shown, the right size, drawing what that kind should draw)? */
function fits(kind: Exclude<InsertKind, 'image'>, el: Element): boolean {
  if (el.closest(`[${ADD_ATTR}]`) || el.closest('[data-ww="editor"]') || !shown(el)) return false;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const words = (el.textContent ?? '').trim();
  if (kind === 'text') return words.length >= 20 && r.height < 400;
  if (kind === 'heading') return words.length >= 2 && words.length <= 140;
  if (kind === 'button') return words.length >= 1 && words.length <= 40 && r.width <= 360 && r.height <= 90 && paintsSurface(cs);
  if (kind === 'divider') return true;
  // a box: a card-sized panel that draws itself
  return r.width >= 120 && r.height >= 60 && r.width <= window.innerWidth * 0.9 && paintsSurface(cs);
}

/** The nearest model: inside the place it goes first, then further out, then anywhere on the page. */
function modelFor(kind: Exclude<InsertKind, 'image'>, near: Element): Element | null {
  const sel = MODELS[kind];
  let scope: Element | null = near;
  for (let i = 0; scope && i < 6; scope = scope.parentElement, i++) {
    let found: Element[];
    try {
      found = [...scope.querySelectorAll(sel)].slice(0, 300);
    } catch {
      return null;
    }
    const hit = found.find((el) => fits(kind, el));
    if (hit) return hit;
  }
  try {
    return [...document.querySelectorAll(sel)].slice(0, 600).find((el) => fits(kind, el)) ?? null;
  } catch {
    return null;
  }
}

/** The look a new element of this kind takes from the page near `near` (empty: nothing to copy). */
export function pageLookFor(kind: InsertKind, near: Element): Record<string, string> {
  if (kind === 'image') return {};
  const model = modelFor(kind, near);
  if (!model) return {};
  const cs = getComputedStyle(model);
  const out: Record<string, string> = {};
  for (const p of COPY[kind]) {
    const v = cs.getPropertyValue(p).trim();
    if (!v || v === 'none' || v === 'normal' || (p.startsWith('background-color') && alphaOf(v) === 0)) continue;
    if (/url\(/i.test(v)) continue; // a picture of the site's would not load in an edit anyway
    out[p] = v;
  }
  // a button sized by a fixed height (no padding above and below): the same height as padding, so it is not cramped
  if (kind === 'button') {
    const h = model.getBoundingClientRect().height;
    const line = (parseFloat(cs.fontSize) || 14) * 1.25;
    const pad = Math.max(parseFloat(cs.paddingTop) || 0, Math.round((h - line) / 2));
    if (pad > 0 && pad < 40) out['padding-top'] = out['padding-bottom'] = `${pad}px`;
    out['line-height'] = '1.25';
  }
  // a card that draws only a border or shadow: no default fill under it either
  if (kind === 'box' && !out['background-color']) out['background-color'] = 'transparent';
  // a copied border is one side's: all four sides alike
  if (out['border-top-width']) {
    out.border = `${out['border-top-width']} ${out['border-top-style'] ?? 'solid'} ${out['border-top-color'] ?? 'currentColor'}`;
    if (kind === 'divider') {
      out['border-top'] = out.border;
      out.border = 'none';
    }
    delete out['border-top-width'];
    delete out['border-top-style'];
    delete out['border-top-color'];
  }
  if (out['border-top-left-radius']) {
    out['border-radius'] = out['border-top-left-radius'];
    delete out['border-top-left-radius'];
  }
  return out;
}
