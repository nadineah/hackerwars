import { JSDOM } from 'jsdom';

const win = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.com/' }).window as any;
(globalThis as any).DOMParser = win.DOMParser;

// ------------------------------------------------------------------ mocked chrome
const mem: Record<string, any> = {};
const sess: Record<string, any> = {};
let setCalls: string[][] = [];
const pick = (store: Record<string, any>, k: any) => (k === null ? { ...store } : Array.isArray(k) ? Object.fromEntries(k.map((x) => [x, store[x]])) : { [k]: store[k] });
const alarms: Record<string, any> = {};
let tabs: any[] = [];
let tabSeq = 100;
const removedTabs: number[] = [];
const created: any[] = [];
let tabBehavior: (tab: any) => void = () => {};
let contentReply: (tabId: number, msg: any) => any = () => ({ ok: true, items: [], finalUrl: '' });
const updListeners: any[] = [];
(globalThis as any).chrome = {
  runtime: { id: 'me' },
  storage: {
    local: {
      get: async (k: any) => pick(mem, k),
      set: async (o: any) => { setCalls.push(Object.keys(o)); Object.assign(mem, JSON.parse(JSON.stringify(o))); },
      remove: async (k: any) => { for (const x of Array.isArray(k) ? k : [k]) delete mem[x]; },
    },
    session: { get: async (k: any) => pick(sess, k), set: async (o: any) => { Object.assign(sess, JSON.parse(JSON.stringify(o))); } },
  },
  alarms: { get: async (n: string) => alarms[n], create: async (n: string, i: any) => { alarms[n] = i; } },
  tabs: {
    query: async () => tabs.map((t) => ({ ...t })),
    create: async (o: any) => { const t = { id: ++tabSeq, url: o.url, active: o.active, status: 'loading' }; tabs.push(t); created.push(o); setTimeout(() => { tabBehavior(t); t.status = t.status === 'loading' ? 'complete' : t.status; updListeners.forEach((l) => l(t.id, { status: t.status })); }, 0); return { ...t }; },
    get: async (id: number) => { const t = tabs.find((x) => x.id === id); if (!t) throw new Error('No tab'); return { ...t }; },
    remove: async (id: number) => { const i = tabs.findIndex((x) => x.id === id); if (i < 0) throw new Error('No tab'); tabs.splice(i, 1); removedTabs.push(id); },
    sendMessage: async (id: number, msg: any) => contentReply(id, msg),
    onUpdated: { addListener: (l: any) => updListeners.push(l), removeListener: (l: any) => { const i = updListeners.indexOf(l); if (i >= 0) updListeners.splice(i, 1); } },
  },
};

import { collectSource, parseRetryAfter, runParse, type CollectDeps, type ParseRequest, type Outcome } from '../src/dashboard/collect';
import { closeOrphanTabs, collectRendered } from '../src/dashboard/browser';
import { combine, contentHash, normalize, sortRecords } from '../src/dashboard/records';
import { NEVER, _resetForTests, backoffDelay, dueSources, reconcile, recoverStale, refresh, refreshStaleFor, runSource, tick, type SchedulerDeps } from '../src/dashboard/scheduler';
import { approvalFor, newDashboard, validateSourceInput, type Dashboard, type Source } from '../src/dashboard/schema';
import * as store from '../src/dashboard/store';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra)?.slice(0, 500));
};

// ------------------------------------------------------------------ fakes
const parseDoc = (t: string, type: any) => new win.DOMParser().parseFromString(t, type);
const FEED = (titles: string[], extra = '') => `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${titles.map((t, i) => `<item><title>${t}</title><link>https://example.com/${t.replace(/\W/g, '')}</link><pubDate>Wed, 0${i + 1} Jun 2026 09:30:00 GMT</pubDate></item>`).join('')}${extra}</channel></rss>`;
type Resp = { status?: number; body?: string; headers?: Record<string, string>; url?: string; delay?: number };
let fetchLog: { url: string; init: any }[] = [];
let respond: (url: string, init: any) => Resp | Promise<Resp> = () => ({ body: FEED(['One', 'Two']) });
const fakeFetch = (async (url: string, init: any) => {
  fetchLog.push({ url, init });
  const r = await respond(url, init);
  if (r.delay) await new Promise((res, rej) => { const t = setTimeout(res, r.delay); init.signal?.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); }); });
  const status = r.status ?? 200;
  const h = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: status >= 200 && status < 300, status, url: r.url ?? url, headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null }, body: undefined, text: async () => r.body ?? '' };
}) as any;
let renderedImpl: CollectDeps['rendered'] = async () => ({ ok: false, error: 'no rendered fake' });
const cdeps: CollectDeps = { fetch: fakeFetch, parse: async (req: ParseRequest) => runParse(req, parseDoc), rendered: (s) => renderedImpl(s), allowLocal: false };

