import { over, parseColor, toHex, type Rgba } from '../shared/contrast';
import { colorTokens, deriveTheme, isOffTheme, mapColor, parseCssColor, replaceColors, type Role, type Theme } from '../shared/theme';
import type { Design } from '../shared/types';
import { compileLearned, learnedKey, MAX_LEARNED, validateLearned, type LearnedRule, designKeyOf } from '../shared/learned';
import { isStableToken } from './identity';

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

/**
 * Colour variables can hold different values in different places (`:root { --bg: white }` but `.dark { --bg: red }`),
 * so a variable is read where the rule actually applies: on an element the rule matches. When none matches yet (a
 * popup not opened), the page-level value is used only for variables the site gives ONE value everywhere.
 */
let varSource: CSSStyleDeclaration | null = null;
/** Every custom property the site's stylesheets declare, with the distinct values they are given. */
let declaredVars = new Map<string, Set<string>>();
const VAR_REF = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g;

function collectDeclaredVars(lists: CSSRuleList[]): void {
  declaredVars = new Map();
  let n = 0;
  const visit = (rules: CSSRuleList) => {
    for (const r of Array.from(rules)) {
      if (++n > 60_000) return;
      if (r instanceof CSSStyleRule) {
        for (let i = 0; i < r.style.length; i++) {
          const name = r.style[i];
          if (!name.startsWith('--')) continue;
          const set = declaredVars.get(name) ?? new Set<string>();
          set.add(r.style.getPropertyValue(name).trim());
          declaredVars.set(name, set);
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
  for (const list of lists) {
    try {
      visit(list);
    } catch {
      /* unreadable */
    }
  }
}

/** The value with its var(--x, fallback) references replaced by what they hold for `where` (a few levels deep). */
function resolveVars(value: string, where: CSSStyleDeclaration): string | null {
  let v = value;
  for (let depth = 0; depth < 4 && v.includes('var('); depth++) {
    v = v.replace(VAR_REF, (_m, name: string, fallback?: string) => where.getPropertyValue(name).trim() || (fallback ?? '').trim());
  }
  return v.includes('var(') ? null : v;
}

/** May this value be resolved at the page level? Only when each variable it uses has a single value everywhere. */
const sameEverywhere = (raw: string): boolean => {
  for (const m of raw.matchAll(VAR_REF)) if ((declaredVars.get(m[1])?.size ?? 0) > 1) return false;
  return true;
};

/** A colour as CSS, keeping its transparency (a see-through overlay must stay see-through). */
const cssColour = (c: Rgba): string => (c.a < 1 ? `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${Math.round(c.a * 1000) / 1000})` : toHex(c));

/** Overrides for background and border colours this rule sets through variables (the ones not handled already). */
function variableOverrides(style: CSSStyleDeclaration, sel: string, t: Theme, root: boolean, done: string[]): string[] {
  const out: string[] = [];
  const has = (p: string) => done.some((d) => d.startsWith(p + ':'));
  // where the variables are read: up to five elements the rule matches now (they must all agree), else the page
  let places: CSSStyleDeclaration[] | undefined;
  const contexts = (raw: string): CSSStyleDeclaration[] => {
    if (places === undefined) {
      places = [];
      try {
        const found = document.querySelectorAll(sel);
        for (let i = 0; i < found.length && i < 5; i++) places.push(getComputedStyle(found[i]));
      } catch {
        /* a selector the browser cannot query (e.g. with a state) */
      }
    }
    if (places.length) return places;
    if (!sameEverywhere(raw)) return []; // different values in different places, and nothing to read it on
    varSource ??= getComputedStyle(document.documentElement);
    return [varSource];
  };
  /** The colour this value gives, only when it is the same off-theme colour everywhere the rule applies. */
  const colourOf = (raw: string, role: Role): Rgba | null => {
    if (!raw || !raw.includes('var(') || /gradient\(|url\(/.test(raw)) return null;
    let first: Rgba | null = null;
    for (const ctx of contexts(raw)) {
      const resolved = resolveVars(raw, ctx);
      if (!resolved) return null;
      const tok = colorTokens(resolved)[0];
      const c = tok ? parseCssColor(tok.text) : parseCssColor(resolved.trim());
      if (!c || !isOffTheme(c, role, t)) return null; // somewhere it is a colour of its own (a red card in a dark section)
      first ??= c;
    }
    return first;
  };
  if (!has('background-color')) {
    const c = colourOf(style.getPropertyValue('background-color') || style.getPropertyValue('background'), 'surface');
    const m = c ? mapColor(c, 'surface', t, root) : null;
    if (m) out.push(`background-color:${cssColour(m)}!important`);
  }
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const p = `border-${side}-color`;
    if (has(p)) continue;
    const c = colourOf(style.getPropertyValue(p) || style.getPropertyValue('border-color') || style.getPropertyValue(`border-${side}`) || style.getPropertyValue('border'), 'border');
    const m = c ? mapColor(c, 'border', t) : null;
    if (m) out.push(`${p}:${cssColour(m)}!important`);
  }
  return out;
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
        // Colours given through a variable (often with a scrambled name, e.g. YouTube's search suggestions use
        // var(--t518e925f61bdcb91)): look up what the variable holds and recolour the rule when that is off-theme.
        // Without this the surface starts white and is only fixed by the live check, which shows as a flash.
        decls.push(...variableOverrides(rule.style, sel, t, root, decls));
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

/** Parsed copies of other-origin sheets, kept alive while a build uses their rules. */
let copies: CSSStyleSheet[] = [];

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
      copies.push(copy); // the rule list alone does not keep the sheet (and its rules) alive
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
  varSource = null; // read the variables as they are now
  copies = [];
  const chunks: string[] = [];
  const sheets: CSSStyleSheet[] = [...Array.from(document.styleSheets), ...document.adoptedStyleSheets];
  // read every sheet first (other-origin ones through the background), so the variables of ALL of them are known
  // before any rule is judged: a variable the site gives different values in different places is never guessed
  const lists: CSSRuleList[] = [];
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
    lists.push(rules);
  }
  collectDeclaredVars(lists);
  for (const rules of lists) {
    if (gen !== generation) return;
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
/** Elements to check at the next frame, and how far to look from each (see Reach). */
const pending = new Map<Element, Reach>();
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
      learn(el, d);
    } else if (had) marks.delete(el);
  }
}

// ------------------------------------------------------------------------------------------- learned corrections

const LEARNED_STYLE_ID = 'ww-theme-learned';
/** What the live check learned on this site for the designs on now, by selector (with its state). */
let learned = new Map<string, LearnedRule>();
let learnedFor = '';
let learnedDirty = false;
let saveTimer: number | undefined;

/** Classes that name a state the site switches on and off. */
const STATE_CLASS = /(^|[-_])(active|selected|open|opened|expanded|focus(ed)?|hover(ed)?|checked|current|show(n|ing)?|visible|pressed|highlighted?)($|[-_])/i;

/** "This kind of element in this state": its tag and up to two stable classes, plus :hover / :focus-within. */
function learnSelector(el: Element): string | null {
  if (el === document.body || el === document.documentElement) return null;
  const stable = [...el.classList].filter(isStableToken);
  // a state class (active, selected, open...) must be part of the rule, or the colour would stick outside that state
  const stateCls = stable.find((c) => STATE_CLASS.test(c));
  const cls = stateCls ? [stable.find((c) => c !== stateCls), stateCls].filter((c): c is string => !!c) : stable.slice(0, 2);
  if (!cls.length) return null;
  const base = el.tagName.toLowerCase() + cls.map((c) => '.' + CSS.escape(c)).join('');
  if (!/^[a-z][a-z0-9-]*(?:\.[A-Za-z_][\w-]*){1,2}$/.test(base)) return null;
  let state = '';
  try {
    state = el.matches(':hover') ? ':hover' : el.matches(':focus-within') ? ':focus-within' : '';
  } catch {
    state = '';
  }
  return base + state;
}

function learn(el: Element, decls: Record<string, string>): void {
  if (!learnedFor || learned.size >= MAX_LEARNED) return;
  const sel = learnSelector(el);
  if (!sel) return;
  const prev = learned.get(sel);
  const merged = { ...(prev?.decls ?? {}), ...decls };
  if (prev && JSON.stringify(prev.decls) === JSON.stringify(merged)) return;
  learned.set(sel, { sel, decls: merged });
  learnedDirty = true;
  writeLearnedStyles();
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveLearned, 1500);
}

function writeLearnedStyles(): void {
  let st = document.getElementById(LEARNED_STYLE_ID) as HTMLStyleElement | null;
  if (!learned.size) {
    st?.remove();
    return;
  }
  if (!st) {
    st = document.createElement('style');
    st.id = LEARNED_STYLE_ID;
    // before the design's own styles, so the design wins any tie (like the other theme overrides)
    const firstDesign = document.documentElement.querySelector(':scope > style[data-whimsyweb]');
    document.documentElement.insertBefore(st, firstDesign);
  }
  st.textContent = compileLearned([...learned.values()]);
}

/** Saved by the background worker (the page script only asks; it never writes storage itself). */
function saveLearned(): void {
  if (!learnedDirty || !learnedFor) return;
  learnedDirty = false;
  void chrome.runtime.sendMessage({ type: 'ww:learnTheme', designKey: learnedFor, rules: [...learned.values()] }).catch(() => undefined);
}

/** Loads what was learned on this site for exactly these designs, before anything else is drawn. */
async function loadLearned(designKey: string): Promise<void> {
  if (learnedFor === designKey) return;
  learnedFor = designKey;
  learned = new Map();
  try {
    const got = await chrome.storage.local.get(learnedKey(location.hostname));
    const set = validateLearned(got[learnedKey(location.hostname)]);
    if (set && set.designKey === designKey) for (const r of set.rules) learned.set(r.sel, r);
  } catch {
    /* nothing saved */
  }
  // nothing saved for this version yet: the previous corrections stay on screen until the new scan is done (startTheme
  // writes them then), so a design change does not flash the site's own colours in between
  if (learned.size) writeLearnedStyles();
}

/**
 * How far a check looks from an element. A hover or click looks at its parents and inside it (rare, and what people
 * see); something that opened or was added looks inside it; a class switch looks a little inside; an inline style
 * change looks at the element only (busy pages change inline styles all the time: progress bars, timers).
 */
interface Reach {
  up: boolean;
  inside: number;
}
const REACH = {
  interaction: { up: true, inside: 60 },
  opened: { up: false, inside: 60 },
  added: { up: false, inside: 40 },
  classChange: { up: false, inside: 8 },
  element: { up: false, inside: 0 },
} satisfies Record<string, Reach>;
/** At most this many elements are measured per check (plus the corrected ones when they are re-measured). */
const MAX_PER_CHECK = 600;
const REMEASURE_MS = 500;
let interacted = false;
let lastRemeasure = 0;
let frameQueued = false;
let settleTimer: number | undefined;

function runLive() {
  lastLive = Date.now();
  if (!theme) return;
  const targets = new Set<Element>();
  for (const [el, reach] of pending) {
    if (targets.size >= MAX_PER_CHECK) break;
    if (!el.isConnected) continue;
    targets.add(el);
    if (reach.up) for (let p = el.parentElement, i = 0; p && i < 6 && p !== document.body; i++, p = p.parentElement) targets.add(p);
    if (reach.inside) {
      let k = 0;
      for (const c of el.querySelectorAll('*')) {
        targets.add(c);
        if (++k >= reach.inside) break;
      }
    }
    // a search box or menu someone is using: what is inside it too
    if (reach.up) {
      const box = el.closest('form,[role="search"],[role="dialog"],[role="listbox"],[role="menu"],[role="combobox"]');
      let k = 0;
      if (box) for (const c of box.querySelectorAll('*')) {
        targets.add(c);
        if (++k >= 80) break;
      }
    }
  }
  pending.clear();
  // elements corrected earlier are measured again (a hover or focus may have ended), but not every frame
  if (interacted || Date.now() - lastRemeasure > REMEASURE_MS) {
    for (const el of marks.keys()) targets.add(el);
    lastRemeasure = Date.now();
    interacted = false;
  }
  if (marks.size > MAX_MARKS) for (const k of [...marks.keys()].slice(0, marks.size - MAX_MARKS)) {
    k.removeAttribute(LIVE_ATTR);
    marks.delete(k);
  }
  checkElements(targets);
  writeLiveStyles();
}

/** The widest reach asked for an element wins. */
function want(el: Element, reach: Reach): void {
  const had = pending.get(el);
  pending.set(el, had ? { up: had.up || reach.up, inside: Math.max(had.inside, reach.inside) } : reach);
}

/** Checks just before the next frame is drawn (so it appears right). After an interaction, once more when transitions land. */
function queue(el: Element | null, reach: Reach) {
  if (!el || !triggersOn) return;
  want(el, reach);
  const interaction = reach === REACH.interaction;
  if (interaction) interacted = true;
  if (!frameQueued) {
    frameQueued = true;
    requestAnimationFrame(() => {
      frameQueued = false;
      runLive();
    });
  }
  if (!interaction) return;
  window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    want(el, reach);
    interacted = true;
    runLive();
  }, 260);
}

