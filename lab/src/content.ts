import { loadArt } from '../../src/content/art';
import { activate, deactivate } from '../../src/content/apply';
import { extractPageContext } from '../../src/content/extract';
import type { Design, DomOp } from '../../src/shared/types';

/**
 * Injected on demand by the lab panel (never runs by itself). It reads the page outline exactly the way Whimsy Web does,
 * and shows a result on the page without saving anything: Preview applies it, Clear puts the page back.
 */
const w = window as unknown as { __wwLab?: boolean };

/**
 * Whimsy Web may have its own theme on this page. The lab must see (and screenshot) the ORIGINAL site, so while it runs it
 * switches off the main extension's stylesheets and hides the elements it inserted. Nothing is deleted: "release" puts it
 * back. A watcher keeps it off if the main extension re-applies while the lab is in use.
 */
const MAIN_STYLES = 'style[data-whimsyweb]:not([data-whimsyweb="lab"])';
let isolated = false;
let watcher: MutationObserver | null = null;
const disableMain = (): number => {
  let n = 0;
  document.querySelectorAll<HTMLStyleElement>(MAIN_STYLES).forEach((el) => {
    if (el.media !== 'not all') {
      el.setAttribute('data-ww-lab-media', el.media);
      el.media = 'not all';
      n++;
    }
  });
  return n;
};
function isolate(): { styles: number; inserted: number } {
  if (!isolated) {
    isolated = true;
    const st = document.createElement('style');
    st.id = 'ww-lab-iso';
    st.textContent = '[data-ww]:not([data-ww="lab"]){display:none!important}';
    document.documentElement.append(st);
    watcher = new MutationObserver(() => disableMain());
    watcher.observe(document.documentElement, { childList: true, subtree: false });
  }
  const styles = disableMain();
  return { styles, inserted: document.querySelectorAll('[data-ww]:not([data-ww="lab"])').length };
}
function release(): void {
  if (!isolated) return;
  isolated = false;
  watcher?.disconnect();
  watcher = null;
  document.getElementById('ww-lab-iso')?.remove();
  document.querySelectorAll<HTMLStyleElement>('style[data-ww-lab-media]').forEach((el) => {
    el.media = el.getAttribute('data-ww-lab-media') ?? '';
    el.removeAttribute('data-ww-lab-media');
  });
}
if (!w.__wwLab) {
  w.__wwLab = true;
  chrome.runtime.onMessage.addListener((msg: { type?: string; css?: string; ops?: DomOp[]; scope?: string; y?: number }, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (msg?.type === 'lab:isolate') {
      sendResponse(isolate());
      return;
    }
    if (msg?.type === 'lab:metrics' || msg?.type === 'lab:scroll') {
      if (msg.type === 'lab:scroll' && typeof (msg as { y?: number }).y === 'number') window.scrollTo(0, (msg as { y: number }).y);
      sendResponse({ scrollY: window.scrollY, pageHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight, viewportWidth: innerWidth });
      return;
    }
    if (msg?.type === 'lab:release') {
      release();
      sendResponse(true);
      return;
    }
    if (msg?.type === 'lab:extract') {
      const found = isolate(); // the outline and its colours must come from the original page, not a theme
      sendResponse({ ...extractPageContext(), ignoredStyles: found.styles, ignoredInserted: found.inserted });
      return;
    }
    if (msg?.type === 'lab:clear') {
      deactivate('lab');
      sendResponse(true);
      return;
    }
    if (msg?.type === 'lab:apply') {
      const design: Design = {
        id: 'lab',
        host: location.hostname,
        scope: msg.scope === 'page' ? 'page' : 'site',
        path: location.pathname,
        name: 'lab',
        prompt: '',
        css: String(msg.css ?? ''),
        ops: Array.isArray(msg.ops) ? msg.ops : [],
        enabled: true,
        createdAt: 0,
        updatedAt: Date.now(),
      };
      deactivate('lab');
      void loadArt([design]).then(() => {
        activate(design, 50);
        sendResponse(true);
      });
      return true; // async response
    }
  });
}
