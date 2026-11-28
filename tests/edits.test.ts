// Visual editor: the edit model (validation, parsing, compiling, upserting) and finding elements again (jsdom).
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://b.com/p' });
const g = globalThis as any;
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLImageElement', 'Text', 'getComputedStyle', 'CSS']) g[k] = (dom.window as any)[k];
g.window = dom.window;
if (!g.CSS?.escape) g.CSS = { escape: (s: string) => s.replace(/([^\w-])/g, '\\$1') };
g.chrome = { storage: { local: { get: async () => ({}) } } };

import { addElement, compileEdits, parseDeclarations, removeAdded, upsertEdit, validateEdits, type VisualEdit } from '../src/shared/edits';
import { buildTarget, labelOf, originOf, resolveTarget, similarOf } from '../src/content/identity';
import { render, setAppliedEdits, setWorkingEdits } from '../src/content/editLayer';
import { sanitizeCss } from '../src/shared/validate';

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

  // ---------- added elements
  document.body.innerHTML = '<main id="m"><h1 id="t">Title</h1><p id="p">Text</p></main>';
  const anchor = buildTarget(document.getElementById('t')!);
  let list = addElement([], anchor, 'heading', 'after').edits;
  const addH = list[0];
  ok('addElement: a heading after the title, with its starting text and look', addH.insert?.kind === 'heading' && addH.insert.position === 'after' && addH.text === 'New heading' && addH.css.margin === '12px 0');
  setAppliedEdits([{ id: 'd3', host: 'b.com', name: 'x', prompt: '', css: '', ops: [], enabled: true, createdAt: 1, updatedAt: 1, edits: list } as any]);
  const made = document.querySelector('[data-ww-add]') as HTMLElement;
  ok('the edit layer creates it right after its anchor, as text (not HTML), and styles it, not the anchor', made?.tagName === 'H2' && made.previousElementSibling?.id === 't' && made.textContent === 'New heading' && made.getAttribute('data-ww-e') === addH.id && !document.getElementById('t')!.hasAttribute('data-ww-e'));
  render();
  ok('rendering again does not add a second one', document.querySelectorAll('[data-ww-add]').length === 1);
  const inner = addElement(list, buildTarget(made), 'box', 'inside').edits;
  ok('an element added inside an added element finds it by its own marker', inner[1].target.selectors[0] === `h2[data-ww-add="${addH.id}"]`);
  ok('removing an added element also removes what was added inside it', removeAdded(inner, addH.id).length === 0);
  const styled = upsertEdit(list, { editId: addH.id, target: addH.target, label: 'x', origin: 'site' }, { color: 'red', margin: null });
  ok('styling an added element keeps it (and an added element with no styles is still kept)', styled.edits[0].insert?.kind === 'heading' && styled.edits[0].css.color === 'red' && upsertEdit(list, { editId: addH.id, target: addH.target, label: 'x', origin: 'site' }, { margin: null }).edits.length === 1);
  const badAdds = validateEdits([{ ...addH, insert: { kind: 'script', position: 'after' } }, { ...addH, id: 'e123456a', insert: { kind: 'text', position: 'replace' } }, { ...addH, id: 'e123456b', text: '<img src=x onerror=alert(1)>', insert: { kind: 'text', position: 'after' } }]);
  ok('validation: unknown kinds and positions are dropped (never applied to the anchor); text stays text', badAdds.length === 1 && badAdds[0].id === 'e123456b');
  setAppliedEdits([{ id: 'd3', host: 'b.com', name: 'x', prompt: '', css: '', ops: [], enabled: true, createdAt: 1, updatedAt: 1, edits: badAdds } as any]);
  ok('markup in the text of an added element is shown as text', document.querySelector('[data-ww-add] img') === null && /onerror/.test(document.querySelector('[data-ww-add]')!.textContent ?? ''));
  setAppliedEdits([]);
  ok('when the edit is gone the added element is removed', document.querySelectorAll('[data-ww-add]').length === 0);
  ok('an image starts without text, a divider is an hr', addElement([], anchor, 'image', 'after').edits[0].text === undefined && addElement([], anchor, 'divider', 'before').edits[0].insert?.kind === 'divider');

  // ---------- hover / focus looks and parts
  const hb = { target: { selectors: ['#b'], tag: 'button' }, label: 'Button', origin: 'site' as const };
  let hv = upsertEdit([], hb, { 'background-color': '#123456' }, { slot: 'hover' });
  ok('a hover change goes to the hover look, not the normal one', hv.edits[0].hover?.['background-color'] === '#123456' && Object.keys(hv.edits[0].css).length === 0);
  hv = upsertEdit(hv.edits, { ...hb, editId: hv.editId }, { color: 'red' });
  ok('a normal change keeps the hover look', hv.edits[0].css.color === 'red' && hv.edits[0].hover?.['background-color'] === '#123456');
  const cleared = upsertEdit(hv.edits, { ...hb, editId: hv.editId }, { 'background-color': null }, { slot: 'hover' });
  ok('clearing the hover look keeps the edit for its normal change; clearing both removes it', !cleared.edits[0].hover && cleared.edits[0].css.color === 'red' && upsertEdit(cleared.edits, { ...hb, editId: hv.editId }, { color: null }).edits.length === 0);
  const looks = compileEdits(validateEdits([{ id: 'ebbbbbb', target: { selectors: ['#b'], tag: 'button' }, label: 'b', origin: 'site', css: {}, hover: { color: '#f00' }, focus: { 'outline-color': '#0f0' }, shapes: { fill: 'currentColor', visibility: 'hidden' }, placeholder: { color: '#999' }, marker: { color: '#00f' }, updatedAt: 1 }]));
  const M = '[data-ww-e~="ebbbbbb"][data-ww-e][data-ww-e]';
  ok('hover compiles to its own :hover, the control it is in, and the preview state', looks.includes(`${M}:hover,`) && looks.includes(`:hover ${M}:not(`) && looks.includes(`${M}[data-ww-state~="hover"]`) && /color:#f00 !important/.test(looks), looks);
  ok('focus, icon shapes (fill only where shapes are filled), placeholder and bullets compile', looks.includes(`${M}:focus-visible`) && looks.includes(':not([fill="none"]){fill:currentColor !important}') && looks.includes('visibility:hidden !important') && looks.includes(`${M}::placeholder{color:#999 !important}`) && looks.includes(`${M} > li::marker`), looks);
  ok('the compiled looks survive the sanitizer', sanitizeCss(looks).includes(':hover') && sanitizeCss(looks).includes('::placeholder') && sanitizeCss(looks).includes(':not([fill="none"])'), sanitizeCss(looks));
  ok('validation drops unsafe declarations in a look too', validateEdits([{ id: 'eccccccc', target: { selectors: ['#b'], tag: 'button' }, css: {}, hover: { background: 'url(https://evil.example/x)' } }]).length === 0);

  // ---------- moving in the layout
  document.body.innerHTML = '<main id="m"><h1 id="t">Title</h1><p id="p">Text</p><section id="s"><span id="x">x</span></section></main>';
  const para = document.getElementById('p')!;
  const pTarget = buildTarget(para);
  const mv = upsertEdit([], { target: pTarget, label: 'Text', origin: 'site' }, {}, { move: { to: buildTarget(document.getElementById('t')!), position: 'before' } });
  ok('a move alone is an edit', mv.edits.length === 1 && mv.edits[0].move?.position === 'before');
  ok('validation keeps a move, drops one with an unknown position or onto "all like this"', validateEdits(mv.edits).length === 1 && validateEdits([{ ...mv.edits[0], move: { ...mv.edits[0].move, position: 'replace' } }]).length === 0 && validateEdits([{ ...mv.edits[0], target: { ...pTarget, all: 'p' } }])[0]?.move === undefined);
  const listener = { n: 0 };
  para.addEventListener('click', () => listener.n++);
  setAppliedEdits([{ id: 'd4', host: 'b.com', name: 'x', prompt: '', css: '', ops: [], enabled: true, createdAt: 1, updatedAt: 1, edits: mv.edits } as any]);
  ok('the element itself is moved before the title (its listeners still work)', document.getElementById('m')!.firstElementChild === para && (para.click(), listener.n === 1));
  render();
  ok('rendering again leaves it in place', document.getElementById('m')!.firstElementChild === para);
  const into = upsertEdit(mv.edits, { editId: mv.editId, target: pTarget, label: 'Text', origin: 'site' }, {}, { move: { to: buildTarget(document.getElementById('s')!), position: 'first' } });
  setAppliedEdits([{ id: 'd4', host: 'b.com', name: 'x', prompt: '', css: '', ops: [], enabled: true, createdAt: 1, updatedAt: 1, edits: into.edits } as any]);
  ok('moving it again: first inside the section', document.getElementById('s')!.firstElementChild === para);
  setAppliedEdits([]);
  ok('when the move is gone it goes back where it came from', document.getElementById('t')!.nextElementSibling === para && !para.hasAttribute('data-ww-moved'));

  console.log(fails ? `${fails} FAILED` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})();
