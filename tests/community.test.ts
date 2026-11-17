// The extension side of the website integration: sender validation, payload re-validation, confirmation, undo.
const mem: Record<string, any> = {};
(globalThis as any).chrome = {
  runtime: { id: 'me' },
  storage: {
    local: {
      get: async (k: any) => (k === null ? { ...mem } : Array.isArray(k) ? Object.fromEntries(k.map((x: string) => [x, mem[x]])) : { [k]: mem[k] }),
      set: async (o: any) => void Object.assign(mem, JSON.parse(JSON.stringify(o))),
      remove: async (k: any) => void (Array.isArray(k) ? k : [k]).forEach((x: string) => delete mem[x]),
    },
  },
};

import { DRAFT_TTL_MS, REQUEST_TTL_MS, createDraft, decide, handleExternal, originsFromMatches, summary, windowClosed, type Deps, type Draft, type Req } from '../src/community/external';
import { getAllDesigns, getCommunityDesigns, getDesignsForHost, installCommunityDesign, removeDesign, upsertDesign } from '../src/shared/storage';
import { appliesOn, appliesTo } from '../src/shared/scope';
import type { Design } from '../src/shared/types';
import { INTEGRATION_PROTOCOL_VERSION as P, THEME_FORMAT_VERSION, validateCommunityCss, versionHash, type PathScope, type ThemeVersionPayload } from '../theme-core/src';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra)?.slice(0, 400));
};

const ORIGIN = 'https://themes.example';
const TID = '11111111-1111-4111-8111-111111111111';
const VID = '22222222-2222-4222-8222-222222222222';
const VID2 = '33333333-3333-4333-8333-333333333333';
const WEB = { origin: ORIGIN };

let clock = 1_000_000;
let seq = 0;
let sessionReqs: Record<string, Req> = {};
let sessionDrafts: Record<string, Draft> = {};
let fetched: string[] = [];
let respond: (url: string) => { status?: number; body?: unknown; throws?: boolean; text?: string };
let opened: string[] = [];
let failOpen = false;
let closedWindows: number[] = [];
let tabs: { id: number; url: string }[] = [];
let applied = new Set<string>();

const deps: Deps = {
  allowedOrigins: () => [ORIGIN],
  extensionVersion: () => '0.2.0',
  fetch: (async (url: string, init: any) => {
    fetched.push(url);
    const r = respond(url);
    if (r.throws) throw new Error('offline');
    const status = r.status ?? 200;
    const text = r.text ?? JSON.stringify(r.body);
    return { ok: status >= 200 && status < 300, status, text: async () => text, _init: init };
  }) as any,
  now: () => clock,
  randomId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  loadRequests: async () => JSON.parse(JSON.stringify(sessionReqs)),
  saveRequests: async (r) => void (sessionReqs = JSON.parse(JSON.stringify(r))),
  loadDrafts: async () => JSON.parse(JSON.stringify(sessionDrafts)),
  saveDrafts: async (d) => void (sessionDrafts = JSON.parse(JSON.stringify(d))),
  openConfirm: async (id) => {
    if (failOpen) throw new Error('no window');
    opened.push(id);
    return 500 + opened.length;
  },
  closeWindow: async (id) => void closedWindows.push(id),
  communityDesigns: getCommunityDesigns,
  install: (d) => installCommunityDesign(d),
  remove: (h, id) => removeDesign(h, id),
  tabsOn: async (h) => tabs.filter((t) => new URL(t.url).hostname === h),
  appliedIn: async (tabId, designId) => applied.has(`${tabId}:${designId}`),
};

