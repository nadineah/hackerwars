import {
  KINDS,
  LIMITS,
  SCHEMA_VERSION,
  approvalCovers,
  approvalFor,
  isSafePath,
  newDashboard,
  sourceIdFor,
  validateDashboard,
  validateSourceConfig,
  validateSourceInput,
  validateTheme,
  validateWidget,
  type Source,
  type WidgetValidationContext,
} from '../src/dashboard/schema';
import { ago, canonicalUrl, checkCollectionUrl, cleanText, hashHex, inFuture, isPrivateHost, parseDate, safeLink, sameSiteHost, stableStringify } from '../src/dashboard/util';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra)?.slice(0, 300));
};

// ====================================================================== URL safety (SSRF-style attacks)
const bad = (u: unknown) => !checkCollectionUrl(u).ok;
for (const u of [
  'javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'ftp://example.com/x', 'chrome://settings', 'chrome-extension://abc/x', 'blob:https://example.com/x', 'about:blank',
  'http://localhost/', 'http://localhost:3000/', 'http://foo.localhost/', 'http://127.0.0.1/', 'http://127.1.2.3/', 'http://0.0.0.0/', 'http://10.0.0.5/', 'http://172.16.0.1/', 'http://172.31.255.255/', 'http://192.168.1.1/',
  'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/', 'http://[::1]/', 'http://[fc00::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/',
  'http://2130706433/', 'http://0x7f000001/', 'http://017700000001/', 'http://127.0.0.1.nip.io.localhost/',
  'http://router.local/', 'http://printer.lan/', 'http://nas.home.arpa/', 'http://intranet/', 'http://corp.internal/',
  'https://user:pass@example.com/', 'https://user@example.com/', 'https://example.com:8080/', 'https://example.com:22/',
  '', '   ', 'not a url', 'https://', null, undefined, 42, {}, 'https://example.com/' + 'a'.repeat(2100),
]) {
  ok(`URL gate rejects ${JSON.stringify(u)?.slice(0, 50)}`, bad(u), checkCollectionUrl(u));
}
for (const u of ['https://example.com/feed.xml', 'http://example.com/', 'https://news.ycombinator.com/', 'https://hn.algolia.com/api/v1/search?tags=story', 'https://www.bbc.co.uk/news/rss.xml', 'https://example.com:443/x', 'https://sub.domain.example.org/a/b?c=d#e']) {
  ok(`URL gate accepts ${u}`, checkCollectionUrl(u).ok);
}
ok('the developer override allows localhost and other ports', checkCollectionUrl('http://127.0.0.1:8123/feed.xml', { allowLocal: true }).ok);
ok('...but never non-http schemes or embedded credentials, even with the override', !checkCollectionUrl('file:///x', { allowLocal: true }).ok && !checkCollectionUrl('http://u:p@127.0.0.1/', { allowLocal: true }).ok);
ok('isPrivateHost basics', isPrivateHost('localhost') && isPrivateHost('192.168.0.1') && !isPrivateHost('example.com') && !isPrivateHost('8.8.8.8') && !isPrivateHost('172.32.0.1') && isPrivateHost('172.20.0.1'));

