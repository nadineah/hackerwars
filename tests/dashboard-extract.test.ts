import { JSDOM } from 'jsdom';

const win = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.com/' }).window as any;
(globalThis as any).DOMParser = win.DOMParser;

import { buildOutline, detectBlocker, discoverFeeds, identityOf, parseFeed } from '../src/dashboard/extract';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra)?.slice(0, 400));
};
const xml = (s: string) => new win.DOMParser().parseFromString(s, 'text/xml') as Document;
const html = (s: string) => new win.DOMParser().parseFromString(s, 'text/html') as Document;

// ---------------------------------------------------------------- feeds
const rss = xml(`<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Example News</title>
<item><title>First &amp; best</title><link>https://example.com/a?utm_source=rss</link><guid>g1</guid><pubDate>Wed, 03 Jun 2026 09:30:00 GMT</pubDate><description>&lt;p&gt;Hello &lt;b&gt;world&lt;/b&gt;&lt;img src="https://example.com/i.png"&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;/p&gt;</description></item>
<item><title>No date here</title><link>/relative</link><description>plain</description><media:thumbnail url="https://cdn.example.com/t.jpg"/></item>
<item><title>Bad link</title><link>javascript:alert(1)</link></item>
<item><title></title><link>https://example.com/untitled</link></item>
<item><title>Future</title><link>https://example.com/f</link><pubDate>Mon, 01 Jan 2999 00:00:00 GMT</pubDate></item>
</channel></rss>`);
const r1 = parseFeed(rss, 'https://example.com/feed.xml', 20) as any;
ok('RSS parses, skipping title-less entries', r1.items?.length === 4 && r1.title === 'Example News', r1);
ok('RSS: entities decoded, HTML stripped to text, script text is not executed', r1.items[0].title === 'First & best' && r1.items[0].summary.startsWith('Hello world'), r1.items[0]);
ok('RSS: image extracted from description html and media:thumbnail', r1.items[0].image === 'https://example.com/i.png' && r1.items[1].image === 'https://cdn.example.com/t.jpg', [r1.items[0].image, r1.items[1].image]);
ok('RSS: relative links resolve; javascript: links are dropped', r1.items[1].url === 'https://example.com/relative' && r1.items[2].url === undefined, [r1.items[1].url, r1.items[2].url]);
ok('RSS: real date parsed; missing and absurd dates stay undefined (never invented)', r1.items[0].publishedAt === Date.UTC(2026, 5, 3, 9, 30) && r1.items[1].publishedAt === undefined && r1.items[3].publishedAt === undefined);
ok('RSS: maxItems respected', (parseFeed(rss, 'https://example.com/', 2) as any).items.length === 2);

const atom = xml(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Blog</title>
<entry><title type="html">Post &lt;i&gt;one&lt;/i&gt;</title><link rel="self" href="https://example.com/self"/><link rel="alternate" href="https://example.com/post1"/><id>tag:1</id><updated>2026-05-01T10:00:00Z</updated><summary>Sum</summary></entry>
<entry><title>Post two</title><link href="/post2"/><id>tag:2</id><published>2026-05-02T10:00:00Z</published><content>Body text</content></entry></feed>`);
const r2 = parseFeed(atom, 'https://example.com/atom', 20) as any;
ok('Atom parses with alternate link preference', r2.items.length === 2 && r2.title === 'Atom Blog' && r2.items[0].url === 'https://example.com/post1' && r2.items[1].url === 'https://example.com/post2', r2);
ok('Atom: HTML in titles is flattened, dates read from updated/published, ids kept', r2.items[0].title === 'Post one' && r2.items[0].publishedAt === Date.UTC(2026, 4, 1, 10) && r2.items[1].publishedAt === Date.UTC(2026, 4, 2, 10) && r2.items[0].key === 'tag:1', r2.items);
ok('RDF/RSS1 parses', ((parseFeed(xml('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel><title>R</title></channel><item><title>T</title><link>https://example.com/r</link></item></rdf:RDF>'), 'https://example.com/', 5) as any).items?.length) === 1);
ok('non-feed XML and malformed XML give a clear error, not a crash', 'error' in (parseFeed(xml('<html><body/></html>'), 'https://e.com/', 5) as any) && 'error' in (parseFeed(xml('<rss><channel>'), 'https://e.com/', 5) as any));
ok('feed discovery finds rss/atom links only', JSON.stringify(discoverFeeds(html('<head><link rel="alternate" type="application/rss+xml" href="/rss" title="R"><link rel="alternate" type="text/html" href="/x"><link rel="alternate" type="application/atom+xml" href="javascript:1"></head>'), 'https://example.com/')) === '[{"url":"https://example.com/rss","title":"R"}]');

// ---------------------------------------------------------------- blockers
ok('login wall is detected', detectBlocker(html('<body><h1>Please sign in</h1><form action="/login"><input type="password"></form></body>')) === 'signin');
ok('captcha / bot challenge is detected', detectBlocker(html('<body><div class="g-recaptcha"></div></body>')) === 'captcha' && detectBlocker(html('<body><p>Checking your browser before accessing example.com</p></body>')) === 'captcha' && detectBlocker(html('<body><p>Please verify you are a human</p></body>')) === 'captcha');
ok('a normal page is not a blocker, even with a newsletter or search box', detectBlocker(html('<body><article><h1>News</h1></article><input type="text" name="q"></body>')) === null);
ok('a page with content plus a small login form is not treated as blocked', detectBlocker(html('<body><article>Story</article><form><input type="password"></form></body>')) === null);

// ---------------------------------------------------------------- outline & identity
const outline = buildOutline(html('<body><script>secret()</script><div id="main" class="a b"><a href="/x">Mail me at bob@example.com 123456789</a><p>' + 'x'.repeat(200) + '</p></div></body>'));
ok('outline has structure but no scripts, emails or long numbers', outline.includes('div#main.a.b') && outline.includes('[href]') && !outline.includes('secret') && !outline.includes('bob@') && !outline.includes('123456789') && outline.includes('[email]'), outline);
ok('outline is bounded', buildOutline(html('<body>' + '<div>'.repeat(5) + '<p>x</p>'.repeat(500) + '</body>'), 500).length < 1500);
ok('identity prefers canonical url, then key, then title', identityOf({ title: 'T', url: 'https://e.com/a/?utm_source=x' }, 'https://e.com/') === identityOf({ title: 'Other', url: 'https://e.com/a' }, 'https://e.com/') && identityOf({ title: 'T', key: 'g1' }, 'https://e.com/') === 'k:g1' && identityOf({ title: 'Ti' }, 'https://e.com/') === 't:ti');

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
