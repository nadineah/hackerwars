// Polish: review passes from screenshots (2 = targeted fixes, 3 = studio rework + best of), against mocked chrome + APIs.
const mem: Record<string, any> = {};
const sent: any[] = [];
let tabState = { active: true, incognito: false, url: 'https://b.com/p' };
let pageShowsLatest = true;

const get = async (k: any) => {
  if (k === null || k === undefined) return JSON.parse(JSON.stringify(mem));
  const keys = Array.isArray(k) ? k : typeof k === 'string' ? [k] : Object.keys(k);
  const out: Record<string, any> = {};
  for (const key of keys) if (key in mem) out[key] = JSON.parse(JSON.stringify(mem[key]));
  return out;
};
(globalThis as any).chrome = {
  runtime: { id: 'me', sendMessage: async () => undefined },
  storage: { local: { get, getKeys: async () => Object.keys(mem), set: async (o: any) => Object.assign(mem, JSON.parse(JSON.stringify(o))), remove: async (k: any) => { for (const key of Array.isArray(k) ? k : [k]) delete mem[key]; } } },
  tabs: {
    get: async (id: number) => ({ id, windowId: 1, ...tabState }),
    sendMessage: async (_id: number, m: any) => {
      sent.push(m);
      if (m.type === 'ww:getState') {
        const d = (mem['site:b.com'] ?? [])[0];
        return { host: 'b.com', original: false, appliedIds: d ? [d.id] : [], applied: true, versions: d && pageShowsLatest ? { [d.id]: d.updatedAt } : {} };
      }
      return true;
    },
  },
};

// ---- API mock: a queue of tool calls per provider endpoint; every request is logged
const log: { u: string; body: any }[] = [];
let antQueue: [string, any][] = [];
const PNG = 'iVBORw0KGgo' + 'A'.repeat(40);
(globalThis as any).fetch = async (u: string, init: any) => {
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
  log.push({ u, body });
  if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  if (u.includes('/images/')) return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: PNG }], usage: { input_tokens: 10, output_tokens: 272 } }) };
  if (u.includes('anthropic.com')) {
    const next = antQueue.shift();
    if (!next) return { ok: true, json: async () => ({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }) };
    if ((globalThis as any).__abortOn === next[0]) (globalThis as any).__ctrl.abort();
    return { ok: true, json: async () => ({ content: [{ type: 'tool_use', name: next[0], input: next[1] }], usage: { input_tokens: 5, output_tokens: 7 } }) };
  }
  throw new Error('unexpected fetch ' + u);
};
// pictures are shrunk with canvas in the browser; a stand-in here
(globalThis as any).createImageBitmap = async () => ({ width: 1024, height: 1024, close() {} });
(globalThis as any).OffscreenCanvas = class { constructor(public width: number, public height: number) {} getContext() { return { drawImage() {}, imageSmoothingQuality: '' }; } async convertToBlob() { return new Blob([new Uint8Array(300).fill(65)]); } };