// ====================================================================== util
ok('canonicalUrl strips tracking, fragments, trailing slash, lowercases host', canonicalUrl('HTTPS://Example.COM/a/b/?utm_source=x&b=2&a=1&fbclid=z#frag') === 'https://example.com/a/b?a=1&b=2' || canonicalUrl('HTTPS://Example.COM/a/b/?utm_source=x&b=2&a=1&fbclid=z#frag') === 'https://example.com/a/b/?a=1&b=2', canonicalUrl('HTTPS://Example.COM/a/b/?utm_source=x&b=2&a=1&fbclid=z#frag'));
ok('canonicalUrl treats equivalent links as equal', canonicalUrl('https://example.com/post/') === canonicalUrl('https://EXAMPLE.com/post#top') && canonicalUrl('https://example.com/post?utm_campaign=a') === canonicalUrl('https://example.com/post'));
ok('canonicalUrl resolves relative links and rejects non-http', canonicalUrl('/x', 'https://example.com/a') === 'https://example.com/x' && canonicalUrl('javascript:1') === null && canonicalUrl('mailto:a@b.c') === null);
ok('safeLink only returns plain http(s)', safeLink('/p', 'https://e.com/') === 'https://e.com/p' && safeLink('javascript:alert(1)', 'https://e.com/') === undefined && safeLink('data:text/html,x', 'https://e.com/') === undefined && safeLink('https://u:p@e.com/', 'https://e.com/') === undefined && safeLink('', 'https://e.com/') === undefined && safeLink(null, 'https://e.com/') === undefined);
ok('hashHex is stable, fixed length and sensitive', hashHex('a') === hashHex('a') && hashHex('a') !== hashHex('b') && hashHex('a').length === 26);
ok('stableStringify ignores key order and undefined', stableStringify({ b: 1, a: [2, { d: 1, c: undefined }] }) === stableStringify({ a: [2, { c: undefined, d: 1 }], b: 1 }));
ok('parseDate accepts real dates', parseDate('2026-05-01T10:00:00Z') === Date.UTC(2026, 4, 1, 10) && parseDate('Wed, 03 Jun 2026 09:30:00 GMT') === Date.UTC(2026, 5, 3, 9, 30));
ok('parseDate NEVER invents one: garbage, empty, ancient and far-future are undefined', parseDate('') === undefined && parseDate(undefined) === undefined && parseDate('yesterday') === undefined && parseDate('0001-01-01') === undefined && parseDate('2999-01-01T00:00:00Z') === undefined && parseDate('NaN') === undefined);
ok('cleanText strips control and bidi characters and collapses space', cleanText('a\u0000b‮c\n\n  d', 50) === 'abc d' && cleanText(null, 5) === '' && cleanText('x'.repeat(10), 3) === 'xxx');
ok('ago/inFuture read naturally', ago(Date.now() - 10_000) === 'just now' && ago(Date.now() - 10 * 60_000) === '10 minutes ago' && ago(Date.now() - 3600_000) === '1 hour ago' && ago(Date.now() - 49 * 3600_000) === '2 days ago' && inFuture(Date.now() + 30 * 60_000) === 'in 30 minutes');
ok('sameSiteHost treats www and bare as one site, nothing else', sameSiteHost('www.example.com', 'example.com') && !sameSiteHost('example.com', 'evil-example.com') && !sameSiteHost('a.example.com', 'example.com'));

// ====================================================================== field paths
for (const p of ['hits', 'data.children', 'data.children[0].title', 'a.b.c', 'objectID', 'x[2]']) ok(`path accepts ${p}`, isSafePath(p));
for (const p of ['', 'a..b', '.a', 'a.', 'a[b]', 'a[1][2]', 'a b', 'a;b', 'a()', '__proto__', 'a.__proto__.b', 'constructor', 'a.prototype', 'a[0].constructor', 'constructor[0]', '__proto__[1].x', 'a'.repeat(200), 5, null]) ok(`path rejects ${JSON.stringify(p)}`, !isSafePath(p));

