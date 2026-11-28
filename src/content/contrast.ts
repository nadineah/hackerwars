import { fixColor, over, parseColor, ratio, targetFor, toHex, type Fix, type Rgba } from '../shared/contrast';
import type { ContrastReviewTarget } from '../shared/types';
import { isProtectedMedia, mediaRepairExclusion } from './media';
import { addContrastGroup, canLearnContrastGroup, clearContrastGroups, contrastTemplate, discardDetachedContrastExceptions, INDIVIDUAL_CONTRAST, samePaint, setIndividualContrast, sharedCorrection } from './contrast-groups';

/**
 * Makes text readable after a design is applied, with no AI. For every piece of visible text it works out the colour that
 * is really behind it, and if the contrast is too low it nudges the text colour the way it already leans (darker text
 * darker, lighter text lighter) until it passes. Elements with the same correction share one CSS rule. Changing
 * a correction moves only that element to a different rule, and "clear" puts everything back.
 */

const ATTR = 'data-ww-fix';
const STYLE_ID = 'ww-contrast-style';
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'HEAD', 'TITLE', 'MATH']);
const CONTROLS = 'input:not([type]),input[type=text],input[type=search],input[type=email],input[type=password],input[type=url],input[type=tel],input[type=number],input[type=button],input[type=submit],input[type=reset],textarea,select';
const OVERLAYS = '[data-ww-preview],[data-ww-snip],[aria-hidden="true"],ww-editor';
const MAX_ELEMENTS = 6000;
const CHUNK = 350;
const MAX_CACHED_PAIRS = 512;

export interface ContrastFailure {
  selector: string;
  text: string;
  ratio: number;
  color: string;
  background: string;
  suggested: string;
  reached: boolean;
}
export interface ContrastReport {
  checked: number;
  failing: number;
  fixed: number;
  /** Text it could not judge (image or gradient behind it). */
  unknown: number;
  failures: ContrastFailure[];
}

let current: ContrastReport = { checked: 0, failing: 0, fixed: 0, unknown: 0, failures: [] };
let scanQueue: Promise<unknown> = Promise.resolve();
let clearVersion = 0;
type ReviewCandidate = { kind: ContrastReviewTarget['kind']; source?: Element; placeholder: boolean };
const appliedFixes = new Map<Element, string>();
const palette = new Map<string, number>();
const installedRules = new Set<string>();
let contrastStyle: HTMLStyleElement | null = null;
let contrastSheet: CSSStyleSheet | null = null;
const reviewCandidates = new Map<Element, ReviewCandidate>();
const colourFixes = new Map<string, Fix | null>();
let unknownCount = 0;
/** Converts colour spaces the parser does not read (oklch, color(), ...) by letting the browser do it. */
let canvasCtx: CanvasRenderingContext2D | null | undefined;
function viaCanvas(css: string): Rgba | null {
  if (canvasCtx === undefined) canvasCtx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!canvasCtx) return null;
  try {
    canvasCtx.clearRect(0, 0, 1, 1);
    canvasCtx.fillStyle = '#000';
    canvasCtx.fillStyle = css;
    canvasCtx.fillRect(0, 0, 1, 1);
    const d = canvasCtx.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
  } catch {
    return null;
  }
}
const colorOf = (css: string): Rgba | null => css ? parseColor(css) ?? viaCanvas(css) : null;

export const getContrastStats = () => ({ fixed: current.fixed, checked: current.checked, unknown: current.unknown });

function selectorOf(el: Element): string {
  if (el === document.body) return 'body';
  const parts: string[] = [];
  let n: Element | null = el;
  for (let i = 0; n && n !== document.body && i < 3; i++, n = n.parentElement) {
    let p = n.tagName.toLowerCase();
    if (n.id && n.id.length < 40 && /^[\w-]+$/.test(n.id)) {
      parts.unshift(`${p}#${n.id}`);
      break;
    }
    const cls = Array.from(n.classList).filter((c) => /^[\w-]{1,30}$/.test(c)).slice(0, 2);
    if (cls.length) p += '.' + cls.join('.');
    parts.unshift(p);
  }
  return parts.join(' > ');
}

type Surface = { style: CSSStyleDeclaration; colour: Rgba | null; image: boolean; opacity: number };
const opacityOf = (style: CSSStyleDeclaration): number => Number(style.opacity || 1);

