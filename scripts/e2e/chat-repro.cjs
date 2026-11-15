// Reproduces the assistant flow in real Chromium with a stubbed provider reply, and reports page errors.
const { chromium } = require('playwright');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const EXT = path.resolve(__dirname, '../../dist');
const PROPOSAL = {
  reply: 'Added sources.',
  sources: [
    { key: 'hn', kind: 'json', name: 'HN', url: 'https://hn.algolia.com/api/v1/search?tags=front_page', config: { itemsPath: 'hits', fields: { title: 'title', url: 'url' }, maxItems: 8 } },
    { key: 'bbc', kind: 'feed', url: 'https://feeds.bbci.co.uk/news/rss.xml', config: {} },
    { key: 'pg', kind: 'page-change', url: 'https://example.com/', config: { selector: 'h1', via: 'rendered' }, backgroundTabs: true },
    { key: 'sp', kind: 'rendered', url: 'https://quotes.toscrape.com/js/', config: { itemSelector: '.quote', fields: { title: { selector: '.text' } } }, backgroundTabs: true },
    { key: 'ht', kind: 'html', url: 'https://news.ycombinator.com/', config: { itemSelector: 'tr.athing', fields: { title: { selector: '.titleline > a' } } } },
  ],
  widgets: [
    { type: 'updates', title: 'All', sourceRefs: ['hn', 'bbc', 'ht'] },
    { type: 'page-change', sourceRefs: ['pg'] },
    { type: 'list', sourceRefs: ['sp'] },
    { type: 'notes' },
  ],
};
(async () => {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'ww-chat-')), { headless: false, args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  await sw.evaluate(() => chrome.storage.local.set({ settings: { apiKey: 'sk-ant-fake', openaiKey: '', model: 'claude-sonnet-5-5', theme: 'default' } }));
  await sw.evaluate((input) => {
    const real = self.fetch;
    self.fetch = async (u, init) => (String(u).includes('api.anthropic.com') ? new Response(JSON.stringify({ content: [{ type: 'tool_use', input }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 }) : real(u, init));
  }, PROPOSAL);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message, (e.stack || '').split('\n').slice(0, 5).join(' | ')));
  await page.goto(`chrome-extension://${id}/dashboard.html`);
  await page.getByRole('button', { name: 'New dashboard' }).click();
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await page.getByLabel('Message to the assistant').fill('Show news');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.waitForTimeout(4000);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click().catch(() => {});
  await page.keyboard.press('Escape');
  await page.getByLabel('Message to the assistant').fill('and remove the notes');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.waitForTimeout(3000);
  console.log('BODY:', JSON.stringify((await page.locator('body').innerText()).slice(0, 200)), 'dialog:', await page.getByRole('dialog').count());
  await ctx.close();
})();