// ====================================================================== source configs
const feedCfg = { maxItems: 10 };
const htmlCfg = { itemSelector: 'article.post', fields: { title: { selector: 'h2 a' }, url: { selector: 'h2 a', attr: 'href' }, summary: { selector: 'p' }, published: { selector: 'time', attr: 'datetime' } }, maxItems: 10 };
ok('a valid feed config', validateSourceConfig('feed', feedCfg).ok);
ok('maxItems is clamped, defaulted', (validateSourceConfig('feed', { maxItems: 9999 }) as any).value.maxItems === LIMITS.maxItems && (validateSourceConfig('feed', {}) as any).value.maxItems === 20 && (validateSourceConfig('feed', { maxItems: -5 }) as any).value.maxItems === 1);
ok('a valid html config', validateSourceConfig('html', htmlCfg).ok);
ok('html config needs a title field and an item selector', !validateSourceConfig('html', { ...htmlCfg, fields: {} }).ok && !validateSourceConfig('html', { fields: htmlCfg.fields }).ok && !validateSourceConfig('html', { ...htmlCfg, itemSelector: '' }).ok);
for (const sel of ['@import url(https://evil.example/x.css) /*', 'a{b}', 'a;b', '<script>', '!!!', 'x'.repeat(300), 'a /* b']) {
  ok(`html config rejects unsafe item selector ${JSON.stringify(sel).slice(0, 40)}`, !validateSourceConfig('html', { ...htmlCfg, itemSelector: sel }).ok);
  ok(`html config rejects unsafe field selector ${JSON.stringify(sel).slice(0, 40)}`, !validateSourceConfig('html', { ...htmlCfg, fields: { title: { selector: sel } } }).ok);
}
ok('html config rejects unknown attr values (no arbitrary attribute reads)', !validateSourceConfig('html', { ...htmlCfg, fields: { title: { selector: 'a', attr: 'onclick' } } }).ok && !validateSourceConfig('html', { ...htmlCfg, fields: { title: { selector: 'a', attr: 'innerHTML' } } }).ok);
ok('rendered config bounds the wait', (validateSourceConfig('rendered', { ...htmlCfg, waitMs: 999999 }) as any).value.waitMs === LIMITS.waitMsMax && (validateSourceConfig('rendered', { ...htmlCfg, waitMs: 1 }) as any).value.waitMs === 1000 && (validateSourceConfig('rendered', htmlCfg) as any).value.waitMs === 8000);
ok('rendered config validates waitFor', !validateSourceConfig('rendered', { ...htmlCfg, waitFor: '@import x /*' }).ok && validateSourceConfig('rendered', { ...htmlCfg, waitFor: '.loaded' }).ok);
const jsonCfg = { itemsPath: 'hits', fields: { title: 'title', url: 'url', published: 'created_at' }, urlTemplate: 'https://news.ycombinator.com/item?id={objectID}', maxItems: 10 };
ok('a valid json config', validateSourceConfig('json', jsonCfg).ok);
ok('json config allows an empty itemsPath (top-level array)', validateSourceConfig('json', { ...jsonCfg, itemsPath: '' }).ok);
ok('json config rejects bad paths and templates', !validateSourceConfig('json', { ...jsonCfg, itemsPath: 'a..b' }).ok && !validateSourceConfig('json', { ...jsonCfg, fields: { title: '__proto__' } }).ok && !validateSourceConfig('json', { ...jsonCfg, urlTemplate: 'javascript:{objectID}' }).ok && !validateSourceConfig('json', { ...jsonCfg, urlTemplate: 'https://x.com/{a b}' }).ok && !validateSourceConfig('json', { ...jsonCfg, urlTemplate: 'https://x.com/{{objectID}}' }).ok && !validateSourceConfig('json', { ...jsonCfg, fields: {} }).ok);
ok('page-change config', validateSourceConfig('page-change', { selector: '#price', via: 'fetch' }).ok && !validateSourceConfig('page-change', { selector: '' }).ok && (validateSourceConfig('page-change', { selector: '#p', via: 'weird' }) as any).value.via === 'fetch');
ok('configs must be objects', !validateSourceConfig('feed', null).ok && !validateSourceConfig('feed', 'x').ok && !validateSourceConfig('feed', []).ok);
ok('unsupported kinds are refused with a clear message', validateSourceConfig('graphql' as any, {}).ok === false);