function surfaceOf(el: Element, cache: Map<Element, Surface>): Surface {
  const cached = cache.get(el);
  if (cached) return cached;
  const style = getComputedStyle(el);
  const surface = {
    style,
    colour: colorOf(style.backgroundColor),
    image: !!style.backgroundImage && style.backgroundImage !== 'none',
    opacity: opacityOf(style),
  };
  cache.set(el, surface);
  return surface;
}

/** Composites each background and its contents as a group before applying its opacity. */
function backdrop(el: Element, cache: Map<Element, Surface>): { bg: Rgba | null; opacity: number; source?: Element; backing?: Element } {
  let bg: Rgba = { r: 0, g: 0, b: 0, a: 0 };
  let unknown = false;
  let opacity = 1;
  let source: Element | undefined;
  let backing: Element | undefined;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const surface = surfaceOf(node, cache);
    if (surface.opacity < 1) {
      opacity *= surface.opacity;
      source ??= node;
    }
    if (surface.image && bg.a < 1) unknown = true;
    if (!unknown && surface.colour && bg.a < 1) {
      const under = surface.colour;
      if (bg.a === 0 && under.a === 1) backing = node;
      const underWeight = under.a * (1 - bg.a);
      const alpha = bg.a + underWeight;
      if (alpha > 0) {
        bg = {
          r: (bg.r * bg.a + under.r * underWeight) / alpha,
          g: (bg.g * bg.a + under.g * underWeight) / alpha,
          b: (bg.b * bg.a + under.b * underWeight) / alpha,
          a: alpha,
        };
      }
    }
    bg.a *= surface.opacity;
  }
  return { bg: unknown ? null : over(bg, { r: 255, g: 255, b: 255, a: 1 }), opacity, source, backing };
}

