import { appliesOn } from '../shared/scope';
import { isThumbDataUrl, liftDark, punch, shrinkWidth, sharpen, THUMB_MAX_CHARS } from '../shared/pixels';
import { getSettings } from '../shared/storage';
import { watchActivation } from '../shared/tabguard';
import type { Design } from '../shared/types';
import type { PreviewMetrics } from '../content/preview';

/**
 * Design previews: a tiny, blurred picture of what the design looks like, made so that no text or detail survives.
 *
 *   1. the page is briefly "skeletonised" by the content script (text -> bars, images blurred in place),
 *   2. the visible tab is captured, and the page is restored straight away,
 *   3. the screenshot is SHRUNK to a few dozen pixels (this throws detail away for good: it is not a blur that could
 *      be undone), then enlarged smoothly, softly blurred and lightly sharpened,
 *   4. only that small result is stored. The full screenshot exists in memory for a moment and is never saved or sent.
 */

export const THUMB_W = 240;
export const THUMB_H = 135;

export type PreviewResult = { ok: true; dataUrl: string } | { ok: false; reason: string };

const toBase64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Halves the image repeatedly (each step averages pixels) until it is about the target width, so nothing is skipped over. */
function shrink(src: ImageBitmap, sx: number, sy: number, sw: number, sh: number, w: number, h: number): OffscreenCanvas {
  let cur = new OffscreenCanvas(sw, sh);
  const c0 = cur.getContext('2d')!;
  c0.imageSmoothingQuality = 'high';
  c0.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  while (cur.width / 2 >= w * 1.5) {
    const next = new OffscreenCanvas(Math.max(1, Math.round(cur.width / 2)), Math.max(1, Math.round(cur.height / 2)));
    const ctx = next.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, next.width, next.height);
    cur = next;
  }
  const out = new OffscreenCanvas(w, h);
  const octx = out.getContext('2d')!;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(cur, 0, 0, w, h);
  return out;
}

/** Screenshot (PNG blob) + the largest text size on the page -> a small, soft, detail-free WebP data URL. */
export async function makeThumb(shot: Blob, maxTextPx: number): Promise<string> {
  const bmp = await createImageBitmap(shot);
  const w = shrinkWidth(maxTextPx, bmp.width);
  const h = Math.max(1, Math.round((w * THUMB_H) / THUMB_W));
  // The top of the page, cropped to the thumbnail's 16:9 shape.
  const cropH = Math.min(bmp.height, Math.round((bmp.width * THUMB_H) / THUMB_W));
  const small = shrink(bmp, 0, 0, bmp.width, cropH, w, h);
  bmp.close();

  // Enlarge smoothly with a little blur, on a slightly bigger canvas so the blur does not fade at the edges, then crop.
  const padW = THUMB_W + 24;
  const padH = THUMB_H + 14;
  const big = new OffscreenCanvas(padW, padH);
  const bctx = big.getContext('2d')!;
  bctx.imageSmoothingQuality = 'high';
  bctx.filter = `blur(${(1.1 + (140 - w) / 90).toFixed(2)}px)`;
  bctx.drawImage(small, -6, -4, padW + 12, padH + 8);
  const out = new OffscreenCanvas(THUMB_W, THUMB_H);
  const octx = out.getContext('2d', { willReadFrequently: true })!;
  octx.drawImage(big, -12, -7);
  const img = octx.getImageData(0, 0, THUMB_W, THUMB_H);
  sharpen(img.data, THUMB_W, THUMB_H, 0.3);
  liftDark(img.data);
  punch(img.data);
  octx.putImageData(img, 0, 0);

  for (const q of [0.78, 0.6, 0.45]) {
    const blob = await out.convertToBlob({ type: 'image/webp', quality: q });
    const url = `data:image/webp;base64,${toBase64(await blob.arrayBuffer())}`;
    if (url.length <= THUMB_MAX_CHARS) return url;
  }
  throw new Error('The preview came out too large.');
}

export interface PreviewDeps {
  /** For tests: replaces the real browser calls. */
  getActiveTab?: () => Promise<chrome.tabs.Tab | undefined>;
}

/** Captures a preview of `design` if (and only if) it is on screen, switched on and applying right now. */
export async function capturePreview(design: Design, deps: PreviewDeps = {}): Promise<PreviewResult> {
  if (!(await getSettings()).previews) return { ok: false, reason: 'off' };
  if (!design.enabled) return { ok: false, reason: 'not-on' };
  const tab = deps.getActiveTab ? await deps.getActiveTab() : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab?.id || !tab.url) return { ok: false, reason: 'no-tab' };
  // Never from a private window: what is on screen there is exactly what the user wants to keep private.
  if (tab.incognito) return { ok: false, reason: 'incognito' };
  let url: URL;
  try {
    url = new URL(tab.url);
  } catch {
    return { ok: false, reason: 'no-tab' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'not-a-website' };
  if (!appliesOn(design, url.hostname, url.pathname)) return { ok: false, reason: 'not-here' };

  const watch = watchActivation();
  let metrics: PreviewMetrics | undefined;
  try {
    metrics = (await chrome.tabs.sendMessage(tab.id, { type: 'ww:previewBegin' })) as PreviewMetrics | undefined;
  } catch {
    watch.stop();
    return { ok: false, reason: 'page-not-ready' };
  }
  if (!metrics?.ok) {
    watch.stop();
    return { ok: false, reason: metrics?.reason ?? 'page-not-ready' };
  }

  let shot: string | undefined;
  try {
    // Right before the capture: is the page we prepared still the one on screen?
    const now = await chrome.tabs.get(tab.id).catch(() => undefined);
    shot = now?.active && now.url === tab.url ? await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }) : undefined;
  } catch {
    shot = undefined;
  } finally {
    // Restore the page the instant the capture is done, before any processing.
    await chrome.tabs.sendMessage(tab.id, { type: 'ww:previewEnd' }).catch(() => undefined);
  }
  watch.stop();
  if (!shot) return { ok: false, reason: 'capture-failed' };
  if (watch.changed()) return { ok: false, reason: 'tab-changed' };
  const after = await chrome.tabs.get(tab.id).catch(() => undefined);
  if (!after || after.url !== tab.url || !after.active) return { ok: false, reason: 'tab-changed' };

  try {
    const dataUrl = await makeThumb(await (await fetch(shot)).blob(), metrics.maxTextPx);
    if (!isThumbDataUrl(dataUrl)) return { ok: false, reason: 'bad-result' };
    return { ok: true, dataUrl };
  } catch {
    return { ok: false, reason: 'processing-failed' };
  }
}