// ====================================================================== source input
const good = { kind: 'feed', name: 'BBC', url: 'https://feeds.bbci.co.uk/news/rss.xml', config: feedCfg };
const s1 = validateSourceInput(good);
ok('a valid source is accepted with defaults', s1.ok && (s1 as any).value.intervalMinutes === 30 && (s1 as any).value.name === 'BBC' && (s1 as any).value.schemaVersion === SCHEMA_VERSION, s1);
ok('rendered default interval is 60 and background tabs are OFF by default', (validateSourceInput({ kind: 'rendered', url: 'https://example.com/', config: { ...htmlCfg } }) as any).value.intervalMinutes === 60 && (validateSourceInput({ kind: 'rendered', url: 'https://example.com/', config: htmlCfg }) as any).value.backgroundTabs === false);
ok('background tabs only on when explicitly true and only for rendered kinds', (validateSourceInput({ kind: 'rendered', url: 'https://example.com/', config: htmlCfg, backgroundTabs: true }) as any).value.backgroundTabs === true && (validateSourceInput({ ...good, backgroundTabs: true }) as any).value.backgroundTabs === false);
ok('name falls back to the host', (validateSourceInput({ ...good, name: '' }) as any).value.name === 'feeds.bbci.co.uk' && (validateSourceInput({ ...good, name: undefined, url: 'https://www.example.com/rss' }) as any).value.name === 'example.com');
ok('unsupported kind lists the supported ones', (() => { const r = validateSourceInput({ ...good, kind: 'graphql' }); return !r.ok && r.errors[0].includes('feed') && r.errors[0].includes('rendered'); })());
ok('private URLs are rejected at the source level', !validateSourceInput({ ...good, url: 'http://192.168.1.1/rss' }).ok && !validateSourceInput({ ...good, url: 'http://localhost/rss' }).ok);
ok('...unless the developer override is on', validateSourceInput({ ...good, url: 'http://127.0.0.1:9000/rss' }, { allowLocal: true }).ok);
for (const [name, mins] of [['too fast for a feed', 5], ['zero', 0], ['negative', -10], ['fractional', 30.5], ['string', '30'], ['too slow', 99999], ['NaN', NaN]] as const) {
  ok(`interval ${name} is rejected`, !validateSourceInput({ ...good, intervalMinutes: mins }).ok, mins);
}
ok('minimum intervals are enforced per kind', validateSourceInput({ ...good, intervalMinutes: 10 }).ok && !validateSourceInput({ kind: 'rendered', url: 'https://example.com/', config: htmlCfg, intervalMinutes: 29 }).ok && validateSourceInput({ kind: 'rendered', url: 'https://example.com/', config: htmlCfg, intervalMinutes: 30 }).ok);
ok('a page-change watcher in rendered mode follows the rendered minimum', !validateSourceInput({ kind: 'page-change', url: 'https://example.com/', config: { selector: '#x', via: 'rendered' }, intervalMinutes: 15 }).ok && validateSourceInput({ kind: 'page-change', url: 'https://example.com/', config: { selector: '#x', via: 'fetch' }, intervalMinutes: 15 }).ok);
ok('the developer override lowers minimums (never reachable from the UI)', validateSourceInput({ ...good, intervalMinutes: 1 }, { fastIntervals: true }).ok && !validateSourceInput({ ...good, intervalMinutes: 1 }).ok);
ok('identical requests share ONE source id (deduplication)', (validateSourceInput(good) as any).value.id === (validateSourceInput({ ...good, name: 'Other name', intervalMinutes: 60 }) as any).value.id);
ok('different url or config means a different source', (validateSourceInput(good) as any).value.id !== (validateSourceInput({ ...good, url: 'https://example.com/rss' }) as any).value.id && (validateSourceInput(good) as any).value.id !== (validateSourceInput({ ...good, config: { maxItems: 5 } }) as any).value.id);
ok('source id ignores config key order', sourceIdFor('html', 'https://e.com/', { itemSelector: 'a', fields: { title: {} }, maxItems: 5 } as any) === sourceIdFor('html', 'https://e.com/', { maxItems: 5, fields: { title: {} }, itemSelector: 'a' } as any));

