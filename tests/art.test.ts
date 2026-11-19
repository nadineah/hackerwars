// Generated illustrations: tokens, the sanitizer's rule for them, and cleaning what the model asks for.
import { bindArtNames, isArtToken, newArtToken, resolveArtTokens, stripArtTokens, tokensIn, TRANSPARENT_PIXEL } from '../src/shared/art';
import { cleanSpecs, generateIllustrations, imageUsage } from '../src/background/images';
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

ok('image usage: what OpenAI reported is used', imageUsage({ usage: { input_tokens: 70, output_tokens: 1600 } }, 'wide').outputTokens === 1600 && imageUsage({ usage: { input_tokens: 70, output_tokens: 1600 } }, 'wide').inputTokens === 70);
ok('image usage: with nothing reported, the documented size for that shape is counted (a billed image is never counted as free)', imageUsage({}, 'square').outputTokens === 1056 && imageUsage(null, 'tall').outputTokens === 1584 && imageUsage({ usage: { output_tokens: 'x' } }, 'wide').outputTokens === 1584);

ok('cleanSpecs honours a larger limit when asked', cleanSpecs(Array.from({ length: 9 }, (_, i) => ({ id: 'a' + i, prompt: 'a picture of something nice ' + i })), 6).length === 6);

(async () => {
  const calls: { url: string; body: any }[] = [];
  const okImg = { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'QUJD'.repeat(10) }], usage: { input_tokens: 10, output_tokens: 1000 } }) };
  const shrink = async () => ({ data: 'data:image/webp;base64,QUJDQUJDQUJDQUJDQUJDQUJD', w: 10, h: 10 });
  const specs = [
    { id: 'hero', prompt: 'a candy village scene at dusk', shape: 'wide' as const, transparent: false },
    { id: 'frame', prompt: 'an ornate card frame with a plain centre', shape: 'square' as const, transparent: true },
  ];
  let usage = 0;
  const r1 = await generateIllustrations(specs, 'k', undefined, { styleSpec: 'Soft painterly pastel storybook.', referenceFirst: true, shrink, onUsage: () => usage++, fetch: (async (url: string, init: any) => { calls.push({ url, body: init.body }); return okImg; }) as any });
  ok('reference mode: the hero is painted first (alone), then the rest are edits that use it as the reference', calls.length === 2 && calls[0].url.endsWith('/images/generations') && calls[1].url.endsWith('/images/edits') && calls[1].body instanceof FormData && !!calls[1].body.get('image[]') && r1.made.size === 2, calls.map((c) => c.url));
  ok('the shared style paragraph leads every prompt (generation and edit)', JSON.parse(calls[0].body).prompt.startsWith('Art direction shared by every picture') && String(calls[1].body.get('prompt')).startsWith('Art direction shared by every picture') && /same art style/.test(String(calls[1].body.get('prompt'))));
  ok('every image call is counted', usage === 2);

  calls.length = 0;
  const r2 = await generateIllustrations(specs, 'k', undefined, { styleSpec: 'Soft painterly pastel storybook.', referenceFirst: true, shrink, fetch: (async (url: string, init: any) => { calls.push({ url, body: init.body }); return url.endsWith('/images/edits') ? { ok: false, status: 400, json: async () => ({ error: { message: 'bad' } }) } : okImg; }) as any });
  ok('if the reference edit is refused, that picture is painted normally with the same style text', r2.made.size === 2 && calls.length === 3 && calls[2].url.endsWith('/images/generations') && JSON.parse(calls[2].body).prompt.startsWith('Art direction shared'), calls.map((c) => c.url));

  calls.length = 0;
  await generateIllustrations(specs, 'k', undefined, { shrink, fetch: (async (url: string, init: any) => { calls.push({ url, body: init.body }); return okImg; }) as any });
  ok('without reference mode both pictures are plain generations, and with no style spec nothing extra is added', calls.length === 2 && calls.every((c) => c.url.endsWith('/images/generations')) && !JSON.parse(calls[0].body).prompt.includes('Art direction shared'));

  console.log(fails ? `${fails} FAILED` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})();
