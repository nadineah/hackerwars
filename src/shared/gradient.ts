/**
 * Gradients in Edit Mode: wherever a colour can be picked and CSS can paint a gradient there (a background, text, a
 * border, an icon, a hover overlay), the colour can become a gradient of two or three colours.
 */

export interface Gradient {
  /** linear (at `angle`) or radial (from the centre). */
  kind: 'linear' | 'radial';
  angle: number;
  /** 2 or 3 colours, spread evenly. */
  stops: string[];
}

/** The directions offered, as [angle, name]; radial is its own choice. */
export const GRADIENT_DIRECTIONS: [number, string][] = [
  [90, 'Left to right'],
  [180, 'Top to bottom'],
  [135, 'Diagonal ↘'],
  [45, 'Diagonal ↗'],
  [270, 'Right to left'],
  [0, 'Bottom to top'],
];

export function gradientCss(g: Gradient): string {
  const stops = g.stops.join(', ');
  return g.kind === 'radial' ? `radial-gradient(circle, ${stops})` : `linear-gradient(${Math.round(g.angle)}deg, ${stops})`;
}

/** Splits at commas that are not inside brackets (rgb(1, 2, 3) is one part). */
function topLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const SIDE_ANGLE: Record<string, number> = { top: 0, right: 90, bottom: 180, left: 270, 'top right': 45, 'right top': 45, 'bottom right': 135, 'right bottom': 135, 'bottom left': 225, 'left bottom': 225, 'top left': 315, 'left top': 315 };

/**
 * The gradient a CSS value paints (as written by Edit Mode, or a simple one a site has), or null: not a gradient, or
 * one too elaborate to edit here (several layers, repeating, positioned stops beyond a percentage).
 */
export function parseGradient(value: string | undefined | null): Gradient | null {
  if (!value) return null;
  const m = /^\s*(linear|radial)-gradient\(([\s\S]*)\)(\s*\d+)?\s*$/i.exec(value);
  if (!m) return null;
  const parts = topLevel(m[2]);
  if (parts.length < 2) return null;
  const kind = m[1].toLowerCase() as Gradient['kind'];
  let angle = 180;
  const first = parts[0].toLowerCase();
  const deg = /^(-?[\d.]+)(deg|turn)$/.exec(first);
  if (kind === 'linear' && deg) {
    angle = deg[2] === 'turn' ? Number(deg[1]) * 360 : Number(deg[1]);
    parts.shift();
  } else if (kind === 'linear' && first.startsWith('to ')) {
    angle = SIDE_ANGLE[first.slice(3).trim()] ?? 180;
    parts.shift();
  } else if (kind === 'radial' && /\b(circle|ellipse|closest-\w+|farthest-\w+|at)\b/.test(first)) {
    parts.shift(); // its shape and size: radial ones are always edited as a circle from the centre
  }
  // a stop is a colour, optionally with one position
  const stops: string[] = [];
  for (const p of parts) {
    const c = p.replace(/\s+-?[\d.]+(%|px)?\s*$/, '').trim();
    if (!c || /\s/.test(c.replace(/\([^)]*\)/g, ''))) return null;
    stops.push(c);
  }
  if (stops.length < 2 || stops.length > 6) return null;
  return { kind, angle: ((angle % 360) + 360) % 360, stops: stops.slice(0, 3) };
}

/** Where a gradient goes: an element's background, its text, its border. */
export type GradientUse = 'background' | 'text' | 'border';

const TEXT_KEYS = ['background-image', '-webkit-background-clip', 'background-clip', '-webkit-text-fill-color'];

/** The declarations that paint `g` as that use (null: take the gradient away). */
export function gradientPatch(use: GradientUse, g: Gradient | null): Record<string, string | null> {
  if (use === 'background') return { 'background-image': g ? gradientCss(g) : null };
  if (use === 'border') return { 'border-image': g ? `${gradientCss(g)} 1` : null };
  if (!g) return Object.fromEntries(TEXT_KEYS.map((k) => [k, null]));
  // the text shows the background through itself; its colour stays as the first stop (selection, copied text)
  return { 'background-image': gradientCss(g), '-webkit-background-clip': 'text', 'background-clip': 'text', '-webkit-text-fill-color': 'transparent', color: g.stops[0] };
}

const clear = (v: string) => /^(transparent|rgba\(0,\s*0,\s*0,\s*0\))$/i.test(v.trim());

/** The gradient an element shows as that use, read through `val` (its edit first, then what the page computes). */
export function currentGradient(use: GradientUse, val: (p: string) => string): Gradient | null {
  const textFill = clear(val('-webkit-text-fill-color') || '');
  if (use === 'border') return parseGradient(val('border-image') || val('border-image-source'));
  if (use === 'text') return textFill ? parseGradient(val('background-image')) : null;
  return textFill ? null : parseGradient(val('background-image'));
}

/** A second colour to start a gradient from one colour: lighter for a dark one, darker for a light one. */
export function partnerOf(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const light = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 > 140;
  const out = rgb.map((c) => Math.round(light ? c * 0.55 : c + (255 - c) * 0.55));
  return '#' + out.map((c) => c.toString(16).padStart(2, '0')).join('');
}
