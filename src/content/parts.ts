import { CONTROL_SELECTOR, MAX_EMBEDDED_SVG } from '../shared/edits';
import { svgDataUrl } from '../shared/iconSet';
import { isEditable } from './identity';

/**
 * Parts of an element that people want to change but rarely manage to click: the icon inside a button, and the overlay
 * a button draws over itself on hover (YouTube's "touch feedback" fill, Material's state layer, a ::before that darkens
 * it). Found by what they look like, never by a site's class names alone.
 */

export type IconType = 'svg' | 'font' | 'img';

const ICON_FONT_CLASS = /(^|\s)(fa[srlbd]?|fa-[\w-]+|bi|bi-[\w-]+|icon|icons?-[\w-]+|[\w-]+-icon|material-icons[\w-]*|material-symbols[\w-]*|glyphicon[\w-]*|mdi[\w-]*|codicon[\w-]*|ti|ti-[\w-]+)(\s|$)/i;
const ICON_FONT_FAMILY = /icon|awesome|material|symbols|glyph|fontello|ionicons/i;
const MAX_ICON = 96;

const sizeOf = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { w: r.width, h: r.height };
};
const shown = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.width >= 1 && r.height >= 1;
};

/** The outermost <svg> an SVG element is part of. */
function outerSvg(el: Element): SVGSVGElement | null {
  let svg: SVGSVGElement | null = el instanceof SVGSVGElement ? el : (el as SVGElement).ownerSVGElement ?? null;
  while (svg?.ownerSVGElement) svg = svg.ownerSVGElement;
  return svg;
}

