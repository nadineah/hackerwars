import { over, parseColor, toHex, type Rgba } from '../shared/contrast';
import { colorTokens, deriveTheme, isOffTheme, mapColor, parseCssColor, replaceColors, type Role, type Theme } from '../shared/theme';
import type { Design } from '../shared/types';

/**
 * Keeps the whole page on the design's theme, with no AI. Three layers, all injected as small stylesheets (the page is
 * never rewritten, and stopping puts everything back):
 *   1. SITE STYLES: the site's own stylesheets are read, and every rule that paints a whitish or greyish surface or border
 *      (including hover, focus and open states, and colour variables) gets a matching override in the theme's colours.
 *      This fixes states BEFORE anyone triggers them (the white search pill, grey hovers, pop-up menus).
 *   2. LIVE CHECK: a light safety net for what layer 1 cannot see (inline styles, colours set by scripts, styles it could
 *      not read). It reacts to focus, click, hover and new elements and checks only the element and its nearby parents.
 *   3. DOUBLED BORDERS: a border drawn twice (a wrapper and the thing inside it) is drawn once.
 */

const SITE_STYLE_ID = 'ww-theme-style';
const LIVE_STYLE_ID = 'ww-theme-live-style';
const BORDER_STYLE_ID = 'ww-border-style';
const LIVE_ATTR = 'data-ww-theme';
const BORDER_ATTR = 'data-ww-nb';
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED', 'IMG', 'PICTURE', 'HEAD', 'MATH', 'LINK', 'META']);
const MAX_SITE_RULES = 8000;
const MAX_SITE_CSS = 500_000;
const SCAN_BUDGET_MS = 2500;
const MAX_MARKS = 300;

export interface ThemeStats {
  /** Override rules generated from the site's stylesheets. */
  rules: number;
  /** Elements corrected by the live check right now. */
  marked: number;
  /** Doubled borders removed. */
  borders: number;
  /** Stylesheets that could not be read at all. */
  unreadable: number;
}

let theme: Theme | null = null;
let generation = 0;
let siteRules = 0;
let unreadable = 0;
let bordersFixed = 0;
let triggersOn = false;
/** What the site-style overrides were built for (designs + stylesheets), so unchanged pages are not scanned again. */
let builtFor = '';
let lastBuild = 0;
const REBUILD_GAP_MS = 10_000;
const sheetTextCache = new Map<string, string | null>();
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export const getThemeStats = (): ThemeStats => ({ rules: siteRules, marked: marks.size, borders: bordersFixed, unreadable });

// ------------------------------------------------------------------------------------------- the theme, from the design

function declaredColors(css: string) {
  const surfaces: Rgba[] = [];
  const borders: Rgba[] = [];
  const text: Rgba[] = [];
  let rootBackground: Rgba | null = null;
  let sheet: CSSStyleSheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
  } catch {
    return { surfaces, borders, text, rootBackground };
  }
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        const root = /(^|[\s,>])(html|body|:root)([\s,>:.[#]|$)/.test(rule.selectorText);
        for (let i = 0; i < rule.style.length; i++) {
          const name = rule.style[i];
          const value = rule.style.getPropertyValue(name);
          if (!value || /gradient\(|url\(/.test(value)) continue;
          const tokens = colorTokens(value).map((t) => t.color);
          if (!tokens.length) continue;
          if (/^background(-color)?$/.test(name)) {
            surfaces.push(...tokens);
            if (root && tokens[0].a >= 0.9) rootBackground = tokens[0];
          } else if (/^(border|outline)(-(top|right|bottom|left))?(-color)?$/.test(name)) borders.push(...tokens.filter((t) => t.a > 0.1));
          else if (name === 'color') text.push(tokens[0]);
          else if (name.startsWith('--')) {
            if (/(^|-)(bg|background|surface|card|panel|base)(-|$)/i.test(name)) {
              surfaces.push(...tokens);
              if (root && /(bg|background)/i.test(name) && !rootBackground && tokens[0].a >= 0.9) rootBackground = tokens[0];
            } else if (/(border|line|outline|divider|stroke)/i.test(name)) borders.push(...tokens);
            else if (/(text|ink|foreground|fg)/i.test(name)) text.push(tokens[0]);
          }
        }
      } else if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules);
    }
  };
  walk(sheet.cssRules);
  return { surfaces, borders, text, rootBackground };
}

