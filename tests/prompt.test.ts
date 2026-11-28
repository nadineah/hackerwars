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
  ok(`${p}${art ? ' + illustrations' : ''}: readability targets apply at every intensity`, /Readable text: whenever you set or change a background/.test(t) && /4.5:1 for normal text and 3:1 for large text at every intensity/.test(t) && /size, weight and spacing for secondary text/.test(t));
  ok(`${p}${art ? ' + illustrations' : ''}: the model is told the outline carries current sizes`, /current size in pixels of links, buttons/.test(t));
}
ok('the old, vaguer wording is gone', !/controls must stay clickable, do not hide essential navigation unless asked/.test(systemPromptFor('anthropic', false)));
ok('Simple follows the brief without mandatory decoration counts', /one clear visual idea/.test(systemPromptFor('anthropic', false)) && !/5-7 colours|2-3 recurring motifs|Avoid flat single-colour/.test(systemPromptFor('anthropic', false)));
ok('Immersive has room for reading and no minimum animation count', /keep dense areas easy to scan/.test(systemPromptFor('anthropic', true, 4)) && !/at least three animated/.test(systemPromptFor('anthropic', true, 4)));
for (const provider of ['anthropic', 'openai'] as const) {
  const prompts = [1, 2, 3, 4, 5].map((level) => systemPromptFor(provider, level >= 2, level));
  ok(`${provider}: lower levels preserve hierarchy and local contrast`, prompts.slice(0, 2).every((p) => /existing visual hierarchy, layout and local contrast/.test(p) && /change the affected text and surface colours together/.test(p)) && prompts.slice(2).every((p) => !/existing visual hierarchy, layout and local contrast/.test(p)));
  ok(`${provider}: all levels preserve native and custom player controls`, prompts.every((p) => /Preserve native video and audio controls and custom player controls/.test(p)));
  ok(`${provider}: Illustrated puts art beside text; Enchanted allows readable backdrops`, /Keep the surface directly behind text solid/.test(prompts[1]) && !/solid or semi-opaque panel|Text stays readable on top of pictures/.test(prompts[1]) && /Artwork can sit behind text/.test(prompts[2]));
  ok(`${provider}: all five levels use the same contrast targets`, prompts.every((p) => /4.5:1 for normal text and 3:1 for large text/.test(p)));
  ok(`${provider}: refinements keep Illustrated placement and higher levels keep their freedom`, /behind text solid/.test(systemPromptFor(provider, false, 2, true)) && !/behind text solid|Intensity: Immersive/.test(systemPromptFor(provider, true, 4, true)));
}

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
