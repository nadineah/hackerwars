// Real Chromium + the extension (test build with the worker hook): blurred design previews.
// Build first:  WW_OUTDIR=dist-e2e WHIMSYWEB_E2E=1 node build.mjs
// Run:          NODE_PATH=<dir with playwright>/node_modules node scripts/e2e/previews.cjs
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('../../web/node_modules/sharp');

const EXT = path.resolve(__dirname, '../../dist-e2e');
const OUT = process.env.PREVIEW_OUT || path.join(os.tmpdir(), 'ww-previews');
fs.mkdirSync(OUT, { recursive: true });
let fails = 0;
const ok = (name, cond, extra) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra)?.slice(0, 400));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A page full of things that must NOT survive: private text, a big headline, text baked into images, text in a canvas,
// shadow DOM text, a form with values, an iframe, a background image with text, and a themed look.
const svgImg = (bg, text) => 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="${bg}"/><text x="40" y="170" font-size="52" font-family="Arial" fill="#222">${text}</text></svg>`);
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title><style>
body{margin:0;font-family:Georgia,serif;background:#fdf6ec;color:#3b2f3f}
header{background:#e9d5ff;padding:14px 24px;display:flex;gap:16px;align-items:center}
h1{font-size:64px;margin:12px 24px}
.wrap{display:flex;gap:20px;padding:0 24px}
.card{background:#fff;border:2px solid #d8b4fe;border-radius:16px;padding:14px;flex:1}
.bgimg{height:120px;border-radius:12px;background-size:cover}
</style></head><body>
<header><svg width="20" height="20"><circle cx="10" cy="10" r="8" fill="#7c3aed"/></svg><b>My Private Bank Portal</b><span>jane.doe@example.com</span></header>
<h1>Welcome back, Jane Doe</h1>
<div class="wrap">
  <div class="card"><p>Account 4412-9980-1123 balance $48,210.55</p><img id="img1" src="${svgImg('#bfdbfe', 'Room 12 Lincoln Elementary')}" width="300"><p>Home: 482 Maple Street</p></div>
  <div class="card"><canvas id="cv" width="300" height="80"></canvas><div id="host"></div><div id="host2"></div><form><input id="name" value="Emma Johnson SSN 123-45-6789"><input id="pw" type="password" value="hunter2hunter2"></form><div class="bgimg" style="background-image:url('${svgImg('#fde68a', 'Secret Project Falcon')}')"></div><iframe id="fr" width="280" height="90" srcdoc="<body style='font-size:22px'>Confidential frame text 999-00-1234</body>"></iframe></div>
</div>
<script>
const c=document.getElementById('cv').getContext('2d');c.fillStyle='#fef3c7';c.fillRect(0,0,300,80);c.fillStyle='#111';c.font='28px Arial';c.fillText('Canvas: Dr. Smith 555-0199',8,48);
const sr2=document.getElementById('host2').attachShadow({mode:'closed'});sr2.innerHTML='<p style="font-size:96px;margin:0;color:#111">Acct 4412</p>';
const sr=document.getElementById('host').attachShadow({mode:'open'});sr.innerHTML='<p style="font-size:20px;color:#7c2d12">Shadow DOM: password reset code 884213</p>';
</script></body></html>`;

