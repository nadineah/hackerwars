/** A rectangle the user dragged on the page, in CSS pixels relative to the viewport. */
export interface SnipRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** The viewport size when it was drawn, so the rectangle can be scaled onto a screenshot of any resolution. */
  vw: number;
  vh: number;
}

/** Smaller than this (in CSS pixels) counts as a stray click, not a selection. */
export const MIN_SNIP_PX = 12;

/** Where to cut out of a screenshot of `imgW` x `imgH` pixels. Always inside the image; null if nothing useful is left. */
export function cropBox(r: SnipRect, imgW: number, imgH: number): { sx: number; sy: number; sw: number; sh: number } | null {
  if (![r.x, r.y, r.w, r.h, r.vw, r.vh, imgW, imgH].every(Number.isFinite) || r.vw <= 0 || r.vh <= 0 || imgW <= 0 || imgH <= 0) return null;
  const kx = imgW / r.vw;
  const ky = imgH / r.vh;
  const x0 = Math.max(0, Math.min(imgW, Math.round(r.x * kx)));
  const y0 = Math.max(0, Math.min(imgH, Math.round(r.y * ky)));
  const x1 = Math.max(0, Math.min(imgW, Math.round((r.x + r.w) * kx)));
  const y1 = Math.max(0, Math.min(imgH, Math.round((r.y + r.h) * ky)));
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  return { sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0 };
}