async function payload(over: Partial<ThemeVersionPayload> = {}, rehash = true): Promise<ThemeVersionPayload> {
  const pathScope: PathScope = over.pathScope ?? { mode: 'prefix', paths: ['/wiki'] };
  const css = over.css ?? 'body { background: #f6efdf; color: #3a2f25; }';
  const hostname = over.hostname ?? 'en.wikipedia.org';
  const p: ThemeVersionPayload = {
    formatVersion: THEME_FORMAT_VERSION, themeId: TID, versionId: VID, version: 1, slug: 'paper-trail', title: 'Paper Trail',
    creator: { username: 'whimsyweb-studio', displayName: 'Whimsy Web Studio' }, appearance: 'light', license: 'cc-by-4.0',
    hostname, pathScope, css, hash: '', minExtensionVersion: '0.2.0', publishedAt: new Date(clock).toISOString(), ...over,
  };
  p.hash = over.hash ?? (rehash ? await versionHash({ hostname: p.hostname, pathScope: p.pathScope, css: p.css }) : 'f'.repeat(64));
  return p;
}
const reset = () => {
  for (const k of Object.keys(mem)) delete mem[k];
  sessionReqs = {}; sessionDrafts = {}; fetched = []; opened = []; closedWindows = []; failOpen = false; tabs = []; applied = new Set(); seq = 0;
  respond = () => ({ status: 404 });
};
const call = (msg: any, sender: any = WEB) => handleExternal(msg, sender, deps);
const install = (extra: any = {}) => call({ type: 'whimsyweb:install', protocol: P, themeId: TID, ...extra });
const mine = (host = 'en.wikipedia.org') => getDesignsForHost(host);
const own = (over: Partial<Design> = {}): Design => ({ id: 'own1', host: 'en.wikipedia.org', scope: 'site', name: 'My look', prompt: 'make it green', css: 'body{color:green}', ops: [], enabled: true, createdAt: 1, updatedAt: 1, ...over });

