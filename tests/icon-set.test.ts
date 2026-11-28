// The icon picker's set: every icon is in one heading, line icons stay lines when filled, saved icons are recognised.
import { ICON_GROUPS, ICON_SET, canFill, iconInMask, iconMatches, iconUrl } from '../src/shared/iconSet';
import { cleanValue } from '../src/shared/edits';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra)?.slice(0, 400));
};

const names = ICON_SET.map(([n]) => n);
const grouped = ICON_GROUPS.flatMap((g) => g.names);
ok('names are unique', new Set(names).size === names.length);
ok('every icon is under exactly one heading', grouped.length === names.length && names.every((n) => grouped.includes(n)), names.filter((n) => !grouped.includes(n)));
ok('more icons to pick from', names.length >= 60, names.length);
ok('a line icon stays lines when filled', !canFill('chevron-down') && iconUrl('chevron-down', true) === iconUrl('chevron-down', false));
ok('a shape can be filled', canFill('heart') && iconUrl('heart', true) !== iconUrl('heart', false));
ok('a saved icon is recognised', iconInMask(`url("${iconUrl('cart')}")`)?.name === 'cart');
ok('a filled one too', iconInMask(`url("${iconUrl('star', true)}")`)?.filled === true);
ok('search by other words', iconMatches('basket')?.has('cart') === true && iconMatches('delete')?.has('trash') === true);
const dropped = ICON_SET.flatMap(([n]) => [false, true].filter((f) => cleanValue('mask-image', `url("${iconUrl(n, f)}")`) === null).map((f) => n + (f ? ' filled' : '')));
ok('every icon survives the saved-value check (long ones were dropped)', dropped.length === 0, dropped);
ok('other long values are still refused', cleanValue('color', 'x'.repeat(500)) === null);
ok('nothing typed shows all', iconMatches('  ') === null);

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
