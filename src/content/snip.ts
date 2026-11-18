import { MIN_SNIP_PX, type SnipRect } from '../shared/snip';

/**
 * A snipping overlay: the user drags a rectangle over the page (Esc cancels). The overlay is removed BEFORE the
 * answer is sent, so the screenshot the panel takes next does not contain it. Nothing is captured here: this only
 * reports where the rectangle is.
 */
let cancelActive: (() => void) | null = null;
const TIMEOUT_MS = 120_000;

export function snip(): Promise<SnipRect | null> {
  cancelActive?.();
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.setAttribute('data-ww-snip', '');
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(10,8,16,0.28);user-select:none;touch-action:none';
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;display:none;border:2px solid #f5b75a;border-radius:4px;box-shadow:0 0 0 100vmax rgba(10,8,16,0.5);pointer-events:none';
    const tip = document.createElement('div');
    tip.textContent = 'Drag over the part of the page to snip. Esc to cancel.';
    tip.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);padding:9px 16px;border-radius:999px;background:#2b1c0d;color:#fff;font:600 14px system-ui,sans-serif;pointer-events:none;box-shadow:0 6px 20px rgba(0,0,0,0.35)';
    root.append(box, tip);
    document.documentElement.append(root);

    let sx = 0;
    let sy = 0;
    let dragging = false;
    let done = false;
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    const clampX = (v: number) => Math.max(0, Math.min(innerWidth, v));
    const clampY = (v: number) => Math.max(0, Math.min(innerHeight, v));
    const rectOf = (x: number, y: number) => ({ x: Math.min(sx, x), y: Math.min(sy, y), w: Math.abs(x - sx), h: Math.abs(y - sy) });

    function finish(result: SnipRect | null) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cancelActive = null;
      removeEventListener('keydown', onKey, true);
      root.remove();
      // Let the page repaint without the overlay before the answer goes back (the panel screenshots right after).
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(result)));
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }
    };
    cancelActive = () => finish(null);
    addEventListener('keydown', onKey, true);

    root.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      sx = clampX(e.clientX);
      sy = clampY(e.clientY);
      dragging = true;
      tip.style.display = 'none';
      root.style.background = 'transparent';
      root.setPointerCapture(e.pointerId);
    });
    root.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const r = rectOf(clampX(e.clientX), clampY(e.clientY));
      box.style.display = 'block';
      box.style.left = r.x + 'px';
      box.style.top = r.y + 'px';
      box.style.width = r.w + 'px';
      box.style.height = r.h + 'px';
    });
    root.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      const r = rectOf(clampX(e.clientX), clampY(e.clientY));
      if (r.w < MIN_SNIP_PX || r.h < MIN_SNIP_PX) {
        // A stray click: let them try again.
        box.style.display = 'none';
        tip.style.display = '';
        root.style.background = 'rgba(10,8,16,0.28)';
        return;
      }
      finish({ ...r, vw: innerWidth, vh: innerHeight });
    });
  });
}

/** Closes the overlay if it is open (used when the panel's Esc or a tab change should abort the snip). */
export const cancelSnip = (): void => cancelActive?.();
