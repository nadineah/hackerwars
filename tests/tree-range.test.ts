// Lazy loading of long lists in the Edit Mode tree (src/shared/treeRange.ts).
import { childRange, TREE_BATCH } from '../src/shared/treeRange';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${!cond && extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`);
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

ok('first look: the first batch', eq(childRange(1000), { start: 0, end: TREE_BATCH }));
ok('a short list: all of it', eq(childRange(40), { start: 0, end: 40 }));
ok('an empty list', eq(childRange(0), { start: 0, end: 0 }));
ok('Show more: one more batch', eq(childRange(1000, { start: 0, end: 300 }), { start: 0, end: 300 }));
ok('...never past the end', eq(childRange(320, { start: 0, end: 450 }), { start: 0, end: 320 }));
ok('a refresh keeps what was loaded', eq(childRange(1000, { start: 0, end: 450 }), { start: 0, end: 450 }));
ok('a list that shrank below the window shows its last batch', eq(childRange(100, { start: 300, end: 450 }), { start: 0, end: 100 }));

// picked on the page
ok('already loaded: nothing changes', eq(childRange(1000, { start: 0, end: 150 }, 20), { start: 0, end: 150 }));
ok('near the top: loaded from the top down to it', eq(childRange(1000, { start: 0, end: 150 }, 160), { start: 0, end: 300 }));
ok('...keeping more that was already loaded', eq(childRange(1000, { start: 0, end: 450 }, 460), { start: 0, end: 600 }));
ok('far down: a window around it', eq(childRange(3000, { start: 0, end: 150 }, 2000), { start: 1950, end: 2100 }));
ok('...clamped at the end of the list', eq(childRange(2010, { start: 0, end: 150 }, 2005), { start: 1955, end: 2010 }));
ok('a window, then one near the top: back to loading from the top', eq(childRange(3000, { start: 1950, end: 2100 }, 10), { start: 0, end: 150 }));
ok('not a child (a decoration, or gone): nothing changes', eq(childRange(1000, { start: 0, end: 150 }, -1), { start: 0, end: 150 }));

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