(async () => {
  const server = http.createServer((req, res) => (res.writeHead(200, { 'content-type': 'text/html' }), res.end(PAGE)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}/`;

  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'ww-prev-')), {
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
    viewport: { width: 1280, height: 800 },
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  try {
    // The worker can be stopped and restarted by Chrome between calls; re-find it and retry instead of failing on a stale handle.
    const evalSw = async (fn, arg) => {
      for (let i = 0; i < 6; i++) {
        try {
          return await sw.evaluate(fn, arg);
        } catch (e) {
          await sleep(400);
          sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 8000 }).catch(() => sw));
          if (i === 5) throw e;
        }
      }
    };
    const mutate = (m) => evalSw((m) => self.__ww.mutate({ type: 'ww:mutate', ...m }), m);
    const now = Date.now();
    const design = { id: 'p1', host: 'localhost', scope: 'site', name: 'Lilac Test', prompt: 'x', css: 'body{background:#f3e8ff !important} header{background:#c084fc !important}', ops: [], enabled: true, createdAt: now, updatedAt: now };
    await evalSw((d) => chrome.storage.local.set({ 'site:localhost': [d], settings: { apiKey: '', openaiKey: '', model: 'claude-sonnet-5-5', theme: 'light', previews: true } }), design);

    const page = await ctx.newPage();
    await page.goto(base);
    await page.waitForTimeout(1500);
    ok('the design is applied to the page first', (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(243, 232, 255)');

    // ---------------------------------------------------------------- the page is restored exactly
    const snapshot = () => page.evaluate(() => ({
      html: document.documentElement.outerHTML.replace(/ style=""/g, ''),
      imgFilter: getComputedStyle(document.getElementById('img1')).filter,
      bgFilter: getComputedStyle(document.querySelector('.bgimg')).filter,
      frFilter: getComputedStyle(document.getElementById('fr')).filter,
      textColor: getComputedStyle(document.querySelector('h1')).color,
      markers: document.querySelectorAll('[data-ww-preview]').length,
    }));
    const before = await snapshot();
    const r = await mutate({ host: 'localhost', action: 'capturePreview', id: 'p1' });
    ok('a preview was saved', r.preview === 'saved', r);
    const after = await snapshot();
    ok('the page is restored: no leftover overlay or style, no changed filters, text colour back', after.markers === 0 && after.imgFilter === before.imgFilter && after.bgFilter === before.bgFilter && after.frFilter === before.frFilter && after.textColor === before.textColor, { before, after });
    let i = 0;
    while (i < before.html.length && before.html[i] === after.html[i]) i++;
    ok('the page markup is identical after the preview (apart from empty style attributes)', before.html === after.html, { at: i, before: before.html.slice(Math.max(0, i - 60), i + 100), after: after.html.slice(Math.max(0, i - 60), i + 100) });

    // ---------------------------------------------------------------- what was stored
    const stored = (await evalSw(() => chrome.storage.local.get('site:localhost')))['site:localhost'][0];
    ok('the preview is a small image, stored on the design', typeof stored.thumb === 'string' && /^data:image\/webp;base64,/.test(stored.thumb) && stored.thumb.length < 44_000, stored.thumb?.length);
    const buf = Buffer.from(stored.thumb.split(',')[1], 'base64');
    const meta = await sharp(buf).metadata();
    ok('it is 240x135', meta.width === 240 && meta.height === 135, meta);
    fs.writeFileSync(path.join(OUT, 'preview-final.webp'), buf);
    await sharp(buf).png().toFile(path.join(OUT, 'preview-final.png'));
    // The page's header band is lilac (#c084fc): the top rows of the preview should still be clearly purple-ish.
    const top = (await sharp(buf).extract({ left: 0, top: 0, width: 240, height: 3 }).resize(1, 1).raw().toBuffer({ resolveWithObject: true })).data;
    ok('it keeps the design colours (the lilac header band is still lilac: blue well above green)', top[2] > top[1] + 25 && top[0] > top[1], [...top]);

    // What the page looked like DURING the capture (for the report): skeletonise, screenshot, restore.
    const metrics = await evalSw(async () => { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); return chrome.tabs.sendMessage(t.id, { type: 'ww:previewBegin' }); });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(OUT, 'during-skeleton.png') });
    await evalSw(async () => { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); return chrome.tabs.sendMessage(t.id, { type: 'ww:previewEnd' }); });
    ok('the skeleton pass reported the largest text (the 96px text inside a CLOSED shadow root counts, not just the 64px headline)', metrics.ok && metrics.maxTextPx >= 95 && metrics.bars > 5, metrics);
    await page.screenshot({ path: path.join(OUT, 'page-normal.png') });
    ok('...and ended with the page back to normal', (await snapshot()).markers === 0);


    // ---------------------------------------------------------------- the rules
    await evalSw(() => chrome.storage.local.set({ settings: { apiKey: '', openaiKey: '', model: 'claude-sonnet-5-5', theme: 'light', previews: false } }));
    let r2 = await mutate({ host: 'localhost', action: 'capturePreview', id: 'p1' });
    ok('with previews switched off, nothing is captured and the page is untouched', r2.preview === 'skipped' && r2.reason === 'off' && (await snapshot()).markers === 0, r2);
    await evalSw(() => chrome.storage.local.set({ settings: { apiKey: '', openaiKey: '', model: 'claude-sonnet-5-5', theme: 'light', previews: true } }));
    const n = await mutate({ host: 'localhost', action: 'clearThumbs' });
    ok('"Clear all previews" removes it', n.cleared === 1 && !(await evalSw(() => chrome.storage.local.get('site:localhost')))['site:localhost'][0].thumb, n);
    await evalSw(() => chrome.storage.local.get('site:localhost').then((r) => chrome.storage.local.set({ 'site:localhost': r['site:localhost'].map((d) => ({ ...d, enabled: false })) })));
    r2 = await mutate({ host: 'localhost', action: 'capturePreview', id: 'p1' });
    ok('a design that is switched off gets no preview', r2.reason === 'not-on', r2);

    // ---------------------------------------------------------------- is anything readable left?
    // Re-enable, take a fresh preview, and measure how much fine detail the stored image has: a readable-text image would have
    // lots of high-frequency energy; the preview should be smooth. (Visual check: preview-final.png.)
    await evalSw(() => chrome.storage.local.get('site:localhost').then((r) => chrome.storage.local.set({ 'site:localhost': r['site:localhost'].map((d) => ({ ...d, enabled: true })) })));
    await page.waitForTimeout(800);
    await mutate({ host: 'localhost', action: 'capturePreview', id: 'p1' });
    const t2 = (await evalSw(() => chrome.storage.local.get('site:localhost')))['site:localhost'][0].thumb;
    const raw = await sharp(Buffer.from(t2.split(',')[1], 'base64')).greyscale().raw().toBuffer({ resolveWithObject: true });
    const { width: W, height: H } = raw.info;
    let diff = 0, cnt = 0;
    for (let y = 0; y < H; y++) for (let x = 1; x < W; x++) { diff += Math.abs(raw.data[y * W + x] - raw.data[y * W + x - 1]); cnt++; }
    const orig = await sharp(path.join(OUT, 'page-normal.png')).resize(240, 135, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
    let diff0 = 0, cnt0 = 0;
    for (let y = 0; y < 135; y++) for (let x = 1; x < 240; x++) { diff0 += Math.abs(orig.data[y * 240 + x] - orig.data[y * 240 + x - 1]); cnt0++; }
    console.log('mean neighbour-pixel difference: preview', (diff / cnt).toFixed(2), ' plain downscale of the raw screenshot', (diff0 / cnt0).toFixed(2));
    ok('the preview carries far less fine detail than a plain screenshot of the same size', diff / cnt < 6, diff / cnt);
  } catch (e) {
    fails++;
    console.log('FAIL crashed:', e?.stack?.split('\n').slice(0, 6).join('\n') ?? e);
  } finally {
    await ctx.close().catch(() => {});
    server.close();
  }
  console.log(`images in ${OUT}`);
  console.log(fails ? `${fails} FAILED` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})();