import { runPolish, type PolishContext } from '../src/background/polish';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${!cond && extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 600) : ''}`);
};

const OLD_ART = 'ww-asset-art:aaaaaaaaaaaa';
function seed(css = 'body{background:#123}') {
  for (const k of Object.keys(mem)) delete mem[k];
  const t = Date.now() - 1000;
  mem['site:b.com'] = [{ id: 'd1', host: 'b.com', scope: 'site', name: 'Palace', prompt: 'palace', css, ops: [], enabled: true, createdAt: t, updatedAt: t }];
  mem['convo:c1'] = { id: 'c1', host: 'b.com', scope: 'site', designId: 'd1', title: 'palace', createdAt: t, updatedAt: t, messages: [{ id: 'u1', role: 'user', text: 'rococo palace', createdAt: t }, { id: 'b1', role: 'assistant', text: 'Built a palace.', createdAt: t, snapshot: { css, ops: [] } }] };
  mem[`art:${OLD_ART.slice(-12)}`] = { data: 'data:image/webp;base64,' + 'UklGR'.padEnd(40, 'A'), w: 512, h: 512, prompt: 'gilded mirror' };
  log.length = 0;
  sent.length = 0;
}
const ctxFor = (level: number, extra: Partial<PolishContext> = {}): PolishContext => {
  const ctrl = new AbortController();
  (globalThis as any).__ctrl = ctrl;
  return {
    level, tabId: 7, signal: ctrl.signal, provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-sonnet-5-5', intensity: 1, imageKey: '',
    request: 'transform this website into an extravagant rococo palace', host: 'b.com', path: '/p', scope: 'site', pageContext: 'host: b.com\nLayout ...', applied: [],
    designId: 'd1', designHost: 'b.com', conversationId: 'c1', botMessageId: 'b1',
    onUsage: () => {}, imageUsage: () => {}, enqueue: (job) => job(),
    capture: async () => ({ ok: true, data: 'SHOT' + (++shots) }),
    settleMs: 1,
    ...extra,
  };
};
let shots = 0;
const design = () => mem['site:b.com'][0];
const reply = () => mem['convo:c1'].messages[1].text as string;
const ant = () => log.filter((c) => c.u.includes('anthropic.com'));
const imagesIn = (body: any) => JSON.stringify(body.messages).match(/"type":"image"/g)?.length ?? 0;

(async () => {
  // ---------- 1 Quick: nothing happens
  seed();
  const q = await runPolish(ctxFor(1), 'Built a palace.');
  ok('Quick: no screenshot, no extra call, no change', q.note === '' && !log.length && !sent.length && design().css === 'body{background:#123}');

  // ---------- 2 Polished: one screenshot, one targeted pass, saved as the chat's design
  seed();
  antQueue = [['submit_design', { name: 'Palace', plan: 'p', reply: 'Made the gold titles readable.', css: 'body{background:#123} h1{color:#fff}', checklist: [] }]];
  const p = await runPolish(ctxFor(2), 'Built a palace.');
  const pc = ant()[0];
  ok('Polished: one review call that carries the screenshot and the current design', ant().length === 1 && imagesIn(pc.body) === 1 && JSON.stringify(pc.body.messages).includes('SHOT') && JSON.stringify(pc.body.messages).includes('current_design') && /targeted corrections only/.test(JSON.stringify(pc.body.messages)), pc && JSON.stringify(pc.body.messages).slice(-400));
  ok('Polished: the corrected design is saved, applied and in the chat snapshot', design().css.includes('h1{color:#fff}') && mem['convo:c1'].messages[1].snapshot.css.includes('h1{color:#fff}'));
  ok('Polished: the reply says what the review did', /Checked a screenshot: Made the gold titles readable/.test(reply()) && reply().startsWith('Built a palace.'), reply());
  ok('Polished: the page was switched off Show original before the screenshot', sent.some((m) => m.type === 'ww:setOriginal' && m.original === false));
  ok('Polished: the conversation history (request and first reply) goes with the review', /rococo palace/.test(JSON.stringify(pc.body.messages)) && /Built a palace/.test(JSON.stringify(pc.body.messages)));
  ok('Polished: usage of the review is added to the turn', (mem['convo:c1'].messages[1].usage?.outputTokens ?? 0) >= 7 && p.usage.outputTokens >= 7);

  // ---------- 3 Studio, no pictures: rework, refine, judge picks the FIRST version -> it is put back
  seed();
  antQueue = [
    ['submit_design', { name: 'Palace', plan: 'p', reply: 'Rebuilt the header as a gilded arch.', css: 'body{background:#123} header{border-radius:40px}', checklist: [] }],
    ['submit_design', { name: 'Palace', plan: 'p', reply: 'Tightened spacing.', css: 'body{background:#123} header{border-radius:40px;padding:4px}', checklist: [] }],
    ['pick_best', { reason: 'A is cleaner; the arch crowds the search box.', best: 'A' }],
  ];
  const s1 = await runPolish(ctxFor(3), 'Built a palace.');
  const calls = ant();
  ok('Studio: rework, final refinement and a comparison: three calls', calls.length === 3, calls.map((c) => c.body.tools?.[0]?.name));
  ok('Studio rework: told it may substantially rework (not only small fixes), with the screenshot', /not limited to small fixes/.test(JSON.stringify(calls[0].body.messages)) && imagesIn(calls[0].body) === 1);
  ok('Studio rework without pictures allowed: says so and offers only the design tool', /No new pictures can be made in this pass/.test(JSON.stringify(calls[0].body.messages)) && calls[0].body.tools.length === 1);
  ok('Studio final pass sees the NEW screenshot of the reworked version', JSON.stringify(calls[1].body.messages).includes('SHOT') && /Final refinement/.test(JSON.stringify(calls[1].body.messages)) && JSON.stringify(calls[1].body.messages).includes('border-radius:40px'));
  ok('Studio judge sees all three versions', imagesIn(calls[2].body) === 3 && calls[2].body.tools[0].name === 'pick_best');
  ok('Studio: the judge preferred the first version, so it is put back', design().css === 'body{background:#123}' && mem['convo:c1'].messages[1].snapshot.css === 'body{background:#123}', design().css);
  ok('Studio: the reply tells the story', /Reworked it: Rebuilt the header/.test(reply()) && /Refined it: Tightened spacing/.test(reply()) && /Kept the first version/.test(reply()) && /crowds the search box/.test(s1.note), reply());

  // ---------- 3 Studio with pictures: new and edited artwork in the rework, the final version kept
  seed(`body{background:#123} .card::before{content:"";background:url(${OLD_ART})}`);
  antQueue = [
    ['plan_artwork', { plan: 'Bigger, warmer palace.', art_direction: 'Rococo oil painting, pastel pink #f4c2c2, mint #bfe3d0, gold #d4af37.', pictures: [
      { id: 'ceiling', use: 'page background', prompt: 'a pastel rococo ceiling fresco with cherubs and clouds', shape: 'wide', transparent: false, quality: 'medium', size: 'large' },
      { id: 'mirror2', use: 'card corners', prompt: 'make the frame pinker with roses', shape: 'square', transparent: true, quality: 'low', size: 'small', edit_of: OLD_ART },
    ] }],
    ['submit_design', { name: 'Palace', plan: 'p', reply: 'Added a ceiling fresco and pinker mirrors.', css: 'body{background:url("ww-asset-ceiling") center/cover} .card::before{content:"";background:url("ww-asset-mirror2")}', checklist: [] }],
    ['submit_design', { name: 'Palace', plan: 'p', reply: 'Softened the fresco behind text.', css: 'body{background:linear-gradient(#fff8,#fff8),url("ww-asset-ceiling") center/cover} .card::before{content:"";background:url("ww-asset-mirror2")}', checklist: [] }],
    ['pick_best', { reason: 'C is the richest and still readable.', best: 'C' }],
  ];
  // the art tokens in the CSS must survive the save: write the bound version through the real flow
  const s2 = await runPolish(ctxFor(3, { intensity: 5, imageKey: 'sk-oai' }), 'Built a palace.');
  const gens = log.filter((c) => c.u.includes('/images/generations'));
  const edits = log.filter((c) => c.u.includes('/images/edits'));
  const rw = ant()[0];
  ok('Studio rework with pictures: the art tools are offered and the screenshot is sent', rw.body.tools.map((t: any) => t.name).join() === 'plan_artwork,submit_design' && /You may paint new pictures and edit or replace existing ones/.test(JSON.stringify(rw.body.messages)) && imagesIn(rw.body) === 1);
  ok('existing artwork is offered for reuse (available_artwork with its token)', JSON.stringify(rw.body.messages).includes(OLD_ART) && /gilded mirror/.test(JSON.stringify(rw.body.messages)));
  ok('a new picture is painted and an existing one is EDITED (the old picture is the input image)', gens.length === 1 && edits.length === 1 && edits[0].body instanceof FormData && /Edit this picture/.test(String((edits[0].body as FormData).get('prompt'))), { gens: gens.length, edits: edits.length });
  const finalCss = design().css as string;
  const toks = finalCss.match(/ww-asset-art:[a-f0-9]{12}/g) ?? [];
  ok('the final design uses the new pictures as stored tokens, and they are stored', toks.length === 2 && toks.every((t) => !!mem[`art:${t.slice(-12)}`]) && !finalCss.includes('ww-asset-ceiling'), finalCss);
  ok('Studio: the judge chose the final version, so it stays', /linear-gradient/.test(finalCss) && /final version came out strongest/.test(reply()) && !!s2.note, reply());
  ok('the replaced old picture is cleaned up once nothing uses it', !mem[`art:${OLD_ART.slice(-12)}`]);

  // ---------- never in a private window, and only when the tab is on screen
  seed();
  tabState = { active: true, incognito: true, url: 'https://b.com/p' };
  const inc = await runPolish(ctxFor(2), 'Built a palace.');
  ok('private window: no screenshot, no call, a short note', /never taken in private windows/.test(inc.note) && !log.length);
  // switched to another tab: the review waits, says so, and carries on when you come back
  seed();
  tabState = { active: false, incognito: false, url: 'https://b.com/p' };
  antQueue = [['submit_design', { name: 'Palace', plan: 'p', reply: 'Fixed after you came back.', css: 'body{background:#0f0}', checklist: [] }]];
  const said: string[] = [];
  setTimeout(() => (tabState = { active: true, incognito: false, url: 'https://b.com/p' }), 1200);
  const back = await runPolish(ctxFor(2, { progress: (t) => said.push(t) }), 'Built a palace.');
  ok('tab not on screen: the review waits, tells the panel, then continues when you return', said.includes('Waiting for you to return to the tab to check the result') && said.includes('Checking the result') && design().css === 'body{background:#0f0}' && /Fixed after you came back/.test(back.note), { said, note: back.note });
  // never comes back: ends cleanly, the design stays
  seed();
  tabState = { active: false, incognito: false, url: 'https://b.com/p' };
  const gone = await runPolish(ctxFor(2, { returnWaitMs: 600 }), 'Built a palace.');
  ok('never back to the tab: ends with a note, nothing sent, the design is unchanged', /did not come back to the tab/.test(gone.note) && !log.length && design().css === 'body{background:#123}', gone.note);
  // moved to another site while waiting: ends
  seed();
  tabState = { active: false, incognito: false, url: 'https://b.com/p' };
  setTimeout(() => (tabState = { active: true, incognito: false, url: 'https://other.com/' }), 700);
  const moved = await runPolish(ctxFor(2), 'Built a palace.');
  ok('the tab went to another site while waiting: ends with a note', /another site/.test(moved.note) && !log.length, moved.note);
  tabState = { active: true, incognito: false, url: 'https://b.com/p' };

  // ---------- Stop during Studio: the last saved version stays, the reply says so
  seed();
  antQueue = [
    ['submit_design', { name: 'Palace', plan: 'p', reply: 'Reworked.', css: 'body{background:#456}', checklist: [] }],
    ['submit_design', { name: 'Palace', plan: 'p', reply: 'Refined.', css: 'body{background:#789}', checklist: [] }],
  ];
  (globalThis as any).__abortOn = 'never';
  const c3 = ctxFor(3);
  const origCapture = c3.capture;
  let n = 0;
  c3.capture = async (id) => { n++; if (n === 2) (globalThis as any).__ctrl.abort(); return origCapture(id); };
  const st = await runPolish(c3, 'Built a palace.');
  ok('Stop: the reworked version (last saved) stays and the reply says the review stopped', design().css === 'body{background:#456}' && /Review stopped/.test(st.note) && /Review stopped/.test(reply()), { css: design().css, note: st.note });

  // ---------- the chat changed meanwhile: nothing is overwritten
  seed();
  antQueue = [['submit_design', { name: 'Palace', plan: 'p', reply: 'Fixed.', css: 'body{background:#abc}', checklist: [] }]];
  const c4 = ctxFor(2);
  c4.capture = async () => { mem['site:b.com'][0].css = 'body{background:#user-edit}'; return { ok: true, data: 'SHOT' }; };
  const ch = await runPolish(c4, 'Built a palace.');
  ok('a change made meanwhile (another panel, an undo) is never overwritten', design().css === 'body{background:#user-edit}' && /not saved/.test(ch.note), ch.note);

  // ---------- the user goes Back while the review runs: the review never saves over that
  seed();
  antQueue = [['submit_design', { name: 'Palace', plan: 'p', reply: 'Fixed.', css: 'body{background:#abc}', checklist: [] }]];
  const c6 = ctxFor(2);
  c6.capture = async () => { mem['convo:c1'].revisionIndex = 0; return { ok: true, data: 'SHOT' }; };
  const nav = await runPolish(c6, 'Built a palace.');
  ok('going Back during a review: the review result is not saved over the version you chose', design().css === 'body{background:#123}' && /not saved/.test(nav.note), nav.note);

  // ---------- the page never shows the new version (navigated away): the review ends, nothing breaks
  seed();
  pageShowsLatest = false;
  const c5 = ctxFor(2);
  const t0 = Date.now();
  // speed up the wait in the test
  const realNow = Date.now;
  let fake = t0;
  (Date as any).now = () => (fake += 2000);
  const nv = await runPolish(c5, 'Built a palace.');
  (Date as any).now = realNow;
  pageShowsLatest = true;
  ok('the page never showed the design: the review ends with a note, no call made', /could not finish \(the page did not show the new version\)/.test(nv.note) && !ant().length, nv.note);

  console.log(fails ? `${fails} FAILED` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})();
