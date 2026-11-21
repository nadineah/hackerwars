// Visual editor: the edit model (validation, parsing, compiling, upserting) and finding elements again (jsdom).
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://b.com/p' });
const g = globalThis as any;
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLImageElement', 'Text', 'getComputedStyle', 'CSS']) g[k] = (dom.window as any)[k];
g.window = dom.window;
if (!g.CSS?.escape) g.CSS = { escape: (s: string) => s.replace(/([^\w-])/g, '\\$1') };
g.chrome = { storage: { local: { get: async () => ({}) } } };

import { compileEdits, parseDeclarations, upsertEdit, validateEdits, type VisualEdit } from '../src/shared/edits';
import { buildTarget, labelOf, originOf, resolveTarget, similarOf } from '../src/content/identity';
import { render, setAppliedEdits, setWorkingEdits } from '../src/content/editLayer';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra)?.slice(0, 400));
};

(async () => {
  // ---------- parsing and validation
  const p = parseDeclarations('color: red; background: url("https://evil.example/x.png"); font-size: 20px !important; colr: 1');
  ok('declarations parse; a remote url is refused with a reason; !important is dropped', p.css.color === 'red' && p.css['font-size'] === '20px' && !('background' in p.css) && p.errors.some((e) => /not allowed/.test(e)), p);
  ok('braces/selectors are explained', parseDeclarations('a { color: red }').errors.some((e) => /without selectors/.test(e)));
  const evil = validateEdits([
    { id: 'e1234567890', target: { selectors: ['#x'], tag: 'div' }, label: 'x', origin: 'site', css: { color: 'red', background: 'url(https://evil.example/a)', 'font-size': '12px;}body{display:none' }, updatedAt: 1 },
    { id: 'bad id', target: { selectors: ['#x'], tag: 'div' }, css: { color: 'red' } },
    { id: 'eabcdef1234', target: { selectors: ['div{}'], tag: 'div' }, css: { color: 'red' } },
    { id: 'eabcdef5678', target: { selectors: ['#y'], tag: 'img' }, css: { content: 'url("ww-asset-art:0123456789ab")' } },
  ]);
  ok('validation keeps safe declarations only, drops bad ids, unsafe selectors and injected rules', evil.length === 2 && evil[0].css.color === 'red' && Object.keys(evil[0].css).length === 1 && evil[1].css.content.includes('ww-asset-art:0123456789ab'), evil);
  const css = compileEdits([{ id: 'eaaaaaa', target: { selectors: ['#t'], tag: 'h1', pseudo: '::before' }, label: 'h', origin: 'site', css: { 'font-family': "'Lora', serif", color: '#fff' }, updatedAt: 1 }]);
  ok('compiled: triple-attribute rule with !important, the pseudo-element, and the Google Font import', /@import url\("https:\/\/fonts\.googleapis\.com\/css2\?family=Lora/.test(css) && css.includes('[data-ww-e~="eaaaaaa"][data-ww-e][data-ww-e]::before{') && css.includes('color:#fff !important'), css);

  // ---------- upsert
  const base = { target: { selectors: ['#t'], tag: 'h1' }, label: 'Heading', origin: 'site' as const };
  let r = upsertEdit([], base, { color: '#f00' });
  ok('a change on an unedited element creates its edit', r.edits.length === 1 && r.edits[0].css.color === '#f00' && !!r.editId);
  r = upsertEdit(r.edits, { ...base, editId: r.editId }, { 'font-size': '30px', color: null });
  ok('later changes update the same edit; null removes a declaration', r.edits.length === 1 && r.edits[0].css['font-size'] === '30px' && !('color' in r.edits[0].css));
  r = upsertEdit(r.edits, { ...base, editId: r.editId }, { 'font-size': null });
  ok('an edit left empty is removed', r.edits.length === 0);

  // ---------- identity
  document.body.innerHTML = `
    <header id="top"><img alt="Logo" src="/img/logo.png"><nav class="menu"><a href="/a">Alpha</a><a href="/b">Beta</a></nav></header>
    <main id="main">
      <div class="card"><h2>One</h2><p>First text</p></div>
      <div class="card"><h2>Two</h2><p>Second text</p></div>
      <div class="card"><h2>Three</h2><p>Third text</p></div>
      <div class="x-a8f3b2c9d"><span>hashed</span></div>
    </main>
    <div data-ww="d1" class="ww-deco">✦</div>`;
  const h2 = document.querySelectorAll('h2')[1];
  const t2 = buildTarget(h2);
  ok('target: structural selector under the nearest stable id, plus a text fingerprint', t2.selectors.some((s) => s.startsWith('#main >')) && t2.text === 'Two' && t2.tag === 'h2', t2);
  ok('it resolves to the same element', resolveTarget(t2)[0] === h2);
  const logo = document.querySelector('img')!;
  const tl = buildTarget(logo);
  ok('an image is found by its alt text (a strong selector)', tl.selectors[0] === 'img[alt="Logo"]' && resolveTarget(tl)[0] === logo, tl);
  ok('hashed class names are never used', !JSON.stringify(buildTarget(document.querySelector('.x-a8f3b2c9d span')!)).includes('a8f3b2c9d'));
  // the page changes: the second card's heading text changes -> no wrong match
  h2.textContent = 'Completely different';
  ok('when the element no longer fits its fingerprint, nothing is matched (never a different element)', resolveTarget(t2).length === 0, resolveTarget(t2).map((e) => e.textContent));
  h2.textContent = 'Two';
  // re-rendered: the same structure comes back as new nodes -> found again
  document.querySelector('#main')!.innerHTML = document.querySelector('#main')!.innerHTML;
  ok('a re-rendered element (new node, same place and text) is found again', resolveTarget(t2)[0]?.textContent === 'Two' && resolveTarget(t2)[0] !== h2);
  const sim = similarOf(document.querySelector('.card')!);
  ok('similar elements: the stable class selector and how many', sim?.selector === 'div.card' && sim.count === 3, sim);
  ok('origin: the website’s own element vs one a design inserted', originOf(document.querySelector('.card')!) === 'site' && originOf(document.querySelector('.ww-deco')!) === 'webloom');
  ok('readable labels', labelOf(logo).label === 'Image · Logo' && labelOf(document.querySelector('header')!).label === 'Header' && labelOf(document.querySelector('nav a')!).label === 'Link · Alpha' && labelOf(document.querySelector('.ww-deco')!).kind === 'decoration');

  // ---------- the edit layer
  const heading = document.querySelectorAll('h2')[2];
  const edit: VisualEdit = { id: 'e1111111', target: buildTarget(heading), label: 'Heading', origin: 'site', css: { color: 'rgb(1, 2, 3)' }, text: 'Renamed', updatedAt: 1 };
  setAppliedEdits([{ id: 'd1', host: 'b.com', name: 'x', prompt: '', css: '', ops: [], enabled: true, createdAt: 1, updatedAt: 1, edits: [edit] } as any]);
  const style = document.getElementById('ww-edits-style');
  ok('saved edits: the element is marked, the stylesheet is written and the text changed in place', heading.getAttribute('data-ww-e') === 'e1111111' && !!style?.textContent?.includes('e1111111') && heading.textContent === 'Renamed', { mark: heading.getAttribute('data-ww-e'), text: heading.textContent });
  const node = heading.firstChild;
  await setWorkingEdits('d1', []);
  ok('removing the edit puts the site’s text back in the SAME text node, and removes the mark and stylesheet', heading.textContent === 'Three' && heading.firstChild === node && !heading.hasAttribute('data-ww-e') && !document.getElementById('ww-edits-style'));
  await setWorkingEdits('new', [{ ...edit, id: 'e2222222', text: undefined }]);
  ok('Edit Mode working copy for a design that does not exist yet still previews', (heading.getAttribute('data-ww-e') ?? '').split(' ').includes('e2222222'));
  await setWorkingEdits(null);
  render();

  // ---------- review findings: never the wrong element, the site's own text wins, empty text stays empty
  document.body.innerHTML = '<div id="wrap"><button id="go">Subscribe</button><p class="note">3 new videos</p></div>';
  const tGo = buildTarget(document.getElementById('go')!);
  document.body.innerHTML = '<div id="wrap"><button id="go">Delete account</button><p class="note">4 new videos</p></div>';
  ok('a site reusing an id for a different button: the edit does not follow the id', resolveTarget(tGo).length === 0);
  document.body.innerHTML = '<div id="wrap"><p class="note">3 new videos</p><p>x</p></div>';
  const tNote = buildTarget(document.querySelector('.note')!);
  document.querySelector('.note')!.textContent = '12 new videos';
  ok('counters changing ("3 new" -> "12 new") do not break a match', resolveTarget(tNote)[0] === document.querySelector('.note'));
  document.body.innerHTML = '<main id="m"><section><p>Hello there</p></section></main>';
  const tP = buildTarget(document.querySelector('p')!);
  document.body.innerHTML = '<main id="m"><section><p></p></section></main>';
  ok('a structural match that is now an empty, different element is not taken', resolveTarget(tP).length === 0);

  document.body.innerHTML = '<main id="m"><span id="price">$10</span><h3 id="h">Title</h3></main>';
  const price = document.getElementById('price')!;
  const pe: VisualEdit = { id: 'e3333333', target: buildTarget(price), label: 'Price', origin: 'site', css: {}, text: 'Free!', updatedAt: 1 };
  setAppliedEdits([{ id: 'd2', host: 'b.com', name: 'x', prompt: '', css: '', ops: [], enabled: true, createdAt: 1, updatedAt: 1, edits: [pe] } as any]);
  ok('a text edit shows', price.textContent === 'Free!');
  (price.firstChild as Text).data = '$12'; // the site updates the live price in place
  render();
  ok('the site updates that text afterwards: the site’s text wins, the edit is not forced back', price.textContent === '$12');
  setAppliedEdits([]);
  ok('removing the edit then keeps the site’s CURRENT text (not the stale $10)', price.textContent === '$12');
  const h = document.getElementById('h')!;
  const he: VisualEdit = { id: 'e4444444', target: buildTarget(h), label: 'Title', origin: 'site', css: {}, text: '', updatedAt: 1 };
  setAppliedEdits([{ id: 'd3', host: 'b.com', name: 'x', prompt: '', css: '', ops: [], enabled: true, createdAt: 1, updatedAt: 1, edits: [he] } as any]);
  render();
  render();
  ok('an empty text edit stays empty across renders (no flipping back)', h.textContent === '', h.textContent);
  setAppliedEdits([]);
  ok('removing it puts the title back', h.textContent === 'Title');

  console.log(fails ? `${fails} FAILED` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})();