function isVisible(el: Element, cs: CSSStyleDeclaration): boolean {
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || Number(cs.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width >= 2 && r.height >= 2;
}

function collectText(root: Element, out: Set<Element>, limit: number): void {
  if (root.matches(CONTROLS)) out.add(root);
  for (const control of root.querySelectorAll(CONTROLS)) {
    if (out.size >= limit) break;
    out.add(control);
  }
  const tw = document.createTreeWalker(root, window.NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      if (!p || SKIP_TAGS.has(p.tagName) || !n.textContent?.trim()) return window.NodeFilter.FILTER_REJECT;
      return window.NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = tw.nextNode(); n && out.size < limit; n = tw.nextNode()) out.add(n.parentElement as Element);
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * The site's own colour for a piece of text. Our fix is on the element only through its marker, so the colour is read
 * while the marker is absent and remembered once it is there: every pass judges the SITE's colour, never our earlier
 * correction. (Judging the correction made text pass, so the fix was dropped, so it failed again: it flip-flopped.)
 */
const siteColour = new WeakMap<Element, { colour: string; placeholder: boolean; gen: number }>();
/** Bumped when the designs change: remembered colours are then read again (see remeasureContrast). */
let generation = 0;
const textColour = (cs: CSSStyleDeclaration) => {
  const fill = cs.getPropertyValue('-webkit-text-fill-color');
  return fill && fill !== 'currentcolor' ? fill : cs.color;
};
function siteColourOf(el: Element, cs: CSSStyleDeclaration, placeholder: boolean, refresh: boolean, ignoreShared: boolean): string {
  const known = siteColour.get(el);
  if (!refresh && known?.gen === generation && known.placeholder === placeholder && el.hasAttribute(ATTR)) return known.colour;
  let colour: string;
  const marker = el.getAttribute(ATTR);
  const hideShared = ignoreShared && !el.hasAttribute(INDIVIDUAL_CONTRAST);
  if (marker !== null || hideShared) {
    // read it without our fix, and put the fix straight back (same task: nothing is painted in between, no flash)
    if (hideShared) el.setAttribute(INDIVIDUAL_CONTRAST, '');
    if (marker !== null) el.removeAttribute(ATTR);
    colour = textColour(getComputedStyle(el, placeholder ? '::placeholder' : null));
    if (marker !== null) el.setAttribute(ATTR, marker);
    if (hideShared) el.removeAttribute(INDIVIDUAL_CONTRAST);
  } else colour = textColour(cs);
  siteColour.set(el, { colour, placeholder, gen: generation });
  return colour;
}

/**
 * The designs changed, so the colours remembered for fixed text may be out of date. They are read again on the next
 * pass while every fix stays on screen until then (removing them first made that text flash).
 */
export function remeasureContrast(): void {
  generation++;
  clearVersion++;
  clearContrastGroups();
  reviewCandidates.clear();
  unknownCount = 0;
}

type Verdict =
  | { kind: 'skip' | 'ok' }
  | { kind: 'unknown'; placeholder: boolean }
  | { kind: 'fail'; ratio: number; fg: Rgba; bg: Rgba; fix: Fix; placeholder: boolean; source?: Element; backing?: Element; target: number };
type FailedContrast = Extract<Verdict, { kind: 'fail' }>;
const groupObservations = new WeakMap<Element, { version: number; selector: string; verdict: FailedContrast }>();

/** Share the expensive colour calculation, while always measuring each element's current styles. */
function fixForPair(fg: Rgba, bg: Rgba, target: number, opacity: number): Fix | null {
  const key = `${fg.r},${fg.g},${fg.b},${fg.a}|${bg.r},${bg.g},${bg.b}|${target}|${opacity}`;
  const cached = colourFixes.get(key);
  if (cached !== undefined) return cached;
  const fix = fixColor(fg, bg, target, opacity);
  if (colourFixes.size >= MAX_CACHED_PAIRS) {
    const oldest = colourFixes.keys().next().value;
    if (oldest !== undefined) colourFixes.delete(oldest);
  }
  colourFixes.set(key, fix);
  return fix;
}

/** Is this text readable on what is behind it, and if not, what colour fixes it? */
function judge(el: Element, cache: Map<Element, Surface>, refresh: boolean, individual: Map<Element, boolean>): Verdict {
  if (el.closest(OVERLAYS) || isProtectedMedia(el)) return { kind: 'skip' };
  const { style: cs } = surfaceOf(el, cache);
  if (!isVisible(el, cs)) return { kind: 'skip' };
  // gradient or background-clipped text, and disabled controls, are left as they are
  if (cs.webkitBackgroundClip === 'text' || (cs as unknown as { backgroundClip: string }).backgroundClip === 'text') return { kind: 'skip' };
  if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return { kind: 'skip' };
  const placeholder = el.matches(':placeholder-shown');
  const text = placeholder ? getComputedStyle(el, '::placeholder') : cs;
  const { bg, opacity, source, backing } = backdrop(el, cache);
  const effectiveOpacity = opacity * (placeholder ? opacityOf(text) : 1);
  const target = targetFor(parseFloat(text.fontSize || cs.fontSize) || 16, Number(text.fontWeight || cs.fontWeight) || 400);
  const shared = sharedCorrection(el);
  if (shared) {
    const fits = !placeholder && !!bg && effectiveOpacity === 1 && samePaint(bg, shared.background) && ratio(shared.colour, bg) >= target;
    individual.set(el, !fits);
    if (fits && bg) {
      const effective = colorOf(textColour(text));
      if (el.hasAttribute(INDIVIDUAL_CONTRAST) || (effective && ratio(over(effective, bg), bg) >= target)) return { kind: 'ok' };
    }
  } else if (el.hasAttribute(INDIVIDUAL_CONTRAST)) individual.set(el, false);
  const fg = colorOf(siteColourOf(el, text, placeholder, refresh, !!shared));
  if (!fg || fg.a === 0) return { kind: 'skip' };
  if (effectiveOpacity === 0) return { kind: 'skip' };
  if (!bg) return { kind: 'unknown', placeholder };
  const rendered = over({ ...fg, a: fg.a * effectiveOpacity }, bg);
  const measured = ratio(rendered, bg);
  if (measured >= target) return { kind: 'ok' };
  const fix = fixForPair(fg, bg, target, effectiveOpacity);
  return fix
    ? { kind: 'fail', ratio: measured, fg: rendered, bg, fix, placeholder, target, backing: effectiveOpacity === 1 && !placeholder ? backing : undefined, source: source ?? (effectiveOpacity < 1 ? el : undefined) }
    : { kind: 'ok' };
}

type ScanOptions = { apply: boolean; maxFailures?: number; roots?: readonly Element[]; removed?: boolean; canRun?: () => boolean };

/** Checks either the whole page or only changed roots. Report-only runs leave the installed fixes alone. */
export function runContrast(opts: ScanOptions): Promise<ContrastReport> {
  const version = clearVersion;
  const scan = scanQueue.then(() => inspectContrast(opts, version));
  scanQueue = scan.catch(() => undefined);
  return scan;
}

async function inspectContrast(opts: ScanOptions, version: number): Promise<ContrastReport> {
  const cache = new Map<Element, Surface>();
  const report: ContrastReport = { checked: 0, failing: 0, fixed: 0, unknown: 0, failures: [] };
  const fixes = new Map<Element, string>();
  const candidates = new Map<Element, ReviewCandidate>();
  const individual = new Map<Element, boolean>();
  const groupSeeds = new Map<string, { el: Element; verdict: FailedContrast; distinct: boolean }>();
  let groupProbes = 0;
  const nodes = new Set<Element>();
  const canRun = () => (!opts.apply || version === clearVersion) && (opts.canRun?.() ?? true);
  if (!canRun()) return report;
  const roots = opts.roots ?? [document.body ?? document.documentElement];
  for (const root of roots) {
    if (!root.isConnected || root.closest(OVERLAYS)) continue;
    collectText(root, nodes, MAX_ELEMENTS);
    if (nodes.size >= MAX_ELEMENTS) break;
  }
  const parents = [...nodes];
  for (let i = 0; i < parents.length; i += CHUNK) {
    for (const el of parents.slice(i, i + CHUNK)) {
      const v = judge(el, cache, !!opts.roots, individual);
      if (opts.apply) groupObservations.delete(el);
      if (v.kind === 'skip') continue;
      report.checked++;
      if (v.kind === 'unknown') {
        report.unknown++;
        if (opts.apply) candidates.set(el, { kind: 'background', placeholder: v.placeholder });
      }
      if (v.kind !== 'fail') continue;
      report.failing++;
      if (report.failures.length < (opts.maxFailures ?? 60)) {
        report.failures.push({ selector: selectorOf(el) + (v.placeholder ? '::placeholder' : ''), text: el.matches(CONTROLS) ? '' : (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40), ratio: Math.round(v.ratio * 100) / 100, color: toHex(v.fg), background: toHex(v.bg), suggested: toHex(v.fix.color), reached: v.fix.reached });
      }
      if (opts.apply && v.fix.reached) fixes.set(el, `${v.placeholder ? 'p' : 't'}-${toHex(v.fix.color).slice(1)}`);
      if (opts.apply && v.fix.reached && v.backing && canLearnContrastGroup() && groupProbes++ < 24) {
        const template = contrastTemplate(el, v.backing);
        if (template) {
          groupObservations.set(el, { version, selector: template.selector, verdict: v });
          if (!groupSeeds.has(template.selector) && !sharedCorrection(el)) groupSeeds.set(template.selector, { el, verdict: v, distinct: template.distinct });
        }
      }
      if (opts.apply && !v.fix.reached && v.source) candidates.set(el, { kind: 'opacity', source: v.source, placeholder: v.placeholder });
    }
    if (i + CHUNK < parents.length) await tick();
    if (!canRun()) return report;
  }
  if (opts.apply) {
    for (const [el, excluded] of individual) if (el.isConnected) setIndividualContrast(el, excluded);
    if (opts.removed) discardDetachedContrastExceptions();
    let groupsAdded = 0;
    let validatedGroups = 0;
    for (const [selector, seed] of groupSeeds) {
      if (!canLearnContrastGroup() || groupsAdded >= 4 || validatedGroups++ >= 6) break;
      if (!seed.el.isConnected || !seed.el.matches(selector)) continue;
      let supporting = false;
      let conflict = false;
      let sampled = 0;
      for (const peer of document.querySelectorAll(selector)) {
        if (peer === seed.el) continue;
        if (++sampled > 3) break;
        const observed = groupObservations.get(peer);
        const v = observed?.version === version && observed.selector === selector ? observed.verdict : judge(peer, cache, false, new Map());
        if (v.kind === 'skip') continue;
        const expected = seed.verdict;
        if (v.kind !== 'fail' || !v.backing || v.target !== expected.target || !samePaint(v.bg, expected.bg) || !samePaint(v.fg, expected.fg)) {
          conflict = true;
          break;
        }
        supporting = true;
      }
      if (!conflict && (supporting || seed.distinct) && addContrastGroup(seed.el, selector, seed.verdict.bg, seed.verdict.fix.color)) groupsAdded++;
    }
    let changed = false;
    const covered = opts.roots ? new Set([...nodes, ...roots]) : new Set([...appliedFixes.keys(), ...reviewCandidates.keys()]);
    if (opts.removed) {
      for (const el of appliedFixes.keys()) if (!el.isConnected) covered.add(el);
      for (const el of reviewCandidates.keys()) if (!el.isConnected) covered.add(el);
    }
    for (const el of covered) {
      if (reviewCandidates.get(el)?.kind === 'background') unknownCount--;
      reviewCandidates.delete(el);
      const prev = appliedFixes.get(el);
      if (!prev) continue;
      const next = el.isConnected ? fixes.get(el) : undefined;
      if (next === prev) {
        fixes.delete(el);
        if (el.getAttribute(ATTR) !== prev) el.setAttribute(ATTR, prev);
        continue;
      }
      if (!next) el.removeAttribute(ATTR);
      appliedFixes.delete(el);
      countRule(prev, -1);
      changed = true;
    }
    for (const [el, fix] of fixes) {
      if (!el.isConnected) continue;
      appliedFixes.set(el, fix);
      countRule(fix, 1);
      if (el.getAttribute(ATTR) !== fix) el.setAttribute(ATTR, fix);
      changed = true;
    }
    if (changed || (palette.size && !contrastStyle?.isConnected)) syncPalette();
    for (const [el, candidate] of candidates) {
      if (!el.isConnected || reviewCandidates.size >= MAX_ELEMENTS) continue;
      reviewCandidates.set(el, candidate);
      if (candidate.kind === 'background') unknownCount++;
    }
    report.fixed = appliedFixes.size;
    current = { ...report, checked: opts.roots ? Math.max(current.checked, report.checked) : report.checked, unknown: unknownCount };
  }
  return report;
}

/** Reuses measured candidates, filtering to those on screen for the screenshot review. */
export function getContrastReviewTargets(): ContrastReviewTarget[] {
  const targets = new Map<string, ContrastReviewTarget>();
  for (const [el, candidate] of reviewCandidates) {
    if (!el.isConnected || isProtectedMedia(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.right <= 0 || r.top >= window.innerHeight || r.left >= window.innerWidth) continue;
    const base = selectorOf(el);
    if (!base) continue;
    const selector = base + (candidate.placeholder ? '::placeholder' : '');
    if (targets.has(selector)) continue;
    const source = candidate.source && (candidate.source === el ? selector : selectorOf(candidate.source));
    targets.set(selector, { selector, kind: candidate.kind, ...(source && { source }) });
    if (targets.size >= 16) break;
  }
  return [...targets.values()];
}

function countRule(marker: string, delta: 1 | -1): void {
  const count = (palette.get(marker) ?? 0) + delta;
  if (count > 0) palette.set(marker, count);
  else palette.delete(marker);
}

function removePalette(): void {
  contrastStyle?.remove();
  contrastStyle = contrastSheet = null;
  installedRules.clear();
}

/** Only add or delete CSS rules when the set of in-use colours changes. */
function syncPalette(): void {
  if (!palette.size) {
    removePalette();
    return;
  }
  if (!contrastStyle) {
    contrastStyle = document.createElement('style');
    contrastStyle.id = STYLE_ID;
    contrastStyle.setAttribute('data-ww-contrast', '');
  }
  if (!contrastStyle.isConnected) document.documentElement.append(contrastStyle);
  const sheet = contrastStyle.sheet;
  if (!sheet) return;
  if (sheet !== contrastSheet) {
    contrastSheet = sheet;
    installedRules.clear();
  }
  const previous = [...installedRules];
  for (let i = previous.length - 1; i >= 0; i--) {
    if (palette.has(previous[i])) continue;
    sheet.deleteRule(i);
    installedRules.delete(previous[i]);
  }
  for (const marker of palette.keys()) {
    if (installedRules.has(marker)) continue;
    // Enough specificity to win against normal themed ID rules using !important.
    const selector = `[${ATTR}="${marker}"]:is(#ww-contrast-style#ww-contrast-style,[${ATTR}])${mediaRepairExclusion()}`;
    const colour = '#' + marker.slice(2);
    const pseudo = marker.startsWith('p-') ? '::placeholder' : '';
    sheet.insertRule(`${selector}${pseudo}{color:${colour}!important;-webkit-text-fill-color:${colour}!important}`, sheet.cssRules.length);
    installedRules.add(marker);
  }
}

/** Removes every correction (the page is exactly as the design left it). */
export function clearContrast(): void {
  clearVersion++;
  clearContrastGroups();
  removePalette();
  for (const el of appliedFixes.keys()) el.removeAttribute(ATTR);
  appliedFixes.clear();
  palette.clear();
  reviewCandidates.clear();
  unknownCount = 0;
  current = { checked: 0, failing: 0, fixed: 0, unknown: 0, failures: [] };
}