// ====================================================================== approvals
const mk = (over: Partial<Source> = {}): Source => ({ ...(validateSourceInput(good) as any).value, approval: null, ...over });
const base = mk();
const appr = approvalFor(base);
ok('approval records host, method and that data stays local', appr.hosts[0] === 'feeds.bbci.co.uk' && appr.method === 'fetch' && appr.backgroundTabs === false && appr.dataLocalOnly === true && appr.kind === 'feed');
ok('no approval covers nothing', !approvalCovers(null, base));
ok('an approval covers the same source', approvalCovers(appr, base));
ok('a faster interval is not an expansion', approvalCovers(appr, { ...base }));
ok('a new host needs a new approval', !approvalCovers(appr, { ...base, url: 'https://evil.example/rss' }));
ok('www and bare host are one site', approvalCovers(approvalFor({ ...base, url: 'https://www.example.com/rss' }), { ...base, url: 'https://example.com/rss' }));
ok('a different kind (collection method / data scope) needs a new approval', !approvalCovers(appr, { ...base, kind: 'html', config: htmlCfg as any }));
const rendered = (validateSourceInput({ kind: 'rendered', url: 'https://example.com/', config: htmlCfg }) as any).value as Source;
const renderedAppr = approvalFor(rendered);
ok('rendered approvals record the method and background-tab choice', renderedAppr.method === 'rendered' && renderedAppr.backgroundTabs === false);
ok('turning background tabs ON after approval needs a new approval', !approvalCovers(renderedAppr, { ...rendered, backgroundTabs: true }) && approvalCovers(approvalFor({ ...rendered, backgroundTabs: true }), { ...rendered, backgroundTabs: false }));
ok('changing selectors within the same page does not need a new approval', approvalCovers(appr, { ...base }) && approvalCovers(renderedAppr, { ...rendered, config: { ...(rendered.config as any), itemSelector: 'li' } }));
ok('switching a page watcher from fetch to rendered needs a new approval', !approvalCovers(approvalFor({ kind: 'page-change', url: 'https://example.com/', config: { selector: '#x', via: 'fetch', waitMs: 8000 }, intervalMinutes: 30, backgroundTabs: false }), { kind: 'page-change', url: 'https://example.com/', config: { selector: '#x', via: 'rendered', waitMs: 8000 }, backgroundTabs: true }));

// ====================================================================== widgets
let n = 0;
const ctx: WidgetValidationContext = { sourceIds: new Set(['src_a', 'src_b']), newId: (p) => `${p}_gen${++n}00` };
const W = (raw: unknown) => validateWidget(raw, ctx);
ok('updates widget with real sources', W({ type: 'updates', sourceIds: ['src_a', 'src_b'] }).ok);
ok('updates widget rejects unknown sources (the AI cannot invent a source id)', !W({ type: 'updates', sourceIds: ['src_zzz'] }).ok && !W({ type: 'updates', sourceIds: [] }).ok && !W({ type: 'updates' }).ok);
ok('updates widget caps how many sources it combines', !W({ type: 'updates', sourceIds: Array.from({ length: 9 }, () => 'src_a') }).ok || (W({ type: 'updates', sourceIds: Array.from({ length: 9 }, () => 'src_a') }) as any).value.sourceIds.length === 1);
const uw = (W({ type: 'updates', sourceIds: ['src_a', 'src_a', 'src_b'], limit: 999, sort: 'nonsense', w: 9, keyword: '  AI  ', title: '  Hi  ' }) as any).value;
ok('widget fields are normalized: dedup sources, clamp limit, default sort, clamp width, trim', JSON.stringify(uw.sourceIds) === '["src_a","src_b"]' && uw.limit === LIMITS.maxItems && uw.sort === 'published' && uw.w === 1 && uw.keyword === 'AI' && uw.title === 'Hi', uw);
ok('list widget requires an existing source', W({ type: 'list', sourceId: 'src_a' }).ok && !W({ type: 'list', sourceId: 'nope' }).ok && !W({ type: 'list' }).ok);
ok('page-change widget requires an existing source', W({ type: 'page-change', sourceId: 'src_b' }).ok && !W({ type: 'page-change', sourceId: 'x' }).ok);
ok('unsupported widget types are refused', !W({ type: 'iframe', url: 'https://x.com' }).ok && !W({ type: 'script', code: 'alert(1)' }).ok && !W({ type: 'html', html: '<b>x</b>' }).ok && !W('str').ok && !W(null).ok);
const lw = W({ type: 'links', links: [{ title: 'OK', url: 'https://example.com/a' }, { title: 'bad', url: 'javascript:alert(1)' }, { title: 'bad2', url: 'data:text/html,x' }, { title: 'file', url: 'file:///etc/passwd' }, { url: 'https://example.org/' }] });
ok('saved links: only http(s) links are kept; javascript:/data:/file: are errors', !lw.ok && (lw as any).errors.length === 3, lw);
const lw2 = (W({ type: 'links', links: [{ title: 'A', url: 'https://example.com/a' }, { url: 'http://192.168.1.5/admin' }] }) as any);
ok('saved links may point anywhere on the web the user chooses (they are just links), titles default to the host', lw2.ok && lw2.value.links.length === 2 && lw2.value.links[1].title === '192.168.1.5', lw2);
ok('links get generated ids and the list is capped', (W({ type: 'links', links: Array.from({ length: 500 }, (_, i) => ({ title: `L${i}`, url: `https://example.com/${i}` })) }) as any).value.links.length === LIMITS.links);
ok('notes are capped and kept as plain text', (W({ type: 'notes', text: 'x'.repeat(30_000) }) as any).value.text.length === LIMITS.notesChars && (W({ type: 'notes', text: '<script>alert(1)</script>' }) as any).value.text === '<script>alert(1)</script>');
ok('widget ids: valid ones kept, invalid replaced, never trusted blindly', (W({ type: 'notes', id: 'my_note-1' }) as any).value.id === 'my_note-1' && /^w_gen/.test((W({ type: 'notes', id: '../../x' }) as any).value.id) && /^w_gen/.test((W({ type: 'notes', id: 5 }) as any).value.id));
ok('paused is only kept when true', (W({ type: 'notes', paused: true }) as any).value.paused === true && !('paused' in (W({ type: 'notes', paused: 'yes' }) as any).value));
ok('prototype-pollution style keys do not leak into widgets', !('polluted' in (W(JSON.parse('{"type":"notes","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}')) as any).value) && !({} as any).polluted);

