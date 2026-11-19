// Generated illustrations: tokens, the sanitizer's rule for them, and cleaning what the model asks for.
import { bindArtNames, isArtToken, newArtToken, resolveArtTokens, stripArtTokens, tokensIn, TRANSPARENT_PIXEL } from '../src/shared/art';
import { cleanSpecs } from '../src/background/images';
import { isAllowedCssUrl, isAllowedImgSrc, sanitizeCss, sanitizeOps } from '../src/shared/validate';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${!cond && extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`);
};
(globalThis as any).crypto ??= require('node:crypto').webcrypto;

const T = 'ww-asset-art:0123456789ab';
ok('a real token is recognised, lookalikes are not', isArtToken(T) && !isArtToken('ww-asset-art:xyz') && !isArtToken('ww-asset-art:0123456789abc') && !isArtToken('https://evil.example/a.png') && !isArtToken('ww-asset-candy'));
ok('new tokens are random and well formed', isArtToken(newArtToken()) && newArtToken() !== newArtToken());
ok('CSS may use a stored-picture token as a url, still not arbitrary addresses', isAllowedCssUrl(T) && !isAllowedCssUrl('https://evil.example/x.png') && !isAllowedCssUrl('ww-asset-art:zz') && isAllowedImgSrc(T) && !isAllowedImgSrc('https://evil.example/x.png'));
const css = sanitizeCss(`a{background:url("${T}")} b{background:url("https://evil.example/x.png")} c{background:url("ww-asset-candy-village")}`);
ok('the sanitizer keeps real tokens and still strips every other address (including an undeclared name)', css.includes(T) && !css.includes('evil') && !css.includes('candy-village'), css);
const ops = sanitizeOps([{ op: 'insert', target: 'body', position: 'beforeend', tag: 'img', src: T }, { op: 'insert', target: 'body', position: 'beforeend', tag: 'img', src: 'https://evil.example/x.png' }]);
ok('an inserted image may use a token but not an outside address', ops.length === 1 && (ops[0] as any).src === T, ops);
ok('an inline style on an inserted element may use a token too', (sanitizeOps([{ op: 'insert', target: 'body', position: 'beforeend', tag: 'div', style: `background:url("${T}")` }])[0] as any)?.style.includes(T));

ok('tokensIn finds each token once', JSON.stringify(tokensIn(`a{background:url(${T})} b{background:url(${T})} c{background:url(ww-asset-art:aaaaaaaaaaaa)}`)) === JSON.stringify([T, 'ww-asset-art:aaaaaaaaaaaa']));
const names = new Map([['hero', T], ['moon', 'ww-asset-art:aaaaaaaaaaaa']]);
const bound = bindArtNames(`x{background:url("ww-asset-hero")} y{background:url("ww-asset-hero-big")} z{background:url("ww-asset-moon")} k{background:url("${T}")}`, names);
ok('declared names become tokens; a longer name, an undeclared name and an existing token are left alone', bound.includes(`url("${T}")} y`) && bound.includes('ww-asset-hero-big') && bound.includes('ww-asset-art:aaaaaaaaaaaa') && (bound.match(new RegExp(T, 'g')) ?? []).length === 2, bound);
const lookup = new Map([[T, 'data:image/webp;base64,QUJDQUJDQUJDQUJDQUJDQUJD']]);
ok('tokens become the stored picture inside the page; an unknown token becomes a blank pixel, never a request', resolveArtTokens(`a{background:url("${T}")} b{background:url("ww-asset-art:ffffffffffff")}`, lookup).includes('data:image/webp;base64,QUJD') && resolveArtTokens('b{background:url("ww-asset-art:ffffffffffff")}', lookup).includes(TRANSPARENT_PIXEL));
ok('a shared theme loses its pictures (they become blank), nothing else changes', stripArtTokens(`a{background:url("${T}") red}`) === `a{background:url("${TRANSPARENT_PIXEL}") red}`);

const specs = cleanSpecs([
  { id: 'Hero-Scene', prompt: 'A moonlit lily pond with fireflies, storybook style', shape: 'wide', transparent: false },
  { id: 'hero-scene', prompt: 'duplicate id should be dropped', shape: 'wide' },
  { id: 'bad id!', prompt: 'spaces and punctuation are not allowed in ids' },
  { id: 'short', prompt: 'tiny' },
  { id: 'frog', prompt: 'A cute frog sitting on a lily pad, transparent background', shape: 'weird', transparent: true },
  { id: 'a3', prompt: 'third picture of some kind of decoration' },
  { id: 'a4', prompt: 'fourth picture of some kind of decoration' },
  { id: 'a5', prompt: 'fifth picture is over the limit of four' },
]);
ok('model requests are cleaned: names normalised, bad/duplicate/too-short dropped, at most 4, shape defaults to wide', specs.length === 4 && specs[0].id === 'hero-scene' && specs[1].id === 'frog' && specs[1].shape === 'wide' && specs[1].transparent === true && specs.every((s) => /^[a-z0-9][a-z0-9-]{0,23}$/.test(s.id)), specs.map((s) => s.id));
ok('garbage input gives no pictures and never throws', cleanSpecs(null).length === 0 && cleanSpecs('x').length === 0 && cleanSpecs([null, 5, {}]).length === 0);

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
