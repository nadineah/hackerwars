// The model's honest self-check: what it did and could not do.
import { cleanChecklist, toolFor, unfulfilledNote } from '../src/background/anthropic';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${!cond && extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`);
};

const list = cleanChecklist([
  { requirement: 'Cyberpunk colours', status: 'done' },
  { requirement: '<b>Animated rain</b> on the header', status: 'partial', note: 'only a CSS shimmer, no real rain\n(needs JavaScript)' },
  { requirement: 'A moving robot mascot', status: 'not_done', note: 'needs JavaScript' },
  { requirement: '', status: 'done' },
  { requirement: 'Weird status', status: 'banana' },
  null,
  'text',
]);
ok('items are cleaned: markup and control characters removed, empty ones dropped, unknown status counts as done', list.length === 4 && list[1].requirement === 'Animated rain on the header' && !list[1].note.includes('\n') && list[3].status === 'done', list);
ok('at most 14 items, garbage input gives none and never throws', cleanChecklist(Array.from({ length: 30 }, (_, i) => ({ requirement: 'r' + i, status: 'done' }))).length === 14 && cleanChecklist(null).length === 0 && cleanChecklist('x').length === 0);
const note = unfulfilledNote(list);
ok('the user-facing note lists only what was not (fully) done, with the reasons', /^Not fully done: /.test(note) && note.includes('Animated rain on the header (partly)') && note.includes('A moving robot mascot: needs JavaScript') && !note.includes('Cyberpunk colours'), note);
ok('when everything was done there is no note', unfulfilledNote(cleanChecklist([{ requirement: 'a', status: 'done' }])) === '' && unfulfilledNote([]) === '');
const tool = toolFor(false) as any;
ok('the design tool asks for the checklist (last, and required) and tells the model to be honest in its reply', tool.input_schema.required.includes('checklist') && Object.keys(tool.input_schema.properties).at(-1) === 'checklist' && /could not do part of what was asked/.test(tool.input_schema.properties.reply.description));

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
