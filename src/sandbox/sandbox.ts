import { buildOutline, detectBlocker, discoverFeeds, parseFeed } from '../dashboard/extract';
import type { BridgeReply, BridgeRequest } from '../dashboard/bridge';

/**
 * Runs inside the sandboxed extension page (see manifest "sandbox"). It has NO extension APIs and its CSP forbids
 * network access (connect-src 'none'), so everything it can do to the outside world goes through the host via
 * postMessage, and the host decides. The assistant's dashboard script and its collect script both get the same
 * `ww` helper object.
 */

type RunMsg = { type: 'run'; mode: 'view' | 'collect'; html?: string; css?: string; js?: string; collect?: string; data?: unknown; updatedAt?: number | null; runId: string };

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;
const pending = new Map<string, (r: any) => void>();
let seq = 0;
let runId = '';

const toParent = (m: Record<string, unknown>) => parent.postMessage({ ...m, runId }, '*');

function ask<T>(msg: Record<string, unknown>): Promise<T> {
  return new Promise((resolve) => {
    const id = `${runId}:${++seq}`;
    pending.set(id, resolve);
    toParent({ ...msg, id });
  });
}

async function bridge(req: BridgeRequest): Promise<any> {
  const r = await ask<{ reply: BridgeReply }>({ type: 'bridge', req });
  if (!r.reply.ok) {
    const e = new Error(r.reply.error) as Error & { code?: string };
    e.code = r.reply.code;
    throw e;
  }
  return r.reply.result;
}

const listeners: ((d: unknown) => void)[] = [];

const ww = {
  data: null as unknown,
  updatedAt: null as number | null,
  onData(cb: (d: unknown, updatedAt: number | null) => void) {
    listeners.push((d) => cb(d, ww.updatedAt));
    if (ww.data !== null) cb(ww.data, ww.updatedAt);
  },
  /** Fetches a page or API from a site the user approved. Resolves like fetch(): { ok, status, url, text(), json() }. */
  async fetch(url: string, opts: { headers?: Record<string, string> } = {}) {
    const r = await bridge({ op: 'fetch', url: String(url), headers: opts.headers });
    return { ok: r.ok as boolean, status: r.status as number, url: r.url as string, contentType: r.contentType as string, text: async () => r.body as string, json: async () => JSON.parse(r.body) };
  },
  async fetchText(url: string) {
    const r = await ww.fetch(url);
    if (!r.ok) throw new Error(`${url} answered ${r.status}`);
    return r.text();
  },
  async fetchJson(url: string) {
    const r = await ww.fetch(url);
    if (!r.ok) throw new Error(`${url} answered ${r.status}`);
    return r.json();
  },
  /** Loads a page in a real background tab (JavaScript runs, your sign-in works) and returns its HTML. Needs background tabs approved. */
  async render(url: string, opts: { waitFor?: string; waitMs?: number } = {}) {
    const r = await bridge({ op: 'render', url: String(url), waitFor: opts.waitFor, waitMs: opts.waitMs });
    return { html: r.html as string, url: r.url as string, doc: new DOMParser().parseFromString(r.html, 'text/html') };
  },
  parseHTML: (html: string) => new DOMParser().parseFromString(String(html), 'text/html'),
  parseXML: (xml: string) => new DOMParser().parseFromString(String(xml), 'text/xml'),
  /** Reads an RSS or Atom feed's text into { title, items: [{ title, url, summary, image, publishedAt }] }. */
  feed(text: string, baseUrl = 'https://invalid.example/', max = 30) {
    const r = parseFeed(new DOMParser().parseFromString(String(text), 'text/xml'), baseUrl, max);
    if ('error' in r) throw new Error(r.error);
    return r;
  },
  findFeeds: (html: string, baseUrl: string) => discoverFeeds(new DOMParser().parseFromString(String(html), 'text/html'), baseUrl),
  /** 'signin' | 'captcha' | null: is this page a login wall or a human check? */
  blocked: (htmlOrDoc: string | Document) => detectBlocker(typeof htmlOrDoc === 'string' ? new DOMParser().parseFromString(htmlOrDoc, 'text/html') : htmlOrDoc),
  outline: (htmlOrDoc: string | Document) => buildOutline(typeof htmlOrDoc === 'string' ? new DOMParser().parseFromString(htmlOrDoc, 'text/html') : htmlOrDoc),
  /** Small persistent storage for this dashboard (notes, saved links, settings). Values must be JSON. */
  store: {
    get: async (key: string) => (await ask<{ value: unknown }>({ type: 'store', op: 'get', key: String(key) })).value,
    set: async (key: string, value: unknown) => void (await ask<{ value: unknown }>({ type: 'store', op: 'set', key: String(key), value })),
  },
  /** Asks the extension to run the collect script now, then calls onData with the result. */
  async refresh() {
    return (await ask<{ ok: boolean; error?: string }>({ type: 'refresh' })).ok;
  },
  log: (...a: unknown[]) => toParent({ type: 'log', text: a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ').slice(0, 500) }),
};

const explain = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 400);

async function run(m: RunMsg) {
  runId = m.runId;
  ww.data = m.data ?? null;
  ww.updatedAt = m.updatedAt ?? null;
  window.onerror = (msg) => void toParent({ type: 'error', where: 'page', message: String(msg).slice(0, 400) });
  window.onunhandledrejection = (e) => void toParent({ type: 'error', where: 'page', message: explain(e.reason) });
  if (m.mode === 'collect') {
    try {
      const value = await new AsyncFunction('ww', m.collect ?? '')(ww);
      toParent({ type: 'result', value: value === undefined ? null : value });
    } catch (e) {
      toParent({ type: 'error', where: 'collect', message: explain(e), code: (e as { code?: string })?.code });
    }
    return;
  }
  // view mode
  let style = document.getElementById('ww-style') as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = 'ww-style';
    document.head.append(style);
  }
  style.textContent = m.css ?? '';
  document.body.innerHTML = m.html ?? '';
  try {
    await new AsyncFunction('ww', m.js ?? '')(ww);
    toParent({ type: 'ready' });
  } catch (e) {
    toParent({ type: 'error', where: 'page', message: explain(e) });
  }
}

window.addEventListener('message', (e) => {
  if (e.source !== parent) return;
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'run') void run(m as RunMsg);
  else if (m.type === 'reply' && pending.has(m.id)) {
    pending.get(m.id)!(m);
    pending.delete(m.id);
  } else if (m.type === 'data') {
    ww.data = m.data;
    ww.updatedAt = m.updatedAt ?? null;
    for (const l of listeners) {
      try {
        l(m.data);
      } catch (err) {
        toParent({ type: 'error', where: 'page', message: explain(err) });
      }
    }
  }
});
toParent({ type: 'loaded' });
