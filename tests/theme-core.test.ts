import {
  LIMITS,
  THEME_FORMAT_VERSION,
  describePathScope,
  isSensitivePath,
  normalizeHostname,
  normalizePath,
  pathInScope,
  sha256Hex,
  supportedSite,
  urlInScope,
  validateCommunityCss,
  validatePathScope,
  versionHash,
} from '../theme-core/src';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra)?.slice(0, 300));
};
const BS = '\\';
const codes = (css: string) => validateCommunityCss(css).errors.map((e) => e.code);
const rejects = (name: string, css: string, code: string) => {
  const r = validateCommunityCss(css);
  ok(name, !r.ok && r.errors.some((e) => e.code === code) && r.css === '', { code, got: r.errors.map((e) => e.code) });
};
const accepts = (name: string, css: string) => {
  const r = validateCommunityCss(css);
  ok(name, r.ok && r.css.length > 0, r.errors);
};

(async () => {
  // ---------------------------------------------------------------- CSS: things that must be REJECTED
  rejects('@import is rejected (even Google Fonts)', '@import url("https://fonts.googleapis.com/css2?family=Lora");a{color:red}', 'import');
  rejects('@import with a string is rejected', '@import "https://evil.example/x.css";', 'import');
  rejects('escaped @import is rejected', `@${BS}69mport "https://evil.example/x.css";`, 'import');
  rejects('remote image url() is rejected', 'a{background:url(https://evil.example/p.png)}', 'external-url');
  rejects('remote font in @font-face is rejected', '@font-face{font-family:X;src:url(https://fonts.gstatic.com/s/x.woff2)}', 'external-url');
  rejects('relative url() is rejected', 'a{background:url(/img/x.png)}', 'external-url');
  rejects('data: html is rejected', 'a{background:url("data:text/html;base64,PHNjcmlwdD4=")}', 'external-url');
  { const r = validateCommunityCss('a{background:url(javascript:alert(1))}'); ok('javascript: url is rejected (as unparseable or external)', !r.ok && r.css === '', r.errors); }
  rejects('escaped url( is rejected', `a{background:u${BS}72l(https://evil.example/x)}`, 'unparseable');
  rejects('escaped-backslash url( chain is rejected', `a{background:u${BS}00005c00005c000072l(https://evil.example/leak)}`, 'unparseable');
  rejects('image-set with a string is rejected', 'a{background:image-set("https://evil.example/a" 1x)}', 'function');
  rejects('escaped-hyphen image-set is rejected', `a{background:image${BS}2d set("https://evil.example/a" 1x)}`, 'function');
  rejects('-webkit-image-set is rejected', 'a{background:-webkit-image-set(url(https://evil.example/a) 1x)}', 'function');
  rejects('cross-fade is rejected', 'a{background:cross-fade(url(data:image/png;base64,AA),url(data:image/png;base64,AA),50%)}', 'function');
  rejects('src() is rejected', 'a{background:src("https://evil.example/a")}', 'function');
  rejects('expression() is rejected', 'a{width:expression(alert(1))}', 'function');
  rejects('behavior property is rejected', 'a{behavior:url(x.htc)}', 'property');
  rejects('-moz-binding is rejected', 'a{-moz-binding:url(x.xml)}', 'property');
  rejects('custom property smuggling a url is rejected', 'a{--x:url(https://evil.example/c);background:var(--x)}', 'external-url');
  rejects('typed attr() is rejected', 'a{content:attr(data-x url)}', 'attr-type');
  rejects('@namespace is rejected', '@namespace url(https://evil.example/ns);', 'at-rule');
  rejects('unknown at-rule is rejected', '@-moz-document url-prefix(){a{color:red}}', 'at-rule');
  rejects('@page is rejected', '@page{size:A4}', 'at-rule');
  rejects('url() hidden inside @media is rejected', '@media (min-width:1px){a{background:url(https://evil.example/m)}}', 'external-url');
  rejects('url() hidden in @supports is rejected', '@supports (display:grid){a{background:url(https://evil.example/m)}}', 'external-url');
  rejects('url() in @keyframes is rejected', '@keyframes k{from{background:url(https://evil.example/k)}}', 'external-url');
  rejects('</style> breakout is rejected', 'a{color:red}</style><script>alert(1)</script>', 'html');
  rejects('HTML comment markers are rejected', '<!-- a{color:red} -->', 'html');
  rejects('stray HTML tags are rejected', 'a{color:red}<img src=x onerror=alert(1)>', 'html');
  rejects('unparseable garbage is rejected, not silently dropped', 'a{color:red}}}}{{{ this is not css', 'parse');
  rejects('empty CSS is rejected', '   ', 'empty');
  rejects('non-string input is rejected', undefined as unknown as string, 'empty');
  rejects('NUL bytes are rejected', 'a{color:red}\0', 'nul');
  rejects('oversized CSS is rejected before parsing', 'a{color:red}'.repeat(10_000), 'too-large');
  rejects('too deeply nested rules are rejected', '@media a{@media b{@media c{@media d{@media e{a{color:red}}}}}}', 'nesting');
  rejects('embedded file over the per-file limit is rejected', `a{background:url("data:image/png;base64,${'A'.repeat(LIMITS.dataUriChars + 10)}")}`, 'data-uri-large');
  rejects('too many embedded files in total is rejected', Array.from({ length: 2 }, (_, i) => `.a${i}{background:url("data:image/png;base64,${'A'.repeat(25_000)}")}`).join('\n'), 'data-uri-total');
  accepts("escapes inside a data: string are decoded, then checked as plain data", `a{background:url("data:image/svg+xml,${BS}3Csvg")}`);
  rejects("a literal backslash inside a data: URL is rejected", `a{background:url("data:image/svg+xml,a${BS}5c b")}`, "escaped-url");
  ok("the total embedded-data limit is reachable (below the CSS size limit)", LIMITS.dataUriTotalChars < LIMITS.cssBytes && LIMITS.dataUriChars < LIMITS.dataUriTotalChars);

  // ---------------------------------------------------------------- CSS: legitimate themes must be ACCEPTED
  accepts('plain CSS', 'body{background:#faf6ee;color:#3b2f3f;font-family:Georgia,serif}a{color:#7b4b94}');
  accepts('custom properties and var()', ':root{--bg:#111;--fg:#eee}body{background:var(--bg);color:var(--fg)}');
  accepts('gradients, calc, animations', '@keyframes pulse{from{opacity:.6}to{opacity:1}}.x{background:linear-gradient(#fff,#eee);width:calc(100% - 4px);animation:pulse 2s infinite}');
  accepts('media queries and prefers-color-scheme', '@media (prefers-color-scheme:dark){body{background:#000}}@media (max-width:600px){h1{font-size:1.2rem}}');
  accepts('@supports and @layer', '@layer base{a{color:red}}@supports (display:grid){.g{display:grid}}');
  accepts('Tailwind-style escaped class selectors', `.md${BS}:flex{display:flex}.w-1${BS}/2{width:50%}`);
  accepts('content strings with escapes', `a::before{content:"${BS}201C"}`);
  accepts('pseudo-elements, :has(), attribute selectors', 'a[href^="https://"]::after{content:"↗"}li:has(> a){margin:0}');
  accepts('small embedded PNG', 'a{background:url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")}');
  accepts('embedded SVG (data URI) background', `a{background:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='4' height='4'><rect width='2' height='2'/></svg>")}`);
  accepts('@font-face with a data: font', '@font-face{font-family:Inline;src:url("data:font/woff2;base64,d09GMgABAAAAAA==") format("woff2")}');
  accepts('local() font source', '@font-face{font-family:X;src:local("Georgia")}');

  // normalization: output re-parses to something valid and is stable
  const norm = validateCommunityCss('  body  {  color : red ;  }  ');
  ok('normalized output is compact CSS', norm.ok && norm.css === 'body{color:red}', norm.css);
  const again = validateCommunityCss(norm.css);
  ok('normalizing is idempotent', again.ok && again.css === norm.css);

  // warnings (do not block)
  const wp = validateCommunityCss('body{pointer-events:none}');
  ok('pointer-events:none on body is allowed but warned', wp.ok && wp.warnings.some((w) => w.code === 'pointer-events'), wp);
  const wh = validateCommunityCss('html{display:none}');
  ok('hiding the whole page is allowed but warned', wh.ok && wh.warnings.some((w) => w.code === 'hides-page'), wh);
  ok('ordinary CSS has no warnings', validateCommunityCss('a{color:red}').warnings.length === 0);

  // line numbers on problems
  const withLine = validateCommunityCss('a{color:red}\n\nb{background:url(https://evil.example/x)}');
  ok('errors carry a line number', withLine.errors[0]?.line === 3, withLine.errors);
  // performance on a pathological but in-limit input
  const t0 = Date.now();
  validateCommunityCss('a{--x:"' + 'url('.repeat(14_000) + '"}');
  ok(`pathological input validates quickly (${Date.now() - t0}ms)`, Date.now() - t0 < 1500);

  // ---------------------------------------------------------------- hostnames
  ok('normalizes case and trailing dot', normalizeHostname(' EN.Wikipedia.org. ') === 'en.wikipedia.org');
  for (const bad of ['', 'localhost', '127.0.0.1', '[::1]', 'example.com:8080', '*.wikipedia.org', 'https://en.wikipedia.org', 'a b.com', 'evil.com/path', 'xn--', 'a..com', '-a.com', null, 42]) {
    ok(`rejects hostname ${JSON.stringify(bad)}`, normalizeHostname(bad) === null, normalizeHostname(bad));
  }
  ok('curated site lookup', supportedSite('news.ycombinator.com')?.name === 'Hacker News' && supportedSite('evil.com') === undefined);

  // ---------------------------------------------------------------- paths
  ok('normalizePath trims slashes and query/hash', normalizePath('/wiki/Cat/?a=1#x') === '/wiki/Cat' && normalizePath('') === '/' && normalizePath('//a//b//') === '/a/b');
  for (const p of ['/login', '/Login/', '/users/sign-in', '/account/security', '/checkout/step1', '/oauth/authorize', '/settings/payments', '/a/2fa']) {
    ok(`${p} is a sensitive path`, isSensitivePath(p));
  }
  for (const p of ['/', '/wiki/Cat', '/item', '/news', '/r/programming', '/blog/loginless']) {
    ok(`${p} is NOT sensitive`, !isSensitivePath(p), p);
  }
  ok('valid scopes pass', validatePathScope({ mode: 'all' }).length === 0 && validatePathScope({ mode: 'prefix', paths: ['/wiki'] }).length === 0 && validatePathScope({ mode: 'exact', paths: ['/', '/news'] }).length === 0);
  for (const [name, scope] of Object.entries({
    missing: undefined,
    'unknown mode': { mode: 'regex', paths: ['/'] },
    'empty paths': { mode: 'prefix', paths: [] },
    'no leading slash': { mode: 'exact', paths: ['wiki'] },
    wildcard: { mode: 'prefix', paths: ['/wiki/*'] },
    'dot-dot': { mode: 'prefix', paths: ['/a/../b'] },
    query: { mode: 'exact', paths: ['/a?b=1'] },
    'login path': { mode: 'prefix', paths: ['/login'] },
    'too many': { mode: 'exact', paths: Array.from({ length: LIMITS.pathScopePaths + 1 }, (_, i) => `/p${i}`) },
    'all with paths': { mode: 'all', paths: ['/x'] },
  })) {
    ok(`invalid scope rejected: ${name}`, validatePathScope(scope).length > 0, scope);
  }

  const prefix = { mode: 'prefix', paths: ['/wiki'] } as const;
  ok('prefix matches the path itself and children at segment boundaries', pathInScope('/wiki', prefix) && pathInScope('/wiki/Cat', prefix) && pathInScope('/wiki/Cat/', prefix));
  ok('prefix does NOT match a different segment that merely starts with it', !pathInScope('/wikipedia', prefix) && !pathInScope('/wikis/x', prefix) && !pathInScope('/', prefix));
  ok('exact matches only listed paths', pathInScope('/news/', { mode: 'exact', paths: ['/news'] }) && !pathInScope('/news/x', { mode: 'exact', paths: ['/news'] }));
  ok('"all" matches everything except sensitive paths', pathInScope('/anything/here', { mode: 'all' }) && !pathInScope('/login', { mode: 'all' }) && !pathInScope('/x/checkout', { mode: 'all' }));
  ok('a prefix of "/" covers all non-sensitive pages', pathInScope('/a/b', { mode: 'prefix', paths: ['/'] }) && !pathInScope('/signin', { mode: 'prefix', paths: ['/'] }));

  const target = { hostname: 'en.wikipedia.org', pathScope: { mode: 'prefix', paths: ['/wiki'] } } as const;
  ok('urlInScope: exact host, in-scope path', urlInScope('https://en.wikipedia.org/wiki/Cat?x=1#y', target));
  ok('urlInScope: subdomain is NOT matched', !urlInScope('https://fr.en.wikipedia.org/wiki/Cat', target) && !urlInScope('https://wikipedia.org/wiki/Cat', target));
  ok('urlInScope: look-alike hosts are NOT matched', !urlInScope('https://en.wikipedia.org.evil.com/wiki/Cat', target) && !urlInScope('https://evil.com/en.wikipedia.org/wiki/Cat', target) && !urlInScope('https://user@en.wikipedia.org.evil.com/wiki', target));
  ok('urlInScope: host is case-insensitive in the URL', urlInScope('https://EN.WIKIPEDIA.ORG/wiki/Cat', target));
  ok('urlInScope: non-http(s) schemes and odd ports rejected', !urlInScope('ftp://en.wikipedia.org/wiki/x', target) && !urlInScope('file:///wiki/x', target) && !urlInScope('https://en.wikipedia.org:8443/wiki/x', target) && urlInScope('https://en.wikipedia.org:443/wiki/x', target));
  ok('urlInScope: garbage and out-of-scope paths rejected', !urlInScope('not a url', target) && !urlInScope('https://en.wikipedia.org/w/index.php', target) && !urlInScope('https://en.wikipedia.org/wiki/Special:UserLogin/login', target));
  ok('describePathScope reads naturally', describePathScope({ mode: 'all' }) === 'All pages' && describePathScope(prefix) === '/wiki and below' && describePathScope({ mode: 'exact', paths: ['/', '/news'] }) === 'Only /, /news');

  // ---------------------------------------------------------------- integrity hash
  ok('sha256 known vector', (await sha256Hex('abc')) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const base = { hostname: 'en.wikipedia.org', pathScope: { mode: 'prefix', paths: ['/wiki', '/w'] } as const, css: 'a{color:red}' };
  const h1 = await versionHash(base);
  ok('hash is 64 hex chars', /^[0-9a-f]{64}$/.test(h1), h1);
  ok('hash ignores the ORDER of scope paths', h1 === (await versionHash({ ...base, pathScope: { mode: 'prefix', paths: ['/w', '/wiki'] } })));
  ok('hash changes with the CSS', h1 !== (await versionHash({ ...base, css: 'a{color:blue}' })));
  ok('hash changes with the hostname', h1 !== (await versionHash({ ...base, hostname: 'news.ycombinator.com' })));
  ok('hash changes with the scope mode and paths', h1 !== (await versionHash({ ...base, pathScope: { mode: 'exact', paths: ['/wiki', '/w'] } })) && h1 !== (await versionHash({ ...base, pathScope: { mode: 'all' } })));
  ok('hash binds the format version', h1 !== (await versionHash({ ...base, formatVersion: THEME_FORMAT_VERSION + 1 })));

  console.log(fails ? `${fails} FAILED` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})();
