// Design previews: the pure pixel steps, the rules for WHEN a preview may be made, and storage of the result.
const mem: Record<string, any> = {};
let tabs: any[] = [];
let sent: { id: number; type: string }[] = [];
let beginReply: any = { ok: true, maxTextPx: 16, bars: 10 };
let captureImpl: () => Promise<string> = async () => 'data:image/png;base64,AAAA';
(globalThis as any).chrome = {
  runtime: { id: 'me' },
  storage: {
    local: {
      get: async (k: any) => (k === null ? { ...mem } : { [k]: mem[k] }),
      set: async (o: any) => void Object.assign(mem, JSON.parse(JSON.stringify(o))),
      remove: async (k: any) => void (Array.isArray(k) ? k : [k]).forEach((x: string) => delete mem[x]),
    },
  },
  tabs: {
    query: async () => tabs.filter((t) => t.active),
    get: async (id: number) => tabs.find((t) => t.id === id),
    sendMessage: async (id: number, m: any) => {
      sent.push({ id, type: m.type });
      if (m.type === 'ww:previewBegin') return beginReply;
      return true;
    },
    captureVisibleTab: async () => captureImpl(),
  },
};

import { MAX_GLYPH_PX, MAX_SHRINK_WIDTH, MIN_SHRINK_WIDTH, THUMB_MAX_CHARS, isThumbDataUrl, liftDark, punch, sharpen, shrinkWidth } from '../src/shared/pixels';
import { capturePreview } from '../src/background/preview';
import { cleanDescriptor } from '../src/background/anthropic';
import { clearAllThumbs, getFavicons, getSettings, saveFavicon, savePreviewsSetting } from '../src/shared/storage';
import type { Design } from '../src/shared/types';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra)?.slice(0, 300));
};

// ------------------------------------------------------------------ how hard to shrink
ok('normal pages (16px text) shrink to the maximum width', shrinkWidth(16, 1280) === MAX_SHRINK_WIDTH);
ok('a page with a 48px headline is shrunk more, so the headline is about 2px tall', shrinkWidth(48, 1280) === Math.round((1280 * MAX_GLYPH_PX) / 48) && shrinkWidth(48, 1280) < MAX_SHRINK_WIDTH);
ok('huge text hits the floor, never below the minimum width', shrinkWidth(400, 1280) === MIN_SHRINK_WIDTH && shrinkWidth(1e9, 1280) === MIN_SHRINK_WIDTH);
ok('garbage metrics fall back safely (never throw, never wider than the cap)', [NaN, 0, -5, Infinity].every((v) => { const w = shrinkWidth(v as number, 1280); return w >= MIN_SHRINK_WIDTH && w <= MAX_SHRINK_WIDTH; }));
ok('after shrinking, the tallest text is at most ~3px (or the page is at the floor)', [10, 12, 16, 24, 32, 48, 64, 96].every((t) => { const w = shrinkWidth(t, 1280); return (t * w) / 1280 <= MAX_GLYPH_PX + 0.1 || w === MAX_SHRINK_WIDTH || w === MIN_SHRINK_WIDTH; }));
ok('even a 100px headline ends up under 4.5px tall in the preview', (100 * shrinkWidth(100, 1280)) / 1280 < 4.5);

// ------------------------------------------------------------------ pixel steps
const px = (rgb: [number, number, number], n = 100) => { const a = new Uint8ClampedArray(n * 4); for (let i = 0; i < n; i++) a.set([...rgb, 255], i * 4); return a; };
const dark = px([20, 25, 30]);
const gain = liftDark(dark);
ok('a dark page is brightened so its colours stay visible', gain > 1.5 && dark[0] > 40 && dark[2] > 60, { gain, p: [...dark.slice(0, 3)] });
const light = px([240, 235, 225]);
ok('a light page is left untouched', liftDark(light) === 1 && light[0] === 240 && light[1] === 235 && light[2] === 225);
const black = px([0, 0, 0]);
liftDark(black);
ok('pure black does not blow up (gain is capped)', black[0] <= 3 * 24 + 1);
const pn = new Uint8ClampedArray([200, 100, 100, 255, 100, 100, 200, 255]);
const before = (pn[0] * 0.2126 + pn[1] * 0.7152 + pn[2] * 0.0722 + pn[4] * 0.2126 + pn[5] * 0.7152 + pn[6] * 0.0722) / 2;
punch(pn);
const after = (pn[0] * 0.2126 + pn[1] * 0.7152 + pn[2] * 0.0722 + pn[4] * 0.2126 + pn[5] * 0.7152 + pn[6] * 0.0722) / 2;
ok('punch adds contrast and colour without changing overall brightness, and keeps alpha', Math.abs(after - before) < 1.5 && pn[0] - pn[4] > 100 && pn[3] === 255 && pn[7] === 255, [...pn]);
const flatPunch = px([90, 90, 90], 4);
punch(flatPunch);
ok('punching a flat grey area changes nothing', flatPunch[0] === 90 && flatPunch[1] === 90 && flatPunch[2] === 90);
const flat = px([100, 120, 140], 36);
sharpen(flat, 6, 6, 0.4);
ok('sharpening a flat area changes nothing (it cannot invent detail)', flat[0] === 100 && flat[1] === 120 && flat[2] === 140);
const edge = new Uint8ClampedArray(6 * 6 * 4);
for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) edge.set(x < 3 ? [60, 60, 60, 255] : [200, 200, 200, 255], (y * 6 + x) * 4);
sharpen(edge, 6, 6, 0.3);
ok('sharpening exaggerates an existing edge and stays in range', edge[(2) * 4] < 60 && edge[(3) * 4] > 200 && [...edge].every((v) => v >= 0 && v <= 255));

