import { detectBlocker, extractItems, extractWatchText } from '../dashboard/extract';
import type { RenderedResult } from '../dashboard/collect';
import type { CollectRequest } from '../shared/types';
import { sameSiteHost } from '../dashboard/util';

/**
 * Read-only extraction from the LIVE page, for sources the user approved as "needs JavaScript or sign-in".
 * It reads text and links with the validated selectors it is given; it never clicks, types, submits forms, or
 * evaluates anything, and it only works on the approved site.
 */
function waitFor(selector: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const has = () => {
      try {
        return !!document.querySelector(selector);
      } catch {
        return true; // an invalid selector must not stall the collection
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

export async function handleCollect(req: CollectRequest): Promise<RenderedResult> {
  try {
    if (!sameSiteHost(location.hostname, new URL(req.url).hostname)) return { ok: false, error: 'The page is not on the approved site.', finalUrl: location.href };
    if (document.readyState === 'loading') await new Promise<void>((r) => document.addEventListener('DOMContentLoaded', () => r(), { once: true }));
    await waitFor(req.waitFor || req.selector, req.waitMs);
    // Let late scripts settle for a moment (bounded), as pages often hydrate after first paint.
    await new Promise((r) => setTimeout(r, 400));
    const blocker = detectBlocker(document);
    const finalUrl = location.href;
    if (req.kind === 'page-change') return { ok: true, watchText: extractWatchText(document, { selector: req.selector }), blocker, finalUrl };
    return { ok: true, items: extractItems(document, req.config, finalUrl), blocker, finalUrl };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 120), finalUrl: location.href };
  }
}
