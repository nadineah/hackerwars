// Programmatic readable-text check: contrast maths and the "nudge the way it already leans" fix.
import { fixColor, luminance, over, parseColor, ratio, targetFor, toHex, type Rgba } from '../src/shared/contrast';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${!cond && extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`);
};
const c = (hex: string): Rgba => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a: 1 });

ok('parses rgb, rgba, modern syntax and transparent; rejects other spaces', JSON.stringify(parseColor('rgb(10, 20, 30)')) === JSON.stringify({ r: 10, g: 20, b: 30, a: 1 }) && parseColor('rgba(0, 0, 0, 0.5)')!.a === 0.5 && parseColor('rgb(1 2 3 / 25%)')!.a === 0.25 && parseColor('transparent')!.a === 0 && parseColor('oklch(0.5 0.1 100)') === null);
ok('black on white is 21:1, same colour is 1:1', Math.abs(ratio(c('#000000'), c('#ffffff')) - 21) < 0.01 && ratio(c('#777777'), c('#777777')) === 1);
ok('luminance is 0 for black and 1 for white', luminance(c('#000000')) === 0 && Math.abs(luminance(c('#ffffff')) - 1) < 1e-9);
ok('semi-transparent colours are blended over what is behind them', toHex(over({ r: 255, g: 0, b: 0, a: 0.5 }, c('#000000'))) === '#800000');
ok('large text needs 3:1, normal text 4.5:1', targetFor(14, 400) === 4.5 && targetFor(24, 400) === 3 && targetFor(19, 700) === 3 && targetFor(19, 400) === 4.5);

// a pair that already passes is left alone
ok('readable text is not touched', fixColor(c('#222222'), c('#ffffff'), 4.5) === null);

// the rule you described: darker text gets darker, lighter text gets lighter
const lightGrey = fixColor(c('#999999'), c('#ffffff'), 4.5)!;
ok('grey text that is darker than a white background is nudged DARKER, just enough', lightGrey.direction === 'darker' && !lightGrey.flipped && lightGrey.reached && lightGrey.ratio >= 4.5 && lightGrey.ratio < 5 && luminance(lightGrey.color) < luminance(c('#999999')), lightGrey);
const darkGrey = fixColor(c('#555555'), c('#111111'), 4.5)!;
ok('grey text that is lighter than a dark background is nudged LIGHTER, just enough', darkGrey.direction === 'lighter' && !darkGrey.flipped && darkGrey.reached && darkGrey.ratio >= 4.5 && luminance(darkGrey.color) > luminance(c('#555555')), darkGrey);

// hue is kept
const blue = fixColor(c('#6fa8ff'), c('#ffffff'), 4.5)!;
const hueOf = (x: Rgba) => (x.b > x.r && x.b > x.g ? 'blue' : 'other');
ok('a light blue on white stays a (darker) blue', blue.direction === 'darker' && hueOf(blue.color) === 'blue' && blue.reached, toHex(blue.color));
const pink = fixColor(c('#7a3a58'), c('#2b1a24'), 4.5)!;
ok('a muted pink on a dark plum is lightened and stays pink', pink.direction === 'lighter' && pink.color.r > pink.color.g && pink.reached, toHex(pink.color));

// when the leaning direction can never pass, it moves the other way instead
const mid = fixColor(c('#333333'), c('#555555'), 4.5)!;
ok('dark text on a mid-grey background cannot get dark enough, so it flips to light', mid.flipped && mid.direction === 'lighter' && mid.reached && mid.ratio >= 4.5, mid);

// an impossible target returns the best effort, honestly marked
const impossible = fixColor(c('#777777'), c('#777777'), 12)!;
ok('when nothing can reach the target the best attempt is returned and marked not reached', impossible.reached === false && impossible.ratio > 1, impossible);

// text with transparency is judged by what it really looks like
const faint = fixColor({ r: 0, g: 0, b: 0, a: 0.2 }, c('#ffffff'), 4.5)!;
ok('very transparent black text on white is made darker', !!faint && faint.direction === 'darker' && faint.reached, faint);

// minimal change: a barely failing colour barely moves
const nearly = fixColor(c('#7a7a7a'), c('#ffffff'), 4.5)!;
ok('a colour that is almost readable moves only a little', Math.abs(nearly.color.r - 0x7a) < 14, toHex(nearly.color));

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
