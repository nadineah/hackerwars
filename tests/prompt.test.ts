// The click-target rule lives in every prompt, and the outline tells the model the real sizes.
import { systemPromptFor } from '../src/background/anthropic';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${!cond && extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`);
};

for (const [p, art] of [['anthropic', false], ['openai', false], ['openai', true]] as const) {
  const t = systemPromptFor(p, art);
  ok(`${p}${art ? ' + illustrations' : ''}: never smaller, nothing covering, no hiding clickable elements`, /never make any link, button, input, select or other clickable element smaller than it is now/i.test(t) && /Nothing may cover a clickable element/.test(t) && /pointer-events:none/.test(t) && /Do not hide a clickable element/.test(t));
  ok(`${p}${art ? ' + illustrations' : ''}: readable text rules (set the colour with the background, 4.5:1, panels behind text on images)`, /Readable text: whenever you set or change a background/.test(t) && /4.5:1 for normal text and 3:1 for large text/.test(t) && /solid or semi-opaque panel/.test(t));
  ok(`${p}${art ? ' + illustrations' : ''}: the model is told the outline carries current sizes`, /current size in pixels of links, buttons/.test(t));
}
ok('the old, vaguer wording is gone', !/controls must stay clickable, do not hide essential navigation unless asked/.test(systemPromptFor('anthropic', false)));

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
