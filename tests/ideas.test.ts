// Example prompts on the empty chat: a large hand-written pool, a few picked at random each visit.
import { IDEAS, pickIdeas } from '../src/sidepanel/ideas';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${!cond && extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`);
};
const rng = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

ok('the pool is large (at least 60) and has no duplicates', IDEAS.length >= 60 && new Set(IDEAS).size === IDEAS.length, IDEAS.length);
ok('every idea is a plain, reasonably short line', IDEAS.every((i) => i.length > 8 && i.length <= 110 && !/[<>\n]/.test(i)), IDEAS.filter((i) => i.length > 110));
const a = pickIdeas(4, [], rng(1));
ok('picks 4 different ideas from the pool', a.length === 4 && new Set(a).size === 4 && a.every((i) => IDEAS.includes(i)));
ok('never repeats what was just shown', Array.from({ length: 50 }, (_, s) => pickIdeas(4, a, rng(s + 2))).every((p) => p.every((i) => !a.includes(i))));
ok('different seeds give different picks', new Set(Array.from({ length: 20 }, (_, s) => pickIdeas(4, [], rng(s + 10)).join('|'))).size > 10);
ok('asking for more than exists still returns something sensible', pickIdeas(500, [], rng(3)).length === IDEAS.length);

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