/** Is this element an icon by itself? */
export function iconTypeOf(el: Element): IconType | null {
  if (el instanceof SVGElement) {
    const svg = outerSvg(el);
    if (svg !== el) return null;
    const { w, h } = sizeOf(el);
    return w > 0 && w <= MAX_ICON && h > 0 && h <= MAX_ICON ? 'svg' : null;
  }
  const tag = el.tagName;
  if (tag === 'IMG') {
    const { w, h } = sizeOf(el);
    const src = (el as HTMLImageElement).currentSrc || el.getAttribute('src') || '';
    return w > 0 && h > 0 && ((w <= 48 && h <= 48) || (/\.svg(\?|#|$)/i.test(src) && w <= MAX_ICON && h <= MAX_ICON)) ? 'img' : null;
  }
  if ((tag === 'I' || tag === 'SPAN' || tag.includes('-')) && !el.children.length) {
    const { w, h } = sizeOf(el);
    if (!(w > 0 && w <= 64 && h > 0 && h <= 64)) return null;
    const cls = typeof el.className === 'string' ? el.className : '';
    const fam = getComputedStyle(el).fontFamily;
    const before = getComputedStyle(el, '::before').content;
    const glyph = (el.textContent ?? '').trim().length <= 30 || (before && before !== 'none' && before !== 'normal');
    if (glyph && (ICON_FONT_CLASS.test(cls) || ICON_FONT_FAMILY.test(fam) || /icon/i.test(tag))) return 'font';
  }
  return null;
}

/** The icon this element is, or is part of (an SVG's inner shape means the SVG). */
function iconOfSelf(el: Element): Element | null {
  if (el instanceof SVGElement) {
    const svg = outerSvg(el);
    return svg && iconTypeOf(svg) ? svg : null;
  }
  return iconTypeOf(el) ? el : null;
}

/** Is it something people point at or tab to (or inside one), or does the site show a hand cursor over it? */
export function isPointable(el: Element): boolean {
  try {
    if (el.closest(CONTROL_SELECTOR)) return true;
  } catch {
    /* old browser */
  }
  return siteCursor(el) === 'pointer';
}

/**
 * The cursor the site gives it. Edit Mode's crosshair is the weakest rule on the page, so a cursor the site sets shows
 * through as it is; one it sets on an element around this one is inherited by the site's rules but not past the
 * crosshair rule, so the nearest element with a cursor of its own decides (nothing is switched off to read it).
 */
function siteCursor(el: Element): string {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const c = getComputedStyle(n).cursor;
    if (c !== 'crosshair') return c;
  }
  return 'auto';
}

export const isControl = (el: Element): boolean => {
  try {
    return el.matches(CONTROL_SELECTOR) || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || (el as HTMLElement).isContentEditable;
  } catch {
    return false;
  }
};

/** Elements below `root`, nearest first, at most `max` of them and `depth` levels down. */
function* below(root: Element, depth: number, max: number): Generator<Element> {
  let level: Element[] = [...root.children];
  let n = 0;
  for (let d = 0; d < depth && level.length; d++) {
    const next: Element[] = [];
    for (const el of level) {
      if (++n > max) return;
      yield el;
      next.push(...el.children);
    }
    level = next;
  }
}

/** The icon of an element: itself, or (for a control or a small box) the first icon shown inside it. */
export function findIcon(el: Element): { el: Element; type: IconType } | null {
  const self = iconOfSelf(el);
  if (self) return { el: self, type: iconTypeOf(self)! };
  const { w, h } = sizeOf(el);
  // a big section's "first icon" would be a surprise; a control or a small box has one icon people mean
  if (!isPointable(el) && (w > 480 || h > 240)) return null;
  for (const c of below(el, 7, 400)) {
    if (!isEditable(c) || !shown(c)) continue;
    const t = iconTypeOf(c);
    if (t) return { el: c, type: t };
  }
  return null;
}

/**
 * A site's SVG icon as a picture of its shape (black where it paints), to use as a mask: then a gradient can show
 * through it, as with a picked icon. The site's CSS does not reach into a picture, so each shape's paint is written on
 * it. Null for icons drawn from elsewhere (a sprite's <use>, an embedded image) or too big to keep in an edit.
 */
export function svgAsMask(svg: Element): string | null {
  if (!(svg instanceof SVGSVGElement) || svg.querySelector('use,image,foreignObject')) return null;
  const SHAPES = 'path,circle,rect,ellipse,line,polyline,polygon';
  const shapes = [...svg.querySelectorAll(SHAPES)];
  if (!shapes.length || shapes.length > 120) return null;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const copies = [...clone.querySelectorAll(SHAPES)];
  const paints = (v: string) => !!v && v !== 'none' && v !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(v);
  shapes.forEach((s, i) => {
    const cs = getComputedStyle(s);
    const c = copies[i];
    for (const a of [...c.attributes]) if (!/^(d|cx|cy|r|rx|ry|x|y|x1|y1|x2|y2|width|height|points|transform)$/.test(a.name)) c.removeAttribute(a.name);
    c.setAttribute('fill', paints(cs.fill) ? 'black' : 'none');
    if (cs.fillRule === 'evenodd') c.setAttribute('fill-rule', 'evenodd');
    if (paints(cs.stroke) && parseFloat(cs.strokeWidth) > 0) {
      c.setAttribute('stroke', 'black');
      c.setAttribute('stroke-width', String(parseFloat(cs.strokeWidth)));
      if (cs.strokeLinecap !== 'butt') c.setAttribute('stroke-linecap', cs.strokeLinecap);
      if (cs.strokeLinejoin !== 'miter') c.setAttribute('stroke-linejoin', cs.strokeLinejoin);
    }
    if (cs.display === 'none') c.setAttribute('display', 'none');
  });
  for (const x of clone.querySelectorAll('style,script,title,desc')) x.remove();
  for (const el of [clone, ...clone.querySelectorAll('*')]) for (const a of [...el.attributes]) if (/^on|^style$|^class$|^id$|^aria-|^data-|^role$|^focusable$/i.test(a.name)) el.removeAttribute(a.name);
  if (!clone.getAttribute('viewBox')) {
    const r = svg.getBoundingClientRect();
    const w = parseFloat(svg.getAttribute('width') ?? '') || r.width;
    const h = parseFloat(svg.getAttribute('height') ?? '') || r.height;
    if (!(w > 0 && h > 0)) return null;
    clone.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }
  clone.removeAttribute('width');
  clone.removeAttribute('height');
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const url = svgDataUrl(new XMLSerializer().serializeToString(clone).replace(/>\s+</g, '><'));
  return url.length + 8 <= MAX_EMBEDDED_SVG ? url : null;
}

/** For an SVG icon: what makes its colour follow `color` (on the svg, and on its shapes). */
export function svgPaint(svg: Element): { root: string[]; shapes: string[] } {
  const shapes = [...svg.querySelectorAll('path,circle,rect,ellipse,line,polyline,polygon')].slice(0, 60);
  const paints = (v: string) => !!v && v !== 'none' && !/rgba\([^)]*,\s*0\)$/.test(v) && v !== 'transparent';
  let filled = 0;
  let stroked = 0;
  for (const s of shapes) {
    const cs = getComputedStyle(s);
    if (paints(cs.fill)) filled++;
    if (paints(cs.stroke) && parseFloat(cs.strokeWidth) > 0) stroked++;
  }
  const rs = getComputedStyle(svg);
  const root = ['color'];
  if (paints(rs.fill)) root.push('fill');
  if (paints(rs.stroke)) root.push('stroke');
  const out: string[] = [];
  // only when every shape paints that way: an outline-only shape must not be filled in
  if (shapes.length && filled === shapes.length) out.push('fill');
  if (shapes.length && stroked === shapes.length) out.push('stroke');
  return { root, shapes: out };
}

const OVERLAY_NAME = /fill|overlay|ripple|state|hover|highlight|touch|feedback|backdrop|bg|background|layer|shine|tint/i;
const NOT_OVERLAY_NAME = /stroke|border|outline|focus|ring|badge|dot/i;

/**
 * The overlay a control draws over itself (on hover, press): an empty, absolutely placed box covering it, inside it or
 * as its own ::before/::after. Only for things people point at.
 */
export function findOverlay(el: Element): { el: Element; pseudo?: '::before' | '::after'; around?: true } | null {
  if (el instanceof SVGElement || !(isPointable(el) || wrapsControl(el))) return null;
  const host = el.getBoundingClientRect();
  if (host.width < 4 || host.height < 4) return null;
  // the element around it (the same size) that the site gives a background when pointed at: what people see on hover
  // (YouTube's top bar: ytd-notification-topbar-button-renderer:hover gets a grey circle; its own layer inside only
  // shows when pressed or focused)
  const around = hoverBackgroundAround(el, host);
  if (around) return { el: around, around: true };
  // a button whose wrapper (the same size) draws the hover layer next to it, not inside it (YouTube's icon buttons:
  // yt-icon-button holds the <button> and a yt-interaction layer): the wrapper's layer is the button's
  const wrap = el.parentElement;
  if (wrap && wrap !== document.body && sameBox(wrap.getBoundingClientRect(), host) && !isControl(wrap)) {
    const beside = layerIn(wrap, wrap.getBoundingClientRect(), el);
    const inside = layerIn(el, host, null);
    if (!inside && beside) return beside;
  }
  return layerIn(el, host, null);
}

/** The same-size element around it (up to three levels) that the site's rules give a background on hover. */
function hoverBackgroundAround(el: Element, host: DOMRect): Element | null {
  let n = el.parentElement;
  for (let i = 0; n && n !== document.body && i < 3; n = n.parentElement, i++) {
    if (!sameBox(n.getBoundingClientRect(), host)) return null;
    if (stateRulesFor(n).some((r) => r.hoverBg)) return n;
  }
  return null;
}

/** About the same box (a wrapper around one thing, give or take a pixel or two)? */
export const sameBox = (a: DOMRect, b: DOMRect) => Math.abs(a.left - b.left) <= 3 && Math.abs(a.top - b.top) <= 3 && Math.abs(a.width - b.width) <= 6 && Math.abs(a.height - b.height) <= 6;

/**
 * How the site shows an overlay that is hidden right now: from its own rules for the overlay in a state (pointed at,
 * pressed, focused: ":hover", ".down", "[focused]", ...), the strongest opacity and the colour they give it. YouTube's
 * icon buttons show their layer at 10% when pressed or focused; it is invisible otherwise, so measuring it shows
 * nothing. Sheets that cannot be read (from another server) are skipped.
 */
const STATE_TOKEN = /:(?:hover|active|focus-visible|focus-within|focus)(?![\w-])|\.(?:down|pressed|active|hovered|hover|focused|is-hovered|is-active|is-focused|is-pressed)\b|\[(?:focused|pressed|active|hovered|data-hover|data-hovered|data-focus|data-focused|data-pressed|data-active)(?:[~|^$*]?=[^\]]*)?\]|\[data-state(?:[~|^$*]?=["']?(?:hover|hovered|active|pressed|focus|focused|open)["']?)\]/g;
const HOVER_TOKEN = /:hover\b|\.(?:is-)?hovered?\b|\[(?:data-)?hovered?\b/;
const FOCUS_TOKEN = /:focus|\.(?:is-)?focused\b|\[(?:data-)?focus(?:ed)?\b|data-state=["']?focus/;
/** Properties whose change people see. */
const VISIBLE_PROP = /^(background|border|box-shadow|outline|opacity|color|transform|scale|translate|rotate|filter|backdrop-filter|text-decoration|fill|stroke|visibility|text-shadow|clip-path|inset|width|height)/;
type StateRule = {
  base: string;
  opacity?: number;
  color?: string;
  hoverBg?: true;
  /** Which tab it belongs in: focus, or hover (pointed at, pressed). */
  kind: 'hover' | 'focus';
  /** Its right-most part's id, class or tag: a quick way to skip rules that cannot match an element. */
  key: string | null;
};
let stateRules: StateRule[] | null = null;
let stateRulesAt = 0;
/** The right-most compound of a selector, as an id, a class or a tag (null: too general to list elements by). */
function keyOf(base: string): string | null {
  const last = base.split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() ?? '';
  const id = /#([\w-]+)/.exec(last);
  if (id) return '#' + id[1];
  const classes = [...last.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  if (classes.length) return '.' + classes[classes.length - 1];
  const tag = /^([a-z][\w-]*)/i.exec(last);
  if (tag && !/^(div|span|html|body|p|li|ul|section|main|header|footer|nav)$/i.test(tag[1])) return tag[1].toLowerCase();
  if (/\[/.test(last)) return '*'; // an attribute only: checked by matching
  return null;
}
/**
 * The page's stylesheets, roughly: how many there are and the last one's size. Reading every rule takes a while on a
 * big site (YouTube: about 300 ms), so it is done again only when this changes (a sheet added, a design applied), or
 * after a minute.
 */
const sheetsStamp = (): string => {
  const n = document.styleSheets.length;
  let last = 0;
  try {
    last = n ? document.styleSheets[n - 1].cssRules.length : 0;
  } catch {
    /* from another server */
  }
  return `${n}:${last}:${document.adoptedStyleSheets?.length ?? 0}`;
};
let stateStamp = '';
function collectStateRules(): StateRule[] {
  if (stateRules && Date.now() - stateRulesAt < 1000) return stateRules; // a burst of tree requests shares one check
  const stamp = sheetsStamp();
  if (stateRules && stamp === stateStamp && Date.now() - stateRulesAt < 60000) return stateRules;
  stateStamp = stamp;
  const out: StateRule[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const r of rules) {
      if (out.length > 6000) return;
      if (r instanceof CSSStyleRule) {
        const sel = r.selectorText;
        STATE_TOKEN.lastIndex = 0;
        if (!STATE_TOKEN.test(sel)) continue;
        let visible = false;
        for (let i = 0; i < r.style.length && !visible; i++) visible = VISIBLE_PROP.test(r.style[i]);
        if (!visible) continue;
        const op = r.style.getPropertyValue('opacity');
        const color = r.style.getPropertyValue('background-color') || r.style.getPropertyValue('background');
        for (const part of sel.split(',')) {
          STATE_TOKEN.lastIndex = 0;
          if (!STATE_TOKEN.test(part)) continue;
          STATE_TOKEN.lastIndex = 0;
          const base = part.replace(STATE_TOKEN, '').replace(/\s+/g, ' ').replace(/\s*([>+~])\s*$/, '').trim();
          if (!base) continue;
          const key = keyOf(base);
          if (!key) continue;
          const paints = !!color && !/url\(|gradient|^\s*(transparent|none|initial|unset|inherit)\s*$/.test(color);
          out.push({
            base,
            key,
            kind: FOCUS_TOKEN.test(part) && !HOVER_TOKEN.test(part) ? 'focus' : 'hover',
            ...(op && Number.isFinite(parseFloat(op)) ? { opacity: parseFloat(op) } : {}),
            ...(paints ? { color } : {}),
            ...(paints && HOVER_TOKEN.test(part) ? { hoverBg: true as const } : {}),
          });
        }
      } else if ('cssRules' in r) {
        try {
          visit((r as CSSGroupingRule).cssRules);
        } catch {
          /* unreadable */
        }
      }
    }
  };
  for (const sh of document.styleSheets) {
    try {
      visit(sh.cssRules);
    } catch {
      /* from another server */
    }
  }
  stateRules = out;
  stateRulesAt = Date.now();
  stateIndex = new Map();
  for (const r of out) {
    const list = stateIndex.get(r.key!);
    if (list) list.push(r);
    else stateIndex.set(r.key!, [r]);
  }
  return out;
}
/** The state rules by their key (id, class, tag), so an element only looks at the few that could match it. */
let stateIndex = new Map<string, StateRule[]>();

/** Could this rule match the element, by its key (before the slower full match)? */
function keyFits(el: Element, key: string | null): boolean {
  if (!key) return false;
  if (key === '*') return true;
  if (key[0] === '#') return el.id === key.slice(1);
  if (key[0] === '.') return el.classList.contains(key.slice(1));
  return el.localName === key;
}

/** The state rules that apply to an element (its hover, pressed and focus looks, as the site writes them). */
function stateRulesFor(el: Element): StateRule[] {
  collectStateRules();
  const candidates: StateRule[] = [];
  const add = (k: string) => {
    const list = stateIndex.get(k);
    if (list) candidates.push(...list);
  };
  if (el.id) add('#' + el.id);
  for (const c of el.classList) add('.' + c);
  add(el.localName);
  add('*');
  const out: StateRule[] = [];
  for (const r of candidates) {
    if (!keyFits(el, r.key)) continue;
    try {
      if (el.matches(r.base)) out.push(r);
    } catch {
      /* not a selector this browser takes */
    }
  }
  return out;
}

const effectMemo = new WeakMap<Element, { at: number; v: { hover: boolean; focus: boolean } }>();
/**
 * Does the site change how it looks when pointed at, pressed or focused (its own rules for it: a background, border,
 * shadow, colour, opacity, size ...)? Such elements are listed in Smart view and get a Hover or Focus tab, even when
 * they draw nothing at rest (a hover background, an overlay layer that shows when pointed at).
 */
export function stateEffectsOf(el: Element): { hover: boolean; focus: boolean } {
  collectStateRules();
  const hit = effectMemo.get(el);
  if (hit && hit.at === stateRulesAt) return hit.v;
  let hover = false;
  let focus = false;
  for (const r of stateRulesFor(el)) {
    if (r.kind === 'focus') focus = true;
    else hover = true;
    if (hover && focus) break;
  }
  const v = { hover, focus };
  effectMemo.set(el, { at: stateRulesAt, v });
  return v;
}

/** A colour written with the site's variables (var(--x, fallback)), as it comes out on this element. */
function resolveVars(el: Element, v: string): string | undefined {
  if (!v.includes('var(')) return v;
  const cs = getComputedStyle(el);
  const out = v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_m, name: string, fb?: string) => cs.getPropertyValue(name).trim() || (fb ?? '').trim());
  return out.includes('var(') || !out.trim() ? undefined : out.trim();
}

export function stateLookOf(el: Element): { opacity?: number; color?: string } | null {
  let opacity = 0;
  let color: string | undefined;
  for (const r of stateRulesFor(el)) {
    if (r.opacity !== undefined && r.opacity > opacity) opacity = r.opacity;
    if (r.color) color = resolveVars(el, r.color);
  }
  return opacity > 0 || color ? { ...(opacity > 0 ? { opacity } : {}), ...(color ? { color } : {}) } : null;
}

/** A wrapper filled by a button or link (a custom element around a <button>): it is pointed at whenever the button is. */
export function wrapsControl(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  for (const c of el.children) if (isControl(c) && sameBox(c.getBoundingClientRect(), r)) return true;
  return false;
}

/** The overlay drawn over `host` inside `el` (not inside `skip`: the button next to it). */
function layerIn(el: Element, host: DOMRect, skip: Element | null): { el: Element; pseudo?: '::before' | '::after' } | null {
  let best: { el: Element; pseudo?: '::before' | '::after'; score: number } | null = null;
  const consider = (cand: Element, pseudo: '::before' | '::after' | undefined, score: number) => {
    if (!best || score > best.score) best = { el: cand, pseudo, score };
  };
  for (const pseudo of ['::before', '::after'] as const) {
    const cs = getComputedStyle(el, pseudo);
    if (!cs.content || cs.content === 'none' || cs.content === 'normal') continue;
    if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
    const w = parseFloat(cs.width);
    const h = parseFloat(cs.height);
    const insets = [cs.top, cs.right, cs.bottom, cs.left].map((v) => parseFloat(v));
    const covers = (w >= host.width * 0.7 && h >= host.height * 0.7) || insets.every((v) => Number.isFinite(v) && Math.abs(v) <= 6);
    if (!covers || (cs.content !== '""' && cs.content !== "''")) continue;
    consider(el, pseudo, 1);
  }
  for (const c of below(el, 5, 200)) {
    if (!isEditable(c) || c instanceof SVGElement || (skip && skip.contains(c))) continue;
    const cs = getComputedStyle(c);
    if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
    if ((c.textContent ?? '').trim() || c.querySelector('img,svg,video,canvas,picture,input')) continue;
    const r = c.getBoundingClientRect();
    const ix = Math.min(r.right, host.right) - Math.max(r.left, host.left);
    const iy = Math.min(r.bottom, host.bottom) - Math.max(r.top, host.top);
    if (ix < host.width * 0.7 || iy < host.height * 0.7) continue;
    const name = `${typeof c.className === 'string' ? c.className : ''} ${c.tagName}`;
    let score = 2;
    if (OVERLAY_NAME.test(name)) score += 2;
    if (NOT_OVERLAY_NAME.test(name)) score -= 3;
    if (cs.pointerEvents === 'none') score += 1;
    if (!c.children.length) score += 2; // the layer that paints, not a wrapper holding layers
    consider(c, undefined, score);
  }
  const b = best as { el: Element; pseudo?: '::before' | '::after'; score: number } | null;
  return b && b.score > 0 ? { el: b.el, ...(b.pseudo ? { pseudo: b.pseudo } : {}) } : null;
}

/** How an element lays out its children. */
export function layoutOf(el: Element | null): 'flow' | 'row' | 'column' | 'grid' {
  if (!el) return 'flow';
  const cs = getComputedStyle(el);
  if (/grid/.test(cs.display)) return 'grid';
  if (/flex/.test(cs.display)) return /column/.test(cs.flexDirection) ? 'column' : 'row';
  return 'flow';
}

/** Elements that cannot hold others (or should not: dropping into a picture or a field means nothing). */
const NO_CHILDREN = /^(IMG|INPUT|TEXTAREA|SELECT|BR|HR|VIDEO|AUDIO|IFRAME|CANVAS|PICTURE|OBJECT|EMBED|SOURCE|TRACK|WBR|OPTION)$/;
export const canHold = (el: Element): boolean => !NO_CHILDREN.test(el.tagName) && !(el instanceof SVGElement);

/** Laid out side by side with its siblings (a row, or inline in a line of text)? */
export function inRow(el: Element): boolean {
  const p = el.parentElement;
  const lay = layoutOf(p);
  if (lay === 'row') return true;
  if (lay === 'column') return false;
  if (lay === 'grid') {
    // a grid with several columns runs across first
    const cols = getComputedStyle(p!).gridTemplateColumns.split(' ').filter(Boolean).length;
    return cols > 1;
  }
  const d = getComputedStyle(el).display;
  return d.startsWith('inline') || getComputedStyle(el).float !== 'none';
}
