// Network check of the demo sources against the real collectors. Run: npm run live-check
import { JSDOM } from 'jsdom';
const win = new JSDOM('<!doctype html><html><body></body></html>').window as any;
(globalThis as any).DOMParser = win.DOMParser;
import { collectSource, runParse, type CollectDeps } from '../src/dashboard/collect';
import { approvalFor, validateSourceInput, type Source } from '../src/dashboard/schema';

const deps: CollectDeps = {
  fetch: (...a) => fetch(...a),
  parse: async (req) => runParse(req, (t, type) => new win.DOMParser().parseFromString(t, type)),
  rendered: async () => ({ ok: false, error: 'rendered sources need a real browser' }),
};
const sources = [
  { kind: 'feed', name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml', config: { maxItems: 8 } },
  { kind: 'json', name: 'Hacker News (API)', url: 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=10', config: { itemsPath: 'hits', fields: { title: 'title', url: 'url', published: 'created_at' }, urlTemplate: 'https://news.ycombinator.com/item?id={objectID}', maxItems: 8 } },
  { kind: 'html', name: 'Hacker News (scraped page)', url: 'https://news.ycombinator.com/', config: { itemSelector: 'tr.athing', fields: { title: { selector: '.titleline > a' }, url: { selector: '.titleline > a', attr: 'href' } }, maxItems: 8 } },
  { kind: 'page-change', name: 'Wikipedia featured article', url: 'https://en.wikipedia.org/wiki/Main_Page', config: { selector: '#mp-tfa', via: 'fetch' } },
] as const;
(async () => {
let bad = 0;
for (const s of sources) {
  const v = validateSourceInput(s as any);
  if (!v.ok) { console.log('INVALID', s.name, v.errors); bad++; continue; }
  const src = { ...v.value, approval: approvalFor(v.value) } as Source;
  const out = await collectSource(src, null, deps);
  if (!out.ok) { console.log('FAIL', s.name, out.code, out.message); bad++; continue; }
  if (out.notModified) continue;
  console.log('ok  ', s.name, out.watchText ? `watch: ${out.watchText.slice(0, 80)}…` : `${out.items.length} items; first: ${out.items[0]?.title} | ${out.items[0]?.url} | ${out.items[0]?.publishedAt ? new Date(out.items[0].publishedAt).toISOString() : 'no date'}`);
  if (!out.watchText && !out.items.length) bad++;
}
process.exit(bad ? 1 : 0);
})();
