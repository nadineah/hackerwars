import { CONTROL_SELECTOR } from '../shared/edits';

/**
 * Edit Mode's "Smart" view: the containers people see as one piece although they draw nothing themselves (a video card
 * whose thumbnail and title do the drawing, a row of buttons, the page's header). Found by how they sit on the page:
 * repeated like their siblings, clickable as a whole, a section of the page, or a group of separate things.
 */

export type UnitKind = 'repeat' | 'control' | 'section' | 'group';
/** Which of two containers with the same box is kept (the higher; on a tie the outer one). */
export const UNIT_RANK: Record<UnitKind, number> = { repeat: 4, control: 3, section: 2, group: 1 };

const SECTION_TAGS = /^(HEADER|NAV|MAIN|ASIDE|FOOTER|ARTICLE|SECTION|FORM|DIALOG|FIGURE|TABLE|LI|UL|OL|DL|MENU|DETAILS|FIELDSET)$/;
const SECTION_ROLES = /^(banner|navigation|main|complementary|contentinfo|region|dialog|alertdialog|list|listitem|article|form|menu|menubar|tablist|toolbar|grid|row|feed|search|tabpanel)$/;
/** Classes that say what state an item is in, not what it is (the third card being "selected" keeps it a card). */
const STATE_CLASS = /(^|[-_])(active|selected|hover(ed)?|focus(ed)?|open(ed)?|expanded|collapsed|current|checked|visible|hidden|show(n|ing)?|loaded|loading|disabled|first|last|odd|even|animat\w*|enter\w*|leav\w*|fade\w*)($|[-_])/i;

const shownBox = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.width >= 4 && r.height >= 4;
};

/** What makes two siblings "the same kind of item": the tag and the classes that are not a state. */
function signature(el: Element): string {
  // a site's own component (ytd-rich-item-renderer) is the same kind of item by its name alone: its classes change
  // with its state (hovered, playing a preview, selected), which must not turn a card into something else
  if (el.tagName.includes('-')) return el.tagName;
  const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') ?? '');
  return `${el.tagName}|${el.getAttribute('role') ?? ''}|${cls
    .split(/\s+/)
    .filter((c) => c && !STATE_CLASS.test(c))
    .sort()
    .join(' ')}`;
}

const sigCache = new WeakMap<Element, { at: number; counts: Map<string, number> }>();
/** How many shown siblings (itself included) are the same kind of item as `el`. */
export function repeatCount(el: Element): number {
  const p = el.parentElement;
  if (!p) return 0;
  const now = performance.now();
  let c = sigCache.get(p);
  if (!c || now - c.at > 600) {
    const counts = new Map<string, number>();
    let n = 0;
    for (const k of p.children) {
      if (++n > 400) break;
      if (!shownBox(k)) continue;
      const s = signature(k);
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    c = { at: now, counts };
    sigCache.set(p, c);
  }
  return c.counts.get(signature(el)) ?? 0;
}

/** Its children that are shown with a size (at most `max` looked at). */
function shownKids(el: Element, max = 60): number {
  let n = 0;
  let seen = 0;
  for (const k of el.children) {
    if (++seen > max) break;
    if (shownBox(k)) n++;
  }
  return n;
}

const isControlish = (el: Element) => {
  try {
    return el.matches(CONTROL_SELECTOR);
  } catch {
    return false;
  }
};

/** Why this element is a container people would pick as one piece (null: it is not one). */
export function unitKind(el: Element, r: DOMRect = el.getBoundingClientRect(), cs: CSSStyleDeclaration = getComputedStyle(el)): UnitKind | null {
  if (r.width < 8 || r.height < 8) return null;
  const tag = el.tagName;
  if (tag === 'BODY' || tag === 'HTML' || el instanceof SVGElement) return null;
  const hasContent = el.children.length > 0 || /\S/.test(el.textContent ?? '');
  if (!hasContent) return null; // an empty box drawing nothing: a spacer, or a layer for effects
  if (r.width >= 24 && r.height >= 16 && repeatCount(el) >= 2) return 'repeat';
  if (isControlish(el) && el.children.length) return 'control';
  if (SECTION_TAGS.test(tag) || SECTION_ROLES.test(el.getAttribute('role') ?? '')) return 'section';
  const kids = shownKids(el);
  if ((/flex|grid/.test(cs.display) && kids >= 2) || kids >= 3) return 'group';
  return null;
}

const ROLE_NAME: Record<string, string> = { menu: 'Menu', menubar: 'Menu', tablist: 'Tabs', toolbar: 'Toolbar', feed: 'Feed', list: 'List', listitem: 'List item', dialog: 'Dialog', search: 'Search', row: 'Row', grid: 'Grid' };

/**
 * A plain name for a container ("Card", "Row of 4", "Grid of 24", "List item", "Menu"), or null for anything else.
 * Only for boxes that are not already something more specific (a link, a heading, a section of the page).
 */
export function containerName(el: Element): string | null {
  const role = el.getAttribute('role') ?? '';
  if (ROLE_NAME[role]) return ROLE_NAME[role];
  if (el.tagName === 'LI') return 'List item';
  if (el.tagName === 'MENU') return 'Menu';
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return null;
  const cs = getComputedStyle(el);
  const kids = shownKids(el, 400);
  if (r.width >= 24 && r.height >= 16 && repeatCount(el) >= 2) {
    // an item of a row or grid with a picture and words is a card; a short line of text is an item
    return el.querySelector('img,picture,video,svg,canvas') && r.height >= 60 ? 'Card' : 'Item';
  }
  if (/grid/.test(cs.display) && kids >= 2) return `Grid of ${kids}`;
  if (/flex/.test(cs.display) && kids >= 2) return /column/.test(cs.flexDirection) ? `Stack of ${kids}` : `Row of ${kids}`;
  if (kids >= 3) return `Group of ${kids}`;
  return null;
}

/** Words that name a card: its heading, or a title the site gave it. */
export function cardTitle(el: Element): string {
  const h = el.querySelector('h1,h2,h3,h4,h5,h6,[id$="title" i],[class*="title" i]');
  const t = (h?.textContent ?? '').replace(/\s+/g, ' ').trim() || h?.getAttribute('title') || el.querySelector('[title]')?.getAttribute('title') || el.getAttribute('aria-label') || '';
  return t.slice(0, 40);
}
