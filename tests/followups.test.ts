// Follow-ups after going Back build on the version on the page; targeted edits leave the rest of the design alone.
import { appliedMessages, layerEdit } from '../src/shared/revisions';
import { systemPromptFor, toolFor } from '../src/background/anthropic';
import type { ChatMessage, Conversation } from '../src/shared/types';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra));
};
const u = (id: string, text: string): ChatMessage => ({ id, role: 'user', text, createdAt: 0 });
const a = (id: string, css: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', text: `made ${css}`, createdAt: 0, snapshot: { css, ops: [] }, ...extra });
const convo = (messages: ChatMessage[], revisionIndex?: number) => ({ id: 'c', host: 'h', title: 't', createdAt: 0, updatedAt: 0, messages, revisionIndex }) as Conversation;

const msgs = [u('1', 'red'), a('2', 'v1'), u('3', 'blue'), a('4', 'v2'), u('5', 'green'), a('6', 'v3')];
const texts = (c: Conversation) => appliedMessages(c).map((m) => m.text);
ok('at the latest version every turn is sent', texts(convo(msgs)).length === 6);
ok('back on version 2: the version 3 request and reply are left out', JSON.stringify(texts(convo(msgs, 1))) === JSON.stringify(['red', 'made v1', 'blue', 'made v2']), texts(convo(msgs, 1)));
ok('back on version 1: versions 2 and 3 are left out', JSON.stringify(texts(convo(msgs, 0))) === JSON.stringify(['red', 'made v1']), texts(convo(msgs, 0)));
const discarded = [u('1', 'red'), a('2', 'v1'), u('3', 'blue'), a('4', 'v2', { discarded: true }), u('5', 'gold'), a('6', 'v2b')];
ok('discarded turns (undone, then replaced) are left out too', JSON.stringify(texts(convo(discarded))) === JSON.stringify(['red', 'made v1', 'gold', 'made v2b']), texts(convo(discarded)));
const failed = [u('1', 'red'), a('2', 'v1'), u('3', 'oops'), { id: '4', role: 'assistant', text: 'error', createdAt: 0 } as ChatMessage];
ok('replies without a design (errors, questions) are kept', texts(convo(failed)).length === 4);

const base = { css: '#a{color:red}\nh1{font-size:40px}', ops: [{ op: 'hide', selector: '.ad' }] };
const merged = layerEdit(base, { css: 'button{border-radius:12px!important}', ops: [{ op: 'hide', selector: '.promo' }] });
ok('a targeted edit keeps the whole current design exactly, the new rules after it', merged.css.startsWith(base.css) && merged.css.trimEnd().endsWith('button{border-radius:12px!important}'), merged.css);
ok('new ops are added after the existing ones', merged.ops.length === 2 && merged.ops[0].selector === '.ad');
ok('an empty edit changes nothing', layerEdit(base, { css: '  ', ops: [] }).css === base.css);

const prompt = systemPromptFor('anthropic', false);
ok('the prompt explains "edit" (only those elements) and "redesign" (complete CSS)', /"edit" \(the default for a follow-up\)/.test(prompt) && /nothing else in the theme or design may change/.test(prompt) && /"redesign": only when/.test(prompt));
ok('every design tool offers the "change" field', ['edit', 'redesign'].every((v) => (toolFor(false).input_schema.properties as Record<string, { enum?: string[] }>).change.enum!.includes(v)) && 'change' in toolFor(true).input_schema.properties);

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
