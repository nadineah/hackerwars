// DOM tests for src/content/apply.ts (jsdom).
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://b.com/p' });
const g = globalThis as any;
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLImageElement', 'Text']) g[k] = (dom.window as any)[k];
g.window = dom.window;

import { activate, activeIds, appliedInDom, deactivate, refresh } from '../src/content/apply';
import { MEDIA_BOUNDARY, recogniseMediaPlayers } from '../src/content/media';

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

// ---- H1 (fable review): even a design stuffed with hostile selectors must compile to harmless CSS
reset('<div id="ad">ad</div><p id="keep">keep</p>');
activate(design('smuggle', [
  { op: 'hide', selector: '@import url(https://evil.example/x.css) /*' },
  { op: 'hide', selector: '#ad' },
]), 0);
const smuggleStyle = document.querySelector('style[data-whimsyweb="smuggle"]')!.textContent ?? '';
ok('no @import and no attacker URL reach the <style> text', !/@import/i.test(smuggleStyle) && !smuggleStyle.includes('evil.example'), smuggleStyle);
ok('the legitimate hide rule in the same design still compiles', smuggleStyle.includes('#ad') && smuggleStyle.includes('display:none'), smuggleStyle);
deactivate('smuggle');
// the design's own CSS carrying an import is stripped too, and the hide rule is not swallowed by it
activate(design('css-import', [{ op: 'hide', selector: '#ad' }], '@import url(https://evil.example/y.css); #keep{color:red}'), 0);
const ciStyle = document.querySelector('style[data-whimsyweb="css-import"]')!.textContent ?? '';
ok('an @import in the design CSS is stripped and later rules survive', !ciStyle.includes('evil.example') && ciStyle.includes('#keep') && ciStyle.includes('#ad'), ciStyle);
deactivate('css-import');

// ---- hide-only design is CSS-based and counts as applied
reset('<div id="ad">ad</div>');
activate(design('hide', [{ op: 'hide', selector: '#ad' }], ''));
ok('hide-only design reports applied (its <style> is present)', appliedInDom());
deactivate('hide');

// The same generated selectors can dress the outer frame while keeping native player controls intact.
dom.reconfigure({ url: 'https://www.youtube.com/watch?v=example' });
reset('<main id="frame"><div class="html5-video-player"><button id="control">Original label</button></div><button id="outside">Outside</button></main>');
const mediaCss = '@keyframes wave{from{opacity:0}to{opacity:1}}#frame,button,video::-webkit-media-controls{color:red}';
const mediaOps = [{ op: 'setText', selector: '#control', text: 'Replaced label' }];
for (const intensity of [undefined, 1, 2, 3, 4, 5]) {
  activate({ ...design('media', mediaOps, mediaCss, intensity), intensity });
  const applied = $('style[data-whimsyweb="media"]').textContent ?? '';
  ok(`level ${intensity}: player CSS and DOM operations are excluded`, applied.includes('button:where(:not(') && applied.includes('))::-webkit-media-controls') && applied.includes('@keyframes wave{from{opacity:0}to{opacity:1}}') && $('#control').textContent === 'Original label', applied);
  deactivate('media');
}
ok('deactivation restores the original player label', $('#control').textContent === 'Original label');
dom.reconfigure({ url: 'https://another.example/video' });
reset('<main id="frame"><div id="unknown"><video></video><button id="play">Play</button><button>Mute</button><input type="range"></div><button id="outside">Outside</button></main>');
recogniseMediaPlayers();
ok('an unknown player is recognised without relying on the site name or on native controls', $('#unknown').matches(MEDIA_BOUNDARY) && !!$('#play').closest(MEDIA_BOUNDARY) && !$('#outside').closest(MEDIA_BOUNDARY));
activate({ ...design('custom', [{ op: 'setText', selector: '#play', text: 'Wrong' }], '#frame{opacity:.2} button{color:red}'), intensity: 5 });
ok('player controls and effects on their ancestors are protected on other sites', $('#play').textContent === 'Play' && ($('style[data-whimsyweb="custom"]').textContent ?? '').includes(':not(:has(:is('));
deactivate('custom');

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