// ------------------------------------------------------------------ what may be stored
const good = 'data:image/webp;base64,' + 'A'.repeat(500);
ok('a small webp/png/jpeg data URL is accepted', isThumbDataUrl(good) && isThumbDataUrl('data:image/png;base64,' + 'B'.repeat(100)) && isThumbDataUrl('data:image/jpeg;base64,' + 'C'.repeat(100)));
for (const bad of ['http://evil.example/x.png', 'data:image/svg+xml;base64,' + 'A'.repeat(100), 'data:text/html;base64,' + 'A'.repeat(100), 'javascript:alert(1)', 'data:image/webp;base64,', 'data:image/webp;base64,' + 'A'.repeat(THUMB_MAX_CHARS), 'data:image/webp;base64,<script>', 5, null, undefined, {}]) ok(`rejects ${String(bad).slice(0, 40)}`, !isThumbDataUrl(bad as any));

// ------------------------------------------------------------------ when a preview may be made
const design = (over: Partial<Design> = {}): Design => ({ id: 'd1', host: 'www.youtube.com', scope: 'site', name: 'X', prompt: 'x', css: 'a{}', ops: [], enabled: true, createdAt: 1, updatedAt: 1, ...over });
const tab = (over: any = {}) => ({ id: 7, windowId: 1, active: true, incognito: false, url: 'https://www.youtube.com/feed', ...over });
const reset = () => { for (const k of Object.keys(mem)) delete mem[k]; tabs = [tab()]; sent = []; beginReply = { ok: true, maxTextPx: 16, bars: 10 }; captureImpl = async () => 'data:image/png;base64,AAAA'; };
(async () => {
  reset();
  ok('previews default to ON', (await getSettings()).previews === true);
  await savePreviewsSetting(false);
  ok('the setting can be turned off and is remembered, leaving keys and model alone', (await getSettings()).previews === false && (await (async () => { mem.settings = { ...mem.settings, apiKey: 'k', model: 'm' }; await savePreviewsSetting(true); const s = await getSettings(); return s.apiKey === 'k' && s.model === 'm' && s.previews; })()));
  const skip = async (name: string, d: Design, setup: () => void, reason: string) => {
    reset(); setup();
    const r: any = await capturePreview(d);
    ok(`no preview ${name} (${reason}), and the page was never touched`, !r.ok && r.reason === reason && sent.length === 0, { r, sent });
  };
  await skip('when previews are off', design(), () => { mem.settings = { previews: false }; }, 'off');
  await skip('when the design is switched off', design({ enabled: false }), () => {}, 'not-on');
  await skip('with no active tab', design(), () => { tabs = []; }, 'no-tab');
  await skip('in a private (incognito) window', design(), () => { tabs = [tab({ incognito: true })]; }, 'incognito');
  await skip('on a chrome:// page', design(), () => { tabs = [tab({ url: 'chrome://newtab/' })]; }, 'not-a-website');
  await skip('on a file:// page', design(), () => { tabs = [tab({ url: 'file:///C:/secret.html' })]; }, 'not-a-website');
  await skip('on a different site than the design', design(), () => { tabs = [tab({ url: 'https://news.ycombinator.com/' })]; }, 'not-here');
  await skip('on a page the design does not cover', design({ scope: 'page', path: '/watch' }), () => { tabs = [tab({ url: 'https://www.youtube.com/feed' })]; }, 'not-here');
  await skip('with a malformed address', design(), () => { tabs = [tab({ url: 'not a url' })]; }, 'no-tab');

  reset(); beginReply = { ok: false, maxTextPx: 0, bars: 0, reason: 'too-complex' };
  let r: any = await capturePreview(design());
  ok('a page that is too complex is skipped, nothing is captured, and no restore is needed', !r.ok && r.reason === 'too-complex' && !sent.some((s) => s.type === 'ww:previewEnd'), sent);
  reset(); tabs = [tab()];
  (chrome as any).tabs.sendMessage = async (id: number, m: any) => { sent.push({ id, type: m.type }); if (m.type === 'ww:previewBegin') throw new Error('no content script'); return true; };
  r = await capturePreview(design());
  ok('a page without the content script is skipped cleanly', !r.ok && r.reason === 'page-not-ready');
  (chrome as any).tabs.sendMessage = async (id: number, m: any) => { sent.push({ id, type: m.type }); return m.type === 'ww:previewBegin' ? beginReply : true; };

  reset(); captureImpl = async () => { throw new Error('capture blocked'); };
  r = await capturePreview(design());
  ok('if the capture fails, the page is STILL restored', !r.ok && r.reason === 'capture-failed' && sent.map((s) => s.type).join() === 'ww:previewBegin,ww:previewEnd', sent);
  reset(); captureImpl = async () => { tabs = [tab({ url: 'https://www.youtube.com/other' })]; return 'data:image/png;base64,AAAA'; };
  r = await capturePreview(design());
  ok('if you navigate away during the capture, the result is thrown away', !r.ok && r.reason === 'tab-changed' && sent.at(-1)!.type === 'ww:previewEnd', r);
  reset(); captureImpl = async () => { tabs = [tab({ active: false })]; return 'data:image/png;base64,AAAA'; };
  r = await capturePreview(design());
  ok('if you switch tabs during the capture, the result is thrown away', !r.ok && r.reason === 'tab-changed');
  reset();
  const global = design({ host: '*', scope: 'global' });
  tabs = [tab({ url: 'https://news.ycombinator.com/' })];
  captureImpl = async () => { throw new Error('stop here'); };
  r = await capturePreview(global);
  ok('an all-sites design may be previewed on any website', r.reason === 'capture-failed' && sent[0].type === 'ww:previewBegin');
  reset(); const excl = design({ host: '*', scope: 'global', excludedHosts: ['www.youtube.com'] });
  r = await capturePreview(excl);
  ok('...but not on a site the user switched it off for', !r.ok && r.reason === 'not-here');

  // ---------------------------------------------------------------- storage
  reset();
  mem['site:a.com'] = [{ ...design({ id: 'a1', host: 'a.com' }), thumb: good }, design({ id: 'a2', host: 'a.com' })];
  mem['site:b.com'] = [{ ...design({ id: 'b1', host: 'b.com' }), thumb: good }];
  mem['site:c.com'] = [design({ id: 'c1', host: 'c.com' })];
  const before = JSON.stringify(mem['site:c.com']);
  const n = await clearAllThumbs();
  ok('"Clear all previews" removes every thumbnail and nothing else', n === 2 && !mem['site:a.com'].some((d: any) => 'thumb' in d) && !mem['site:b.com'].some((d: any) => 'thumb' in d) && mem['site:a.com'].length === 2 && mem['site:a.com'][0].name === 'X' && JSON.stringify(mem['site:c.com']) === before, mem);
  ok('clearing twice is harmless', (await clearAllThumbs()) === 0);

  // favicons
  reset();
  const png = 'data:image/png;base64,' + 'iVBORw0KGgo='.repeat(4);
  await saveFavicon('www.youtube.com', png);
  ok('a favicon is saved per host', (await getFavicons())['www.youtube.com'] === png);
  for (const [h, u] of [['bad host!', png], ['x.com', 'data:image/svg+xml;base64,' + 'A'.repeat(50)], ['x.com', 'https://evil.example/x.png'], ['x.com', 'data:image/png;base64,' + 'A'.repeat(30_000)], ['', png]] as const) {
    let threw = false;
    try { await saveFavicon(h, u); } catch { threw = true; }
    ok(`favicon rejected: ${h || '(empty host)'} / ${u.slice(0, 30)}`, threw);
  }
  for (let i = 0; i < 310; i++) await saveFavicon(`s${i}.example.com`, png);
  ok('only the 300 most recent favicons are kept', Object.keys(await getFavicons()).length === 300);

  // descriptor from the model
  ok('descriptor: plain text, one line, short; markup and control characters are removed', cleanDescriptor('Paper textures · Soft colors') === 'Paper textures · Soft colors' && cleanDescriptor('<b>Hi</b>\n there\t· <script>x</script>ok') === 'Hi there · xok' && cleanDescriptor('x'.repeat(200)).length === 40 && cleanDescriptor(5) === '' && cleanDescriptor(null) === '' && cleanDescriptor('   ') === '');

  console.log(fails ? `${fails} FAILED` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL crashed', e?.stack ?? e); process.exit(1); });
