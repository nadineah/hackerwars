// Light or dark where people read: the vote over text backdrops, with the page background as the fallback.
import { decideTone, type Backdrop } from '../src/shared/tone';
import { systemPromptFor } from '../src/background/anthropic';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra));
};
const c = (hex: string) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a: 1 });
const many = (b: Backdrop, n: number): Backdrop[] => Array.from({ length: n }, () => b);
const white = c('#ffffff'), grey = c('#f0f2f5'), black = c('#0f0f0f');

ok('text on white: light', decideTone(many(white, 20), white).tone === 'light');
ok('text on near-black: dark', decideTone(many(black, 20), black).tone === 'dark');
const cards = decideTone(many(white, 20), c('#18191a'));
ok('white cards on a dark page: the text decides (light), not the page', cards.tone === 'light' && /text mostly on #ffffff/.test(cards.basis), cards);
ok('grey page with white cards: light either way', decideTone([...many(white, 15), ...many(grey, 5)], grey).tone === 'light');
const grid = decideTone([...many('picture', 30), ...many(black, 3)], black);
ok('a video grid (text mostly on pictures, little else): the page background decides', grid.tone === 'dark' && /page background/.test(grid.basis), grid);
const gridLight = decideTone(many('picture', 40), white);
ok('a video grid on a light page: light', gridLight.tone === 'light' && /page background/.test(gridLight.basis));
const split = decideTone([...many(white, 10), ...many(black, 9)], black);
ok('an even split: the page background decides', split.tone === 'dark' && /page background/.test(split.basis), split);
ok('mid-grey backdrops do not vote; too few votes: page background', /page background/.test(decideTone([...many(c('#888888'), 30), ...many(white, 3)], white).basis));

const levels = [systemPromptFor('anthropic', false), systemPromptFor('anthropic', true, 2), systemPromptFor('anthropic', true, 5), systemPromptFor('openai', false), systemPromptFor('openai', true, 4)];
ok('every level (Claude and OpenAI) has the light/dark rule and the Direction line in the plan', levels.every((p) => /A NEW design keeps that direction/.test(p) && /Direction: keeps light/.test(p) && /A follow-up keeps the current design's direction/.test(p)));

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