/** The colour behind the page as it is now, or null if an image or gradient is painted there. */
function pageBackgroundNow(): Rgba | null {
  for (const el of [document.body, document.documentElement]) {
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.backgroundImage !== 'none') return null;
    const c = parseColor(cs.backgroundColor);
    if (c && c.a > 0.9) return c;
  }
  return null;
}

function themeFrom(designs: Design[]): Theme | null {
  const d = declaredColors(designs.map((x) => x.css).join('\n'));
  const mostCommon = (list: Rgba[]): Rgba | null => {
    const counts = new Map<string, { c: Rgba; n: number }>();
    for (const c of list) {
      const k = toHex(c);
      counts.set(k, { c, n: (counts.get(k)?.n ?? 0) + 1 });
    }
    return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.c ?? null;
  };
  const borders = mostCommon(d.borders);
  return deriveTheme({ pageBackground: pageBackgroundNow() ?? d.rootBackground, surfaces: d.surfaces, borders: borders ? [borders] : [], text: mostCommon(d.text) });
}

// ------------------------------------------------------------------------------------------- layer 1: the site's own stylesheets

function fetchViaBackground(url: string): Promise<string | null> {
  if (sheetTextCache.has(url)) return Promise.resolve(sheetTextCache.get(url)!);
  return chrome.runtime
    .sendMessage({ type: 'ww:fetchSheet', url })
    .then((r: { ok?: boolean; text?: string } | undefined) => {
      const text = r?.ok && typeof r.text === 'string' ? r.text : null;
      sheetTextCache.set(url, text);
      return text;
    })
    .catch(() => null);
}

