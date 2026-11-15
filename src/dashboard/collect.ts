import { buildOutline, detectBlocker, discoverFeeds, extractItems, extractJson, extractWatchText, parseFeed, type Blocker, type RawItem } from './extract';
import { KINDS, approvalCovers, effectiveMethod, type HtmlConfig, type JsonConfig, type PageChangeConfig, type Source, type SourceState, type SourceStatus } from './schema';
import { checkCollectionUrl, sameSiteHost } from './util';

/** Requests the offscreen document answers. It parses text it is handed; it never fetches and never runs page scripts. */
export type ParseRequest =
  | { op: 'feed'; text: string; url: string; max: number }
  | { op: 'html'; text: string; url: string; cfg: HtmlConfig }
  | { op: 'watch'; text: string; selector: string }
  | { op: 'outline'; text: string; url: string };
export type ParseResponse = { ok: true; items?: RawItem[]; title?: string; watchText?: string | null; blocker?: Blocker; outline?: string; feeds?: { url: string; title?: string }[] } | { ok: false; error: string };

export interface RenderedResult {
  ok: boolean;
  error?: string;
  items?: RawItem[];
  watchText?: string | null;
  blocker?: Blocker;
  /** Where the tab ended up, so a redirect off the approved site is caught before anything is read. */
  finalUrl?: string;
}

export interface CollectDeps {
  fetch: typeof fetch;
  parse: (req: ParseRequest) => Promise<ParseResponse>;
  rendered: (src: Source) => Promise<RenderedResult>;
  allowLocal?: boolean;
}

export type Outcome =
  | { ok: true; notModified?: false; items: RawItem[]; watchText?: string | null; etag?: string; lastModified?: string; feedTitle?: string }
  | { ok: true; notModified: true }
  | { ok: false; code: string; message: string; status: SourceStatus; retryAfterMs?: number };

export const MAX_BODY_BYTES = 2_500_000;
const fail = (code: string, message: string, status: SourceStatus = 'error', retryAfterMs?: number): Outcome => ({ ok: false, code, message, status, retryAfterMs });

/** Retry-After is either seconds or an HTTP date. Capped at a day; nonsense is ignored. */
export function parseRetryAfter(v: string | null | undefined, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const t = v.trim();
  const ms = /^\d+$/.test(t) ? Number(t) * 1000 : Date.parse(t) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 24 * 3600_000) : undefined;
}

async function readCapped(res: Response, signal: AbortSignal): Promise<string> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) throw new RangeError('too-large');
    return text;
  }
  const dec = new TextDecoder();
  let out = '';
  let bytes = 0;
  for (;;) {
    if (signal.aborted) throw new DOMException('Timed out', 'AbortError');
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      void reader.cancel();
      throw new RangeError('too-large');
    }
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}

const ACCEPT: Record<string, string> = {
  feed: 'application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
  json: 'application/json, text/plain;q=0.8, */*;q=0.5',
  html: 'text/html, application/xhtml+xml;q=0.9, */*;q=0.5',
};

/**
 * One bounded request: no cookies, no referrer, no cache, timeout, size cap, conditional headers, and a check that
 * any redirect stayed on the approved site. The body is returned as text and is never executed.
 */
export async function fetchText(src: Source, state: SourceState | null, deps: CollectDeps, conditional: boolean): Promise<{ text: string; etag?: string; lastModified?: string } | { notModified: true } | Outcome> {
  const info = KINDS[src.kind];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), info.timeoutMs);
  try {
    const headers: Record<string, string> = { Accept: ACCEPT[src.kind === 'json' ? 'json' : src.kind === 'feed' ? 'feed' : 'html'] };
    if (conditional && state?.etag) headers['If-None-Match'] = state.etag;
    if (conditional && state?.lastModified) headers['If-Modified-Since'] = state.lastModified;
    const res = await deps.fetch(src.url, { method: 'GET', headers, credentials: 'omit', cache: 'no-store', redirect: 'follow', referrerPolicy: 'no-referrer', signal: ctrl.signal });
    if (res.url) {
      const check = checkCollectionUrl(res.url, { allowLocal: deps.allowLocal });
      if (!check.ok || !sameSiteHost(check.url!.hostname, new URL(src.url).hostname)) return fail('redirected-off-site', 'The address redirected to a different site, so it was not read. Re-add the source with the new address to approve it.', 'needs-approval');
    }
    if (res.status === 304) return { notModified: true };
    if (res.status === 429 || res.status === 503) {
      const wait = parseRetryAfter(res.headers?.get?.('retry-after'));
      return fail(`http-${res.status}`, res.status === 429 ? 'The site asked for fewer requests (rate limited). Trying again later.' : 'The site is temporarily unavailable. Trying again later.', 'error', wait);
    }
    if (res.status === 401 || res.status === 403) return fail(`http-${res.status}`, 'The site refused an anonymous request. If the page works when you are signed in, use the "needs JavaScript or sign-in" method instead.', 'needs-attention');
    if (!res.ok) return fail(`http-${res.status}`, `The site answered with an error (${res.status}).`);
    const len = Number(res.headers?.get?.('content-length') ?? 0);
    if (len > MAX_BODY_BYTES) return fail('too-large', 'The response is too large to read safely.', 'needs-attention');
    const text = await readCapped(res, ctrl.signal);
    return { text, etag: res.headers?.get?.('etag') ?? undefined, lastModified: res.headers?.get?.('last-modified') ?? undefined };
  } catch (e: any) {
    if (e?.name === 'AbortError') return fail('timeout', 'The site took too long to respond.');
    if (e instanceof RangeError) return fail('too-large', 'The response is too large to read safely.', 'needs-attention');
    return fail('network', 'Could not reach the site.');
  } finally {
    clearTimeout(timer);
  }
}

