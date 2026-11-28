import { isStableToken } from './identity';
import { mediaRepairExclusion } from './media';
import { toHex, type Rgba } from '../shared/contrast';

export const INDIVIDUAL_CONTRAST = 'data-ww-contrast-individual';
const MAX_GROUPS = 32;
const groups = new Map<string, Map<string, { background: Rgba; colour: Rgba }>>();
const exceptions = new Set<Element>();
let style: HTMLStyleElement | null = null;
let groupCount = 0;

// Keep the selector specific to the measured template, including theme variants and inline overrides.
function attributePart(el: Element, name: string): string | null {
  const value = el.getAttribute(name);
  if (value === null) return `:not([${name}])`;
  if (value.length > 180 || /[\u0000-\u001f]/.test(value)) return null;
  return `[${name}="${value.replace(/["\\]/g, '\\$&')}"]`;
}

function templatePart(el: Element): { selector: string; named: boolean } | null {
  const tag = el.localName;
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) return null;
  const classes = attributePart(el, 'class');
  const inline = attributePart(el, 'style');
  const theme = attributePart(el, 'data-theme');
  if (classes === null || inline === null || theme === null) return null;
  const id = isStableToken(el.id) && !/\d/.test(el.id) ? '#' + el.id : '';
  const named = !!id || tag.includes('-') || [...el.classList].some(isStableToken);
  return { selector: tag + id + classes + inline + theme, named };
}

export function contrastTemplate(el: Element, surface: Element): { selector: string; distinct: boolean } | null {
  const parts: string[] = [];
  let namedLabel = false;
  for (let node: Element | null = el; node && parts.length < 12; node = node.parentElement) {
    const part = templatePart(node);
    if (!part) return null;
    if (parts.length < 3 && node !== surface && part.named) namedLabel = true;
    parts.unshift(part.selector);
    if (node === surface) {
      const sameElement = el === surface;
      if (!namedLabel && !(sameElement && part.named)) return null;
      const selector = parts.join(' > ');
      if (selector.length > 1600 || selector.includes('ww-editor')) return null;
      return { selector, distinct: namedLabel && part.named && node !== document.body && node !== document.documentElement };
    }
  }
  return null;
}

export const samePaint = (a: Rgba, b: Rgba): boolean =>
  a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;

export function sharedCorrection(el: Element): { background: Rgba; colour: Rgba } | undefined {
  const byTag = groups.get(el.localName);
  if (!byTag) return undefined;
  for (const [selector, correction] of byTag) if (el.matches(selector)) return correction;
  return undefined;
}

export function canLearnContrastGroup(): boolean {
  return groupCount < MAX_GROUPS;
}

export function addContrastGroup(el: Element, selector: string, background: Rgba, colour: Rgba): boolean {
  if (!canLearnContrastGroup() || sharedCorrection(el)) return false;
  if (!style) {
    style = document.createElement('style');
    style.id = 'ww-shared-contrast';
    document.documentElement.append(style);
  }
  const sheet = style.sheet;
  if (!sheet) return false;
  const value = toHex(colour);
  const scope = `:where(${selector}):is(#ww-contrast-style#ww-contrast-style,*)`;
  sheet.insertRule(`${scope}:not([data-ww-fix],[${INDIVIDUAL_CONTRAST}],:disabled,[aria-disabled="true"])${mediaRepairExclusion()}:where(:not([aria-hidden="true"],[aria-hidden="true"] *)){color:${value}!important;-webkit-text-fill-color:${value}!important}`, sheet.cssRules.length);
  let byTag = groups.get(el.localName);
  if (!byTag) {
    byTag = new Map();
    groups.set(el.localName, byTag);
  }
  byTag.set(selector, { background, colour });
  groupCount++;
  return true;
}

export function setIndividualContrast(el: Element, individual: boolean): void {
  if (individual) {
    if (!exceptions.has(el)) el.setAttribute(INDIVIDUAL_CONTRAST, '');
    exceptions.add(el);
  } else if (exceptions.delete(el)) el.removeAttribute(INDIVIDUAL_CONTRAST);
}

export function discardDetachedContrastExceptions(): void {
  for (const el of exceptions) if (!el.isConnected) setIndividualContrast(el, false);
}

export function clearContrastGroups(): void {
  style?.remove();
  style = null;
  for (const el of exceptions) el.removeAttribute(INDIVIDUAL_CONTRAST);
  exceptions.clear();
  groups.clear();
  groupCount = 0;
}
