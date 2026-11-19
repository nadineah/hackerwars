import { loadArt } from '../../src/content/art';
import { activate, deactivate } from '../../src/content/apply';
import { extractPageContext } from '../../src/content/extract';
import type { Design, DomOp } from '../../src/shared/types';

/**
 * Injected on demand by the lab panel (never runs by itself). It reads the page outline exactly the way Whimsy Web does,
 * and shows a result on the page without saving anything: Preview applies it, Clear puts the page back.
 */
const w = window as unknown as { __wwLab?: boolean };
if (!w.__wwLab) {
  w.__wwLab = true;
  chrome.runtime.onMessage.addListener((msg: { type?: string; css?: string; ops?: DomOp[]; scope?: string }, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (msg?.type === 'lab:extract') {
      sendResponse(extractPageContext());
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
