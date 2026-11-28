// Removing @import before CSSStyleSheet.replaceSync (src/shared/cssImports.ts).
import { withoutImports } from '../src/shared/cssImports';

let fails = 0;
const ok = (name: string, got: string, want: string) => {
  const cond = got === want;
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

ok('a quoted import', withoutImports('@import "a.css";\n.x{color:red}'), '\n.x{color:red}');
ok('a url() import with media', withoutImports("@import url('a.css') screen and (min-width: 600px);.x{}"), '.x{}');
ok('url() with a ; inside', withoutImports('@import url(data:text/css;base64,AAA);.x{}'), '.x{}');
ok('a string with a ; inside', withoutImports('@import "a;b.css" layer(base);.x{}'), '.x{}');
ok('upper case', withoutImports('@IMPORT "a.css";.x{}'), '.x{}');
ok('several', withoutImports('@charset "utf-8";@import "a.css";@import "b.css";.x{}'), '@charset "utf-8";.x{}');
ok('inside a comment: untouched (the Codex case)', withoutImports('/* @import "example.css" */ .card { color: red; }'), '/* @import "example.css" */ .card { color: red; }');
ok('inside a string: untouched', withoutImports('.x::before{content:"@import \\"a\\";"}'), '.x::before{content:"@import \\"a\\";"}');
ok('inside a block: untouched', withoutImports('.x{--a:@import "a.css";}'), '.x{--a:@import "a.css";}');
ok('a lookalike at-rule: untouched', withoutImports('@import-ish x;.x{}'), '@import-ish x;.x{}');
ok('a comment inside the rule', withoutImports('@import /* why */ "a.css";.x{}'), '.x{}');
ok('unterminated at the end of the sheet', withoutImports('.x{}@import "a.css"'), '.x{}');
ok('no ";" before a block: left for the browser', withoutImports('@import "a.css" .x{color:red}'), '@import "a.css" .x{color:red}');
ok('no imports: same text', withoutImports('a{b:c}/* x */'), 'a{b:c}/* x */');

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
