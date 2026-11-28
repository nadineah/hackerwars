import { JSDOM } from 'jsdom';
import { clearContrast, getContrastReviewTargets, remeasureContrast, runContrast } from '../src/content/contrast';

const { window } = new JSDOM(`<!doctype html><body style="background-color:white">
  <div id="faded" style="opacity:.4"><span id="faint" style="color:black">Muted label</span></div>
  <p id="original" style="color:#aaa">Original card</p>
  <h1 id="large" style="color:#aaa;font-size:30px">Large title</h1>
  <input id="search" type="search" placeholder="Private search hint" style="background-color:white">
  <div style="background-image:linear-gradient(white, black)">
    <h1 id="cover" style="color:white">Title on artwork</h1>
    <p id="below" style="color:white">Artwork below the viewport</p>
    <div style="background-color:white"><p id="backed" style="color:#aaa">Title on a solid card</p></div>
  </div>
</body>`, { pretendToBeVisual: true });
const { document } = window;
Object.assign(globalThis, { window, document, Node: window.Node });
const pseudo = document.createElement('span');
pseudo.style.cssText = 'color:#aaa;font-size:14px';
let observed = new Set<Element>();
globalThis.getComputedStyle = (el, kind) => {
  observed.add(el);
  return kind === '::placeholder' ? pseudo.style : window.getComputedStyle(el);
};
window.Element.prototype.getBoundingClientRect = function () {
  const top = this.id === 'below' ? window.innerHeight + 10 : 10;
  return new window.DOMRect(10, top, 100, 20);
};
const el = (id: string) => document.getElementById(id)!;
const mark = (id: string) => el(id).getAttribute('data-ww-fix');
const rules = () => [...((document.getElementById('ww-contrast-style') as HTMLStyleElement | null)?.sheet?.cssRules ?? [])];
let fails = 0;
function ok(name: string, passed: boolean): void {
  if (!passed) fails++;
  console.log(`${passed ? 'ok' : 'FAIL'} ${name}`);
}

void (async () => {
  const initial = await runContrast({ apply: true });
  ok('the same colours get separate corrections for different contrast targets', !!mark('large') && !!mark('original') && mark('large') !== mark('original'));
  const faint = initial.failures.find((failure) => failure.selector === 'span#faint');
  ok('ancestor opacity turns nominally black text into failing gray text', faint?.ratio === 2.85 && !faint.reached && mark('faint') === null);
  const placeholder = initial.failures.find((failure) => failure.selector === 'input#search::placeholder');
  ok('visible placeholders are measured and corrected separately without reporting field text', !!placeholder && placeholder.text === '' && !!mark('search') && rules().some((rule) => rule.cssText.includes('::placeholder')));
  const audit = getContrastReviewTargets();
  ok('the review gets the visible image-backed text and the source of unfixable fading', audit.some((item) => item.selector === 'h1#cover' && item.kind === 'background') && audit.some((item) => item.selector === 'span#faint' && item.source === 'div#faded'));
  ok('the review excludes offscreen text and text on an opaque card above the artwork', !audit.some((item) => /#below|#backed/.test(item.selector)) && !!mark('backed'));
  const old = mark('original');
  const originalRules = rules();
  const added = document.createElement('p');
  added.id = 'added';
  added.style.color = '#aaa';
  added.textContent = 'New card';
  document.body.append(added);
  observed = new Set();
  await runContrast({ apply: true, roots: [added] });
  ok('a local check corrects the new card and preserves the old correction without remeasuring it', !!old && mark('original') === old && !!mark('added') && !observed.has(el('original')));
  ok('another card with the same correction reuses the existing CSS rule', mark('added') === old && rules().length === originalRules.length && rules().every((rule, index) => rule === originalRules[index]));
  added.style.color = '#fbb';
  await runContrast({ apply: true, roots: [added] });
  ok('a new correction colour adds just one rule', mark('added') !== old && !!mark('added') && rules().length === originalRules.length + 1 && originalRules.every((rule) => rules().includes(rule)));
  added.remove();
  await runContrast({ apply: true, roots: [], removed: true });
  ok('a removed card retires only its unused rule', !added.hasAttribute('data-ww-fix') && rules().length === originalRules.length && rules().every((rule, index) => rule === originalRules[index]));
  document.getElementById('ww-contrast-style')?.remove();
  await runContrast({ apply: true, roots: [el('original')] });
  ok('the active rules are restored if the site removes the contrast stylesheet', rules().length === originalRules.length && mark('original') === old);
  clearContrast();
  ok('clearing removes corrections, rules and cached review clues', !mark('original') && !added.hasAttribute('data-ww-fix') && !rules().length && getContrastReviewTargets().length === 0);
  const makeCard = (background: string) => {
    const card = document.createElement('article');
    card.className = 'reply-card';
    card.style.backgroundColor = background;
    card.innerHTML = '<a class="reply-author" style="color:white">An author</a>';
    document.body.append(card);
    return card.firstElementChild!;
  };
  const author = makeCard('rgb(233, 222, 190)');
  await runContrast({ apply: true, roots: [author] });
  const group = (document.getElementById('ww-shared-contrast') as HTMLStyleElement | null)?.sheet?.cssRules[0] as CSSStyleRule | undefined;
  const nextAuthor = makeCard('rgb(233, 222, 190)');
  const differentCard = makeCard('rgb(10, 20, 30)');
  ok('a verified template rule immediately covers future text that has not been scanned', !!group && nextAuthor.matches(group.selectorText) && !nextAuthor.hasAttribute('data-ww-fix'));
  ok('a different card background is outside the learned selector', !!group && !differentCard.matches(group.selectorText));
  remeasureContrast();
  ok('a design or stylesheet change clears learned text rules', !document.getElementById('ww-shared-contrast'));
  clearContrast();
  window.close();
  process.exit(fails ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
