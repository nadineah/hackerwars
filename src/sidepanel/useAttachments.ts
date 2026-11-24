import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { cropBox, type SnipRect } from '../shared/snip';
import { MAX_ATTACHMENTS, type CaptureResponse, type ImageAttachment } from '../shared/types';
import type { TabInfo } from './useActiveTab';

/**
 * The pictures attached to the next message: your own images, and screenshots (whole view or a snipped area) of the
 * page. A screenshot belongs to the tab AND site it was taken on: it is never added if you switched tabs while it was
 * being taken, and it is dropped when you switch tabs or the tab goes to another site.
 */

export interface Attachment extends ImageAttachment {
  id: string;
  /** For screenshots: the tab and site they were taken on. */
  tabId?: number;
  host?: string | null;
  label: 'screenshot' | 'reference';
  /** data: URL for the thumbnail preview */
  preview: string;
}

const MAX_EDGE = 1568; // larger images are downscaled by the API anyway; this saves upload size + tokens
const NO_VISION = 'The selected model can’t read images. Pick an image-capable model in Settings.';
const FULL = `You can attach up to ${MAX_ATTACHMENTS} images per message.`;

/** Downscales to MAX_EDGE and re-encodes as JPEG (transparent areas become white). */
export async function toAttachment(file: Blob): Promise<Attachment> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const preview = canvas.toDataURL('image/jpeg', 0.85);
  return { id: crypto.randomUUID(), mediaType: 'image/jpeg', label: 'reference', data: preview.split(',')[1], preview };
}

/** Why snipping could not reach the page, when we can tell. */
async function unreachable(tabId: number): Promise<string> {
  const info = await chrome.tabs.get(tabId).catch(() => undefined);
  if (info?.incognito) return 'Chrome does not run extensions in private windows unless you allow it: chrome://extensions, Whimsy Web, Details, Allow in Incognito. Then reload the page.';
  if (info && !/^https?:/i.test(info.url ?? '')) return 'Snipping only works on regular websites, not browser pages.';
  return 'Could not reach this page. Reload the tab and try again.';
}

/** Crops a capture to the snipped area (null: the area was too small). */
async function crop(blob: Blob, rect: SnipRect): Promise<Blob | null> {
  const bmp = await createImageBitmap(blob);
  const box = cropBox(rect, bmp.width, bmp.height);
  if (!box) {
    bmp.close();
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = box.sw;
  canvas.height = box.sh;
  canvas.getContext('2d')!.drawImage(bmp, box.sx, box.sy, box.sw, box.sh, 0, 0, box.sw, box.sh);
  bmp.close();
  return new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('no blob'))), 'image/jpeg', 0.88));
}

export function useAttachments(opts: {
  tab: TabInfo | null;
  tabIdRef: MutableRefObject<number | null>;
  hostRef: MutableRefObject<string | null>;
  visionOk: boolean;
  canSend: boolean;
  setError: (e: string | null) => void;
}) {
  const { tab, tabIdRef, hostRef, visionOk, canSend, setError } = opts;
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [snipping, setSnipping] = useState(false);
  const shotBusy = useRef(false);

  // switching tabs, or the tab going to another site, drops its screenshots
  useEffect(() => {
    const stale = (x: Attachment) => x.label === 'screenshot' && (x.tabId !== tab?.id || x.host !== (tab?.host ?? null));
    setAttachments((a) => (a.some(stale) ? a.filter((x) => !stale(x)) : a));
  }, [tab?.id, tab?.host]);

  const addFiles = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    if (!visionOk) return setError(NO_VISION);
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) return setError(FULL);
    try {
      const added = await Promise.all(imgs.slice(0, room).map(toAttachment));
      // Re-check the limit against the latest list: two batches may have been decoding at once.
      setAttachments((a) => [...a, ...added].slice(0, MAX_ATTACHMENTS));
      setError(imgs.length > room ? `Only ${MAX_ATTACHMENTS} images fit in one message.` : null);
    } catch {
      setError('Could not read that image.');
    }
  };

  const addScreenshot = async (snipRegion = false) => {
    if (!tab || !canSend) return;
    if (!visionOk) return setError(NO_VISION);
    if (attachments.length >= MAX_ATTACHMENTS) return setError(FULL);
    if (shotBusy.current) return;
    shotBusy.current = true; // a second click while capturing must not add a second screenshot
    const shotTab = tab.id;
    const shotHost = tab.host;
    const stillHere = () => tabIdRef.current === shotTab && hostRef.current === shotHost;
    try {
      setError(null);
      let rect: SnipRect | null = null;
      if (snipRegion) {
        setSnipping(true);
        try {
          rect = await chrome.tabs.sendMessage(shotTab, { type: 'ww:snip' });
        } catch {
          setError(await unreachable(shotTab));
          return;
        } finally {
          setSnipping(false);
        }
        if (!rect || !stillHere()) return; // cancelled, or you went elsewhere
      }
      const res: CaptureResponse = await chrome.runtime.sendMessage({ type: 'ww:capture', tabId: shotTab });
      if (!res.ok) return setError(res.error);
      // Full-resolution captures can be several MB on large/retina displays: shrink like any other image.
      let blob: Blob | null = await (await fetch(`data:image/jpeg;base64,${res.data}`)).blob();
      if (rect) blob = await crop(blob, rect);
      if (!blob) return setError('That selection was too small. Drag a bigger area.');
      const shot = await toAttachment(blob);
      // Decoding takes a moment: if you switched tabs meanwhile, this screenshot is of the wrong page.
      if (!stillHere()) return;
      setAttachments((a) => (a.length >= MAX_ATTACHMENTS ? a : [...a, { ...shot, label: 'screenshot', tabId: shotTab, host: shotHost }]));
    } catch (e) {
      console.error('[Whimsy Web] screenshot failed', e);
      setError('Could not process the screenshot.');
    } finally {
      shotBusy.current = false;
    }
  };

  // Esc in the panel also cancels a snip in progress (the page only sees Esc once it has focus).
  useEffect(() => {
    if (!snipping || !tab) return;
    const id = tab.id;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void chrome.tabs.sendMessage(id, { type: 'ww:snipCancel' }).catch(() => undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [snipping, tab?.id]);

  return { attachments, setAttachments, addFiles, addScreenshot, snipping };
}
