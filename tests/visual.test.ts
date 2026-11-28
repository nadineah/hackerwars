// Edit Mode's Visual elements rules (src/content/visual.ts): what counts as drawing something.
import { alphaOf, isShown, paintsBox, type PaintStyle } from '../src/content/visual';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${!cond && extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`);
};

const plain: PaintStyle = {
  display: 'block', visibility: 'visible', opacity: '1',
  backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none',
  borderTopWidth: '0px', borderTopStyle: 'none', borderTopColor: 'rgb(0, 0, 0)',
  borderRightWidth: '0px', borderRightStyle: 'none', borderRightColor: 'rgb(0, 0, 0)',
  borderBottomWidth: '0px', borderBottomStyle: 'none', borderBottomColor: 'rgb(0, 0, 0)',
  borderLeftWidth: '0px', borderLeftStyle: 'none', borderLeftColor: 'rgb(0, 0, 0)',
  boxShadow: 'none', outlineStyle: 'none', outlineWidth: '0px', outlineColor: 'rgb(0, 0, 0)',
};
const box = (o: Partial<PaintStyle>) => ({ ...plain, ...o });

ok('alpha: transparent', alphaOf('transparent') === 0);
ok('alpha: rgba(0, 0, 0, 0)', alphaOf('rgba(0, 0, 0, 0)') === 0);
ok('alpha: rgb() is opaque (its blue is not an alpha)', alphaOf('rgb(10, 20, 30)') === 1);
ok('alpha: rgba(…, 0.5)', alphaOf('rgba(10, 20, 30, 0.5)') === 0.5);
ok('alpha: modern "/ a"', alphaOf('oklch(0.7 0.1 200 / 0.25)') === 0.25);
ok('alpha: modern "/ a%"', alphaOf('color(srgb 1 0 0 / 40%)') === 0.4);

ok('a plain wrapper paints nothing', !paintsBox(plain));
ok('a coloured background paints', paintsBox(box({ backgroundColor: 'rgb(255, 255, 255)' })));
ok('a nearly invisible background does not', !paintsBox(box({ backgroundColor: 'rgba(255, 255, 255, 0.01)' })));
ok('a background image (or gradient) paints', paintsBox(box({ backgroundImage: 'linear-gradient(red, blue)' })));
ok('an empty box with a visible border paints', paintsBox(box({ borderLeftWidth: '2px', borderLeftStyle: 'solid' })));
ok('a border with style none does not', !paintsBox(box({ borderLeftWidth: '2px', borderLeftStyle: 'none' })));
ok('a transparent border does not', !paintsBox(box({ borderTopWidth: '2px', borderTopStyle: 'solid', borderTopColor: 'rgba(0, 0, 0, 0)' })));
ok('a shadow paints', paintsBox(box({ boxShadow: 'rgba(0, 0, 0, 0.1) 0px 4px 14px 0px' })));
ok('an outline paints', paintsBox(box({ outlineStyle: 'solid', outlineWidth: '1px' })));

const size = { width: 100, height: 40 };
ok('shown: an ordinary box', isShown(plain, size));
ok('not shown: display none', !isShown(box({ display: 'none' }), size));
ok('not shown: display contents (no box of its own)', !isShown(box({ display: 'contents' }), size));
ok('not shown: visibility hidden', !isShown(box({ visibility: 'hidden' }), size));
ok('not shown: opacity 0', !isShown(box({ opacity: '0' }), size));
ok('not shown: no size', !isShown(plain, { width: 0, height: 40 }));

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
