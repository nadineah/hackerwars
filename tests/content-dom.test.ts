// DOM tests for src/content/apply.ts (jsdom).
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://b.com/p' });
const g = globalThis as any;
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLImageElement', 'Text']) g[k] = (dom.window as any)[k];
g.window = dom.window;

import { activate, activeIds, appliedInDom, deactivate, refresh } from '../src/content/apply';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra)?.slice(0, 300));
};
const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const design = (id: string, ops: any[], css = '', updatedAt = 1): any => ({ id, host: 'b.com', name: id, prompt: '', css, ops, enabled: true, createdAt: 1, updatedAt });
const reset = (html: string) => { for (const id of [...activeIds()].reverse()) deactivate(id); document.body.innerHTML = html; };

// count DOM mutations caused by refresh() calls
function countMutations(fn: () => void): number {
  const obs = new (dom.window as any).MutationObserver(() => {});
  obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
  fn();
  return obs.takeRecords().length;
}

// ---- #4 (Codex r4): two moves aimed at the same target must not thrash
reset('<div id="box"><i id="A"></i><i id="B"></i><i id="T"></i></div>');
activate(design('d1', [
  { op: 'move', selector: '#A', target: '#T', position: 'beforebegin' },
  { op: 'move', selector: '#B', target: '#T', position: 'beforebegin' },
]));
const after1 = $('#box').innerHTML;
const churn = countMutations(() => { for (let i = 0; i < 20; i++) refresh(); });
ok('two moves before the same target: zero DOM churn over 20 refreshes', churn === 0, churn);
ok('both stay before the target', $('#A').compareDocumentPosition($('#T')) & 4 && $('#B').compareDocumentPosition($('#T')) & 4, $('#box').innerHTML);
// the page moves A to AFTER the target: that is a real displacement and must be repaired
$('#T').after($('#A'));
refresh();
ok('a genuine displacement (A pushed past the target) is repaired', !!($('#A').compareDocumentPosition($('#T')) & 4), $('#box').innerHTML);
// the page re-orders siblings on the same side: tolerated, no fighting
$('#box').insertBefore($('#B'), $('#A'));
const churn2 = countMutations(() => refresh());
ok('reordering on the same side is tolerated (no extra moves)', churn2 === 0, churn2);
ok('move runner reports applied()', appliedInDom());
deactivate('d1');

// ---- layered text ownership (#3 r2): site + page edit the same heading
reset('<h1 id="h">Original</h1>');
activate(design('site', [{ op: 'setText', selector: '#h', text: 'Site text' }]), 0);
activate(design('page', [{ op: 'setText', selector: '#h', text: 'Page text' }]), 1);
const churn3 = countMutations(() => { for (let i = 0; i < 50; i++) refresh(); });
ok('layered setText: no rewriting over 50 refreshes', churn3 === 0 && $('#h').textContent === 'Page text', [churn3, $('#h').textContent]);
// the page re-renders the text: the TOP layer repairs it
$('#h').firstChild!.nodeValue = 'Original again';
refresh();
ok('top layer repairs after the site changes the text', $('#h').textContent === 'Page text', $('#h').textContent);
for (const id of [...activeIds()].reverse()) deactivate(id);
ok('reverse undo restores the very first text', $('#h').textContent === 'Original' || $('#h').textContent === 'Original again', $('#h').textContent);

// ---- #4 (r2): ops-only designs count as applied
reset('<p id="p">hello</p>');
ok('nothing applied yet', !appliedInDom());
activate(design('ops-only', [{ op: 'setText', selector: '#p', text: 'changed' }], ''));
ok('ops-only design (no CSS, no [data-ww]) reports applied', appliedInDom() && $('#p').textContent === 'changed');
deactivate('ops-only');
ok('...and not applied after deactivation', !appliedInDom());
reset('<p class="x" id="q">hi</p>');
activate(design('cls', [{ op: 'addClass', selector: '#q', className: 'fancy' }], ''));
ok('addClass-only design reports applied', appliedInDom() && $('#q').classList.contains('fancy'));
deactivate('cls');
ok('undo removes only the class we added', !$('#q').classList.contains('fancy') && $('#q').classList.contains('x'));

// ---- #3 (r1): setText must refuse <style>/<script>, including SVG <style> (lowercase localName)
reset('<svg id="s"><style id="svgstyle">.a{fill:red}</style></svg><style id="htmlstyle">p{color:red}</style><script id="sc">var x=1</script>');
activate(design('evil', [
  { op: 'setText', selector: '#svgstyle', text: '@import "https://evil.example/x.css";' },
  { op: 'setText', selector: '#htmlstyle', text: '@import "https://evil.example/x.css";' },
  { op: 'setText', selector: '#sc', text: 'alert(1)' },
  { op: 'setText', selector: 'svg style', text: 'x' },
]));
ok('SVG <style> text untouched', $('#svgstyle').textContent === '.a{fill:red}', $('#svgstyle').textContent);
ok('HTML <style> text untouched', $('#htmlstyle').textContent === 'p{color:red}');
ok('<script> text untouched', $('#sc').textContent === 'var x=1');
deactivate('evil');

// ---- hide-only design is CSS-based and counts as applied
reset('<div id="ad">ad</div>');
activate(design('hide', [{ op: 'hide', selector: '#ad' }], ''));
ok('hide-only design reports applied (its <style> is present)', appliedInDom());
deactivate('hide');

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
