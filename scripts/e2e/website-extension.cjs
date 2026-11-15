// End-to-end: real Chromium + the built extension + the website (next dev). Needs: npm i playwright (outside the repo) and npx playwright install chromium; run npm run build first. Edit ROOT below.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = 'C:/dev/whimsyweb';
const EXT = path.join(ROOT, 'dist');
const WEB = path.join(ROOT, 'web');
const SITE = 'http://localhost:3000';
let fails = 0;
const ok = (name, cond, extra) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra)?.slice(0, 400));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-e2e-'));
  const ctx = await chromium.launchPersistentContext(userData, {
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
    viewport: { width: 1280, height: 800 },
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;
  console.log('extension id', extId);

  const env = { ...process.env, DATA_DIR: path.join(WEB, 'data-e2e'), EXTENSION_IDS: extId, SITE_URL: SITE, MODERATOR_EMAILS: 'mod@example.com', NODE_ENV: 'development' };
  const server = spawn(process.execPath, [path.join(WEB, 'node_modules/next/dist/bin/next'), 'dev', '-p', '3000'], { cwd: WEB, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const stop = async () => {
    server.kill();
    await ctx.close().catch(() => {});
  };
  try {
    for (let i = 0; i < 60 && !/Ready in|ready/.test(log); i++) await sleep(1000);
    ok('website started', /Ready in|ready/.test(log), log.slice(-300));

    // ---------------------------------------------------------------- discovery
    const page = await ctx.newPage();
    await page.goto(`${SITE}/explore`, { timeout: 60000 });
    const cards = await page.locator('.theme-card').count();
    ok('explore lists the 5 seeded themes', cards === 5, cards);
    await page.goto(`${SITE}/explore?q=terminal`);
    ok('search finds by title/tag', (await page.locator('.theme-card').count()) === 1);
    await page.goto(`${SITE}/explore?site=en.wikipedia.org`);
    ok('site filter works', (await page.locator('.theme-card').count()) === 3);
    await page.goto(`${SITE}/explore?look=dark`);
    ok('appearance filter works', (await page.locator('.theme-card').count()) === 1);

    // ---------------------------------------------------------------- apply flow
    await page.goto(`${SITE}/themes/paper-trail`);
    await page.waitForSelector('.apply-box', { timeout: 15000 });
    await page.screenshot({ path: path.join(os.tmpdir(), 'ww-theme-page.png') });
    const applyBtn = page.getByRole('button', { name: /apply theme/i }).first();
    await applyBtn.waitFor({ timeout: 15000 });
    ok('extension detected, Apply button offered', await applyBtn.isEnabled());
    const popupPromise = ctx.waitForEvent('page', { timeout: 20000 });
    await applyBtn.click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    await popup.waitForSelector('dl', { timeout: 10000 });
    const popupText = await popup.locator('main').innerText();
    ok('confirmation window names the theme, website and origin', /Paper Trail/.test(popupText) && /en\.wikipedia\.org/.test(popupText) && /localhost:3000/.test(popupText), popupText);
    const stillWaiting = await page.locator('.apply-box').innerText();
    ok('website does NOT claim success before confirmation', !/applied|installed/i.test(stillWaiting.replace(/apply theme/gi, '')) || /confirm/i.test(stillWaiting), stillWaiting);
    const before = await sw.evaluate(async () => Object.entries(await chrome.storage.local.get(null)).filter(([k]) => k.startsWith('site:')).length);
    ok('nothing stored before confirming', before === 0, before);
    await popup.getByRole('button', { name: /apply theme/i }).click();
    await page.waitForFunction(() => /applied|installed/i.test(document.querySelector('.apply-box')?.textContent ?? ''), null, { timeout: 20000 });
    ok('after confirmation the website reports the real result', true);
    const designs = await sw.evaluate(async () => (await chrome.storage.local.get('site:en.wikipedia.org'))['site:en.wikipedia.org']);
    ok('extension stored the theme as enabled, with community metadata', designs?.length === 1 && designs[0].enabled && designs[0].community?.slug === 'paper-trail' && designs[0].community.origin === SITE, designs);

    // ---------------------------------------------------------------- the theme is really applied on the real site
    const wiki = await ctx.newPage();
    await wiki.goto('https://en.wikipedia.org/wiki/Hedgehog', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await wiki.waitForTimeout(2500);
    const bg = await wiki.evaluate(() => getComputedStyle(document.body).backgroundColor);
    ok('Wikipedia is restyled by the installed theme (paper background)', bg === 'rgb(246, 239, 223)', bg);
    await wiki.screenshot({ path: path.join(os.tmpdir(), 'ww-wiki-applied.png') });
    const other = await ctx.newPage();
    await other.goto('https://en.wikipedia.org/w/index.php?title=Hedgehog&action=history', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await other.waitForTimeout(1500);
    const bg2 = await other.evaluate(() => getComputedStyle(document.body).backgroundColor);
    ok('outside the theme\'s declared /wiki path the theme does NOT apply', bg2 !== 'rgb(246, 239, 223)', bg2);
    await other.close();

    // the website now shows it as installed
    await page.goto(`${SITE}/themes/paper-trail`);
    await page.waitForTimeout(2500);
    ok('theme page reflects the installed state from the extension', /installed|active|up to date|remove|turn off/i.test(await page.locator('.apply-box').innerText()), await page.locator('.apply-box').innerText());

    // ---------------------------------------------------------------- undo: remove restores the previous design
    await sw.evaluate(async () => {
      const k = 'site:en.wikipedia.org';
      const list = (await chrome.storage.local.get(k))[k];
      await chrome.storage.local.set({ [k]: [...list.map((d) => ({ ...d, enabled: false })), { id: 'mine', host: 'en.wikipedia.org', scope: 'site', name: 'Mine', prompt: 'x', css: 'body{color:green}', ops: [], enabled: false, createdAt: 1, updatedAt: 1 }] });
    });
    // reinstall to exercise displacement of a design the user had on
    await sw.evaluate(async () => {
      const k = 'site:en.wikipedia.org';
      const list = (await chrome.storage.local.get(k))[k];
      await chrome.storage.local.set({ [k]: list.map((d) => (d.id === 'mine' ? { ...d, enabled: true } : d)) });
    });
    await page.goto(`${SITE}/themes/paper-trail`);
    const btn2 = page.getByRole('button', { name: /apply|reapply|turn on|install/i }).first();
    await btn2.waitFor({ timeout: 15000 });
    const popup2Promise = ctx.waitForEvent('page', { timeout: 20000 });
    await btn2.click();
    const popup2 = await popup2Promise;
    await popup2.waitForSelector('dl', { timeout: 10000 });
    await popup2.getByRole('button', { name: /apply theme|turn|update/i }).click();
    await sleep(1500);
    const after = await sw.evaluate(async () => (await chrome.storage.local.get('site:en.wikipedia.org'))['site:en.wikipedia.org']);
    const mineAfter = after.find((d) => d.id === 'mine');
    const comm = after.find((d) => d.community);
    ok('installing displaced the user\'s own design (switched off, not deleted)', mineAfter && mineAfter.enabled === false && comm.enabled && comm.community.displacedIds.includes('mine'), after);
    await page.goto(`${SITE}/themes/paper-trail`);
    await page.evaluate((t) => (window.__tid = t), comm.community.themeId);
    // remove via the website uninstall message (an extension page sending the mutate message)
    const res = await page.evaluate(async ([id]) => new Promise((r) => chrome.runtime.sendMessage(id, { type: 'whimsyweb:uninstall', protocol: 1, themeId: window.__tid }, r)), [extId]).catch((e) => ({ err: String(e) }));
    ok('remove is accepted', res?.ok, res);
    const restored = await sw.evaluate(async () => (await chrome.storage.local.get('site:en.wikipedia.org'))['site:en.wikipedia.org']);
    ok('removing restores the previous design', restored.length === 1 && restored[0].id === 'mine' && restored[0].enabled === true, restored);

    // ---------------------------------------------------------------- sign in, profile, save
    const user = await ctx.newPage();
    await user.goto(`${SITE}/sign-in?next=/library`);
    await user.fill('#email', 'creator@example.com');
    await user.getByRole('button', { name: /email me/i }).click();
    await user.waitForURL(/check-email/, { timeout: 30000 });
    await user.goto(`${SITE}/dev/mail`);
    const href = await user.locator('a.btn', { hasText: 'Open sign-in link' }).first().getAttribute('href');
    await user.goto(href);
    await user.waitForURL(/\/library/, { timeout: 30000 });
    ok('email sign-in works and returns to the requested page', /My library/.test(await user.locator('h1').first().innerText()));
    await user.goto(`${SITE}/themes/sunday-edition`);
    await user.getByRole('button', { name: /^save$/i }).click();
    await user.waitForSelector('button[aria-pressed="true"]', { timeout: 10000 });
    await user.goto(`${SITE}/library`);
    ok('saved theme appears in My library', /Sunday Edition/.test(await user.locator('main').innerText()));
    await user.goto(`${SITE}/settings`);
    await user.fill('#displayName', 'E2E Creator');
    await user.fill('#username', 'e2e-creator');
    await user.getByRole('button', { name: /save profile/i }).click();
    await user.waitForSelector('.alert.ok', { timeout: 10000 });
    await user.goto(`${SITE}/creators/e2e-creator`);
    ok('public profile exists and hides the email', /E2E Creator/.test(await user.locator('main').innerText()) && !/example\.com/.test(await user.locator('main').innerText()));

    // ---------------------------------------------------------------- publish flow
    await user.goto(`${SITE}/publish`);
    await user.fill('#title', 'Ink Night');
    await user.selectOption('#hostname', 'news.ycombinator.com');
    await user.selectOption('#license', 'cc-by-4.0');
    await user.fill('#description', 'A test theme made during the end-to-end run.');
    await user.fill('#tags', 'test, dark');
    await user.selectOption('#appearance', 'dark');
    await user.fill('#css', '@import url(https://evil.example/x.css);\nbody { background: #111 }');
    await user.getByRole('button', { name: /save draft/i }).click();
    await user.waitForURL(/\/edit/, { timeout: 30000 });
    ok('draft with a forbidden @import is saved but reported invalid', /problem/i.test(await user.locator('aside').innerText()), await user.locator('aside').innerText());
    ok('publishing is blocked until fixed', await user.getByRole('button', { name: /publish theme/i }).isDisabled());
    await user.fill('#css', '#hnmain { background: #101114; }\nbody { background: #0b0c0e; color: #e6e6e6 }');
    await user.getByRole('button', { name: /save changes/i }).click();
    await user.waitForSelector('.alert.ok', { timeout: 15000 });
    await user.reload();
    ok('CSS now passes validation', /passed validation/i.test(await user.locator('aside').innerText()));
    await user.selectOption('#role', 'after');
    await user.setInputFiles('#image', path.join(WEB, 'seed/previews/terminal-green-after.png'));
    await user.getByRole('button', { name: /add screenshot/i }).click();
    await user.waitForFunction(() => document.querySelectorAll('aside img').length > 0, null, { timeout: 20000 });
    await user.reload();
    await user.locator('input[name=permission]').check();
    await user.getByRole('button', { name: /publish theme/i }).click();
    await user.waitForURL(/published=1/, { timeout: 30000 });
    ok('published and shareable URL shown', /Published/.test(await user.locator('.alert.ok').first().innerText()));
    await page.goto(`${SITE}/explore?q=ink+night`);
    ok('the new theme is discoverable', (await page.locator('.theme-card').count()) === 1);

    // another user cannot reach the editor of this theme
    await ctx.clearCookies();
    const other2 = await ctx.newPage();
    await other2.goto(`${SITE}/themes/ink-night/edit`);
    ok('signed-out visitor is sent to sign in, not shown the editor', /sign-in/.test(other2.url()));
    await other2.close();

    // ---------------------------------------------------------------- report + moderation
    await page.goto(`${SITE}/themes/ink-night`);
    await page.locator('summary', { hasText: 'Report this theme' }).click();
    await page.selectOption('#reason', 'broken');
    await page.getByRole('button', { name: /send report/i }).click();
    await page.waitForSelector('.alert.ok', { timeout: 10000 });
    ok('a signed-out visitor can report a theme', true);
    const modCtxPage = await ctx.newPage();
    await modCtxPage.goto(`${SITE}/moderation`);
    ok('moderation area is hidden from non-moderators', /could not be found|404/i.test(await modCtxPage.locator('body').innerText()));
    await modCtxPage.goto(`${SITE}/sign-in?next=/moderation`);
    await modCtxPage.context().clearCookies();
    await modCtxPage.goto(`${SITE}/sign-in?next=/moderation`);
    await modCtxPage.fill('#email', 'mod@example.com');
    await modCtxPage.getByRole('button', { name: /email me/i }).click();
    await modCtxPage.waitForURL(/check-email/);
    await modCtxPage.goto(`${SITE}/dev/mail`);
    await modCtxPage.goto(await modCtxPage.locator('a.btn', { hasText: 'Open sign-in link' }).first().getAttribute('href'));
    await modCtxPage.waitForURL((u) => u.pathname === '/moderation', { timeout: 30000 });
    console.log('MODPAGE', (await modCtxPage.locator('body').innerText()).slice(0,300), modCtxPage.url());
    ok('moderator sees the open report', /Ink Night/.test(await modCtxPage.locator('main').innerText()));
    await modCtxPage.getByRole('button', { name: /unpublish theme/i }).first().click();
    await modCtxPage.waitForTimeout(1500);
    await page.goto(`${SITE}/themes/ink-night`);
    ok('unpublished theme is gone from public view', /could not be found|not found/i.test(await page.locator('body').innerText()));
    const api = await page.evaluate(async () => {
      const r = await fetch('/explore?q=ink+night');
      return r.status;
    });
    const gone = await page.goto(`${SITE}/explore?q=ink+night`);
    ok('and from search', gone.ok() && (await page.locator('.theme-card').count()) === 0, api);

    // ---------------------------------------------------------------- extension -> website draft
    await sw.evaluate(async () => {
      const k = 'site:github.com';
      await chrome.storage.local.set({ [k]: [{ id: 'g1', host: 'github.com', scope: 'site', name: 'Espresso draft', prompt: 'x', css: 'body { background: #2b2118; color: #f0e6d8 }', ops: [], enabled: true, createdAt: 1, updatedAt: 1 }] });
    });
    // (The side panel's Share button needs the real side panel; creating the export is unit-tested. Here the draft is planted
    // in the extension's session storage exactly as createDraft stores it, to test the website <-> extension transfer.)
    const did = 'abcdefghijklmnopqrstuvwxyz012345';
    await sw.evaluate(async (id) => chrome.storage.session.set({ wwCommunityDrafts: { [id]: { origin: 'http://localhost:3000', createdAt: Date.now(), draft: { title: 'Espresso draft', hostname: 'github.com', pathScope: { mode: 'all' }, css: 'body { background: #2b2118; color: #f0e6d8 }' } } } }), did);
    const pubTab = await ctx.newPage();
    await pubTab.goto(SITE + '/publish?draft=' + did);
    ok('the publish URL carries only an opaque id', /\/publish\?draft=[A-Za-z0-9_-]{16,}/.test(pubTab.url()) && !/css|body/.test(pubTab.url()), pubTab.url());
    await pubTab.waitForSelector('#title', { timeout: 20000 });
    await pubTab.waitForFunction(() => document.querySelector('#css')?.value?.includes('2b2118'), null, { timeout: 20000 });
    ok('the draft was fetched from the extension and prefilled', (await pubTab.inputValue('#title')) === 'Espresso draft' && (await pubTab.inputValue('#hostname')) === 'github.com');
    await pubTab.reload();
    await sleep(3000);
    ok('the one-time draft is gone after use', (await pubTab.inputValue('#title')) === '');
  } catch (e) {
    fails++;
    console.log('FAIL crashed:', e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e);
    console.log('--- server log tail ---\n' + log.slice(-1500));
  } finally {
    await stop();
  }
  console.log(fails ? `${fails} FAILED` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})();
