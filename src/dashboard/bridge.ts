import { FETCH_TIMEOUT_MS, LIMITS, RENDER_TIMEOUT_MS, bareHost, hostAllowed } from './schema';
import { checkCollectionUrl, sameSiteHost } from './util';

/**
 * The only door between sandboxed dashboard code and the outside world. Scripts ask; this decides. It never sends
 * cookies, never talks to private or local addresses, never leaves the sites the user approved (including after
 * redirects), and caps size, time and number of requests per run.
 */

export interface BridgeCtx {
  /** Sites the user approved for this dashboard. */
  domains: string[];
  /** Whether a managed background tab may be used for render(). */
  backgroundTabs: boolean;
  fetch: typeof fetch;
  /** Loads a page in a real (inactive) tab and returns its HTML after scripts ran. Implemented by the worker. */
  render: (url: string, opts: { waitFor?: string; waitMs: number }) => Promise<RenderResult>;
  /** Requests made so far in this run. */
  counter: { requests: number };
  maxRequests?: number;
  allowLocal?: boolean;
}

export interface RenderResult {
  ok: boolean;
  html?: string;
  finalUrl?: string;
  blocker?: 'signin' | 'captcha' | null;
  error?: string;
}

export type BridgeRequest =
  | { op: 'fetch'; url: string; headers?: Record<string, string> }
  | { op: 'render'; url: string; waitFor?: string; waitMs?: number };

export type BridgeReply = { ok: true; result: unknown } | { ok: false; code: string; error: string };

const fail = (code: string, error: string): BridgeReply => ({ ok: false, code, error });
export const MAX_REQUESTS_PER_RUN = 40;
const SAFE_HEADERS = new Set(['accept', 'accept-language']);

function gate(ctx: BridgeCtx, rawUrl: unknown): URL | BridgeReply {
  const c = checkCollectionUrl(rawUrl, { allowLocal: ctx.allowLocal });
  if (!c.ok || !c.url) return fail('bad-url', c.reason ?? 'That address is not allowed.');
  if (!hostAllowed(ctx.domains, c.url.hostname)) return fail('not-approved', `${bareHost(c.url.hostname)} has not been approved for this dashboard.`);
  if (ctx.counter.requests >= (ctx.maxRequests ?? MAX_REQUESTS_PER_RUN)) return fail('too-many', 'This script made too many requests in one run.');
  ctx.counter.requests++;
  return c.url;
}

async function readCapped(res: Response, signal: AbortSignal): Promise<string> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const t = await res.text();
    if (t.length > LIMITS.fetchBytes) throw new RangeError('too-large');
    return t;
  }
  const dec = new TextDecoder();
  let out = '';
  let bytes = 0;
  for (;;) {
    if (signal.aborted) throw new DOMException('Timed out', 'AbortError');
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > LIMITS.fetchBytes) {
      void reader.cancel();
      throw new RangeError('too-large');
    }
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}

export async function handleBridge(ctx: BridgeCtx, req: BridgeRequest): Promise<BridgeReply> {
  if (!req || typeof req !== 'object') return fail('bad-request', 'Malformed request.');
  if (req.op === 'fetch') {
    const g = gate(ctx, req.url);
    if (!(g instanceof URL)) return g;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) if (SAFE_HEADERS.has(k.toLowerCase()) && typeof v === 'string') headers[k] = v.slice(0, 200);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await ctx.fetch(g.toString(), { method: 'GET', headers, credentials: 'omit', cache: 'no-store', redirect: 'follow', referrerPolicy: 'no-referrer', signal: ctrl.signal });
      if (res.url) {
        const f = checkCollectionUrl(res.url, { allowLocal: ctx.allowLocal });
        if (!f.ok || !f.url || (!sameSiteHost(f.url.hostname, g.hostname) && !hostAllowed(ctx.domains, f.url.hostname))) return fail('redirected-off-site', 'The address redirected to a site that has not been approved, so nothing was read.');
      }
      const body = await readCapped(res, ctrl.signal);
      return { ok: true, result: { status: res.status, ok: res.ok, url: res.url || g.toString(), contentType: res.headers?.get?.('content-type') ?? '', body } };
    } catch (e: any) {
      if (e?.name === 'AbortError') return fail('timeout', 'The site took too long to respond.');
      if (e instanceof RangeError) return fail('too-large', 'The response is too large.');
      return fail('network', 'Could not reach the site.');
    } finally {
      clearTimeout(timer);
    }
  }
  if (req.op === 'render') {
    if (!ctx.backgroundTabs) return fail('tabs-not-approved', 'Reading pages that need JavaScript or sign-in requires approving background tabs for this dashboard.');
    const g = gate(ctx, req.url);
    if (!(g instanceof URL)) return g;
    const waitMs = Math.min(15_000, Math.max(500, Math.round(Number(req.waitMs) || 6000)));
    const waitFor = typeof req.waitFor === 'string' && req.waitFor.length <= 200 ? req.waitFor : undefined;
    const timeout = new Promise<RenderResult>((r) => setTimeout(() => r({ ok: false, error: 'The page took too long.' }), RENDER_TIMEOUT_MS + 5000));
    const r = await Promise.race([ctx.render(g.toString(), { waitFor, waitMs }), timeout]).catch((e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 100) }) as RenderResult);
    if (!r.ok || r.html === undefined) return fail('render-failed', r.error ?? 'The page could not be read.');
    if (r.finalUrl) {
      const f = checkCollectionUrl(r.finalUrl, { allowLocal: ctx.allowLocal });
      if (!f.ok || !f.url || !hostAllowed(ctx.domains, f.url.hostname)) return fail('redirected-off-site', 'The page redirected to a site that has not been approved.');
    }
    if (r.blocker === 'signin') return fail('signin', `Sign-in required. Sign in to ${bareHost(g.hostname)} in your browser, then refresh. WhimsyWeb never asks for your password.`);
    if (r.blocker === 'captcha') return fail('captcha', `${bareHost(g.hostname)} is showing a human-verification challenge. WhimsyWeb does not try to get past those.`);
    return { ok: true, result: { html: r.html.slice(0, LIMITS.fetchBytes), url: r.finalUrl ?? g.toString() } };
  }
  return fail('bad-request', 'Unknown request.');
}
