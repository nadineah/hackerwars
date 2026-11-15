import { handleBridge, type BridgeCtx, type BridgeReply, type BridgeRequest } from '../dashboard/bridge';
import { buildOutline } from '../dashboard/extract';
import { collectOnce } from '../dashboard/host';

/**
 * Offscreen document: runs a dashboard's collect script in a sandboxed frame while no dashboard page is open. It has no
 * storage or tab access of its own: page rendering is relayed to the worker, which re-checks the dashboard's approval.
 */
chrome.runtime.onMessage.addListener((msg: { target?: string; op?: string; code?: string; domains?: string[]; backgroundTabs?: boolean; dashboardId?: string }, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || msg?.target !== 'ww-offscreen') return;
  if (msg.op === 'outline' && typeof (msg as { html?: unknown }).html === 'string') {
    sendResponse({ outline: buildOutline(new DOMParser().parseFromString((msg as { html: string }).html, 'text/html')) });
    return;
  }
  if (msg.op !== 'collect' || typeof msg.code !== 'string') return;
  const ctx: BridgeCtx = {
    domains: Array.isArray(msg.domains) ? msg.domains.filter((d) => typeof d === 'string') : [],
    backgroundTabs: msg.backgroundTabs === true,
    fetch: (...a) => fetch(...a),
    counter: { requests: 0 },
    render: async (url, opts) => ((await chrome.runtime.sendMessage({ type: 'ww:render', dashboardId: msg.dashboardId, url, ...opts })) ?? { ok: false, error: 'No answer from the extension.' }),
  };
  const bridge = (req: BridgeRequest): Promise<BridgeReply> => handleBridge(ctx, req);
  collectOnce(document.body, chrome.runtime.getURL('sandbox.html'), msg.code, bridge).then(sendResponse);
  return true;
});
