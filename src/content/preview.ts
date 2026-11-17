/**
 * Prepares THIS page for a privacy-safe preview screenshot, then puts it back exactly as it was.
 *
 *   text      -> neutral rounded bars the colour of the text (the real glyphs are made transparent)
 *   images    -> kept, but blurred in place in proportion to their size (so detail inside them is gone before capture)
 *   inputs    -> values and placeholders hidden
 *
 * No AI is involved. After the capture, the worker also shrinks the image to a few dozen pixels, which is what makes
 * anything this pass missed (closed shadow roots, text drawn into a canvas) unreadable. Everything changed here is
 * restored in `end()`, and a safety timer restores it even if the extension never calls `end`.
 */

export interface PreviewMetrics {
  ok: boolean;
  /** The largest text size (px) among the text that is on screen. Used to choose how hard the screenshot is shrunk. */
  maxTextPx: number;
  bars: number;
  reason?: 'too-complex' | 'hidden' | 'busy';
}

const CAP_TEXT_NODES = 3500;
const CAP_BARS = 4000;
const SAFETY_MS = 4000;
const MEDIA = 'img,video,canvas,iframe,embed,object,picture';

interface Restore {
  el: HTMLElement;
  /** The element's original `style` attribute, byte for byte (null = it had none). */
  style: string | null;
}

let active: { overlay: HTMLElement; styles: HTMLStyleElement[]; restores: Restore[]; timer: ReturnType<typeof setTimeout> } | null = null;

const hash = (s: string) => {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};
const rgbOf = (c: string): [number, number, number] => {
  const m = c.match(/[\d.]+/g);
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : [90, 90, 90];
};

function collectRoots(): (Document | ShadowRoot)[] {
  const roots: (Document | ShadowRoot)[] = [document];
  const walk = (node: Document | ShadowRoot) => {
    for (const el of node.querySelectorAll('*')) {
      const sr = (el as Element).shadowRoot;
      if (sr) {
        roots.push(sr);
        walk(sr);
      }
    }
  };
  walk(document);
  return roots;
}

const HIDE_TEXT = '*,*::before,*::after{color:transparent!important;text-shadow:none!important;caret-color:transparent!important;-webkit-text-fill-color:transparent!important}::placeholder{color:transparent!important}svg text,svg tspan{fill:transparent!important}input,textarea,select{color:transparent!important}';

export function begin(): PreviewMetrics {
  if (active) return { ok: false, maxTextPx: 0, bars: 0, reason: 'busy' };
  if (document.hidden || !document.body) return { ok: false, maxTextPx: 0, bars: 0, reason: 'hidden' };
  const vw = innerWidth;
  const vh = innerHeight;
  const overlay = document.createElement('div');
  overlay.setAttribute('data-ww-preview', '');
  overlay.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;overflow:hidden;pointer-events:none;z-index:2147483647;contain:strict';
  const frag = document.createDocumentFragment();
  const restores: Restore[] = [];
  let maxTextPx = 0;
  let bars = 0;
  let textNodes = 0;
  let tooComplex = false;

  const roots = collectRoots();
  for (const root of roots) {
    const tw = document.createTreeWalker(root === document ? document.body : root, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n && !tooComplex; n = tw.nextNode()) {
      const p = n.parentElement;
      if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName) || !n.textContent || !n.textContent.trim()) continue;
      if (++textNodes > CAP_TEXT_NODES * 3) {
        tooComplex = true;
        break;
      }
      const range = document.createRange();
      range.selectNodeContents(n);
      const rects = range.getClientRects();
      let first = true;
      let color: [number, number, number] = [90, 90, 90];
      let fontPx = 14;
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (r.width < 3 || r.height < 3 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
        if (first) {
          const cs = getComputedStyle(p);
          if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) break;
          color = rgbOf(cs.color);
          fontPx = parseFloat(cs.fontSize) || 14;
          first = false;
        }
        if (++bars > CAP_BARS) {
          tooComplex = true;
          break;
        }
        maxTextPx = Math.max(maxTextPx, fontPx);
        const w = Math.min(r.width, r.width * (0.6 + (hash((n.textContent as string).slice(0, 12) + i) % 40) / 100));
        const h = Math.max(3, Math.min(fontPx * 0.5, r.height * 0.55));
        const d = document.createElement('div');
        d.style.cssText = `position:absolute;left:${r.left}px;top:${r.top + (r.height - h) / 2}px;width:${w}px;height:${h}px;border-radius:${h / 2}px;background:rgba(${color[0]},${color[1]},${color[2]},0.5)`;
        frag.append(d);
      }
    }
    if (tooComplex) break;
    // Pictures stay, but blurred in place in proportion to their size.
    for (const el of root.querySelectorAll<HTMLElement>('*')) {
      let isMedia = el.matches(MEDIA);
      if (!isMedia) {
        const bg = getComputedStyle(el).backgroundImage;
        isMedia = !!bg && bg !== 'none' && /url\(/.test(bg);
      }
      if (!isMedia) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > vh) continue;
      restores.push({ el, style: el.getAttribute('style') });
      const sigma = Math.max(3, Math.min(42, Math.max(r.width, r.height) * 0.04));
      el.style.transition = 'none';
      el.style.filter = `blur(${sigma.toFixed(1)}px)`;
      el.style.clipPath = 'inset(0)';
    }
  }
  if (tooComplex) {
    for (const r of restores) restoreOne(r);
    return { ok: false, maxTextPx: 0, bars: 0, reason: 'too-complex' };
  }
  overlay.append(frag);
  document.documentElement.append(overlay);
  const styles: HTMLStyleElement[] = [];
  for (const root of roots) {
    const st = document.createElement('style');
    st.setAttribute('data-ww-preview', '');
    st.textContent = HIDE_TEXT;
    (root === document ? document.head ?? document.documentElement : root).append(st);
    styles.push(st);
  }
  const timer = setTimeout(end, SAFETY_MS);
  active = { overlay, styles, restores, timer };
  return { ok: true, maxTextPx, bars };
}

function restoreOne(r: Restore) {
  // Put the attribute back exactly as it was, instead of re-serialising it through the style object.
  if (r.style === null) r.el.removeAttribute('style');
  else r.el.setAttribute('style', r.style);
}

/** Puts the page back exactly as it was. Safe to call any number of times. */
export function end(): void {
  if (!active) return;
  const { overlay, styles, restores, timer } = active;
  clearTimeout(timer);
  active = null;
  overlay.remove();
  for (const s of styles) s.remove();
  for (const r of restores) restoreOne(r);
}
