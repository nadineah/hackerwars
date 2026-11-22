// Scrollbar styling: the reset that lets Chrome draw a design's ::-webkit-scrollbar styling.
import { scrollbarReset } from '../src/shared/scrollbars';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra));
};

ok('no scrollbar styling: nothing is added', scrollbarReset('body{color:red}') === '');
ok('page-wide scrollbar styling: scrollbar-color/width are reset everywhere', scrollbarReset('::-webkit-scrollbar{width:12px} ::-webkit-scrollbar-thumb{background:gold}') === ':root,:root *{scrollbar-color:auto!important;scrollbar-width:auto!important}');
ok('html::-webkit-scrollbar counts as page-wide too', scrollbarReset('html::-webkit-scrollbar-thumb{background:gold}').startsWith(':root,:root *'));
const one = scrollbarReset('.sidebar::-webkit-scrollbar-thumb{background:gold} .sidebar::-webkit-scrollbar-thumb:hover{background:orange} a{color:red}');
ok('one scroller styled: only that one is reset (the rest of the site keeps its own scrollbars)', one === '.sidebar{scrollbar-color:auto!important;scrollbar-width:auto!important}', one);
ok('inside @media: still found', scrollbarReset('@media (min-width:600px){.feed::-webkit-scrollbar{width:8px}}').startsWith('.feed{'));

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