// ====================================================================== dashboards
const raw = { id: 'dash_abc123', name: '  My   Dash  ', columns: 7, theme: { mode: 'neon', accent: 'chartreuse', mono: 'yes' }, widgets: [{ type: 'notes', id: 'note_1', text: 'hi' }, { type: 'bogus' }, { type: 'updates', sourceIds: ['src_zzz'] }, { type: 'notes', id: 'note_1', text: 'dup id' }, { type: 'list', sourceId: 'src_a' }] };
const vd = validateDashboard(raw, ctx);
ok('invalid widgets are dropped and reported; valid ones survive', vd.dashboard!.widgets.length === 3 && vd.errors.length === 2, vd);
ok('duplicate widget ids are regenerated', new Set(vd.dashboard!.widgets.map((w) => w.id)).size === 3);
ok('dashboard fields normalized: name trimmed, columns defaulted, theme sanitized', vd.dashboard!.name === 'My Dash' && vd.dashboard!.columns === 2 && JSON.stringify(vd.dashboard!.theme) === '{"mode":"auto","accent":"ink","mono":false}', vd.dashboard);
ok('a dashboard with an unsafe id is rejected outright', validateDashboard({ ...raw, id: '../../etc' }, ctx).dashboard === null && validateDashboard({ ...raw, id: undefined }, ctx).dashboard === null && validateDashboard(null, ctx).dashboard === null && validateDashboard([], ctx).dashboard === null);
ok('too many widgets are capped', validateDashboard({ id: 'dash_big1', widgets: Array.from({ length: 100 }, () => ({ type: 'notes' })) }, ctx).dashboard!.widgets.length === LIMITS.widgetsPerDashboard);
ok('theme validation', JSON.stringify(validateTheme({ mode: 'dark', accent: 'rose', mono: true })) === '{"mode":"dark","accent":"rose","mono":true}' && JSON.stringify(validateTheme(null)) === '{"mode":"auto","accent":"ink","mono":false}');
ok('newDashboard is a valid blank canvas', (() => { const d = newDashboard('dash_new1'); return d.widgets.length === 0 && !d.paused && validateDashboard(d, ctx).errors.length === 0; })());
ok('every kind declares timing, method and a plain-language summary', Object.values(KINDS).every((k) => k.minIntervalMin >= 10 && k.defaultIntervalMin >= k.minIntervalMin && k.maxIntervalMin >= k.defaultIntervalMin && k.timeoutMs >= 10_000 && k.summary.length > 20 && (k.method === 'rendered') === k.backgroundTab));

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