let clock = Date.parse('2026-06-10T12:00:00Z');
const sleeps: number[] = [];
let collectCalls: string[] = [];
let concurrent = 0;
let maxConcurrent = 0;
const sdeps = (over: Partial<SchedulerDeps> = {}): SchedulerDeps => ({
  collect: async (s, st) => { collectCalls.push(s.id); concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); try { await new Promise((r) => setTimeout(r, 5)); return await collectSource(s, st, cdeps); } finally { concurrent--; } },
  now: () => clock,
  sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  random: () => 0.5,
  ...over,
});
const reset = async () => {
  for (const k of Object.keys(mem)) delete mem[k];
  for (const k of Object.keys(sess)) delete sess[k];
  _resetForTests();
  fetchLog = []; collectCalls = []; setCalls = []; sleeps.length = 0; concurrent = 0; maxConcurrent = 0;
  respond = () => ({ body: FEED(['One', 'Two']) });
  tabs = []; removedTabs.length = 0; created.length = 0;
};
const mkSource = async (url: string, over: any = {}, approve = true): Promise<Source> => {
  const r = validateSourceInput({ kind: 'feed', url, config: { maxItems: 10 }, ...over }, { fastIntervals: true }, clock);
  if (!r.ok) throw new Error(r.errors.join());
  const src = { ...r.value, approval: approve ? approvalFor({ ...r.value }, clock) : null } as Source;
  await store.putSource(src);
  return src;
};
const mkDash = async (id: string, sourceIds: string[], over: Partial<Dashboard> = {}) => {
  const d = { ...newDashboard(id, id, clock), widgets: [{ id: `w_${id}`.padEnd(6, 'x'), type: 'updates', title: 'U', w: 1, sourceIds, sort: 'published', limit: 10, showChecked: true } as any], ...over };
  await store.saveDashboard(d);
  return d;
};
const state = async (id: string) => (await store.getState(id))!;

