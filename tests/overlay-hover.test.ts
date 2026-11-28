// A hover overlay inside the element it covers ignores the pointer, so its hover look follows that element being
// pointed at (hoverUp levels up), not its own hover.
import { compileEdits, upsertEdit, validateEdits } from '../src/shared/edits';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra)?.slice(0, 400));
};

const base = { target: { selectors: ['.tile > .overlay'], tag: 'div', hoverUp: 1 }, label: 'Hover overlay', origin: 'site' as const };
const e = upsertEdit([], base, { 'background-color': 'red' }, { slot: 'hover' }).edits;
const css = compileEdits(e);
const m = `[data-ww-e~="${e[0].id}"][data-ww-e][data-ww-e]`;
ok('its hover look shows when the element it is in is pointed at', css.includes(`:hover > ${m}`), css);
const two = compileEdits(upsertEdit([], { ...base, target: { ...base.target, hoverUp: 2 } }, { color: 'red' }, { slot: 'hover' }).edits);
ok('two levels up', /:hover > \* > \[data-ww-e/.test(two), two);
ok('kept when saved and loaded', validateEdits(e)[0]?.target.hoverUp === 1);
ok('a bad value is dropped', validateEdits([{ ...e[0], target: { ...e[0].target, hoverUp: 9 } }])[0]?.target.hoverUp === undefined);
const old = upsertEdit([], { ...base, target: { selectors: ['.tile > .overlay'], tag: 'div' } }, { opacity: '1' }, { slot: 'hover' }).edits;
const fixed = upsertEdit(old, { ...base, editId: old[0].id }, { 'background-color': 'blue' }, { slot: 'hover' }).edits;
ok('an overlay edit made before learns it on its next change', fixed[0].target.hoverUp === 1, fixed[0].target);
const plain = compileEdits(upsertEdit([], { target: { selectors: ['#x'], tag: 'div' }, label: 'x', origin: 'site' }, { color: 'red' }, { slot: 'hover' }).edits);
ok('other elements: no parent hover rule', !/:hover > \[/.test(plain), plain);

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