const onFocus = (e: Event) => queue(e.target as Element, REACH.interaction);
const onPointerOver = (e: Event) => {
  const t = e.target as Element;
  if (t === lastHover) return;
  lastHover = t;
  queue(t, REACH.interaction);
};
const onTransitionEnd = (e: Event) => queue(e.target as Element, REACH.element);
const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape' || e.key.startsWith('Arrow')) queue(e.target as Element, REACH.interaction);
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
  window.clearTimeout(settleTimer);
  pending.clear();
}

/** New elements appear (a menu opens, a feed loads): check the added ones, nothing else. */
export function noteAddedNodes(records: MutationRecord[]): void {
  if (!triggersOn) return;
  let count = 0;
  let first: [Element, Reach] | null = null;
  for (const r of records) {
    if (++count > 150) break;
    if (r.type === 'attributes') {
      const t = r.target as Element;
      if (t.nodeType !== Node.ELEMENT_NODE || t.id?.startsWith('ww-') || t.closest?.('ww-editor')) continue;
      const reach = r.attributeName === 'style' ? REACH.element : r.attributeName === 'class' ? REACH.classChange : REACH.opened;
      want(t, reach);
      first ??= [t, reach];
      continue;
    }
    for (const n of r.addedNodes) {
      if (n.nodeType !== Node.ELEMENT_NODE || (n as Element).id?.startsWith('ww-')) continue;
      want(n as Element, REACH.added);
      first ??= [n as Element, REACH.added];
    }
  }
  if (first) queue(first[0], first[1]);
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
  const designKey = designKeyOf(designs);
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
  await loadLearned(designKey);
  if (gen !== generation) return;
  startTriggers();
  await buildSiteStyles(theme, gen);
  if (gen !== generation) return;
  builtFor = key;
  lastBuild = Date.now();
  writeLearnedStyles();
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
  saveLearned();
  for (const id of [SITE_STYLE_ID, LIVE_STYLE_ID, BORDER_STYLE_ID, LEARNED_STYLE_ID]) document.getElementById(id)?.remove();
  learned = new Map();
  learnedFor = '';
  document.querySelectorAll(`[${BORDER_ATTR}]`).forEach((e) => e.removeAttribute(BORDER_ATTR));
  siteRules = 0;
  bordersFixed = 0;
  unreadable = 0;
  builtFor = '';
}
