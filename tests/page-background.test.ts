// The page's background (an edit on <body>) is drawn by <html>, which fills the whole window; the body is see-through.
import { compileEdits, upsertEdit } from '../src/shared/edits';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra)?.slice(0, 400));
};

const page = upsertEdit([], { target: { selectors: ['body'], tag: 'body' }, label: 'Page', origin: 'site' }, { 'background-color': '#123456', padding: '8px' }).edits;
const css = compileEdits(page);
const m = `[data-ww-e~="${page[0].id}"][data-ww-e][data-ww-e]`;
ok('the background goes on <html>', css.includes(`html:has(> ${m}){background-color:#123456 !important}`), css);
ok('the body keeps its other changes, see-through', css.includes(`${m}{padding:8px !important;background-color:transparent !important;background-image:none !important}`), css);
const plain = compileEdits(upsertEdit([], { target: { selectors: ['body'], tag: 'body' }, label: 'Page', origin: 'site' }, { padding: '8px' }).edits);
ok('no background change: nothing on <html>', !plain.includes('html:has'), plain);
const box = compileEdits(upsertEdit([], { target: { selectors: ['#x'], tag: 'div' }, label: 'x', origin: 'site' }, { 'background-color': 'red' }).edits);
ok('other elements: as before', !box.includes('html:has') && box.includes('background-color:red'), box);

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
