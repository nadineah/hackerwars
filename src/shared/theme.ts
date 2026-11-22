import { fromHsl, luminance, over, parseColor, toHex, toHsl, type Rgba } from './contrast';

/**
 * Keeping the whole page on the design's theme, with no AI. Sites show extra colours the design never saw (a white search
 * pill while you type, a grey hover, a pop-up menu). This module decides which colours are "off theme" and what they should
 * become. Only NEUTRAL colours (whites, greys, blacks) are ever remapped: a deliberate red badge or brand colour is left alone.
 */

export interface Theme {
  /** A dark design (page background dark) or a light one. */
  dark: boolean;
  /** The page background. */
  base: Rgba;
  /** A slightly raised surface (cards, pop-ups, search boxes). */
  card: Rgba;
  /** A soft line colour (dividers, field borders). */
  border: Rgba;
}

export type Role = 'surface' | 'border';

const hexToRgba = (h: string): Rgba | null => {
  const s = h.replace('#', '');
  const full = s.length === 3 || s.length === 4 ? s.split('').map((c) => c + c).join('') : s;
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(full)) return null;
  return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16), a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1 };
};

/** A single colour written the way CSS writes it (hex, rgb(), hsl(), white, black, transparent). */
export function parseCssColor(token: string): Rgba | null {
  const t = token.trim().toLowerCase();
  if (t.startsWith('#')) return hexToRgba(t);
  if (t === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (t === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  if (t === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hsl = t.match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/);
  if (hsl) {
    const c = fromHsl(Number(hsl[1]) % 360, Number(hsl[2]) / 100, Number(hsl[3]) / 100);
    const a = hsl[4] === undefined ? 1 : hsl[5] === '%' ? Number(hsl[4]) / 100 : Number(hsl[4]);
    return { ...c, a };
  }
  return parseColor(t);
}

const TOKEN = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\b(?:white|black|transparent)\b/g;

/** Every colour written in a CSS value, with where it is. */
export function colorTokens(value: string): { text: string; start: number; end: number; color: Rgba }[] {
  const out: { text: string; start: number; end: number; color: Rgba }[] = [];
  for (const m of value.matchAll(TOKEN)) {
    const color = parseCssColor(m[0]);
    if (color) out.push({ text: m[0], start: m.index!, end: m.index! + m[0].length, color });
  }
  return out;
}

/** Rewrites the colours in a CSS value (keeps everything else exactly as it was). */
export function replaceColors(value: string, fn: (c: Rgba, text: string) => Rgba | null): string {
  let out = '';
  let last = 0;
  for (const t of colorTokens(value)) {
    const next = fn(t.color, t.text);
    if (!next) continue;
    out += value.slice(last, t.start) + (next.a < 1 ? `rgba(${Math.round(next.r)}, ${Math.round(next.g)}, ${Math.round(next.b)}, ${Math.round(next.a * 1000) / 1000})` : toHex(next));
    last = t.end;
  }
  return out + value.slice(last);
}

const chroma = (c: Rgba) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
/** Whites, greys and blacks (a little tint is allowed: #e8eaed, #f1f3f4). */
export const isNeutral = (c: Rgba): boolean => chroma(c) <= 26;

/** Is this colour visibly out of place on this theme, in this role? Always false for non-neutral or see-through colours. */
export function isOffTheme(c: Rgba, role: Role, theme: Theme): boolean {
  if (c.a < 0.5 || !isNeutral(c)) return false;
  const L = luminance(c);
  if (theme.dark) return role === 'surface' ? L > 0.28 : L > 0.2;
  // light theme: near-black surfaces are out of place; and on a TINTED light theme (cream, parchment, blush) so are
  // plain white and grey surfaces and grey lines (YouTube's white search pill on a parchment design). A plain white
  // theme keeps them. Only true greys are changed, never colours, and never the theme's own colours.
  if (role === 'surface' && L < 0.06) return true;
  if (!tintedLight(theme) || chroma(c) > 10 || near(c, theme.base) || near(c, theme.card)) return false;
  return role === 'surface' ? L > 0.55 : L > 0.35 && L < 0.92;
}

/** A light theme whose page colour has its own tint (not white or grey). */
const tintedLight = (t: Theme) => !t.dark && chroma(t.base) >= 10;
/** Close enough to count as the same colour. */
const near = (a: Rgba, b: Rgba) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b)) <= 10;

/**
 * What an off-theme colour should become. Surfaces become the theme's card colour (or the page colour for the page
 * itself); borders become the theme's soft line. The original transparency is kept.
 */
export function mapColor(c: Rgba, role: Role, theme: Theme, isRoot = false): Rgba | null {
  if (!isOffTheme(c, role, theme)) return null;
  const target = role === 'border' ? theme.border : isRoot ? theme.base : theme.card;
  return { r: target.r, g: target.g, b: target.b, a: c.a };
}

const mix = (a: Rgba, b: Rgba, t: number): Rgba => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: 1 });
const shiftL = (c: Rgba, dL: number): Rgba => {
  const [h, s, l] = toHsl(c);
  return fromHsl(h, s, Math.min(1, Math.max(0, l + dL)));
};

export interface ThemeInput {
  /** The page background as it is now (opaque), if known. */
  pageBackground: Rgba | null;
  /** Colours the design declares for backgrounds (any order). */
  surfaces: Rgba[];
  /** Colours the design declares for borders and outlines. */
  borders: Rgba[];
  /** The design's text colour, if known. */
  text: Rgba | null;
}

/** Works out the theme from the colours the design itself uses. Returns null when there is nothing to go on. */
export function deriveTheme(input: ThemeInput): Theme | null {
  const opaque = (list: Rgba[]) => list.filter((c) => c.a >= 0.8).map((c) => (c.a < 1 ? over(c, { r: 0, g: 0, b: 0, a: 1 }) : c));
  const surfaces = opaque(input.surfaces);
  const base = input.pageBackground && input.pageBackground.a > 0.9 ? input.pageBackground : surfaces[0] ?? null;
  if (!base) return null;
  const dark = luminance(base) < 0.4;
  const Lb = luminance(base);
  // a card: one of the design's own surfaces slightly raised from the page, else the page colour nudged
  const candidates = surfaces.filter((c) => {
    const d = luminance(c) - Lb;
    return dark ? d > 0.004 && d < 0.2 : d < -0.004 && d > -0.25;
  });
  candidates.sort((a, b) => Math.abs(luminance(a) - Lb) - Math.abs(luminance(b) - Lb));
  const card = candidates[0] ?? shiftL(base, dark ? 0.07 : -0.05);
  // a soft line: the design's own border colour, softened toward the page when it is a bright accent
  const borders = opaque(input.borders);
  const rawBorder = borders[0];
  const soft = rawBorder ? mix(base, rawBorder, toHsl(rawBorder)[1] > 0.4 ? 0.4 : 0.8) : mix(base, input.text ?? (dark ? { r: 255, g: 255, b: 255, a: 1 } : { r: 0, g: 0, b: 0, a: 1 }), 0.28);
  return { dark, base, card, border: soft };
}
