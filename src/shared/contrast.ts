/**
 * Readable-text maths (WCAG contrast), with no AI: how far apart are a text colour and the colour behind it, and what is the
 * smallest change to the text colour that makes it readable. The rule for the fix keeps the design's intent: text that is
 * darker than its background is nudged darker still, text that is lighter is nudged lighter still, and the hue is kept.
 */

export interface Rgba {
  r: number; // 0-255
  g: number;
  b: number;
  a: number; // 0-1
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Parses what getComputedStyle returns for colours: rgb(), rgba(), the modern space-separated form, and transparent. */
export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : m[5] === '%' ? Number(m[4]) / 100 : Number(m[4]);
  const c = { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: clamp(a, 0, 1) };
  return [c.r, c.g, c.b, c.a].every(Number.isFinite) ? { r: clamp(c.r, 0, 255), g: clamp(c.g, 0, 255), b: clamp(c.b, 0, 255), a: c.a } : null;
}

/** `top` painted over an opaque `bottom`. */
export function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a;
  return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
}

const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
export const luminance = (c: Rgba): number => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);

export function ratio(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** WCAG AA: 4.5:1 for normal text, 3:1 for large text (24px, or 18.66px and bold). */
export function targetFor(fontPx: number, fontWeight: number): number {
  return fontPx >= 24 || (fontPx >= 18.66 && fontWeight >= 700) ? 3 : 4.5;
}

export const toHex = (c: Rgba): string =>
  '#' + [c.r, c.g, c.b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');

// ---- HSL, to move a colour lighter or darker while keeping its hue and saturation
function toHsl(c: Rgba): [number, number, number] {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return [h, s, l];
}
function fromHsl(h: number, s: number, l: number): Rgba {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a: 1 };
}

export interface Fix {
  color: Rgba;
  /** Did the new colour reach the target ratio? false = this is the best that could be done. */
  reached: boolean;
  /** Which way the colour moved. */
  direction: 'darker' | 'lighter';
  /** True if it had to move AGAINST the way it leaned, because that way could never reach the target. */
  flipped: boolean;
  ratio: number;
}

/** The smallest lightness change in one direction that reaches `target` (or the extreme if it never does). */
function nudge(h: number, s: number, l: number, bg: Rgba, target: number, dir: -1 | 1): { color: Rgba; ratio: number; reached: boolean } {
  const end = dir < 0 ? 0 : 1;
  const at = (L: number) => fromHsl(h, s, L);
  const endColor = at(end);
  const endRatio = ratio(endColor, bg);
  if (endRatio < target) return { color: endColor, ratio: endRatio, reached: false };
  let lo = l; // fails
  let hi = end; // passes
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (ratio(at(mid), bg) >= target) hi = mid;
    else lo = mid;
  }
  const color = at(hi);
  return { color, ratio: ratio(color, bg), reached: true };
}

/**
 * The text colour that makes `text` readable on `bg`, or null if it already is. Darker-than-background text gets darker,
 * lighter-than-background text gets lighter (hue kept, smallest change that passes). If that direction can never pass
 * (for example dark text on a mid-grey background), the other direction is used instead.
 */
export function fixColor(text: Rgba, bg: Rgba, target: number): Fix | null {
  const solid = text.a < 1 ? over(text, bg) : text;
  if (ratio(solid, bg) >= target) return null;
  const [h, s, l] = toHsl(solid);
  const lt = luminance(solid);
  const lb = luminance(bg);
  const dark = nudge(h, s, l, bg, target, -1);
  const light = nudge(h, s, l, bg, target, 1);
  const leans: 'darker' | 'lighter' = lt < lb ? 'darker' : lt > lb ? 'lighter' : dark.ratio >= light.ratio ? 'darker' : 'lighter';
  const pref = leans === 'darker' ? dark : light;
  const other = leans === 'darker' ? light : dark;
  if (pref.reached) return { color: pref.color, reached: true, direction: leans, flipped: false, ratio: pref.ratio };
  const otherDir: 'darker' | 'lighter' = leans === 'darker' ? 'lighter' : 'darker';
  if (other.reached) return { color: other.color, reached: true, direction: otherDir, flipped: true, ratio: other.ratio };
  const best = pref.ratio >= other.ratio ? { r: pref, d: leans, f: false } : { r: other, d: otherDir, f: true };
  return { color: best.r.color, reached: false, direction: best.d, flipped: best.f, ratio: best.r.ratio };
}