const isRootSelector = (sel: string) => /(^|[\s,>+~])(html|body|:root)([\s,>+~:.[#]|$)/.test(sel);
const WRAPPER = /^CSS(Media|Supports|Container)Rule$/;

function roleOf(name: string): Role | null {
  if (/^background-color$/.test(name)) return 'surface';
  if (/^(border|outline)(-(top|right|bottom|left))?-color$/.test(name)) return 'border';
  if (name.startsWith('--')) {
    if (/(^|-)(bg|background|surface|card|panel|container|base)(-|$)/i.test(name)) return 'surface';
    if (/(border|divider|line|outline|stroke)/i.test(name)) return 'border';
  }
  return null;
}

async function overridesFor(sheetRules: CSSRuleList, t: Theme, gen: number, started: number, out: string[]): Promise<void> {
  let n = 0;
  const visit = async (rules: CSSRuleList, wrap: string[]): Promise<void> => {
    for (const rule of Array.from(rules)) {
      if (gen !== generation || siteRules >= MAX_SITE_RULES || Date.now() - started > SCAN_BUDGET_MS) return;
      if (++n % 250 === 0) await tick();
      if (rule instanceof CSSStyleRule) {
        const sel = rule.selectorText;
        if (!sel || sel.length > 600 || /::|:(before|after|first-line|first-letter)\b|:host|:-/.test(sel)) continue;
        const root = isRootSelector(sel);
        const decls: string[] = [];
        for (let i = 0; i < rule.style.length; i++) {
          const name = rule.style[i];
          const role = roleOf(name);
          if (!role) continue;
          const value = rule.style.getPropertyValue(name);
          if (!value || /var\(|gradient\(|url\(/.test(value)) continue;
          const mapped = replaceColors(value, (c) => mapColor(c, role, t, root && role === 'surface'));
          if (mapped !== value) decls.push(`${name}:${mapped}!important`);
        }
        if (!decls.length) continue;
        let css = `:where(${sel}){${decls.join(';')}}`;
        for (const w of [...wrap].reverse()) css = `${w}{${css}}`;
        out.push(css);
        siteRules++;
      } else if ('cssRules' in rule) {
        const kind = rule.constructor.name;
        const cond = (rule as CSSConditionRule).conditionText;
        if (WRAPPER.test(kind) && cond) {
          const head = kind === 'CSSMediaRule' ? `@media ${cond}` : kind === 'CSSSupportsRule' ? `@supports ${cond}` : `@container ${cond}`;
          await visit((rule as CSSGroupingRule).cssRules, [...wrap, head]);
        } else if (kind !== 'CSSKeyframesRule' && kind !== 'CSSFontFaceRule') await visit((rule as CSSGroupingRule).cssRules, wrap);
      } else if (rule instanceof CSSImportRule && rule.styleSheet) {
        try {
          await visit(rule.styleSheet.cssRules, wrap);
        } catch {
          /* unreadable import */
        }
      }
    }
  };
  await visit(sheetRules, []);
}

async function readableRules(sheet: CSSStyleSheet): Promise<CSSRuleList | null> {
  try {
    return sheet.cssRules;
  } catch {
    // another origin's stylesheet: the browser will not show its rules to the page. The background can fetch the text.
    const href = sheet.href;
    if (!href || !/^https?:/i.test(href)) return null;
    const text = await fetchViaBackground(href);
    if (!text) return null;
    try {
      const copy = new CSSStyleSheet();
      copy.replaceSync(text);
      return copy.cssRules;
    } catch {
      return null;
    }
  }
}

async function buildSiteStyles(t: Theme, gen: number): Promise<void> {
  const started = Date.now();
  siteRules = 0;
  unreadable = 0;
  const chunks: string[] = [];
  const sheets: CSSStyleSheet[] = [...Array.from(document.styleSheets), ...document.adoptedStyleSheets];
  for (const sheet of sheets) {
    if (gen !== generation) return;
    const owner = sheet.ownerNode as Element | null;
    if (owner && (owner.hasAttribute('data-whimsyweb') || owner.id?.startsWith('ww-'))) continue; // not ours to restyle
    if (sheet.disabled || sheet.media?.mediaText === 'not all') continue;
    const rules = await readableRules(sheet);
    if (!rules) {
      unreadable++;
      continue;
    }
    await overridesFor(rules, t, gen, started, chunks);
  }
  if (gen !== generation) return;
  let css = chunks.join('\n');
  if (css.length > MAX_SITE_CSS) css = css.slice(0, css.lastIndexOf('}\n', MAX_SITE_CSS) + 1);
  let st = document.getElementById(SITE_STYLE_ID) as HTMLStyleElement | null;
  if (!st) {
    st = document.createElement('style');
    st.id = SITE_STYLE_ID;
    // before the design's own styles, so the design wins any tie
    const firstDesign = document.documentElement.querySelector(':scope > style[data-whimsyweb]');
    document.documentElement.insertBefore(st, firstDesign);
  }
  st.textContent = css;
}

// ------------------------------------------------------------------------------------------- layer 2: the live safety net

interface Mark {
  id: number;
  decls: Record<string, string>;
}
const marks = new Map<Element, Mark>();
let nextMark = 1;
const pending = new Set<Element>();
let liveTimer: number | undefined;
let lastLive = 0;
let lastHover: Element | null = null;

function offThemeDecls(el: Element, t: Theme): Record<string, string> | null {
  const cs = getComputedStyle(el);
  const decls: Record<string, string> = {};
  if (cs.backgroundImage === 'none') {
    const bg = parseColor(cs.backgroundColor);
    if (bg && isOffTheme(bg, 'surface', t)) {
      const m = mapColor(bg, 'surface', t, el === document.body || el === document.documentElement);
      if (m) decls['background-color'] = toHex(m);
    }
  }
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    if (parseFloat(cs.getPropertyValue(`border-${side}-width`)) < 0.5 || cs.getPropertyValue(`border-${side}-style`) === 'none') continue;
    const bc = parseColor(cs.getPropertyValue(`border-${side}-color`));
    if (bc && isOffTheme(bc, 'border', t)) decls[`border-${side}-color`] = toHex(mapColor(bc, 'border', t)!);
  }
  if (parseFloat(cs.outlineWidth) >= 0.5 && cs.outlineStyle !== 'none') {
    const oc = parseColor(cs.outlineColor);
    if (oc && isOffTheme(oc, 'border', t)) decls['outline-color'] = toHex(mapColor(oc, 'border', t)!);
  }
  return Object.keys(decls).length ? decls : null;
}

function writeLiveStyles() {
  let st = document.getElementById(LIVE_STYLE_ID) as HTMLStyleElement | null;
  if (!st) {
    st = document.createElement('style');
    st.id = LIVE_STYLE_ID;
    const firstDesign = document.documentElement.querySelector(':scope > style[data-whimsyweb]');
    document.documentElement.insertBefore(st, firstDesign);
  }
  st.textContent = [...marks.values()].map((m) => `[${LIVE_ATTR}="${m.id}"][${LIVE_ATTR}]{${Object.entries(m.decls).map(([k, v]) => `${k}:${v}!important`).join(';')}}`).join('\n');
}

function checkElements(els: Iterable<Element>) {
  if (!theme) return;
  for (const el of els) {
    if (!el.isConnected || SKIP_TAGS.has(el.tagName)) continue;
    if (el.closest('[data-ww-preview],[data-ww-snip],#ww-theme-style,#ww-theme-live-style')) continue;
    // measure the element as the SITE paints it right now (without our marker), so a state that ended is not kept forever
    const had = marks.get(el);
    if (had) el.removeAttribute(LIVE_ATTR);
    const d = offThemeDecls(el, theme);
    if (d) {
      const id = had?.id ?? nextMark++;
      marks.set(el, { id, decls: d });
      el.setAttribute(LIVE_ATTR, String(id));
    } else if (had) marks.delete(el);
  }
}

function runLive() {
  lastLive = Date.now();
  if (!theme) return;
  const targets = new Set<Element>();
  for (const el of pending) {
    targets.add(el);
    let p = el.parentElement;
    for (let i = 0; p && i < 6 && p !== document.body; i++, p = p.parentElement) targets.add(p);
    // a search box or menu that just opened: look at what is inside it too
    const box = el.closest('form,[role="search"],[role="dialog"],[role="listbox"],[role="menu"],[role="combobox"]');
    if (box) {
      let k = 0;
      for (const c of box.querySelectorAll('*')) {
        targets.add(c);
        if (++k >= 80) break;
      }
    }
  }
  pending.clear();
  // every element we corrected earlier is re-measured too (a hover or focus may have ended)
  for (const el of marks.keys()) targets.add(el);
  if (marks.size > MAX_MARKS) for (const k of [...marks.keys()].slice(0, marks.size - MAX_MARKS)) {
    k.removeAttribute(LIVE_ATTR);
    marks.delete(k);
  }
  checkElements(targets);
  writeLiveStyles();
}

function queue(el: Element | null) {
  if (!el || !triggersOn) return;
  pending.add(el);
  window.clearTimeout(liveTimer);
  // wait for the transition to land, and never run more often than every ~120ms
  const wait = Math.max(90, 120 - (Date.now() - lastLive));
  liveTimer = window.setTimeout(runLive, wait);
}

const onFocus = (e: Event) => queue(e.target as Element);
const onPointerOver = (e: Event) => {
  const t = e.target as Element;
  if (t === lastHover) return;
  lastHover = t;
  queue(t);
};
const onTransitionEnd = (e: Event) => queue(e.target as Element);
const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape' || e.key.startsWith('Arrow')) queue(e.target as Element);
};

function startTriggers() {
  if (triggersOn) return;
  triggersOn = true;
  const opt = { capture: true, passive: true } as const;
  document.addEventListener('focusin', onFocus, opt);
  document.addEventListener('focusout', onFocus, opt);
  document.addEventListener('pointerdown', onFocus, opt);
  document.addEventListener('click', onFocus, opt);
  document.addEventListener('pointerover', onPointerOver, opt);
  document.addEventListener('transitionend', onTransitionEnd, opt);
  document.addEventListener('keydown', onKey, opt);
}
function stopTriggers() {
  if (!triggersOn) return;
  triggersOn = false;
  const opt = { capture: true } as const;
  document.removeEventListener('focusin', onFocus, opt);
  document.removeEventListener('focusout', onFocus, opt);
  document.removeEventListener('pointerdown', onFocus, opt);
  document.removeEventListener('click', onFocus, opt);
  document.removeEventListener('pointerover', onPointerOver, opt);
  document.removeEventListener('transitionend', onTransitionEnd, opt);
  document.removeEventListener('keydown', onKey, opt);
  window.clearTimeout(liveTimer);
  pending.clear();
}

/** New elements appear (a menu opens, a feed loads): check the added ones, nothing else. */
export function noteAddedNodes(records: MutationRecord[]): void {
  if (!triggersOn) return;
  let count = 0;
  for (const r of records) {
    for (const n of r.addedNodes) {
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const el = n as Element;
      if (el.id?.startsWith('ww-')) continue;
      pending.add(el);
      for (const c of el.querySelectorAll('*')) {
        pending.add(c);
        if (++count > 150) break;
      }
      if (count > 150) break;
    }
    if (count > 150) break;
  }
  if (pending.size) queue([...pending][0]);
}

// ------------------------------------------------------------------------------------------- layer 3: doubled borders

const bordered = (cs: CSSStyleDeclaration) => {
  for (const s of ['top', 'right', 'bottom', 'left'] as const) {
    if (parseFloat(cs.getPropertyValue(`border-${s}-width`)) >= 0.5 && cs.getPropertyValue(`border-${s}-style`) !== 'none') {
      const c = parseColor(cs.getPropertyValue(`border-${s}-color`));
      if (c && c.a > 0.15) return c;
    }
  }
  if (parseFloat(cs.outlineWidth) >= 0.5 && cs.outlineStyle !== 'none') {
    const c = parseColor(cs.outlineColor);
    if (c && c.a > 0.15) return c;
  }
  return null;
};
const closeColor = (a: Rgba, b: Rgba) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 60;

/** A border drawn twice (a box and its direct, almost identical child) is drawn once: the outer one stays. */
export async function dedupeBorders(): Promise<number> {
  const marked = new Map<Element, number>();
  const root = document.body ?? document.documentElement;
  const all = root.querySelectorAll('*');
  let seen = 0;
  for (const el of Array.from(all)) {
    if (++seen > 5000) break;
    if (seen % 600 === 0) await tick();
    if (SKIP_TAGS.has(el.tagName) || el.id?.startsWith('ww-')) continue;
    const parent = el.parentElement;
    if (!parent || parent === document.body) continue;
    const cs = getComputedStyle(el);
    const own = bordered(cs);
    if (!own) continue;
    const pcs = getComputedStyle(parent);
    const pb = bordered(pcs);
    if (!pb || !closeColor(own, pb)) continue;
    const r = el.getBoundingClientRect();
    const p = parent.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    const inset = 9;
    if (Math.abs(r.left - p.left) <= inset && Math.abs(r.right - p.right) <= inset && Math.abs(r.top - p.top) <= inset && Math.abs(r.bottom - p.bottom) <= inset) marked.set(el, marked.size + 1);
  }
  let st = document.getElementById(BORDER_STYLE_ID) as HTMLStyleElement | null;
  if (!marked.size && !st) {
    bordersFixed = 0;
    return 0;
  }
  if (!st) {
    st = document.createElement('style');
    st.id = BORDER_STYLE_ID;
    const firstDesign = document.documentElement.querySelector(':scope > style[data-whimsyweb]');
    document.documentElement.insertBefore(st, firstDesign);
  }
  document.querySelectorAll(`[${BORDER_ATTR}]`).forEach((e) => e.removeAttribute(BORDER_ATTR));
  const rules: string[] = [];
  let id = 1;
  for (const el of marked.keys()) {
    el.setAttribute(BORDER_ATTR, String(id));
    rules.push(`[${BORDER_ATTR}="${id}"][${BORDER_ATTR}]{border-color:transparent!important;outline-color:transparent!important}`);
    id++;
  }
  st.textContent = rules.join('\n');
  bordersFixed = marked.size;
  return marked.size;
}

// ------------------------------------------------------------------------------------------- control

/** Starts (or restarts) the theme layers for the designs now applied on this page. */
export async function startTheme(designs: Design[]): Promise<void> {
  const designKey = designs.map((d) => `${d.id}@${d.updatedAt}`).join('|');
  const key = `${designKey}#${document.styleSheets.length}+${document.adoptedStyleSheets.length}`;
  const built = !!document.getElementById(SITE_STYLE_ID);
  if (theme && built && key === builtFor) return; // nothing changed: the overrides are still right
  // only the set of stylesheets changed (a page loading more CSS): rebuild, but not more often than every 10s
  if (theme && built && builtFor.startsWith(designKey + '#') && Date.now() - lastBuild < REBUILD_GAP_MS) return;
  const gen = ++generation;
  theme = themeFrom(designs);
  if (!theme) {
    stopTheme(false);
    return;
  }
  startTriggers();
  await buildSiteStyles(theme, gen);
  if (gen !== generation) return;
  builtFor = key;
  lastBuild = Date.now();
  // the live layer re-checks the places that already showed something off-theme
  checkElements(marks.keys());
  writeLiveStyles();
}

/** Puts everything back as the design left it. `bump` invalidates a scan that is still running. */
export function stopTheme(bump = true): void {
  if (bump) generation++;
  theme = null;
  stopTriggers();
  for (const el of marks.keys()) el.removeAttribute(LIVE_ATTR);
  marks.clear();
  for (const id of [SITE_STYLE_ID, LIVE_STYLE_ID, BORDER_STYLE_ID]) document.getElementById(id)?.remove();
  document.querySelectorAll(`[${BORDER_ATTR}]`).forEach((e) => e.removeAttribute(BORDER_ATTR));
  siteRules = 0;
  bordersFixed = 0;
  unreadable = 0;
  builtFor = '';
}
