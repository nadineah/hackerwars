// Snipping tool: mapping a dragged rectangle onto a screenshot.
import { cropBox, type SnipRect } from '../src/shared/snip';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${!cond && extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`);
};
const r = (o: Partial<SnipRect> = {}): SnipRect => ({ x: 100, y: 50, w: 300, h: 200, vw: 1000, vh: 800, ...o });

ok('same size screenshot: the box is the rectangle', JSON.stringify(cropBox(r(), 1000, 800)) === JSON.stringify({ sx: 100, sy: 50, sw: 300, sh: 200 }));
ok('retina screenshot (2x): the box is scaled up', JSON.stringify(cropBox(r(), 2000, 1600)) === JSON.stringify({ sx: 200, sy: 100, sw: 600, sh: 400 }));
ok('a rectangle running off the edge is clipped to the image', (() => { const b = cropBox(r({ x: 900, w: 500 }), 1000, 800); return !!b && b.sx === 900 && b.sx + b.sw === 1000; })());
ok('a rectangle outside the image gives nothing', cropBox(r({ x: 1200 }), 1000, 800) === null);
ok('a sliver is rejected', cropBox(r({ w: 2 }), 1000, 800) === null && cropBox(r({ h: 1 }), 1000, 800) === null);
ok('garbage input is rejected, never throws', [NaN, Infinity, -1].every((v) => cropBox(r({ vw: v }), 1000, 800) === null) && cropBox(r({ x: NaN }), 1000, 800) === null && cropBox(r(), 0, 800) === null);

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
