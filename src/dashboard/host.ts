import type { BridgeReply, BridgeRequest } from './bridge';
import { COLLECT_TIMEOUT_MS, LIMITS } from './schema';

/**
 * Hosts the sandbox iframe (sandbox.html) inside an extension page and answers its requests. Used by the dashboard
 * page (to show a dashboard) and by the offscreen document (to run collect scripts while no dashboard is open).
 * Messages are accepted only from THIS iframe's window and only for the current run.
 */

export interface SandboxHandlers {
  bridge: (req: BridgeRequest) => Promise<BridgeReply>;
  store?: (op: 'get' | 'set', key: string, value?: unknown) => Promise<unknown>;
  refresh?: () => Promise<{ ok: boolean; error?: string }>;
  onError?: (e: { where: 'page' | 'collect'; message: string; code?: string }) => void;
  onLog?: (text: string) => void;
  onReady?: () => void;
  onResult?: (value: unknown) => void;
}

export interface RunPayload {
  mode: 'view' | 'collect';
  html?: string;
  css?: string;
  js?: string;
  collect?: string;
  data?: unknown;
  updatedAt?: number | null;
}

export interface Sandbox {
  iframe: HTMLIFrameElement;
  run(p: RunPayload): void;
  sendData(data: unknown, updatedAt: number | null): void;
  destroy(): void;
}

export function mountSandbox(container: HTMLElement, url: string, h: SandboxHandlers): Sandbox {
  const iframe = document.createElement('iframe');
  // The page's own CSP (manifest "sandbox") is what blocks the network; the attribute keeps it from touching anything else.
  iframe.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
  iframe.src = url;
  iframe.title = 'Dashboard';
  let runId = '';
  let loaded: Promise<void> | null = null;
  let destroyed = false;
  const post = (m: Record<string, unknown>) => iframe.contentWindow?.postMessage(m, '*');

  const onMessage = async (e: MessageEvent) => {
    if (destroyed || e.source !== iframe.contentWindow) return;
    const m = e.data as Record<string, any> | null;
    if (!m || typeof m !== 'object' || (m.type !== 'loaded' && m.runId !== runId)) return;
    switch (m.type) {
      case 'bridge':
        post({ type: 'reply', id: m.id, reply: await h.bridge(m.req) });
        break;
      case 'store':
        if (!h.store) post({ type: 'reply', id: m.id, value: null });
        else if (m.op === 'set' && JSON.stringify(m.value ?? null).length > LIMITS.storeBytes) post({ type: 'reply', id: m.id, value: null });
        else post({ type: 'reply', id: m.id, value: await h.store(m.op, String(m.key).slice(0, 80), m.value).catch(() => null) });
        break;
      case 'refresh':
        post({ type: 'reply', id: m.id, ok: (await (h.refresh?.() ?? Promise.resolve({ ok: false }))).ok });
        break;
      case 'error':
        h.onError?.({ where: m.where, message: String(m.message).slice(0, 500), code: m.code });
        break;
      case 'log':
        h.onLog?.(String(m.text));
        break;
      case 'ready':
        h.onReady?.();
        break;
      case 'result':
        h.onResult?.(m.value);
        break;
    }
  };
  window.addEventListener('message', onMessage);
  loaded = new Promise<void>((res) => {
    const ready = (e: MessageEvent) => {
      if (e.source === iframe.contentWindow && e.data?.type === 'loaded') {
        window.removeEventListener('message', ready);
        res();
      }
    };
    window.addEventListener('message', ready);
  });
  container.append(iframe);

  return {
    iframe,
    run(p) {
      runId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const id = runId;
      void loaded!.then(() => !destroyed && runId === id && post({ type: 'run', runId: id, ...p }));
    },
    sendData: (data, updatedAt) => post({ type: 'data', data, updatedAt }),
    destroy() {
      destroyed = true;
      window.removeEventListener('message', onMessage);
      iframe.remove();
    },
  };
}

export type CollectOutcome = { ok: true; value: unknown; bytes: number } | { ok: false; error: string; code?: string };

/** Runs a collect script once in a throwaway sandbox, with a hard time limit, and returns its data (size-checked). */
export function collectOnce(container: HTMLElement, url: string, collect: string, bridge: SandboxHandlers['bridge'], timeoutMs = COLLECT_TIMEOUT_MS): Promise<CollectOutcome> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (o: CollectOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sb.destroy();
      resolve(o);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'The collect script took too long and was stopped.', code: 'timeout' }), timeoutMs);
    const sb = mountSandbox(container, url, {
      bridge,
      onError: (e) => finish({ ok: false, error: e.message, code: e.code }),
      onResult: (value) => {
        let json: string;
        try {
          json = JSON.stringify(value ?? null);
        } catch {
          return finish({ ok: false, error: 'The script returned something that cannot be saved (it must be plain data).', code: 'bad-result' });
        }
        if (json.length > LIMITS.dataBytes) return finish({ ok: false, error: `The script returned too much data (limit ${Math.round(LIMITS.dataBytes / 1000)} KB).`, code: 'too-large' });
        finish({ ok: true, value: JSON.parse(json), bytes: json.length });
      },
    });
    sb.run({ mode: 'collect', collect });
  });
}
