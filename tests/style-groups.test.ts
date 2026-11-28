// Group edits (All like this; also any-tag groups on one rule): stored on a selector, and drawn weaker than one
// element's own edit, so the element's own change wins wherever both apply.
import { compileEdits, upsertEdit, validateEdits, type VisualEdit } from '../src/shared/edits';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra)?.slice(0, 400));
};

const style = upsertEdit([], { target: { selectors: [], tag: '*', all: '.card-title, h2.title' }, label: 'Style · Card title', origin: 'site' }, { color: '#123456' }).edits;
ok('a shared style is a group edit on its rule, any tag', style[0].target.tag === '*' && style[0].target.all === '.card-title, h2.title');
ok('it survives validation (as saved and loaded)', validateEdits(style).length === 1);
ok('“any tag” needs a group selector', validateEdits([{ ...style[0], target: { selectors: ['#x'], tag: '*' } } as VisualEdit]).length === 0);
const own = upsertEdit([], { target: { selectors: ['#x'], tag: 'div' }, label: 'x', origin: 'site' }, { color: 'red' }).edits;
const css = compileEdits([...style, ...own]);
ok('a group edit is one attribute weaker than one element’s own', css.includes(`[data-ww-e~="${style[0].id}"][data-ww-e]{`) && css.includes(`[data-ww-e~="${own[0].id}"][data-ww-e][data-ww-e]{`), css);

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
