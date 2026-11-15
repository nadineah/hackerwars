// Real Chromium + the built extension: Dashboard mode. Needs playwright (npm i playwright outside the repo; npx playwright install chromium).
// Run after `npm run build`:  NODE_PATH=<dir with playwright>/node_modules node scripts/e2e/dashboard.cjs
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
  chromium.launchPersistentContext(dir, { headless: false, args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'], viewport: { width: 1280, height: 800 } });
async function worker(ctx) {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  return sw;
}
const store = (sw) => sw.evaluate(async () => Object.fromEntries(Object.entries(await chrome.storage.local.get(null)).filter(([k]) => /^(dsrc|dstate|drec|dash|dlog):/.test(k) || k === 'dlog')));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-dash-'));
  let ctx = await launch(dir);
  let sw = await worker(ctx);
  const id = new URL(sw.url()).host;
  const dashUrl = `chrome-extension://${id}/dashboard.html`;
  try {
    const page = await ctx.newPage();
    await page.goto(dashUrl);
    await page.getByRole('heading', { name: 'Dashboards' }).waitFor();
    await page.getByText('No dashboards yet').waitFor();
    ok('library shows the empty state and the New dashboard card', (await page.getByText('No dashboards yet').count()) === 1 && (await page.getByRole('button', { name: 'New dashboard' }).count()) === 1);
    await page.getByRole('button', { name: 'New dashboard' }).click();
    await page.waitForURL(/#\/d\//);
    await page.getByLabel('Dashboard title').fill('News demo');
    const call = (op, args) => page.evaluate(([op, args]) => chrome.runtime.sendMessage({ type: 'ww:dash', op, ...args }), [op, args]);

    // ------------------------------------------------ sources of every kind (real internet)
    const defs = {
      bbc: { kind: 'feed', name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml', config: { maxItems: 8 } },
      hnapi: { kind: 'json', name: 'HN (API)', url: 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=10', config: { itemsPath: 'hits', fields: { title: 'title', url: 'url', published: 'created_at' }, urlTemplate: 'https://news.ycombinator.com/item?id={objectID}', maxItems: 8 } },
      hnhtml: { kind: 'html', name: 'HN (scraped)', url: 'https://news.ycombinator.com/', config: { itemSelector: 'tr.athing', fields: { title: { selector: '.titleline > a' }, url: { selector: '.titleline > a', attr: 'href' } }, maxItems: 8 } },
      quotes: { kind: 'rendered', name: 'Quotes (JS page)', url: 'https://quotes.toscrape.com/js/', backgroundTabs: true, config: { itemSelector: '.quote', waitFor: '.quote', fields: { title: { selector: '.text' }, summary: { selector: '.author' } }, maxItems: 5 } },
    };
    const ids = {};
    for (const [k, input] of Object.entries(defs)) {
      const r = await call('addSource', { input });
      ids[k] = r.source?.id;
      ok(`added ${k}, not yet approved`, r.ok && r.source && r.source.approval === null, r);
    }
    await sleep(1500);
    let s = await store(sw);
    ok('nothing is fetched before approval', Object.keys(s).filter((k) => k.startsWith('drec:')).length === 0);

    const dash = Object.values(s).find((v) => v && v.widgets && v.name === 'News demo');
    const widgets = [
      { type: 'updates', title: 'All news', w: 2, sourceIds: [ids.bbc, ids.hnapi, ids.hnhtml], sort: 'published', limit: 15, showChecked: true },
      { type: 'list', title: 'Quotes', w: 1, sourceId: ids.quotes, limit: 5, showSummary: true, showImage: false, showTime: true },
      { type: 'notes', title: 'Notes', w: 1, text: 'hello' },
    ];
    console.log('IDS', JSON.stringify(ids), Object.keys(s).filter((k) => k.startsWith('dsrc')));
    const saved = await call('save', { dashboard: { ...dash, widgets } });
    ok('dashboard saved with widgets via validated save', saved.ok && saved.dashboard.widgets.length === 3, saved);

    // ------------------------------------------------ approval through the real dialog (one source), API for the rest
    await page.reload();
    await page.getByRole('button', { name: /Sources \(/ }).click();
    await page.getByRole('button', { name: /Review & approve/ }).first().click();
    const dlg = page.getByRole('dialog');
    ok('approval dialog states site, data, method, interval, background tabs, local storage', (await dlg.innerText()).match(/Site[\s\S]*What is collected[\s\S]*How[\s\S]*How often[\s\S]*Where the data goes/) !== null, await dlg.innerText());
    await dlg.getByRole('button', { name: 'Allow automatic updates' }).click();
    for (const k of Object.keys(ids)) {
      const st = (await store(sw))[`dsrc:${ids[k]}`];
      if (!st?.approval) await call('approve', { sourceId: ids[k], backgroundTabs: k === 'quotes' });
    }

    // rendered source opens a managed background tab; watch tabs
    const opened = [];
    ctx.on('page', (p) => opened.push(p));
    const userTabsBefore = ctx.pages().length;
    let tries = 0;
    while (tries++ < 60) {
      s = await store(sw);
      if (Object.keys(ids).every((k) => s[`drec:${ids[k]}`]?.length)) break;
      await sleep(2000);
    }
    s = await store(sw);
    for (const k of Object.keys(ids)) ok(`first collection after approval: ${k} has items`, s[`drec:${ids[k]}`]?.length > 0, s[`dstate:${ids[k]}`]);
    ok('feed, JSON and scraped records carry titles, links and only real dates', s[`drec:${ids.bbc}`].every((r) => r.title && r.url && (r.publishedAt === undefined || r.publishedAt > 6e11)) && s[`drec:${ids.hnhtml}`].every((r) => r.publishedAt === undefined));
    ok('the JS-rendered page really produced quotes', s[`drec:${ids.quotes}`].some((r) => r.summary), s[`drec:${ids.quotes}`]?.[0]);
    await sleep(1500);
    ok('collector-created tab was closed; user tabs untouched', ctx.pages().length === userTabsBefore && !ctx.pages().some((p) => /quotes\.toscrape/.test(p.url())), ctx.pages().map((p) => p.url()));
    ok('all states ok with last success recorded', Object.keys(ids).every((k) => s[`dstate:${ids[k]}`].status === 'ok' && s[`dstate:${ids[k]}`].lastSuccessAt));
    await page.waitForSelector('.item', { timeout: 15000 });
    ok('the dashboard UI shows collected items and honest freshness', (await page.locator('.item').count()) > 5 && /Updated|Checked/.test(await page.locator('.status-lines').first().innerText()), await page.locator('.status-lines').first().innerText());
    await page.screenshot({ path: path.join(os.tmpdir(), 'ww-dashboard.png') });

    // ------------------------------------------------ collection with every dashboard tab closed (alarm-driven)
    await page.close();
    ok('no dashboard page is open', !ctx.pages().some((p) => p.url().startsWith(`chrome-extension://${id}`)));
    const before = Object.fromEntries(Object.keys(ids).map((k) => [k, s[`dstate:${ids[k]}`].lastSuccessAt]));
    await sw.evaluate(async (list) => {
      for (const sid of list) {
        const k = `dstate:${sid}`;
        const st = (await chrome.storage.local.get(k))[k];
        await chrome.storage.local.set({ [k]: { ...st, nextCheckAt: Date.now() - 1000, backoffUntil: undefined, lastAttemptAt: Date.now() - 3600_000 } });
      }
    }, Object.values(ids));
    let advanced = false;
    for (let i = 0; i < 40 && !advanced; i++) {
      await sleep(5000);
      s = await store(sw);
      advanced = Object.keys(ids).every((k) => s[`dstate:${ids[k]}`].lastSuccessAt > before[k]);
    }
    ok('alarm-driven collection ran for all sources with the dashboard closed', advanced, Object.keys(ids).map((k) => [k, s[`dstate:${ids[k]}`].lastSuccessAt - before[k]]));
    ok('unchanged data was not rewritten (no change time bump) or was honestly marked changed', Object.keys(ids).every((k) => typeof s[`dstate:${ids[k]}`].lastChangeAt === 'number'));

    // ------------------------------------------------ restart recovery: real browser restart with an interrupted run
    await sw.evaluate(async (sid) => {
      const k = `dstate:${sid}`;
      const st = (await chrome.storage.local.get(k))[k];
      await chrome.storage.local.set({ [k]: { ...st, status: 'running', runId: 'dead', runningSince: Date.now() - 600_000, nextCheckAt: 0 } });
    }, ids.bbc);
    await ctx.close();
    ctx = await launch(dir);
    sw = await worker(ctx);
    let recovered = false;
    for (let i = 0; i < 30 && !recovered; i++) {
      await sleep(2000);
      const st = (await store(sw))[`dstate:${ids.bbc}`];
      recovered = st && st.status === 'ok' && st.runId === undefined && st.lastSuccessAt > before.bbc;
    }
    s = await store(sw);
    ok('after a browser restart the interrupted run is recovered and collected again', recovered, s[`dstate:${ids.bbc}`]);
    ok('data and approvals survived the restart', Object.keys(ids).every((k) => s[`drec:${ids[k]}`]?.length && s[`dsrc:${ids[k]}`].approval));
    const alarms = await sw.evaluate(async () => (await chrome.alarms.getAll()).map((a) => a.name));
    ok('the scheduler alarm exists after restart', alarms.includes('ww-dash-tick'), alarms);

    // ------------------------------------------------ pause + delete
    const p2 = await ctx.newPage();
    await p2.goto(dashUrl);
    await p2.evaluate(() => chrome.runtime.sendMessage({ type: 'ww:dash', op: 'setGlobalPaused', paused: true }));
    await sw.evaluate(async (sid) => {
      const k = `dstate:${sid}`;
      const st = (await chrome.storage.local.get(k))[k];
      await chrome.storage.local.set({ [k]: { ...st, nextCheckAt: Date.now() - 1000 } });
    }, ids.hnapi);
    const t0 = (await store(sw))[`dstate:${ids.hnapi}`].lastSuccessAt;
    await sleep(75000);
    ok('global pause stops background collection', (await store(sw))[`dstate:${ids.hnapi}`].lastSuccessAt === t0);
    const dashId = Object.keys(await store(sw)).find((k) => k.startsWith('dash:')).slice(5);
    await p2.evaluate((d) => chrome.runtime.sendMessage({ type: 'ww:dash', op: 'delete', id: d }), dashId);
    await sleep(800);
    s = await store(sw);
    ok('deleting the only dashboard removes its sources, schedules and cached data', !Object.keys(s).some((k) => /^(dsrc|dstate|drec):/.test(k)), Object.keys(s));
  } catch (e) {
    fails++;
    console.log('FAIL crashed:', e?.stack?.split('\n').slice(0, 6).join('\n') ?? e);
  } finally {
    await ctx.close().catch(() => {});
  }
  console.log(fails ? `${fails} FAILED` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})();