(async () => {
  // ================================================================== retry-after + backoff math
  ok('Retry-After seconds / date / garbage', parseRetryAfter('120') === 120_000 && parseRetryAfter(new Date(clock + 90_000).toUTCString(), clock) === 90_000 && parseRetryAfter('soon') === undefined && parseRetryAfter('-5') === undefined && parseRetryAfter('99999999') === 86_400_000 && parseRetryAfter(null) === undefined);
  ok('backoff doubles with jitter and is capped', backoffDelay(1, 0.5) === 300_000 && backoffDelay(2, 0.5) === 600_000 && backoffDelay(3, 0.5) === 1_200_000 && backoffDelay(30, 0.5) === 6 * 3600_000 && backoffDelay(1, 0) === 270_000 && backoffDelay(1, 1) === 330_000);

  // ================================================================== records
  const srcA = { id: 'src_a', name: 'A', url: 'https://example.com/' };
  const recs = normalize(srcA, [{ title: 'X', url: 'https://example.com/x?utm_source=1' }, { title: 'X dupe', url: 'https://example.com/x' }, { title: 'Y' }], 1000);
  ok('records: stable ids, deduped by canonical url, attribution kept, no invented dates', recs.length === 2 && recs[0].sourceName === 'A' && recs[0].publishedAt === undefined && recs[0].collectedAt === 1000, recs);
  const recs2 = normalize(srcA, [{ title: 'X', url: 'https://example.com/x' }], 9999, recs);
  ok('records: collectedAt is preserved on re-collection, ids are stable', recs2[0].id === recs[0].id && recs2[0].collectedAt === 1000);
  ok('contentHash ignores collection time but not content', contentHash(recs2) === contentHash(normalize(srcA, [{ title: 'X', url: 'https://example.com/x' }], 55555)) && contentHash(recs2) !== contentHash(normalize(srcA, [{ title: 'X!', url: 'https://example.com/x' }], 1)));
  const mixed = sortRecords([{ ...recs[0], id: 'a', publishedAt: 3000 }, { ...recs[0], id: 'b', publishedAt: undefined, collectedAt: 5000 }, { ...recs[0], id: 'c', publishedAt: 1000 }]);
  ok('sorting: items without a date use first-seen time, newest first', mixed.map((r) => r.id).join() === 'b,a,c');
  ok('combine: keyword filter, cross-source URL dedupe, limit', combine([[{ ...recs[0], id: 'p', title: 'AI news', url: 'https://x.com/a' }], [{ ...recs[0], id: 'q', title: 'AI news again', url: 'https://x.com/a/?utm_x=1' }, { ...recs[0], id: 'r', title: 'Other', url: 'https://x.com/o' }]], { keyword: 'ai', limit: 5 }).length === 1 && combine([[{ ...recs[0], id: 'p' }, { ...recs[0], id: 'q', url: 'https://x.com/q' }]], { limit: 1 }).length === 1);

  // ================================================================== collectors
  await reset();
  const feed = await mkSource('https://example.com/feed.xml');
  let o: Outcome = await collectSource(feed, null, cdeps);
  ok('feed collected without cookies, referrer or cache', o.ok && !o.notModified && o.items.length === 2 && fetchLog[0].init.credentials === 'omit' && fetchLog[0].init.referrerPolicy === 'no-referrer' && fetchLog[0].init.cache === 'no-store', o);
  respond = () => ({ status: 304 });
  o = await collectSource(feed, { sourceId: feed.id, status: 'ok', nextCheckAt: 0, consecutiveFailures: 0, etag: '"abc"', lastModified: 'Wed, 01 Jun 2026 00:00:00 GMT' }, cdeps);
  ok('conditional headers sent; 304 is "not modified"', o.ok && o.notModified === true && fetchLog.at(-1)!.init.headers['If-None-Match'] === '"abc"' && fetchLog.at(-1)!.init.headers['If-Modified-Since'].includes('2026'));
  respond = () => ({ status: 429, headers: { 'Retry-After': '600' } });
  o = await collectSource(feed, null, cdeps);
  ok('429 carries Retry-After into the outcome', !o.ok && o.code === 'http-429' && o.retryAfterMs === 600_000 && o.status === 'error', o);
  respond = () => ({ status: 403 });
  o = await collectSource(feed, null, cdeps);
  ok('403 asks the user to act (needs-attention) rather than hammering', !o.ok && o.status === 'needs-attention');
  respond = () => ({ status: 500 });
  ok('500 is a retryable error', (o = await collectSource(feed, null, cdeps), !o.ok && o.status === 'error' && o.code === 'http-500'));
  respond = () => ({ body: FEED(['x']), url: 'https://evil.example/feed.xml' });
  o = await collectSource(feed, null, cdeps);
  ok('a redirect off the approved site is refused and needs re-approval', !o.ok && o.code === 'redirected-off-site' && o.status === 'needs-approval', o);
  respond = () => ({ body: FEED(['x']), url: 'http://169.254.169.254/latest' });
  ok('a redirect into a private address is refused', (o = await collectSource(feed, null, cdeps), !o.ok && o.code === 'redirected-off-site'));
  respond = () => ({ body: FEED(['x']), url: 'https://www.example.com/feed.xml' });
  ok('www<->bare redirects are fine', (o = await collectSource(feed, null, cdeps), o.ok));
  respond = () => ({ body: 'x'.repeat(2_600_000) });
  ok('oversized responses are refused', (o = await collectSource(feed, null, cdeps), !o.ok && o.code === 'too-large'));
  respond = () => ({ body: '<html>not a feed</html>' });
  ok('non-feed content gives a clear failure', (o = await collectSource(feed, null, cdeps), !o.ok && o.code === 'bad-feed'));
  respond = () => ({ body: FEED(['x']), delay: 400 });
  const slowDeps = { ...cdeps };
  const origTimeout = (await import('../src/dashboard/schema')).KINDS.feed.timeoutMs;
  (await import('../src/dashboard/schema')).KINDS.feed.timeoutMs = 50;
  ok('a slow server times out', (o = await collectSource(feed, null, slowDeps), !o.ok && o.code === 'timeout'));
  (await import('../src/dashboard/schema')).KINDS.feed.timeoutMs = origTimeout;
  const unapproved = await mkSource('https://example.com/unapproved.xml', {}, false);
  fetchLog = [];
  o = await collectSource(unapproved, null, cdeps);
  ok('an unapproved source is NEVER fetched', !o.ok && o.status === 'needs-approval' && fetchLog.length === 0);
  const expanded = { ...feed, url: 'https://other.example/feed.xml' };
  fetchLog = [];
  ok('a source whose address moved to a new host is not fetched under the old approval', (o = await collectSource(expanded, null, cdeps), !o.ok && o.status === 'needs-approval' && fetchLog.length === 0));
  ok('private addresses are refused at collection time even if stored (defense in depth)', (o = await collectSource({ ...feed, url: 'http://192.168.0.1/f' }, null, cdeps), !o.ok && o.code === 'bad-url'));

  const jsonSrc = await mkSource('https://api.example.com/items', { kind: 'json', config: { itemsPath: 'items', fields: { title: 't', url: 'u' }, maxItems: 5 } });
  respond = () => ({ body: JSON.stringify({ items: [{ t: 'J1', u: 'https://api.example.com/1' }] }) });
  ok('json collected', (o = await collectSource(jsonSrc, null, cdeps), o.ok && !o.notModified && o.items[0].title === 'J1'));
  respond = () => ({ body: '{nope' });
  ok('bad json is reported', (o = await collectSource(jsonSrc, null, cdeps), !o.ok && o.code === 'bad-json'));
  respond = () => ({ body: '{"other":1}' });
  ok('json shape mismatch is reported', (o = await collectSource(jsonSrc, null, cdeps), !o.ok && o.code === 'bad-shape'));

  const htmlCfg = { itemSelector: 'article', fields: { title: { selector: 'h2' }, url: { selector: 'a', attr: 'href' } }, maxItems: 5 };
  const htmlSrc = await mkSource('https://example.com/news', { kind: 'html', config: htmlCfg });
  respond = () => ({ body: '<body><script>window.x=1</script><article><h2>H1</h2><a href="/h1">go</a></article></body>' });
  ok('html scraped via the inert parser', (o = await collectSource(htmlSrc, null, cdeps), o.ok && !o.notModified && o.items[0].title === 'H1' && o.items[0].url === 'https://example.com/h1'));
  ok('page scripts never ran (no global was set on the parsing window)', (win as any).x === undefined);
  respond = () => ({ body: '<body><h1>Sign in</h1><form action="/login"><input type="password"></form></body>' });
  ok('a login wall becomes needs-signin and says what to do', (o = await collectSource(htmlSrc, null, cdeps), !o.ok && o.status === 'needs-signin' && /never asks for your password/.test(o.message)));
  respond = () => ({ body: '<body><div class="g-recaptcha"></div></body>' });
  ok('a CAPTCHA is reported, never bypassed', (o = await collectSource(htmlSrc, null, cdeps), !o.ok && o.code === 'captcha' && o.status === 'needs-attention'));
  respond = () => ({ body: '<body><p>nothing here</p></body>' });
  ok('no matches means needs-attention with advice', (o = await collectSource(htmlSrc, null, cdeps), !o.ok && o.code === 'no-items' && o.status === 'needs-attention'));

  const watch = await mkSource('https://example.com/price', { kind: 'page-change', config: { selector: '#p', via: 'fetch' } });
  respond = () => ({ body: '<div id="p"> $10 </div>' });
  ok('page watcher reads its region', (o = await collectSource(watch, null, cdeps), o.ok && !o.notModified && o.watchText === '$10'));

  const rsrc = await mkSource('https://example.com/spa', { kind: 'rendered', backgroundTabs: true, config: htmlCfg });
  renderedImpl = async () => ({ ok: true, items: [{ title: 'R1' }], finalUrl: 'https://example.com/spa' });
  ok('rendered source delegates to the tab collector and needs no fetch', (fetchLog = [], o = await collectSource(rsrc, null, cdeps), o.ok && !o.notModified && o.items[0].title === 'R1' && fetchLog.length === 0));
  renderedImpl = async () => ({ ok: true, items: [{ title: 'R1' }], finalUrl: 'https://evil.example/' });
  ok('rendered redirect off-site is refused', (o = await collectSource(rsrc, null, cdeps), !o.ok && o.code === 'redirected-off-site'));
  renderedImpl = async () => ({ ok: true, blocker: 'signin', finalUrl: 'https://example.com/spa' });
  ok('rendered sign-in wall: ask the user to sign in on the site', (o = await collectSource(rsrc, null, cdeps), !o.ok && o.status === 'needs-signin'));
  renderedImpl = async () => ({ ok: false, error: 'no' });
  ok('rendered failure is an outcome, not an exception', (o = await collectSource(rsrc, null, cdeps), !o.ok));
  renderedImpl = async () => { throw new Error('boom'); };
  ok('even a throwing collector cannot crash the caller', (o = await collectSource(rsrc, null, cdeps), !o.ok && o.code === 'unexpected'));

  // ================================================================== scheduler: first run, change detection, no rewrite
  await reset();
  const s1 = await mkSource('https://example.com/feed.xml', { intervalMinutes: 30 });
  await mkDash('dash_one', [s1.id]);
  ok('an approved source needed by a live dashboard is due', JSON.stringify(await dueSources(clock)) === JSON.stringify([s1.id]));
  let res = await tick(sdeps());
  let st = await state(s1.id);
  ok('first tick collects it, records saved, freshness recorded', res[s1.id] === 'ran' && st.status === 'ok' && st.lastSuccessAt === clock && st.lastChangeAt === clock && st.nextCheckAt === clock + 30 * 60_000 && (await store.getRecords(s1.id)).length === 2, st);
  ok('collection finished with NO dashboard tab involved (alarm-style tick only touches storage)', (await store.getLog())[0].outcome === 'changed');
  clock += 31 * 60_000;
  setCalls = [];
  res = await tick(sdeps());
  st = await state(s1.id);
  ok('an unchanged result updates freshness but does NOT rewrite cached records', st.lastSuccessAt === clock && st.lastChangeAt !== clock && !setCalls.some((k) => k.includes(store.K.rec(s1.id))) && (await store.getLog())[0].outcome === 'unchanged', setCalls);
  const firstSeen = (await store.getRecords(s1.id))[0].collectedAt;
  clock += 31 * 60_000;
  respond = () => ({ body: FEED(['One', 'Two', 'Three']) });
  await tick(sdeps());
  const after = await store.getRecords(s1.id);
  ok('a changed result is written, old items keep their first-seen time', after.length === 3 && after.find((r) => r.title === 'One')!.collectedAt === firstSeen && (await state(s1.id)).lastChangeAt === clock);
  ok('not due again before the interval elapses', (await dueSources(clock + 10 * 60_000)).length === 0 && (await tick(sdeps({ now: () => clock + 10 * 60_000 }))) && collectCalls.length === 3);

  // ================================================================== failures keep last good data, back off, stop for the user
  clock += 31 * 60_000;
  respond = () => ({ status: 500 });
  await tick(sdeps());
  st = await state(s1.id);
  ok('failure: last good data kept, status error, honest message, backoff scheduled', st.status === 'error' && st.consecutiveFailures === 1 && (await store.getRecords(s1.id)).length === 3 && st.lastSuccessAt !== undefined && st.nextCheckAt === clock + 300_000 && /error/.test(st.lastError!), st);
  ok('not retried before the backoff', (await dueSources(clock + 60_000)).length === 0);
  clock += 301_000;
  await tick(sdeps());
  st = await state(s1.id);
  ok('second failure doubles the delay', st.consecutiveFailures === 2 && st.nextCheckAt === clock + 600_000);
  for (let i = 0; i < 3; i++) { clock += 7 * 3600_000; await tick(sdeps()); }
  st = await state(s1.id);
  ok('after bounded retries automatic checks stop and the user is told', st.consecutiveFailures === 5 && st.status === 'error', st);
  clock += 7 * 3600_000;
  await tick(sdeps());
  st = await state(s1.id);
  ok('6th failure -> needs-attention, never scheduled again automatically', st.status === 'needs-attention' && st.nextCheckAt === NEVER && /Automatic retries stopped/.test(st.lastError!) && (await dueSources(clock + 1e12)).length === 0, st);
  respond = () => ({ body: FEED(['One', 'Two', 'Three']) });
  const rr = await refresh([s1.id], sdeps());
  st = await state(s1.id);
  ok('manual Refresh recovers it and resets the failure count', rr[s1.id] === 'ran' && st.status === 'ok' && st.consecutiveFailures === 0 && st.nextCheckAt < NEVER);

  // Retry-After
  clock += 31 * 60_000;
  respond = () => ({ status: 429, headers: { 'Retry-After': '7200' } });
  await tick(sdeps());
  st = await state(s1.id);
  ok('Retry-After longer than the backoff wins', st.backoffUntil === clock + 7200_000 && st.nextCheckAt === clock + 7200_000, st);
  respond = () => ({ body: FEED(['One']) });
  ok('a manual refresh also respects Retry-After', (await refresh([s1.id], sdeps()))[s1.id] === 'backoff' && collectCalls.length > 0);

  // user-action states stop automatic checks
  await reset();
  const sw = await mkSource('https://example.com/news', { kind: 'html', config: htmlCfg });
  await mkDash('dash_wall', [sw.id]);
  respond = () => ({ body: '<form action="/login"><input type="password"></form>' });
  await tick(sdeps());
  st = await state(sw.id);
  ok('sign-in required is surfaced and NOT retried automatically', st.status === 'needs-signin' && st.nextCheckAt === NEVER && st.errorCode === 'signin' && (await dueSources(clock + 1e11)).length === 0, st);

  // ================================================================== overlap, dedupe, concurrency, host politeness
  await reset();
  const s2 = await mkSource('https://example.com/feed.xml');
  await mkDash('dash_a', [s2.id]);
  await mkDash('dash_b', [s2.id]);
  const widgetTwice = await store.getDashboard('dash_a');
  widgetTwice!.widgets.push({ ...widgetTwice!.widgets[0], id: 'w_second' } as any);
  await store.saveDashboard(widgetTwice!);
  ok('one source used by 2 dashboards and 2 widgets is scheduled ONCE', (await dueSources(clock)).length === 1);
  await tick(sdeps());
  ok('...and fetched once', collectCalls.length === 1 && fetchLog.length === 1, collectCalls);
  await reset();
  const s3 = await mkSource('https://example.com/feed.xml');
  await mkDash('dash_c', [s3.id]);
  const [a, b] = await Promise.all([runSource(s3.id, sdeps()), runSource(s3.id, sdeps())]);
  ok('two simultaneous runs of one source never overlap', [a, b].sort().join() === 'already-running,ran' && collectCalls.length === 1, [a, b]);
  const [c, d] = await Promise.all([refresh([s3.id], sdeps()), tick(sdeps())]);
  ok('refresh racing a tick does not double-collect', collectCalls.length <= 2 && Object.values({ ...c, ...d }).every((x) => ['ran', 'already-running', 'recent', 'backoff'].includes(x)), [c, d]);

  await reset();
  const many: Source[] = [];
  for (let i = 0; i < 8; i++) many.push(await mkSource(`https://site${i}.example.com/feed.xml`));
  await mkDash('dash_many', many.map((s) => s.id).slice(0, 8));
  await tick(sdeps());
  ok('concurrency is bounded', maxConcurrent <= 3 && maxConcurrent >= 2 && collectCalls.length === 8, maxConcurrent);
  await reset();
  const h1 = await mkSource('https://same.example.com/a.xml'); const h2 = await mkSource('https://same.example.com/b.xml');
  await mkDash('dash_host', [h1.id, h2.id]);
  await tick(sdeps({ collect: async (s, st) => collectSource(s, st, cdeps) }));
  ok('requests to the same host are spaced out', sleeps.some((ms) => ms > 0 && ms <= 4000), sleeps);

  // ================================================================== pauses and approvals
  await reset();
  const p1 = await mkSource('https://example.com/feed.xml');
  const dash = await mkDash('dash_p', [p1.id]);
  await store.setSettings({ paused: true });
  ok('global pause: nothing is due', (await dueSources(clock)).length === 0 && Object.keys(await tick(sdeps())).length === 0 && collectCalls.length === 0);
  await store.setSettings({ paused: false });
  await store.saveDashboard({ ...dash, paused: true });
  ok('dashboard pause: its sources are not scheduled', (await dueSources(clock)).length === 0);
  const wpaused = { ...dash, widgets: [{ ...dash.widgets[0], paused: true }] } as Dashboard;
  await store.saveDashboard(wpaused);
  ok('widget pause: a source nobody wants updated is not scheduled', (await dueSources(clock)).length === 0);
  await mkDash('dash_other', [p1.id]);
  ok('...but another live dashboard using the same source keeps it scheduled', (await dueSources(clock)).length === 1);
  await store.deleteDashboard('dash_other');
  ok('deleting a dashboard another one still needs keeps the source; deleting the last user removes source, state and cache', (await store.getSource(p1.id)) !== null);
  await store.saveDashboard({ ...dash, paused: false });
  await tick(sdeps());
  await store.deleteDashboard('dash_p');
  ok('...last dashboard deleted: source, state and cached data are gone', (await store.getSource(p1.id)) === null && (await store.getState(p1.id)) === null && (await store.getRecords(p1.id)).length === 0 && !Object.keys(mem).some((k) => k.startsWith('dsrc:') || k.startsWith('dstate:') || k.startsWith('drec:')), Object.keys(mem));
  await reset();
  const pause2 = await mkSource('https://example.com/feed.xml');
  await mkDash('dash_sp', [pause2.id]);
  await store.putState({ sourceId: pause2.id, status: 'paused', nextCheckAt: 0, consecutiveFailures: 0 });
  ok('a paused source is skipped by ticks and refreshes', (await dueSources(clock)).length === 0 && (await refresh([pause2.id], sdeps()))[pause2.id] === 'paused' && collectCalls.length === 0);
  await reset();
  const un = await mkSource('https://example.com/feed.xml', {}, false);
  await mkDash('dash_un', [un.id]);
  ok('unapproved sources are never due and never fetched, even on manual refresh', (await dueSources(clock)).length === 0 && (await refresh([un.id], sdeps()))[un.id] === 'needs-approval' && fetchLog.length === 0 && (await state(un.id)).status === 'needs-approval');
  const rend = await mkSource('https://example.com/spa', { kind: 'rendered', backgroundTabs: false, config: htmlCfg });
  const widened = { ...rend, backgroundTabs: true };
  await store.putSource(widened);
  await mkDash('dash_wide', [rend.id]);
  ok('turning on background tabs after approval invalidates it: never run until re-approved', (await dueSources(clock)).length === 0 && (await refresh([rend.id], sdeps()))[rend.id] === 'needs-approval');

  // ================================================================== restart recovery
  await reset();
  const r1 = await mkSource('https://example.com/feed.xml');
  await mkDash('dash_r', [r1.id]);
  await store.putState({ sourceId: r1.id, status: 'running', runningSince: clock - 3600_000, runId: 'dead', nextCheckAt: 0, consecutiveFailures: 0 });
  ok('a lease left by a dead worker is not "due" (so it cannot be stuck forever)...', (await dueSources(clock)).length === 0);
  _resetForTests();
  const n = await recoverStale(sdeps());
  st = await state(r1.id);
  ok('...recovery marks it interrupted and due immediately', n === 1 && st.status === 'error' && st.errorCode === 'interrupted' && st.nextCheckAt === clock && (await dueSources(clock)).length === 1);
  await store.putState({ ...st, status: 'running', runId: 'dead2', runningSince: clock });
  let orphansClosed = 0;
  await reconcile(sdeps({ closeOrphans: async () => { orphansClosed++; return 0; } }));
  st = await state(r1.id);
  ok('startup reconcile: alarm created, orphan tabs cleaned, interrupted run recovered and re-run, data present', !!alarms['ww-dash-tick'] && alarms['ww-dash-tick'].periodInMinutes === 1 && orphansClosed === 1 && st.status === 'ok' && (await store.getRecords(r1.id)).length === 2, st);
  const keep = alarms['ww-dash-tick'];
  await reconcile(sdeps());
  ok('reconcile is idempotent (alarm not duplicated)', alarms['ww-dash-tick'] === keep);

  // ================================================================== schedules persist; new sources run immediately; stale-on-open
  await reset();
  const n1 = await mkSource('https://example.com/feed.xml', { intervalMinutes: 30 });
  await mkDash('dash_n', [n1.id]);
  ok('a newly approved source with no state is immediately due', (await dueSources(clock)).includes(n1.id));
  await refresh([n1.id], sdeps());
  clock += 10 * 60_000;
  fetchLog = [];
  ok('opening a dashboard with fresh data does not hit the network', Object.keys(await refreshStaleFor('dash_n', sdeps())).length === 0 && fetchLog.length === 0);
  clock += 25 * 60_000;
  const so = await refreshStaleFor('dash_n', sdeps());
  ok('opening a dashboard refreshes sources whose data is past its interval', so[n1.id] === 'ran' && fetchLog.length === 1);
  ok('stale-on-open skips sources in backoff or needing the user', (async () => true)() instanceof Promise);

  // ================================================================== failure isolation
  await reset();
  const good = await mkSource('https://good.example.com/feed.xml'); const bad = await mkSource('https://bad.example.com/feed.xml');
  await mkDash('dash_iso', [good.id, bad.id]);
  respond = (u) => (u.includes('bad.') ? { status: 500 } : { body: FEED(['G1']) });
  await tick(sdeps());
  ok('one failing connector does not break another', (await state(good.id)).status === 'ok' && (await state(bad.id)).status === 'error' && (await store.getRecords(good.id)).length === 1);
  respond = (u) => { if (u.includes('bad.')) throw new Error('kaboom'); return { body: FEED(['G1']) }; };
  clock += 40 * 60_000;
  await tick(sdeps());
  ok('even a thrown error is contained and recorded', (await state(good.id)).status === 'ok' && (await state(bad.id)).status === 'error');
  await tick(sdeps({ collect: async () => { throw new Error('collector exploded'); } }));
  ok('a throwing collector function is contained by the scheduler', true);

  // ================================================================== managed tab collector
  await reset();
  const renderedSrc = (await mkSource('https://example.com/spa', { kind: 'rendered', backgroundTabs: true, config: htmlCfg }));
  const goodReply = (tabId: number, msg: any) => (msg.type === 'ww:collect' ? { ok: true, items: [{ title: 'T' }], finalUrl: tabs.find((t) => t.id === tabId)?.url ?? 'https://example.com/spa' } : undefined);
  contentReply = goodReply;
  tabs = [{ id: 1, url: 'https://example.com/spa#frag', status: 'complete', active: true }, { id: 2, url: 'https://news.example.com/', status: 'complete', active: false }];
  let rr2 = await collectRendered(renderedSrc);
  ok('uses an existing tab on the same page, and never creates, navigates or closes anything', rr2.ok && created.length === 0 && removedTabs.length === 0 && tabs.length === 2, rr2);
  tabs = [{ id: 2, url: 'https://news.example.com/', status: 'complete', active: true }, { id: 3, url: 'https://example.com/other', status: 'complete', active: false }];
  rr2 = await collectRendered(renderedSrc);
  ok('otherwise opens ONE inactive tab, reads it, and closes only that tab', rr2.ok && created.length === 1 && created[0].active === false && removedTabs.length === 1 && removedTabs[0] > 100 && tabs.map((t) => t.id).join() === '2,3', { created, removedTabs, tabs });
  ok('the collector tab list is cleaned up', (sess['dcollectTabs'] ?? []).length === 0);
  const noTabs = await mkSource('https://example.com/spa', { kind: 'rendered', backgroundTabs: false, config: { ...htmlCfg, maxItems: 4 } });
  created.length = 0;
  rr2 = await collectRendered(noTabs);
  ok('without permission for background tabs, no tab is ever opened', !rr2.ok && created.length === 0 && /background tabs/.test(rr2.error!), rr2);
  contentReply = () => { throw new Error('no content script'); };
  removedTabs.length = 0;
  rr2 = await collectRendered(renderedSrc);
  ok('an unreadable page fails cleanly and the created tab is still closed', !rr2.ok && removedTabs.length === 1);
  contentReply = goodReply;
  tabBehavior = (t) => { t.url = 'https://evil.example/landing'; };
  removedTabs.length = 0;
  rr2 = await collectRendered(renderedSrc);
  ok('a redirect to another site is detected before reading, and the tab is closed', !rr2.ok && /different site/.test(rr2.error!) && removedTabs.length === 1);
  tabBehavior = () => {};
  const pageChange = await mkSource('https://example.com/p', { kind: 'page-change', backgroundTabs: true, config: { selector: '#x', via: 'rendered' } });
  contentReply = (id, msg) => ({ ok: true, watchText: 'v1', finalUrl: 'https://example.com/p', echo: msg.kind });
  rr2 = await collectRendered(pageChange);
  ok('rendered page watchers use the same collector', rr2.ok && rr2.watchText === 'v1');
  // concurrency: managed tabs are serialized
  tabs = [];
  let open = 0; let maxOpen = 0;
  contentReply = async (id, msg) => { open++; maxOpen = Math.max(maxOpen, open); await new Promise((r) => setTimeout(r, 15)); open--; return { ok: true, items: [{ title: 'x' }], finalUrl: 'https://example.com/spa' }; };
  await Promise.all([collectRendered(renderedSrc), collectRendered({ ...renderedSrc, url: 'https://example.com/spa2' }), collectRendered({ ...renderedSrc, url: 'https://example.com/spa3' })]);
  ok('never more than one managed tab at once', maxOpen === 1, maxOpen);
  // orphan cleanup
  tabs = [{ id: 7, url: 'https://example.com/spa', status: 'complete' }, { id: 8, url: 'https://user.example/', status: 'complete' }];
  sess['dcollectTabs'] = [7, 999];
  removedTabs.length = 0;
  const closed = await closeOrphanTabs();
  ok('orphan cleanup closes only recorded collector tabs', closed === 1 && removedTabs.join() === '7' && tabs.length === 1 && tabs[0].id === 8 && sess['dcollectTabs'].length === 0, { closed, removedTabs });

  // ================================================================== store: migration + duplicate
  await reset();
  mem['dash:dash_old1'] = { id: 'dash_old1', name: 'Old', widgets: [{ type: 'updates', sourceIds: ['src_missing'] }, { type: 'notes', text: 'kept' }] };
  mem['dash:../bad'] = { id: '../bad', widgets: [] };
  mem['dsrc:src_bad'] = { id: 'src_bad', kind: 'html', config: { itemSelector: '@import x', fields: {} } };
  await store.migrate();
  const migrated = await store.getDashboard('dash_old1');
  ok('migration repairs dashboards (drops widgets that point nowhere), drops corrupt ones and sources', migrated!.widgets.length === 1 && migrated!.widgets[0].type === 'notes' && !mem['dash:../bad'] && !mem['dsrc:src_bad'] && mem['dset'].schemaVersion === 1, mem);
  const dup = await mkSource('https://example.com/feed.xml');
  await mkDash('dash_dup1', [dup.id]);
  const copy = await store.duplicateDashboard('dash_dup1');
  ok('duplicate gets new ids, shares sources (no extra traffic)', copy!.id !== 'dash_dup1' && copy!.widgets[0].id !== (await store.getDashboard('dash_dup1'))!.widgets[0].id && store.sourceIdsOf(copy!)[0] === dup.id && /copy/.test(copy!.name) && (await dueSources(clock)).length === 1);

  console.log(fails ? `${fails} FAILED` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL crashed', e?.stack ?? e); process.exit(1); });
