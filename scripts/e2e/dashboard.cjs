// Real Chromium + the built extension: Dashboard mode v2 (AI-written page + collect scripts in a sandbox).
// The AI provider is stubbed (no API key needed); everything else is real, including the websites.
// Needs playwright (npm i playwright outside the repo; npx playwright install chromium). Run after `npm run build`:
//   NODE_PATH=<dir with playwright>/node_modules node scripts/e2e/dashboard.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EXT = path.resolve(__dirname, '../../dist');
let fails = 0;
const ok = (name, cond, extra) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra)?.slice(0, 500));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const launch = (dir) =>
  chromium.launchPersistentContext(dir, { headless: false, args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'], viewport: { width: 1280, height: 900 } });
async function worker(ctx) {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  return sw;
}
const store = (sw) => sw.evaluate(async () => Object.fromEntries(Object.entries(await chrome.storage.local.get(null)).filter(([k]) => /^(dash|dstate|ddata|dkv|dlog)/.test(k))));

// What the "assistant" writes. Real scripts, against real sites.
const PROPOSAL = {
  reply: 'Here is a news dashboard: Hacker News (API and scraped page), BBC, and a JavaScript-rendered quotes page.',
  name: 'News demo',
  domains: ['hn.algolia.com', 'news.ycombinator.com', 'feeds.bbci.co.uk', 'quotes.toscrape.com'],
  intervalMinutes: 30,
  backgroundTabs: true,
  html: '<main><header><h1>News demo</h1><p id="status">Waiting for the first update…</p><button id="refresh">Refresh</button></header><section><h2>Hacker News</h2><ul id="hn"></ul></section><section><h2>BBC</h2><ul id="bbc"></ul></section><section><h2>Scraped HN</h2><ul id="hnhtml"></ul></section><section><h2>Quotes (needs JavaScript)</h2><ul id="quotes"></ul></section><section><h2>Notes</h2><textarea id="note" rows="3"></textarea></section><pre id="probe"></pre></main>',
  css: 'body{font-family:system-ui;margin:0;padding:16px;background:#fff;color:#111}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}ul{padding-left:18px}h1{margin:0}',
  js: `
    const fill = (id, items) => { const ul = document.getElementById(id); ul.textContent = ''; for (const it of items || []) { const li = document.createElement('li'); const a = document.createElement(it.url ? 'a' : 'span'); a.textContent = it.title; if (it.url && /^https?:/.test(it.url)) { a.href = it.url; a.target = '_blank'; a.rel = 'noopener'; } li.append(a); ul.append(li); } };
    ww.onData((d, at) => { fill('hn', d.hn); fill('bbc', d.bbc); fill('hnhtml', d.hnhtml); fill('quotes', d.quotes); document.getElementById('status').textContent = 'Updated ' + new Date(at).toLocaleTimeString(); });
    document.getElementById('refresh').onclick = () => ww.refresh();
    const note = document.getElementById('note');
    note.value = (await ww.store.get('note')) || '';
    note.oninput = () => ww.store.set('note', note.value);
    // Probes: what can this page do on its own?
    let net = 'blocked'; try { await fetch('https://example.com/'); net = 'REACHED'; } catch (e) { net = 'blocked'; }
    document.getElementById('probe').textContent = 'direct-network:' + net + ' chrome-api:' + (typeof chrome === 'object' && chrome && (chrome.runtime && chrome.runtime.id || chrome.storage) ? 'AVAILABLE' : 'undefined');
  `,
  collect: `
    const out = {};
    out.hn = (await ww.fetchJson('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=8')).hits.map((h) => ({ title: h.title, url: h.url || 'https://news.ycombinator.com/item?id=' + h.objectID }));
    out.bbc = ww.feed(await ww.fetchText('https://feeds.bbci.co.uk/news/rss.xml'), 'https://feeds.bbci.co.uk/', 8).items.map((i) => ({ title: i.title, url: i.url }));
    const doc = ww.parseHTML(await ww.fetchText('https://news.ycombinator.com/'));
    out.hnhtml = [...doc.querySelectorAll('tr.athing .titleline > a')].slice(0, 8).map((a) => ({ title: a.textContent, url: a.getAttribute('href') }));
    const page = await ww.render('https://quotes.toscrape.com/js/', { waitFor: '.quote', waitMs: 8000 });
    out.quotes = [...page.doc.querySelectorAll('.quote')].slice(0, 5).map((q) => ({ title: q.querySelector('.text').textContent + ' — ' + q.querySelector('.author').textContent }));
    return out;
  `,
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-dash-'));
  let ctx = await launch(dir);
  let sw = await worker(ctx);
  const id = new URL(sw.url()).host;
  const dashUrl = `chrome-extension://${id}/dashboard.html`;
  try {
    await sw.evaluate(() => chrome.storage.local.set({ settings: { apiKey: 'sk-ant-stub', openaiKey: '', model: 'claude-sonnet-5-5', theme: 'default' } }));
    // Round 1: the assistant asks to LOOK AT a page itself; round 2: it writes the dashboard. The stub records what it was shown.
    await sw.evaluate((input) => {
      const real = self.fetch;
      self.__calls = [];
      self.fetch = async (u, init) => {
        if (!String(u).includes('api.anthropic.com')) return real(u, init);
        const body = JSON.parse(init.body);
        self.__calls.push(JSON.stringify(body.messages).slice(-6000));
        const first = self.__calls.length === 1;
        const out = first ? { reply: 'Let me look at the page first.', inspect: ['https://news.ycombinator.com/', 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=1'] } : input;
        return new Response(JSON.stringify({ content: [{ type: 'tool_use', input: out }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
      };
    }, PROPOSAL);

    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(dashUrl);
    await page.getByRole('heading', { name: 'Dashboards' }).waitFor();
    await page.getByText('No dashboards yet').waitFor();
    ok('library shows the empty state and the New dashboard card', (await page.getByRole('button', { name: 'New dashboard' }).count()) === 1);
    await page.getByRole('button', { name: 'New dashboard' }).click();
    await page.waitForURL(/#\/d\//);
    await page.getByRole('heading', { name: 'An empty dashboard' }).waitFor();
    ok('a new dashboard is an empty canvas for the assistant (no preset widgets)', (await page.getByRole('button', { name: /Add widget/ }).count()) === 0);

    // ------------------------------------------------ the assistant writes the page
    await page.getByLabel('Message to the assistant').fill('Make me a news dashboard');
    await page.getByRole('button', { name: 'Send' }).click();
    ok('the message box clears immediately when sent, and the message shows in the chat', (await page.getByLabel('Message to the assistant').inputValue()) === '' && (await page.locator('.turn.user .bubble', { hasText: 'Make me a news dashboard' }).count()) === 1);
    const dlg = page.getByRole('dialog');
    await dlg.waitFor({ timeout: 20000 });
    const text = await dlg.innerText();
    ok('before anything is fetched, an approval dialog lists every site, interval, background tabs and local storage', ['hn.algolia.com', 'news.ycombinator.com', 'feeds.bbci.co.uk', 'quotes.toscrape.com', 'Every 30 minutes', 'Background tabs', 'stays in this browser'].every((t) => text.includes(t)), text);
    const seen = await sw.evaluate(() => self.__calls);
    ok('the assistant looked at the pages itself, with no permission step: it was shown their structure and a text sample', seen.length === 2 && /page_outline/.test(seen[1]) && /athing|titleline/.test(seen[1]) && /JSON response/.test(seen[1]), seen.map((x) => x.length));
    ok('the chat says which pages it looked at', (await page.locator('.notes-list').innerText()).includes('Looked at: https://news.ycombinator.com/'));
    let s = await store(sw);
    ok('nothing was collected before approval', !Object.keys(s).some((k) => k.startsWith('ddata:')));
    await dlg.getByText('Read the script that will run').click();
    ok('the user can read the exact script that will run', /ww\.fetchJson/.test(await dlg.locator('pre.code').innerText()));
    await dlg.getByRole('button', { name: 'Allow automatic updates' }).click();

    const frame = page.frameLocator('iframe.preview-frame');
    await frame.locator('h1').waitFor({ timeout: 20000 });
    ok('the AI-written HTML/CSS/JS page is shown', (await frame.locator('h1').innerText()) === 'News demo');
    let tries = 0;
    while (tries++ < 60) {
      s = await store(sw);
      if (Object.keys(s).some((k) => k.startsWith('ddata:'))) break;
      await sleep(2000);
    }
    const dashId = Object.keys(s).find((k) => k.startsWith('dash:')).slice(5);
    const data = s[`ddata:${dashId}`]?.value;
    ok('the collect script ran and returned data from all four kinds of source', data && data.hn?.length > 0 && data.bbc?.length > 0 && data.hnhtml?.length > 0 && data.quotes?.length > 0, data && Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v?.length])));
    await frame.locator('#quotes li').first().waitFor({ timeout: 15000 });
    ok('the page rendered the collected items itself (HN API, BBC feed, scraped HN, JS-rendered page)', (await frame.locator('#hn li').count()) > 0 && (await frame.locator('#bbc li').count()) > 0 && (await frame.locator('#hnhtml li').count()) > 0 && (await frame.locator('#quotes li').count()) > 0);
    ok('it shows when it was updated, from the real collection time', /^Updated /.test(await frame.locator('#status').innerText()));
    await sleep(1500);
    ok('the managed background tab was closed; no stray tabs', !ctx.pages().some((p) => /quotes\.toscrape/.test(p.url())));
    const probe = await frame.locator('#probe').innerText();
    ok('SANDBOX: the page cannot reach the network itself and has no extension APIs', /direct-network:blocked/.test(probe) && /chrome-api:undefined/.test(probe), probe);
    await page.screenshot({ path: path.join(os.tmpdir(), 'ww-dashboard-v2.png') });

    // notes persist through the bridge
    await frame.locator('#note').fill('remember this');
    await sleep(800);
    ok('the page can keep its own notes (saved by the extension, per dashboard)', (await store(sw))[`dkv:${dashId}`]?.note === 'remember this');

    // refresh button inside the page goes through the extension
    await sw.evaluate(async (k) => { const st = (await chrome.storage.local.get(k))[k]; await chrome.storage.local.set({ [k]: { ...st, lastAttemptAt: Date.now() - 3600_000 } }); }, `dstate:${dashId}`);
    await frame.locator('#refresh').click();
    let refreshed = false;
    for (let i = 0; i < 40 && !refreshed; i++) { await sleep(2000); refreshed = (await store(sw))[`dstate:${dashId}`].lastAttemptAt > Date.now() - 600_000; }
    ok('the page Refresh button makes the extension run the collect script', refreshed);

    // a script cannot read a site the user did not approve
    await page.getByRole('button', { name: 'Code' }).click();
    await page.getByRole('tab', { name: 'Collect' }).click();
    await page.getByLabel('collect code').fill("const r = await ww.fetchText('https://example.org/'); return { r };");
    await page.getByRole('button', { name: 'Apply changes' }).click();
    await sleep(1500);
    await sw.evaluate(async (k) => { const st = (await chrome.storage.local.get(k))[k]; await chrome.storage.local.set({ [k]: { ...st, lastAttemptAt: Date.now() - 3600_000, status: 'ok' } }); }, `dstate:${dashId}`);
    await page.getByRole('button', { name: /Refresh now/ }).click();
    let st2;
    for (let i = 0; i < 30; i++) { await sleep(1500); st2 = (await store(sw))[`dstate:${dashId}`]; if (st2.status === 'needs-approval') break; }
    ok('a collect script that reads an unapproved site is stopped and the user is told, not trusted', st2.status === 'needs-approval' && /not been approved/.test(st2.lastError), st2);
    await page.getByLabel('collect code').fill(PROPOSAL.collect);
    await page.getByRole('button', { name: 'Apply changes' }).click();
    await sleep(1500);

    // ------------------------------------------------ collection with every dashboard tab closed (alarm-driven)
    await page.close();
    ok('no dashboard page is open', !ctx.pages().some((p) => p.url().startsWith(`chrome-extension://${id}`)));
    const t0 = (await store(sw))[`dstate:${dashId}`].lastSuccessAt;
    await sw.evaluate(async (k) => { const st = (await chrome.storage.local.get(k))[k]; await chrome.storage.local.set({ [k]: { ...st, status: 'idle', nextCheckAt: Date.now() - 1000, backoffUntil: undefined, lastError: undefined, lastAttemptAt: Date.now() - 3600_000 } }); }, `dstate:${dashId}`);
    let advanced = false;
    for (let i = 0; i < 40 && !advanced; i++) { await sleep(5000); advanced = ((await store(sw))[`dstate:${dashId}`].lastSuccessAt ?? 0) > (t0 ?? 0); }
    ok('the alarm ran the collect script with the dashboard closed', advanced);

    // ------------------------------------------------ restart recovery
    await sw.evaluate(async (k) => { const st = (await chrome.storage.local.get(k))[k]; await chrome.storage.local.set({ [k]: { ...st, status: 'running', runId: 'dead', runningSince: Date.now() - 600_000, nextCheckAt: 0 } }); }, `dstate:${dashId}`);
    const t1 = (await store(sw))[`dstate:${dashId}`].lastSuccessAt;
    await ctx.close();
    ctx = await launch(dir);
    sw = await worker(ctx);
    let recovered = false;
    for (let i = 0; i < 40 && !recovered; i++) { await sleep(2000); const x = (await store(sw))[`dstate:${dashId}`]; recovered = x && x.status === 'ok' && x.runId === undefined && x.lastSuccessAt > t1; }
    ok('after a real browser restart the interrupted run is recovered and collected again', recovered, (await store(sw))[`dstate:${dashId}`]);
    ok('the scheduler alarm exists after restart', (await sw.evaluate(async () => (await chrome.alarms.getAll()).map((a) => a.name))).includes('ww-dash-tick'));
    const data2 = (await store(sw))[`ddata:${dashId}`];
    ok('data, notes and approval survived the restart', data2?.value?.hn?.length > 0 && (await store(sw))[`dkv:${dashId}`]?.note === 'remember this' && (await store(sw))[`dash:${dashId}`].approval.domains.length === 4);

    // ------------------------------------------------ pause + delete
    const p2 = await ctx.newPage();
    await p2.goto(dashUrl);
    await p2.evaluate(() => chrome.runtime.sendMessage({ type: 'ww:dash', op: 'setGlobalPaused', paused: true }));
    await sw.evaluate(async (k) => { const st = (await chrome.storage.local.get(k))[k]; await chrome.storage.local.set({ [k]: { ...st, nextCheckAt: Date.now() - 1000 } }); }, `dstate:${dashId}`);
    const t2 = (await store(sw))[`dstate:${dashId}`].lastSuccessAt;
    await sleep(75000);
    ok('global pause stops background collection', (await store(sw))[`dstate:${dashId}`].lastSuccessAt === t2);
    await p2.evaluate((d) => chrome.runtime.sendMessage({ type: 'ww:dash', op: 'delete', id: d }), dashId);
    await sleep(800);
    ok('deleting the dashboard removes its schedule, data, notes and itself', !Object.keys(await store(sw)).some((k) => k.endsWith(dashId)), Object.keys(await store(sw)));
    ok('no page errors were thrown by the dashboard UI', pageErrors.length === 0, pageErrors);
  } catch (e) {
    fails++;
    console.log('FAIL crashed:', e?.stack?.split('\n').slice(0, 6).join('\n') ?? e);
  } finally {
    await ctx.close().catch(() => {});
  }
  console.log(fails ? `${fails} FAILED` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})();
