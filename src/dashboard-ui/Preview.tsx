import { useEffect, useRef } from 'react';
import { handleBridge, type BridgeCtx } from '../dashboard/bridge';
import { mountSandbox, type Sandbox } from '../dashboard/host';
import type { DashData, Dashboard } from '../dashboard/schema';
import { call } from './data';

export interface PreviewIssue {
  where: 'page' | 'collect';
  message: string;
}

/**
 * Shows the dashboard: the assistant's HTML/CSS/JS inside the sandboxed page. It is remounted when the code changes and
 * simply sent new data when only the collected data changes. All outside access goes through the bridge, which only
 * allows sites the user approved.
 */
export function Preview({ dashboard, data, kv, onIssue, onLog }: { dashboard: Dashboard; data: DashData | null; kv: Record<string, unknown>; onIssue: (i: PreviewIssue) => void; onLog?: (t: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const sb = useRef<Sandbox | null>(null);
  const latest = useRef({ dashboard, data, kv, onIssue, onLog });
  latest.current = { dashboard, data, kv, onIssue, onLog };
  const codeKey = `${dashboard.id}|${dashboard.html}|${dashboard.css}|${dashboard.js}`;

  useEffect(() => {
    const d = latest.current.dashboard;
    const ctx: BridgeCtx = {
      get domains() {
        const cur = latest.current.dashboard;
        return cur.domains.filter((h) => cur.approval?.domains.includes(h));
      },
      get backgroundTabs() {
        const cur = latest.current.dashboard;
        return !!cur.approval?.backgroundTabs && cur.backgroundTabs;
      },
      fetch: (...a) => fetch(...a),
      counter: { requests: 0 },
      render: async (url, opts) => (await chrome.runtime.sendMessage({ type: 'ww:render', dashboardId: d.id, url, ...opts })) ?? { ok: false, error: 'No answer from the extension.' },
    };
    const mount = box.current!;
    mount.replaceChildren();
    const s = mountSandbox(mount, chrome.runtime.getURL('sandbox.html'), {
      bridge: (req) => handleBridge(ctx, req),
      store: async (op, key, value) => (op === 'get' ? (latest.current.kv[key] ?? null) : (await call('kvSet', { id: d.id, key, value }), value)),
      refresh: async () => {
        try {
          await call('refresh', { id: d.id });
          return { ok: true };
        } catch (e: any) {
          return { ok: false, error: e.message };
        }
      },
      onError: (e) => latest.current.onIssue({ where: e.where, message: e.message }),
      onLog: (t) => latest.current.onLog?.(t),
    });
    s.iframe.className = 'preview-frame';
    // On-demand requests from the page are limited per minute (the cap protects sites and the user's connection).
    const limiter = setInterval(() => (ctx.counter.requests = 0), 60_000);
    sb.current = s;
    const cur = latest.current;
    s.run({ mode: 'view', html: cur.dashboard.html, css: cur.dashboard.css, js: cur.dashboard.js, data: cur.data?.value ?? null, updatedAt: cur.data?.at ?? null });
    return () => {
      clearInterval(limiter);
      s.destroy();
      sb.current = null;
    };
  }, [codeKey]);

  useEffect(() => {
    if (data) sb.current?.sendData(data.value, data.at);
  }, [data?.at]);

  return <div className="preview-box" ref={box} />;
}
