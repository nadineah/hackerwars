// Loads the REAL content script (src/content/index.ts) in jsdom with a mocked chrome.storage.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><head></head><body><h1 id="h">Title</h1><p class="ad">ad</p></body></html>', { url: 'https://b.com/p' });
const g = globalThis as any;
const w = dom.window as any;
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLImageElement', 'Text', 'MutationObserver', 'location', 'history', 'getComputedStyle']) g[k] = w[k];
g.window = w;

const mem: Record<string, any> = {};
let changed: ((c: any, area: string) => void) | null = null;
g.chrome = {
  runtime: { id: 'me', onMessage: { addListener() {} } },
  storage: {
    local: {
      get: async (k: any) => (k === null ? { ...mem } : { [k]: JSON.parse(JSON.stringify(mem[k] ?? null)) ?? undefined }),
    },
    onChanged: { addListener: (fn: any) => (changed = fn) },
  },
};

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra)?.slice(0, 300));
};
const tick = () => new Promise((r) => setTimeout(r, 30));
const styles = () => Array.from(document.querySelectorAll('style[data-whimsyweb]')).map((e) => ({ id: e.getAttribute('data-whimsyweb'), rank: e.getAttribute('data-ww-rank'), css: e.textContent }));
const set = async (key: string, val: any) => { mem[key] = val; changed?.({ [key]: {} }, 'local'); await tick(); };
const D = (id: string, host: string, scope: string, css: string, extra: any = {}): any => ({ id, host, scope, css, ops: [], name: id, prompt: '', enabled: true, createdAt: 1, updatedAt: 1, ...extra });

(async () => {
  await import('../src/content/index');
  await tick();
  ok('nothing applied initially', styles().length === 0);

  // all-sites design applies on any host, ops ignored (CSS-only), hide ops compile to nothing
  await set('site:*', [D('G', '*', 'global', 'h1{color:teal}', { ops: [{ op: 'hide', selector: '.ad' }, { op: 'setText', selector: '#h', text: 'HACKED' }] })]);
  ok('all-sites design is applied on b.com', styles().some((s) => s.id === 'G' && s.css!.includes('teal')), styles());
  ok('all-sites design is CSS-only: setText ignored', document.querySelector('#h')!.textContent === 'Title');
  ok('all-sites design is CSS-only: hide ops ignored', !styles().find((s) => s.id === 'G')!.css!.includes('display:none'));

  // layering order in the DOM: global (0) < site (1) < page (2)
  await set('site:b.com', [
    D('P', 'b.com', 'page', 'h1{color:red}', { path: '/p' }),
    D('S', 'b.com', 'site', 'h1{color:blue}'),
  ]);
  const order = styles().map((s) => s.id);
  ok('stacking order bottom-to-top is all sites, site, page', order.join() === 'G,S,P', order);

  // a page design for a different page does not apply
  await set('site:b.com', [D('P2', 'b.com', 'page', 'h1{color:pink}', { path: '/other' }), D('S', 'b.com', 'site', 'h1{color:blue}')]);
  ok('page design for another path is not applied', !styles().some((s) => s.id === 'P2') && styles().some((s) => s.id === 'S'), styles().map((s) => s.id));

  // per-site exclusion removes ONLY the all-sites design here
  await set('site:*', [D('G', '*', 'global', 'h1{color:teal}', { excludedHosts: ['b.com'], updatedAt: 2 })]);
  ok('excluded site: all-sites design is removed', !styles().some((s) => s.id === 'G'), styles().map((s) => s.id));
  ok('...but the site design stays', styles().some((s) => s.id === 'S'));
  await set('site:*', [D('G', '*', 'global', 'h1{color:teal}', { excludedHosts: [], updatedAt: 3 })]);
  ok('un-excluding brings it back, still below the site design', styles().map((s) => s.id).join() === 'G,S', styles().map((s) => s.id));

  // disabling the all-sites design removes it; a global design excluded for ANOTHER host still applies here
  await set('site:*', [D('G', '*', 'global', 'h1{color:teal}', { excludedHosts: ['zzz.com'], updatedAt: 4 })]);
  ok('exclusion of a different host does not affect this site', styles().some((s) => s.id === 'G'));
  await set('site:*', [D('G', '*', 'global', 'h1{color:teal}', { enabled: false, updatedAt: 5 })]);
  ok('disabled all-sites design is removed', !styles().some((s) => s.id === 'G'));

  console.log(fails ? `${fails} FAILED` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})();