(async () => {
  // ================================================================== who may talk to us
  reset();
  ok('origins come from exact manifest patterns only', JSON.stringify(originsFromMatches(['https://a.example/*', 'http://localhost:3000/*', '<all_urls>', '*://*/*', 'https://*.evil.com/*', 'https://b.example/path/*'])) === JSON.stringify(['https://a.example', 'http://localhost:3000']));
  for (const [name, sender] of [['an unlisted website', { origin: 'https://evil.example' }], ['a lookalike origin', { origin: 'https://themes.example.evil.io' }], ['another extension', { id: 'other-ext', origin: ORIGIN }], ['no origin at all', {}], ['http downgrade of the same host', { origin: 'http://themes.example' }]] as const) {
    const r: any = await call({ type: 'whimsyweb:ping', protocol: P }, sender);
    ok(`rejects ${name}`, !r.ok && r.code === 'forbidden-origin', r);
  }
  ok('every message type is refused for a bad origin, with no side effects', (await Promise.all(['whimsyweb:install', 'whimsyweb:status', 'whimsyweb:installed', 'whimsyweb:get-draft', 'whimsyweb:uninstall'].map((type) => call({ type, protocol: P, themeId: TID }, { origin: 'https://evil.example' })))).every((r: any) => !r.ok && r.code === 'forbidden-origin') && fetched.length === 0 && opened.length === 0);
  for (const bad of [null, undefined, 'ping', 42, [], {}, { type: 5, protocol: P }]) ok(`malformed message ${JSON.stringify(bad)} is rejected`, !(await call(bad as any) as any).ok);
  ok('wrong protocol version is refused', ((await call({ type: 'whimsyweb:ping', protocol: P + 1 })) as any).code === 'unsupported-protocol' && ((await call({ type: 'whimsyweb:ping' })) as any).code === 'unsupported-protocol');
  ok('unknown message types are refused (no way to run code or read data)', (await Promise.all(['whimsyweb:eval', 'whimsyweb:getStorage', 'whimsyweb:setSettings', 'whimsyweb:readPage', '__proto__', 'constructor'].map((t) => call({ type: t, protocol: P })))).every((r: any) => r.code === 'bad-request'));
  const ping: any = await call({ type: 'whimsyweb:ping', protocol: P });
  ok('ping reports version and capabilities', ping.ok && ping.extensionVersion === '0.2.0' && ping.capabilities.includes('install-theme'));

  // ================================================================== payload validation (the server is untrusted too)
  const attempt = async (p: any, extra: any = {}, status = 200) => {
    reset();
    respond = () => ({ status, body: p });
    return (await install(extra)) as any;
  };
  const good = await payload();
  let r = await attempt(good);
  ok('a valid theme is fetched from the sender origin API and waits for confirmation', r.ok && !!r.requestId && fetched[0] === `${ORIGIN}/api/v1/themes/${TID}` && opened.length === 1 && sessionReqs[r.requestId].state === 'awaiting-confirmation', { r, fetched });
  ok('the theme was NOT stored or applied before the user confirmed', (await getAllDesigns()).length === 0);
  r = await attempt(await payload({ versionId: VID }), { versionId: VID });
  ok('an exact version is requested with ?version=', fetched[0] === `${ORIGIN}/api/v1/themes/${TID}?version=${VID}`, fetched);
  const cases: [string, any, string][] = [
    ['CSS with @import', await payload({ css: '@import url(https://evil.example/x.css); body{color:red}' }), 'invalid-theme'],
    ['remote image url', await payload({ css: 'body{background:url(https://evil.example/t.png)}' }), 'invalid-theme'],
    ['javascript in CSS', await payload({ css: 'body{background:url(javascript:alert(1))}' }), 'invalid-theme'],
    ['oversized CSS', await payload({ css: 'a{color:red}'.repeat(10_000) }), 'invalid-theme'],
    ['a hash that does not match', await payload({}, false), 'integrity'],
    ['CSS changed after hashing', { ...good, css: 'body{color:red}' }, 'integrity'],
    ['scope changed after hashing', { ...good, pathScope: { mode: 'all' } }, 'integrity'],
    ['a website that is not supported', await payload({ hostname: 'bank.example.com' }), 'unsupported-target'],
    ['a hostname with a wildcard/port', await payload({ hostname: 'en.wikipedia.org:8080' }), 'invalid-theme'],
    ['a path scope with a wildcard', await payload({ pathScope: { mode: 'prefix', paths: ['/wiki/*'] } as any }), 'invalid-theme'],
    ['a sign-in page in scope', await payload({ pathScope: { mode: 'exact', paths: ['/login'] } }), 'invalid-theme'],
    ['an unknown format version', await payload({ formatVersion: 99 as any }), 'invalid-theme'],
    ['a different theme id than requested', await payload({ themeId: '99999999-9999-4999-8999-999999999999' }), 'invalid-theme'],
    ['an extension that is too old', await payload({ minExtensionVersion: '9.0.0' }), 'too-old'],
    ['a payload that is not an object', 'hello', 'invalid-theme'],
    ['a missing title', { ...good, title: '' }, 'invalid-theme'],
    ['a bad appearance', { ...good, appearance: 'neon' }, 'invalid-theme'],
  ];
  for (const [name, p, code] of cases) {
    r = await attempt(p);
    ok(`refuses ${name} (${code}) and opens no window`, !r.ok && r.code === code && opened.length === 0 && Object.keys(sessionReqs).length === 0, r);
  }
  r = await attempt(await payload({ versionId: VID2 }), { versionId: VID });
  ok('a version other than the one requested is refused', !r.ok && r.code === 'invalid-theme', r);
  r = await attempt(null, {}, 404);
  ok('unpublished/removed themes report "unavailable"', r.code === 'unavailable', r);
  r = await attempt(null, {}, 500);
  ok('a server error reports "network"', r.code === 'network', r);
  reset(); respond = () => ({ throws: true });
  ok('being offline reports "network"', ((await install()) as any).code === 'network');
  reset(); respond = () => ({ text: 'not json' });
  ok('a non-JSON reply is refused', ((await install()) as any).code === 'invalid-theme');
  reset(); respond = () => ({ text: JSON.stringify(good) + ' '.repeat(250_000) });
  ok('an oversized reply is refused', ((await install()) as any).code === 'invalid-theme');
  for (const bad of ['../etc/passwd', 'x'.repeat(100), '', 5, null, "1' OR '1'='1", `${TID}/../x`]) {
    reset();
    ok(`theme id ${JSON.stringify(bad)} is refused without any network request`, ((await install({ themeId: bad })) as any).code === 'bad-request' && fetched.length === 0);
  }
  reset();
  ok('a bad version id is refused without any network request', ((await install({ versionId: 'x/../y' })) as any).code === 'bad-request' && fetched.length === 0);
  const fetchInit = (await (async () => { reset(); let seen: any; const d2 = { ...deps, fetch: (async (u: string, init: any) => { seen = init; return { ok: false, status: 404, text: async () => '' }; }) as any }; await handleExternal({ type: 'whimsyweb:install', protocol: P, themeId: TID }, WEB, d2); return seen; })());
  ok('the theme is fetched with no cookies, no referrer, no cache, and redirects refused', fetchInit.credentials === 'omit' && fetchInit.referrerPolicy === 'no-referrer' && fetchInit.cache === 'no-store' && fetchInit.redirect === 'error', fetchInit);

  // ================================================================== confirmation, apply, undo
  reset();
  respond = () => ({ body: good });
  await upsertDesign(own());
  await upsertDesign(own({ id: 'page1', scope: 'page', path: '/wiki/Cat', enabled: true, name: 'Cat page' }));
  const a: any = await install();
  const sum = await summary(a.requestId, deps);
  ok('the confirmation names the theme, creator, exact website, pages and origin', !!sum && sum.title === 'Paper Trail' && sum.hostname === 'en.wikipedia.org' && sum.siteName === 'Wikipedia (English)' && sum.scope === '/wiki and below' && sum.origin === ORIGIN && sum.creator === 'Whimsy Web Studio' && !sum.update, sum);
  const st1: any = await call({ type: 'whimsyweb:status', protocol: P, requestId: a.requestId });
  ok('status is "awaiting-confirmation", never "applied", before the user says yes', st1.ok && st1.state === 'awaiting-confirmation' && st1.activeOnOpenTab === undefined, st1);
  ok('a second install while one is waiting is refused as busy', ((await install()) as any).code === 'busy');
  ok('another origin cannot read this request status', ((await handleExternal({ type: 'whimsyweb:status', protocol: P, requestId: a.requestId }, { origin: 'https://other.example' }, { ...deps, allowedOrigins: () => [ORIGIN, 'https://other.example'] })) as any).code === 'not-found');
  ok('bad request ids are refused', ((await call({ type: 'whimsyweb:status', protocol: P, requestId: 5 })) as any).code === 'bad-request' && ((await call({ type: 'whimsyweb:status', protocol: P, requestId: 'nope' })) as any).code === 'not-found');

  const dec = await decide(a.requestId, true, deps);
  const designs = await mine();
  const community = designs.find((d) => d.community);
  ok('on approval the theme is stored as the enabled site-wide design with its metadata', dec.ok && !!community && community.enabled && community.scope === 'site' && community.css === good.css && community.community!.versionId === VID && community.community!.origin === ORIGIN && community.name === 'Paper Trail', community);
  ok('the user\'s previous site design was switched off (not deleted) and remembered', designs.find((d) => d.id === 'own1')!.enabled === false && community!.community!.displacedIds.join() === 'own1', designs);
  ok('a design in a different slot (a specific page) is left alone', designs.find((d) => d.id === 'page1')!.enabled === true);
  const tab = { id: 7, url: 'https://en.wikipedia.org/wiki/Cat' };
  tabs = [tab, { id: 8, url: 'https://example.com/' }];
  const st2: any = await call({ type: 'whimsyweb:status', protocol: P, requestId: a.requestId });
  ok('"applied" is reported, but active on an open tab only if the page confirms it', st2.state === 'applied' && st2.activeOnOpenTab === false, st2);
  applied.add(`7:${community!.id}`);
  ok('...and true once the open tab reports the design applied', ((await call({ type: 'whimsyweb:status', protocol: P, requestId: a.requestId })) as any).activeOnOpenTab === true);
  ok('a second approval of the same request is refused', !(await decide(a.requestId, true, deps)).ok && (await mine()).filter((d) => d.community).length === 1);
  const list: any = await call({ type: 'whimsyweb:installed', protocol: P });
  ok('installed list shows what the extension itself holds', list.themes.length === 1 && list.themes[0].themeId === TID && list.themes[0].enabled === true && list.themes[0].version === 1 && list.themes[0].hostname === 'en.wikipedia.org', list);

  // same version again: nothing to confirm
  opened.length = 0;
  const again: any = await install();
  ok('installing the same active version again does not claim a new install and opens no window', again.ok && opened.length === 0 && sessionReqs[again.requestId].state === 'applied' && /already/i.test(sessionReqs[again.requestId].message ?? ''), sessionReqs[again.requestId]);

  // update
  const v2 = await payload({ versionId: VID2, version: 2, css: 'body { background: #fff; }' });
  respond = () => ({ body: v2 });
  const up: any = await install({ versionId: VID2 });
  const sum2 = await summary(up.requestId, deps);
  ok('a newer version asks to UPDATE and says which version it replaces', !!sum2 && sum2.update?.from === 1 && sum2.version === 2, sum2);
  ok('until confirmed, the installed version is unchanged (no silent update)', (await mine()).find((d) => d.community)!.community!.version === 1);
  await decide(up.requestId, true, deps);
  const after = (await mine()).filter((d) => d.community);
  ok('updating replaces the same design in place, keeps what it displaced, and creates no duplicate', after.length === 1 && after[0].id === community!.id && after[0].community!.version === 2 && after[0].css === v2.css && after[0].community!.displacedIds.join() === 'own1', after);

  // undo
  await removeDesign('en.wikipedia.org', community!.id);
  const restored = await mine();
  ok('removing the community theme restores the previous design exactly', restored.length === 2 && restored.find((d) => d.id === 'own1')!.enabled === true && restored.find((d) => d.id === 'own1')!.css === 'body{color:green}' && !restored.some((d) => d.community));

  // decline / window closed / expiry
  reset(); respond = () => ({ body: good });
  const d1: any = await install();
  ok('declining stores nothing and reports "declined"', (await decide(d1.requestId, false, deps)).ok && (await getAllDesigns()).length === 0 && ((await call({ type: 'whimsyweb:status', protocol: P, requestId: d1.requestId })) as any).state === 'declined');
  ok('after declining, a new request is allowed (not stuck busy)', ((await install()) as any).ok);
  const wid = sessionReqs[Object.keys(sessionReqs).at(-1)!].windowId!;
  await windowClosed(wid, deps);
  const closedStatus: any = await call({ type: 'whimsyweb:status', protocol: P, requestId: Object.keys(sessionReqs).at(-1) });
  ok('closing the confirmation window counts as declining', closedStatus.state === 'declined' && (await getAllDesigns()).length === 0, closedStatus);
  const e1: any = await install();
  clock += REQUEST_TTL_MS + 1000;
  ok('an unanswered confirmation expires into "declined" and closes its window', ((await call({ type: 'whimsyweb:status', protocol: P, requestId: e1.requestId })) as any).state === 'declined' && closedWindows.length >= 1);
  ok('...and a later approval of the expired request is refused', !(await decide(e1.requestId, true, deps)).ok && (await getAllDesigns()).length === 0);
  failOpen = true;
  ok('if the confirmation window cannot open, the request fails cleanly', ((await install()) as any).code === 'failed' && Object.values(sessionReqs).every((x) => x.state !== 'awaiting-confirmation'));
  failOpen = false;

  // user already disabled it: reenable path
  reset(); respond = () => ({ body: good });
  const x1: any = await install(); await decide(x1.requestId, true, deps);
  await upsertDesign({ ...(await mine())[0], enabled: false });
  const x2: any = await install();
  const sum3 = await summary(x2.requestId, deps);
  ok('a disabled installed copy asks before turning it back on', !!sum3 && sum3.reenable && sum3.update === null && opened.length === 2, sum3);

  // uninstall via the website
  await decide(x2.requestId, true, deps);
  ok('the website can remove only what it installed itself', ((await call({ type: 'whimsyweb:uninstall', protocol: P, themeId: TID })) as any).ok === true && (await getCommunityDesigns()).length === 0);
  ok('...and not something else', ((await call({ type: 'whimsyweb:uninstall', protocol: P, themeId: TID })) as any).code === 'not-found');
  await upsertDesign(own({ id: 'plain', host: 'github.com' }));
  ok('it cannot remove a design the user made themselves', ((await call({ type: 'whimsyweb:uninstall', protocol: P, themeId: 'plain' })) as any).code === 'bad-request' && (await mine('github.com')).length === 1);

  // ================================================================== path scope in the extension
  const cd = (pathScope: PathScope): Design => ({ ...own({ id: 'c', community: { themeId: TID, versionId: VID, version: 1, slug: 's', hash: 'h', creator: 'x', pathScope, displacedIds: [], origin: ORIGIN, installedAt: 1 } }) });
  ok('a prefix scope applies at segment boundaries only', appliesTo(cd({ mode: 'prefix', paths: ['/wiki'] }), '/wiki/Cat') && appliesTo(cd({ mode: 'prefix', paths: ['/wiki'] }), '/wiki') && !appliesTo(cd({ mode: 'prefix', paths: ['/wiki'] }), '/wikipedia') && !appliesTo(cd({ mode: 'prefix', paths: ['/wiki'] }), '/w/index.php'));
  ok('an exact scope applies to exactly those pages', appliesTo(cd({ mode: 'exact', paths: ['/'] }), '/') && !appliesTo(cd({ mode: 'exact', paths: ['/'] }), '/x'));
  ok('a whole-site community theme still never applies to sign-in, security or payment pages', appliesTo(cd({ mode: 'all' }), '/wiki/Cat') && !appliesTo(cd({ mode: 'all' }), '/login') && !appliesTo(cd({ mode: 'all' }), '/account/security') && !appliesTo(cd({ mode: 'all' }), '/checkout/pay'));
  ok('appliesOn needs the exact host as well', appliesOn(cd({ mode: 'all' }), 'en.wikipedia.org', '/wiki/X') && !appliesOn(cd({ mode: 'all' }), 'de.wikipedia.org', '/wiki/X') && !appliesOn(cd({ mode: 'all' }), 'evil.en.wikipedia.org', '/wiki/X'));
  ok('ordinary designs are unaffected by the community path logic', appliesTo(own(), '/anything') && appliesTo(own({ scope: 'page', path: '/a' }), '/a') && !appliesTo(own({ scope: 'page', path: '/a' }), '/b') && appliesTo(own({ scope: 'site' }), '/login'));

  // ================================================================== draft export (extension -> website)
  reset();
  const draftId = await createDraft({ title: 'Mine', hostname: 'github.com', pathScope: { mode: 'all' }, css: 'a{color:red}' }, ORIGIN, deps);
  ok('draft ids are long, unguessable-looking and URL safe', /^[A-Za-z0-9_-]{16,64}$/.test(draftId), draftId);
  const got: any = await call({ type: 'whimsyweb:get-draft', protocol: P, draftId });
  ok('the website receives the structured draft (not via the URL)', got.ok && got.draft.css === 'a{color:red}' && got.draft.hostname === 'github.com', got);
  ok('a draft can be read exactly once', ((await call({ type: 'whimsyweb:get-draft', protocol: P, draftId })) as any).code === 'not-found');
  const d2 = await createDraft({ title: 'Mine', hostname: 'github.com', pathScope: { mode: 'all' }, css: 'a{color:red}' }, 'https://other.example', deps);
  ok('a draft made for one website cannot be read by another (and the attempt burns it)', ((await handleExternal({ type: 'whimsyweb:get-draft', protocol: P, draftId: d2 }, { origin: ORIGIN }, deps)) as any).code === 'not-found' && ((await call({ type: 'whimsyweb:get-draft', protocol: P, draftId: d2 })) as any).code === 'not-found');
  const d3 = await createDraft({ title: 'Mine', hostname: 'github.com', pathScope: { mode: 'all' }, css: 'x' }, ORIGIN, deps);
  clock += DRAFT_TTL_MS + 1;
  ok('drafts expire', ((await call({ type: 'whimsyweb:get-draft', protocol: P, draftId: d3 })) as any).code === 'not-found');
  ok('bad draft ids are refused', ((await call({ type: 'whimsyweb:get-draft', protocol: P, draftId: '../x' })) as any).code === 'bad-request');

  // the same CSS check the website uses runs inside the extension
  ok('the extension re-checks CSS with the shared validator', validateCommunityCss('body{color:red}').ok && !validateCommunityCss('@import "x.css";').ok);

  console.log(fails ? `${fails} FAILED` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL crashed', e?.stack ?? e); process.exit(1); });
