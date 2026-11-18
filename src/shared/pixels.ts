/**
 * Pure pixel helpers for design previews. They work on RGBA byte arrays so they can be tested without a browser.
 * The privacy-critical step is NOT here: it is the shrink in background/preview.ts, which throws detail away for good.
 */

/** After shrinking, the tallest text should be no more than this many pixels high: far below readable. */
export const MAX_GLYPH_PX = 4;
export const MIN_SHRINK_WIDTH = 56;
export const MAX_SHRINK_WIDTH = 150;

/**
 * How wide the screenshot is shrunk before it is blurred. Normal pages land near the maximum; a page with huge text
 * is shrunk more, so even its largest letters end up about two pixels tall.
 */
export function shrinkWidth(maxTextPx: number, captureWidth: number): number {
  const text = Number.isFinite(maxTextPx) && maxTextPx > 0 ? maxTextPx : 16;
  const w = Math.round((captureWidth * MAX_GLYPH_PX) / text);
  return Math.max(MIN_SHRINK_WIDTH, Math.min(MAX_SHRINK_WIDTH, w));
}

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Dark pages would show as near-black tiles. Stretch them so the theme's colours stay visible. Returns the gain used (1 = untouched). */
export function liftDark(data: Uint8ClampedArray): number {
  const hist = new Uint32Array(256);
  let sum = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const l = Math.round(lum(data[i], data[i + 1], data[i + 2]));
    hist[l]++;
    sum += l;
  }
  if (n === 0 || sum / n > 70) return 1;
  let acc = 0;
  let p95 = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= n * 0.95) {
      p95 = v;
      break;
    }
  }
  const gain = Math.min(3.2, 175 / Math.max(p95, 24));
  if (gain <= 1.05) return 1;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.min(255, data[i] * gain);
    data[i + 1] = Math.min(255, data[i + 1] * gain);
    data[i + 2] = Math.min(255, data[i + 2] * gain);
  }
  return gain;
}

/** A mild 3x3 sharpen. It can only exaggerate edges that are already in the (tiny) image; it cannot recover removed detail. */
export function sharpen(data: Uint8ClampedArray, w: number, h: number, amount = 0.35): void {
  const src = new Uint8ClampedArray(data);
  const at = (x: number, y: number, c: number) => src[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4 + c];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        const centre = at(x, y, c);
        const around = (at(x - 1, y, c) + at(x + 1, y, c) + at(x, y - 1, c) + at(x, y + 1, c)) / 4;
        data[(y * w + x) * 4 + c] = Math.max(0, Math.min(255, centre + (centre - around) * amount * 4));
      }
    }
  }
}

/** Only small, plain image data URLs are accepted for storage. */
export const THUMB_MAX_CHARS = 44_000;
export const isThumbDataUrl = (v: unknown): v is string => typeof v === 'string' && v.length <= THUMB_MAX_CHARS && /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]{20,}$/.test(v);
