// Learned theme corrections: only simple selectors and theme colours are kept; the stylesheet they make.
import { compileLearned, validateLearned } from '../src/shared/learned';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra));
};

const set = validateLearned({
  designKey: 'd1@1',
  rules: [
    { sel: 'div.ytSearchboxComponentInputBox:focus-within', decls: { 'background-color': '#ebdfc4', 'border-top-color': 'rgba(201, 180, 142, 0.8)' } },
    { sel: 'span.chip:hover', decls: { 'background-color': '#ebdfc4', color: 'red' } },
    { sel: 'div.x{}body{display:none}', decls: { 'background-color': '#000000' } },
    { sel: 'div.a', decls: { 'background-color': 'url(https://evil.example/x)' } },
    { sel: 'body', decls: { 'background-color': '#ffffff' } },
    { sel: 'div.b:visited', decls: { 'background-color': '#ffffff' } },
  ],
});
ok('valid rules are kept with only colour properties; injected selectors, urls, bare tags and other states are dropped', !!set && set.rules.length === 2 && set.rules[1].decls.color === undefined && set.rules[0].decls['border-top-color'] === 'rgba(201, 180, 142, 0.8)', set);
const css = compileLearned(set!.rules);
ok('compiled: zero-specificity :where() with the state outside it, !important', css.includes(':where(div.ytSearchboxComponentInputBox):focus-within{background-color:#ebdfc4!important') && css.includes(':where(span.chip):hover{'), css);
ok('nothing without a design key', validateLearned({ rules: [] }) === null);
const many = validateLearned({ designKey: 'k', rules: Array.from({ length: 500 }, (_, i) => ({ sel: `div.c${i}`, decls: { 'background-color': '#111111' } })) });
ok('at most 300 rules are kept', many!.rules.length === 300);

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
