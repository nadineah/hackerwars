// Keeping site colours on the design's theme: which colours are off-theme and what they become.
import { colorTokens, deriveTheme, isNeutral, isOffTheme, mapColor, parseCssColor, replaceColors, type Theme } from '../src/shared/theme';
import { luminance, toHex, type Rgba } from '../src/shared/contrast';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${!cond && extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`);
};
const c = (hex: string, a = 1): Rgba => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a });

ok('parses hex (3, 6, 8 digits), rgb, hsl, keywords', toHex(parseCssColor('#fff')!) === '#ffffff' && toHex(parseCssColor('#1a2B3c')!) === '#1a2b3c' && parseCssColor('#ffffff80')!.a > 0.49 && toHex(parseCssColor('rgb(10, 20, 30)')!) === '#0a141e' && toHex(parseCssColor('hsl(0, 0%, 100%)')!) === '#ffffff' && parseCssColor('white')!.r === 255 && parseCssColor('nonsense') === null);
const toks = colorTokens('1px solid #ccc, 0 0 4px rgba(0,0,0,.3) inset');
ok('finds each colour in a value with its position', toks.length === 2 && toks[0].text === '#ccc' && toks[1].text.startsWith('rgba('), toks.map((t) => t.text));
ok('rewrites only the colours, keeps the rest of the value exactly', replaceColors('1px solid #ffffff', (col) => (col.r === 255 ? c('#202030') : null)) === '1px solid #202030' && replaceColors('url(a.png) no-repeat', () => c('#000000')) === 'url(a.png) no-repeat');
ok('neutral means white, grey, black or a faint tint; strong colours are not neutral', isNeutral(c('#ffffff')) && isNeutral(c('#e8eaed')) && isNeutral(c('#0f0f0f')) && !isNeutral(c('#d4af37')) && !isNeutral(c('#cc0000')));

const dark: Theme = { dark: true, base: c('#10061f'), card: c('#241038'), border: c('#6b5a2a') };
const light: Theme = { dark: false, base: c('#fbf6ec'), card: c('#f2e9d8'), border: c('#c9b99a') };
ok('dark theme: a white or light-grey surface is off-theme, a dark one is not', isOffTheme(c('#ffffff'), 'surface', dark) && isOffTheme(c('#e5e5e5'), 'surface', dark) && !isOffTheme(c('#1b1b1b'), 'surface', dark) && !isOffTheme(c('#241038'), 'surface', dark));
ok('a coloured surface (a red badge, a brand blue) is never touched', !isOffTheme(c('#cc0000'), 'surface', dark) && !isOffTheme(c('#1a73e8'), 'surface', dark));
ok('a see-through overlay is left alone', !isOffTheme(c('#ffffff', 0.2), 'surface', dark));
ok('dark theme: glaring light borders are off-theme, dark ones are fine', isOffTheme(c('#d0d0d0'), 'border', dark) && !isOffTheme(c('#333333'), 'border', dark));
ok('light theme: a near-black surface is off-theme, a cream one is not; borders are not touched', isOffTheme(c('#000000'), 'surface', light) && !isOffTheme(c('#f2e9d8'), 'surface', light) && !isOffTheme(c('#000000'), 'border', light));
const m = mapColor(c('#ffffff'), 'surface', dark)!;
ok('a white surface becomes the theme card colour, a root surface becomes the page colour', toHex(m) === '#241038' && toHex(mapColor(c('#ffffff'), 'surface', dark, true)!) === '#10061f');
ok('transparency is kept when remapping', mapColor(c('#ffffff', 0.8), 'surface', dark)!.a === 0.8);
ok('a border becomes the theme line; on-theme colours return null', toHex(mapColor(c('#dddddd'), 'border', dark)!) === '#6b5a2a' && mapColor(c('#241038'), 'surface', dark) === null);

const t1 = deriveTheme({ pageBackground: c('#10061f'), surfaces: [c('#10061f'), c('#2a1442'), c('#d4af37')], borders: [c('#d4af37')], text: c('#f5e9c8') })!;
ok('theme from a dark gold design: dark, the page colour, a raised card from the design, a softened line', t1.dark && toHex(t1.base) === '#10061f' && toHex(t1.card) === '#2a1442' && luminance(t1.border) < luminance(c('#d4af37')) && luminance(t1.border) > luminance(t1.base), { card: toHex(t1.card), border: toHex(t1.border) });
const t2 = deriveTheme({ pageBackground: c('#fbf6ec'), surfaces: [], borders: [], text: c('#2b2320') })!;
ok('with no declared card the page colour is nudged (darker on a light theme)', !t2.dark && luminance(t2.card) < luminance(t2.base) && luminance(t2.card) > luminance(t2.base) - 0.15);
ok('nothing to go on gives no theme', deriveTheme({ pageBackground: null, surfaces: [], borders: [], text: null }) === null);

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