const blockerOutcome = (b: Blocker, host: string): Outcome | null =>
  b === 'signin'
    ? fail('signin', `Sign-in required. Sign in to ${host} in your browser, then refresh. WhimsyWeb never asks for your password.`, 'needs-signin')
    : b === 'captcha'
      ? fail('captcha', `${host} is showing a human-verification challenge. WhimsyWeb does not try to get past those; open the site yourself, then refresh.`, 'needs-attention')
      : null;

/** Runs one collection for an approved source. Never throws; every failure is an Outcome the scheduler can record. */
export async function collectSource(src: Source, state: SourceState | null, deps: CollectDeps): Promise<Outcome> {
  const urlCheck = checkCollectionUrl(src.url, { allowLocal: deps.allowLocal });
  if (!urlCheck.ok) return fail('bad-url', urlCheck.reason ?? 'The address is not allowed.', 'needs-attention');
  if (!approvalCovers(src.approval, src)) return fail('needs-approval', 'Permission needed: approve automatic updates for this source.', 'needs-approval');
  const host = urlCheck.url!.hostname.replace(/^www\./, '');
  try {
    const method = effectiveMethod(src.kind, src.config);
    if (method === 'rendered') {
      const r = await deps.rendered(src);
      if (!r.ok) return fail('rendered-failed', r.error ?? 'The page could not be read.', 'error');
      if (r.finalUrl) {
        const c = checkCollectionUrl(r.finalUrl, { allowLocal: deps.allowLocal });
        if (!c.ok || !sameSiteHost(c.url!.hostname, urlCheck.url!.hostname)) return fail('redirected-off-site', 'The page redirected to a different site, so nothing was read.', 'needs-approval');
      }
      const b = blockerOutcome(r.blocker ?? null, host);
      if (b) return b;
      if (src.kind === 'page-change') return r.watchText ? { ok: true, items: [], watchText: r.watchText } : fail('no-region', 'The watched section was not found on the page.', 'needs-attention');
      if (!r.items?.length) return fail('no-items', 'No items matched. The page layout may have changed; edit the source to update its selectors.', 'needs-attention');
      return { ok: true, items: r.items };
    }

    const useConditional = src.kind === 'feed' || src.kind === 'json';
    const got = await fetchText(src, state, deps, useConditional);
    if ('ok' in got) return got; // an Outcome (failure)
    if ('notModified' in got) return { ok: true, notModified: true };
    const meta = { etag: got.etag, lastModified: got.lastModified };

    if (src.kind === 'json') {
      let data: unknown;
      try {
        data = JSON.parse(got.text);
      } catch {
        return fail('bad-json', 'The response is not valid JSON.', 'needs-attention');
      }
      const items = extractJson(data, src.config as JsonConfig, src.url);
      return Array.isArray(items) ? { ok: true, items, ...meta } : fail('bad-shape', items.error, 'needs-attention');
    }
    if (src.kind === 'feed') {
      const r = await deps.parse({ op: 'feed', text: got.text, url: src.url, max: (src.config as { maxItems: number }).maxItems });
      return r.ok && r.items ? { ok: true, items: r.items, feedTitle: r.title, ...meta } : fail('bad-feed', r.ok ? 'This is not a readable feed.' : r.error, 'needs-attention');
    }
    if (src.kind === 'html') {
      const r = await deps.parse({ op: 'html', text: got.text, url: src.url, cfg: src.config as HtmlConfig });
      if (!r.ok) return fail('parse-failed', r.error, 'error');
      const b = blockerOutcome(r.blocker ?? null, host);
      if (b) return b;
      return r.items?.length ? { ok: true, items: r.items } : fail('no-items', 'No items matched. The page may need JavaScript (try the "needs JavaScript or sign-in" method) or its layout changed.', 'needs-attention');
    }
    // page-change via fetch
    const r = await deps.parse({ op: 'watch', text: got.text, selector: (src.config as PageChangeConfig).selector });
    if (!r.ok) return fail('parse-failed', r.error, 'error');
    const b = blockerOutcome(r.blocker ?? null, host);
    if (b) return b;
    return r.watchText ? { ok: true, items: [], watchText: r.watchText } : fail('no-region', 'The watched section was not found on the page.', 'needs-attention');
  } catch (e: any) {
    return fail('unexpected', `Unexpected problem: ${String(e?.message ?? e).slice(0, 120)}`);
  }
}

/** Pure parse step shared by the offscreen page and by tests. */
export function runParse(req: ParseRequest, parseDoc: (text: string, type: 'text/xml' | 'text/html') => Document): ParseResponse {
  try {
    if (req.op === 'feed') {
      const r = parseFeed(parseDoc(req.text, 'text/xml'), req.url, req.max);
      return 'error' in r ? { ok: false, error: r.error } : { ok: true, items: r.items, title: r.title };
    }
    const doc = parseDoc(req.text, 'text/html');
    if (req.op === 'outline') return { ok: true, outline: buildOutline(doc), feeds: discoverFeeds(doc, req.url), blocker: detectBlocker(doc) };
    const blocker = detectBlocker(doc);
    if (req.op === 'html') return { ok: true, items: extractItems(doc, req.cfg, req.url), blocker };
    return { ok: true, watchText: extractWatchText(doc, { selector: req.selector }), blocker };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 120) };
  }
}
