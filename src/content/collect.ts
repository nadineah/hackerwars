import { detectBlocker } from '../dashboard/extract';
import type { RenderResult } from '../dashboard/bridge';
import type { CollectRequest } from '../shared/types';
import { sameSiteHost } from '../dashboard/util';

/**
 * Read-only: returns the rendered HTML of THIS page for a dashboard that was approved for this site. It never clicks,
 * types, submits forms or evaluates anything, and it only answers on the approved site.
 */
function waitFor(selector: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const has = () => {
      try {
        return !!document.querySelector(selector);
      } catch {
        return true; // an invalid selector must not stall the read
      }
    };
    if (has()) return resolve();
    const done = () => {
      obs.disconnect();
      clearTimeout(timer);
      resolve();
    };
    const obs = new MutationObserver(() => has() && done());
    obs.observe(document.documentElement, { childList: true, subtree: true });
    const timer = setTimeout(done, ms);
  });
}

export async function handleCollect(req: CollectRequest): Promise<RenderResult> {
  try {
    if (!sameSiteHost(location.hostname, new URL(req.url).hostname)) return { ok: false, error: 'The page is not on the approved site.', finalUrl: location.href };
    if (document.readyState === 'loading') await new Promise<void>((r) => document.addEventListener('DOMContentLoaded', () => r(), { once: true }));
    if (req.waitFor) await waitFor(req.waitFor, req.waitMs);
    // Let late scripts settle for a moment (bounded), as pages often hydrate after first paint.
    await new Promise((r) => setTimeout(r, 400));
    const blocker = detectBlocker(document);
    return { ok: true, html: document.documentElement.outerHTML, blocker, finalUrl: location.href };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 120), finalUrl: location.href };
  }
}
